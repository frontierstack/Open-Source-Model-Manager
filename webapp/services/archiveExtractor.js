// Archive extraction helper for the extract_archive tool/skill.
//
// Shells out to system binaries (unzip, tar, 7z, gunzip, bunzip2, xz,
// unrar) rather than pulling in a pile of npm packages. These are
// already in the webapp image (see Dockerfile) — 7z and unrar are added
// alongside the existing unzip/tar/gzip/bzip2/xz tooling.
//
// Input: a buffer holding the archive bytes + a filename hint used to
// pick the extraction command.
//
// Output: { ok, archive, entries: [{ path, size, text? }], note? }
//   - entries[].text is populated for small, printable text files so the
//     model can read them directly. Binary entries get metadata only.
//   - The extraction directory is cleaned up before this function returns.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');

// Every extractor is run through this wrapper rather than a bare execFile:
//   - stdin is CLOSED immediately. An encrypted archive makes 7z (and unrar)
//     prompt for a password on the terminal; with an open-but-never-written
//     pipe they block FOREVER. Measured: `7z x` on an encrypted .7z sat for
//     138 s and only died on an external SIGKILL — the `timeout` option below
//     could not save it, because p7zip survives the SIGTERM node sends and
//     execFile then keeps waiting on the still-open stdout.
//   - killSignal is SIGKILL for the same reason: a timeout must actually end
//     the process, not politely ask.
function execFileP(bin, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(
            bin,
            args,
            { killSignal: 'SIGKILL', ...opts },
            (err, stdout, stderr) => {
                if (err) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    reject(err);
                } else {
                    resolve({ stdout, stderr });
                }
            },
        );
        // Never leave a prompt-capable extractor with a readable stdin.
        if (child.stdin) child.stdin.end();
    });
}

const EXEC_TIMEOUT_MS = 60_000;
// Extraction time scales with archive size: a 1 GB tarball on this 4-core
// host runs minutes, not seconds. Base 60 s + ~1 s per 2 MB, capped.
const EXEC_TIMEOUT_MAX_MS = parseInt(process.env.ARCHIVE_EXTRACT_TIMEOUT_MAX_MS || String(20 * 60_000), 10);
function execTimeoutFor(sizeBytes) {
    const scaled = EXEC_TIMEOUT_MS + Math.ceil((sizeBytes || 0) / (2 * 1024 * 1024)) * 1000;
    return Math.min(EXEC_TIMEOUT_MAX_MS, Math.max(EXEC_TIMEOUT_MS, scaled));
}
const MAX_ENTRIES = 500;
// Hard ceiling on how many files a single walk enumerates (stats + listing).
// Well above any realistic source tree; bounds a pathological archive.
const MAX_WALK_ENTRIES = 250_000;
// Decompressed-size ceiling (zip-bomb / disk-exhaustion guard). Checked
// after extraction; on breach the output is removed and the call fails.
const MAX_EXTRACTED_BYTES = parseInt(process.env.ARCHIVE_MAX_EXTRACTED_BYTES || String(8 * 1024 * 1024 * 1024), 10);
// uid/gid the sandbox runtime runs as (sandbox-runtime/Dockerfile: `useradd
// -u 1000 sandbox`). Extracted trees are chowned to it so the sandbox can
// WRITE into them (npm install, a script saving output next to its input,
// replace_lines on an extracted file) — root-owned 0755 dirs only allowed reads.
const SANDBOX_UID = parseInt(process.env.SANDBOX_UID || '1000', 10);
const SANDBOX_GID = parseInt(process.env.SANDBOX_GID || '1000', 10);
const MAX_TEXT_BYTES_PER_ENTRY = 200_000; // 200KB
const MAX_TOTAL_TEXT_BYTES = 2_000_000;   // 2MB across all entries

// Extension → handler. Tested in order; the first whose `matches` returns
// true wins. Multi-part suffixes (.tar.gz) live before single (.gz).
const HANDLERS = [
    { name: 'tar.gz',  matches: (n) => /\.(tar\.gz|tgz)$/i.test(n),  cmd: ['tar', ['-xzf', '__FILE__', '-C', '__DIR__']] },
    { name: 'tar.bz2', matches: (n) => /\.(tar\.bz2|tbz2?)$/i.test(n), cmd: ['tar', ['-xjf', '__FILE__', '-C', '__DIR__']] },
    { name: 'tar.xz',  matches: (n) => /\.(tar\.xz|txz)$/i.test(n),  cmd: ['tar', ['-xJf', '__FILE__', '-C', '__DIR__']] },
    { name: 'tar',     matches: (n) => /\.tar$/i.test(n),            cmd: ['tar', ['-xf',  '__FILE__', '-C', '__DIR__']] },
    // `pw` builds the password arguments for encrypted archives. It is called
    // with '' when the caller gave no password — 7z NEEDS the bare `-p` in
    // that case so it fails fast with "Cannot open encrypted archive. Wrong
    // password?" instead of the opaque "Break signaled" it emits when its
    // prompt hits a closed stdin.
    { name: 'zip',     matches: (n) => /\.zip$/i.test(n),            cmd: ['unzip', ['-qq', '-o', '__FILE__', '-d', '__DIR__']], pw: (p) => (p ? ['-P', p] : []) },
    { name: '7z',      matches: (n) => /\.7z$/i.test(n),             cmd: ['7z', ['x', '-y', '-bd', '-o__DIR__', '__FILE__']], pw: (p) => [`-p${p}`] },
    { name: 'rar',     matches: (n) => /\.rar$/i.test(n),            cmd: ['unrar-free', ['-x', '__FILE__', '__DIR__/']], pw: (p) => (p ? ['-p', p] : []) },
    { name: 'gz',      matches: (n) => /\.gz$/i.test(n),             single: 'gz' },
    { name: 'bz2',     matches: (n) => /\.bz2$/i.test(n),            single: 'bz2' },
    { name: 'xz',      matches: (n) => /\.xz$/i.test(n),             single: 'xz' },
];

function pickHandler(filename) {
    const n = (filename || '').toLowerCase();
    return HANDLERS.find(h => h.matches(n)) || null;
}

// gzip outer magic says nothing about what's inside (.tar.gz vs a single
// gzipped file). Decompress just the head — Z_SYNC_FLUSH tolerates the
// truncated stream — and check for the tar "ustar" magic at offset 257.
// Returns 'tar.gz' / 'gz', or null when the stream won't decompress at all
// (corrupt/truncated download — let the attempt chain surface the real error).
function sniffGzipInner(buf) {
    try {
        const head = zlib.gunzipSync(
            buf.length > 65536 ? buf.subarray(0, 65536) : buf,
            { finishFlush: zlib.constants.Z_SYNC_FLUSH },
        );
        if (head.length >= 263 && head.subarray(257, 262).toString('ascii') === 'ustar') return 'tar.gz';
        return 'gz';
    } catch (_) { return null; }
}

// Sniff the archive format from the leading bytes. Protects against
// files whose extension lies (a .7z that's actually a zip, a renamed
// tarball, etc.) — we trust the magic over the extension when they
// disagree. Returns a handler name matching HANDLERS[].name, or null.
function sniffFormat(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    // 7z: 37 7A BC AF 27 1C
    if (buf.slice(0, 6).equals(Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]))) return '7z';
    // zip: PK\x03\x04 or PK\x05\x06 (empty) or PK\x07\x08 (spanned)
    if (buf[0] === 0x50 && buf[1] === 0x4B &&
        ((buf[2] === 0x03 && buf[3] === 0x04) ||
         (buf[2] === 0x05 && buf[3] === 0x06) ||
         (buf[2] === 0x07 && buf[3] === 0x08))) return 'zip';
    // rar v5: 52 61 72 21 1A 07 01 00 ; rar v1.5-4: 52 61 72 21 1A 07 00
    if (buf.slice(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])) ||
        buf.slice(0, 8).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]))) return 'rar';
    // gzip: 1F 8B — decompress the head and look for an inner tar so a
    // single gzipped file routes to gunzip instead of failing inside tar.
    if (buf[0] === 0x1F && buf[1] === 0x8B) return sniffGzipInner(buf) || 'tar.gz';
    // bzip2: 42 5A 68 ("BZh") — no stdlib decompressor to peek inside;
    // default tar.bz2, the attempt chain falls back to single-file bz2.
    if (buf[0] === 0x42 && buf[1] === 0x5A && buf[2] === 0x68) return 'tar.bz2';
    // xz: FD 37 7A 58 5A 00 — same ambiguity, same fallback.
    if (buf.slice(0, 6).equals(Buffer.from([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]))) return 'tar.xz';
    // tar: "ustar" at offset 257 (POSIX), or just a valid-looking tar
    // header — skip; we only hit this path when the extension also fails
    if (buf.length >= 263 && buf.slice(257, 262).toString('ascii') === 'ustar') return 'tar';
    return null;
}

// ---------------------------------------------------------------------------
// Encrypted (password-protected) archives
//
// A password-protected zip is NOT a corrupt zip, but every extractor reports
// it as a generic failure — and unzip reports a WRONG password with exit 82
// and completely empty stderr. Without the checks below the model gets
// "Extraction failed ... last error (zip): " and starts guessing at the
// filename instead of asking the user for the password (live-observed: an
// upload whose inner zip was encrypted produced ~25 flailing tool calls).
// ---------------------------------------------------------------------------

// Read the zip central directory and report how many entries carry the
// "encrypted" general-purpose flag (bit 0). Returns null when the structure
// can't be parsed (zip64, truncated, not a zip) — callers then fall back to
// the stderr/exit-code classification.
function zipEncryptionInfo(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
    // End of central directory: PK\x05\x06, within the last 64KB + 22 bytes.
    const scanFrom = Math.max(0, buf.length - 65_557);
    let eocd = -1;
    for (let i = buf.length - 22; i >= scanFrom; i--) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    // 0xFFFFFFFF means the real offset lives in the zip64 record — bail out
    // rather than mis-parse (the stderr classification still covers it).
    if (off === 0xFFFFFFFF || off + 46 > buf.length) return null;
    let encrypted = 0, total = 0;
    const names = [];
    for (let i = 0; i < count; i++) {
        if (off + 46 > buf.length) return null;
        if (buf.readUInt32LE(off) !== 0x02014b50) return null; // PK\x01\x02
        const flags = buf.readUInt16LE(off + 8);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
        // Directory entries have no content to encrypt — don't count them.
        if (!name.endsWith('/')) {
            total++;
            if (flags & 0x0001) { encrypted++; if (names.length < 5) names.push(name); }
        }
        off += 46 + nameLen + extraLen + commentLen;
    }
    return { total, encrypted, names };
}

// Same verdict for an archive that lives on DISK (source-path mode — the
// bytes are never loaded whole). Reads the EOCD from the tail, then the
// central directory region at its absolute offset (bounded to 16 MB), and
// hands a synthetic buffer to the parser above with offsets rebased.
async function zipEncryptionInfoFromFile(filePath, size) {
    let fd = null;
    try {
        if (!size || size < 22) return null;
        fd = await fs.promises.open(filePath, 'r');
        const tailLen = Math.min(size, 65_557);
        const tail = Buffer.alloc(tailLen);
        await fd.read(tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail[i] === 0x50 && tail[i + 1] === 0x4B && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
        }
        if (eocd < 0) return null;
        const cdOff = tail.readUInt32LE(eocd + 16);
        const cdSize = tail.readUInt32LE(eocd + 12);
        if (cdOff === 0xFFFFFFFF || cdSize > 16 * 1024 * 1024 || cdOff + cdSize > size) return null;
        // Synthesize [central directory][EOCD] and rebase the CD offset to 0.
        const cd = Buffer.alloc(cdSize);
        await fd.read(cd, 0, cdSize, cdOff);
        const eocdRec = Buffer.from(tail.subarray(eocd, eocd + 22));
        eocdRec.writeUInt32LE(0, 16);
        return zipEncryptionInfo(Buffer.concat([cd, eocdRec]));
    } catch (_) {
        return null;
    } finally {
        if (fd) await fd.close().catch(() => {});
    }
}

// Cheap per-file check used to flag an extracted entry that is ITSELF an
// encrypted zip (the reported case: an ordinary zip containing a
// password-protected zip). Reads only the local file header.
async function zipFileIsEncrypted(fullPath) {
    let fd = null;
    try {
        fd = await fs.promises.open(fullPath, 'r');
        const head = Buffer.alloc(30);
        const { bytesRead } = await fd.read(head, 0, 30, 0);
        if (bytesRead < 30) return false;
        if (head.readUInt32LE(0) !== 0x04034b50) return false; // PK\x03\x04
        return (head.readUInt16LE(6) & 0x0001) === 1;          // local header flags
    } catch (_) {
        return false;
    } finally {
        if (fd) await fd.close().catch(() => {});
    }
}

const PASSWORD_ERROR_RE = /unable to get password|incorrect password|wrong password|bad password|cannot open encrypted|encrypted archive|password is incorrect|need password|password required/i;

// Does this extractor failure mean "the archive is encrypted and we don't have
// the right password"? unzip is the tricky one: a wrong -P password exits 82
// with NO output at all, so the exit code has to carry the verdict.
function isPasswordFailure(err, handlerName, encInfo) {
    const text = `${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`;
    if (PASSWORD_ERROR_RE.test(text)) return true;
    // unzip exit 82 = "nothing extracted". Only a password verdict when the
    // central directory actually says entries are encrypted — otherwise 82 is
    // an ordinary empty/filtered archive and must keep its own error.
    if (handlerName === 'zip' && err?.code === 82 && encInfo?.encrypted > 0) return true;
    return false;
}

// When nothing matches, figure out whether the bytes are even an archive.
// The classic failure: fetch_url saved an HTML error page (404/login/rate
// limit) under the archive's filename — tell the model to re-download
// instead of letting tar produce "gzip: stdin: not in gzip format".
function describeNonArchive(buf) {
    const head = buf.slice(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')) {
        return 'an HTML page (the download likely saved an error/login page instead of the archive — re-fetch the URL and check the response)';
    }
    if (head.startsWith('{') || head.startsWith('[')) {
        return 'JSON (likely an API error response saved in place of the archive — re-fetch and check the response)';
    }
    if (isPrintableUtf8(buf.slice(0, 2048))) {
        return 'plain text, not a binary archive';
    }
    return null;
}

function isPrintableUtf8(buf) {
    // Heuristic: UTF-8 decode, count replacement + C0 control chars.
    // Allows \t \n \r. Rejects if >10% of chars are bad.
    if (!buf.length) return true;
    const text = buf.toString('utf8');
    if (!text) return false;
    let bad = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 0xFFFD) { bad++; continue; }
        if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
    }
    return bad / text.length < 0.1;
}

// Enumerate every regular file under root (bounded by MAX_WALK_ENTRIES so
// the stats — count, bytes, per-top-level-dir summary — are truthful for
// the whole tree, not just the first listing page). Symlinks are never
// followed; one whose target resolves OUTSIDE root is removed (an archive
// can carry `evil -> /etc` and the webapp reads the tree as root).
async function walkDir(root, { pruneEscapingSymlinks = true } = {}) {
    const out = [];
    const droppedSymlinks = [];
    let capped = false;
    const rootReal = await fs.promises.realpath(root).catch(() => path.resolve(root));
    async function walk(dir, relBase) {
        if (capped) return;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const ent of entries) {
            if (out.length >= MAX_WALK_ENTRIES) { capped = true; return; }
            const full = path.join(dir, ent.name);
            const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
            if (ent.isSymbolicLink()) {
                if (!pruneEscapingSymlinks) continue;
                try {
                    const target = await fs.promises.readlink(full);
                    const resolved = path.resolve(path.dirname(full), target);
                    if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
                        await fs.promises.unlink(full).catch(() => {});
                        if (droppedSymlinks.length < 20) droppedSymlinks.push(`${rel} -> ${target}`);
                    }
                } catch (_) { /* best effort */ }
                continue;
            }
            if (ent.isDirectory()) {
                await walk(full, rel);
            } else if (ent.isFile()) {
                try {
                    const stat = await fs.promises.stat(full);
                    out.push({ path: rel, size: stat.size, fullPath: full });
                } catch (_) { /* vanished */ }
            }
        }
    }
    await walk(root, '');
    return { files: out, droppedSymlinks, capped };
}

// Per-top-level-directory summary so a truncated listing still conveys the
// tree's SHAPE (which subtrees hold the bulk of the files/bytes).
function summarizeTopLevel(files, limit = 12) {
    const agg = new Map();
    for (const f of files) {
        const slash = f.path.indexOf('/');
        const key = slash < 0 ? '(root files)' : f.path.slice(0, slash) + '/';
        const a = agg.get(key) || { path: key, files: 0, bytes: 0 };
        a.files += 1; a.bytes += f.size;
        agg.set(key, a);
    }
    return [...agg.values()].sort((a, b) => b.files - a.files).slice(0, limit);
}

async function totalBytesOf(files) {
    let n = 0;
    for (const f of files) n += f.size;
    return n;
}

// Free bytes on the filesystem holding `dir` (null when statfs is unavailable).
async function freeBytesAt(dir) {
    try {
        if (typeof fs.promises.statfs !== 'function') return null;
        const st = await fs.promises.statfs(dir);
        return Number(st.bavail) * Number(st.bsize);
    } catch (_) { return null; }
}

async function rmrf(dir) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); }
    catch (_) { /* best effort */ }
}

// Make an extracted tree readable by the sandbox's unprivileged user (uid
// 1000). The webapp extracts as root and tar/unzip/7z/rar restore the
// archive's STORED modes + ownership — so an entry that isn't world-readable
// (e.g. a 0600 file, or a 0700 dir with no traversal bit for "other") makes a
// later sandboxed read_file/move_file fail with EACCES. We OR in read bits for
// files and read+traverse bits for directories, preserving any existing
// execute bits. chmod-by-root works regardless of the (possibly archive-stored)
// owner. Best-effort, bounded, and symlink-safe (chmod() follows links on
// Linux and lchmod isn't supported, so symlinks are skipped, not recursed).
async function normalizeTreePermissions(root) {
    // Fast path: coreutils handle a 100k-file tree in well under a second and
    // — unlike a JS walk bounded by a visit cap — cover EVERY entry, so no
    // file deep in a big archive is left unreadable/unwritable. GNU chmod -R
    // ignores symlinks met during traversal; chown -R (default -P) changes
    // the link itself, never its referent. `u+w` restores owner write on
    // read-only-stored dirs; `X` grants traversal only where it belongs.
    // The ownership change is what lets the sandbox user (uid 1000) WRITE
    // into the extracted tree. Falls back to the bounded JS walk on error.
    try {
        await execFileP('chmod', ['-R', 'u+rw,a+rX', root], { timeout: 5 * 60_000 });
        await execFileP('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, root], { timeout: 5 * 60_000 });
        return;
    } catch (_) { /* fall back to the JS walk below */ }
    let visited = 0;
    const MAX_VISIT = MAX_WALK_ENTRIES;
    async function walk(dir) {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const ent of entries) {
            if (visited++ > MAX_VISIT) return;
            if (ent.isSymbolicLink()) continue; // don't chmod through a link
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                try { const st = await fs.promises.stat(full); await fs.promises.chmod(full, st.mode | 0o755); }
                catch (_) { /* best effort */ }
                try { await fs.promises.chown(full, SANDBOX_UID, SANDBOX_GID); } catch (_) { /* best effort */ }
                await walk(full);
            } else if (ent.isFile()) {
                try { const st = await fs.promises.stat(full); await fs.promises.chmod(full, st.mode | 0o644); }
                catch (_) { /* best effort */ }
                try { await fs.promises.chown(full, SANDBOX_UID, SANDBOX_GID); } catch (_) { /* best effort */ }
            }
        }
    }
    try { const st = await fs.promises.stat(root); await fs.promises.chmod(root, st.mode | 0o755); } catch (_) { /* best effort */ }
    try { await fs.promises.chown(root, SANDBOX_UID, SANDBOX_GID); } catch (_) { /* best effort */ }
    await walk(root);
}

/**
 * Extract an archive provided as raw bytes.
 * @param {Buffer} buffer - archive bytes
 * @param {string} filename - used to pick extractor (extension-based)
 * @param {object} opts - {
 *     maxEntries, maxTextBytesPerEntry, maxTotalTextBytes,
 *     extractTo,            // when set: extract into this directory and DO NOT clean up.
 *                           //   Caller owns the lifecycle. Each entry's `path` is
 *                           //   then expressed relative to `pathBase` (defaults to extractTo).
 *     pathBase,             // root used to compute entries[].path. Defaults to extractTo.
 *     inlineText,           // false (default when extractTo set) → only metadata + tiny preview;
 *                           //   true → behave like the legacy temp-dir mode and inline UTF-8.
 * }
 */
async function extractArchive(buffer, filename, opts = {}) {
    // Two input shapes: raw bytes (base64 tool arg, legacy callers) or a
    // `sourcePath` on disk (uploaded archive in the store, a workspace file).
    // With the upload limit at 1 GB the on-disk form is the only sane one —
    // reading the whole archive into a Buffer just to write it back out
    // doubles peak RAM and the format sniff needs only the head (64 KB) and,
    // for zip encryption, the tail. `head`/`size` are what every check
    // below reads; `buffer` stays null in source-path mode.
    const sourcePath = typeof opts.sourcePath === 'string' && opts.sourcePath ? opts.sourcePath : null;
    let size, head;
    if (sourcePath) {
        const st = await fs.promises.stat(sourcePath).catch(() => null);
        if (!st || !st.isFile() || !st.size) throw new Error(`extractArchive: sourcePath "${sourcePath}" is not a readable, non-empty file`);
        size = st.size;
        const fd = await fs.promises.open(sourcePath, 'r');
        try {
            head = Buffer.alloc(Math.min(size, 65536));
            const { bytesRead } = await fd.read(head, 0, head.length, 0);
            head = head.subarray(0, bytesRead);
        } finally { await fd.close(); }
        buffer = null;
    } else {
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            throw new Error('extractArchive: non-empty Buffer or sourcePath required');
        }
        size = buffer.length;
        head = buffer.length > 65536 ? buffer.subarray(0, 65536) : buffer;
    }
    const execTimeout = execTimeoutFor(size);
    // Try the extension first, then fall back to magic-byte sniffing.
    // If both agree, we use the extension handler. If they disagree,
    // trust the magic — renamed/mislabeled archives are common and the
    // user's intent is "extract this, whatever it is".
    const extHandler = pickHandler(filename);
    const sniffed = sniffFormat(head);
    let handler = extHandler;
    let sourcedFrom = 'extension';
    if (!handler && sniffed) {
        handler = HANDLERS.find(h => h.name === sniffed);
        sourcedFrom = 'magic';
    } else if (handler && sniffed && handler.name !== sniffed) {
        // Extension and magic disagree. Within the same compression family
        // (xz↔tar.xz, bz2↔tar.bz2) the magic side is a blind tar-first GUESS
        // (we can't peek inside bz2/xz), while the extension is an informed
        // claim — keep the extension. gzip is the exception: sniffGzipInner
        // positively identified the inner content, so its verdict wins. Any
        // cross-family mismatch (a .tgz that's really a zip) → magic wins.
        const family = (n) => n.startsWith('tar.') ? n.slice(4) : n;
        const sameFamily = family(handler.name) === family(sniffed);
        if (sameFamily && (family(sniffed) === 'bz2' || family(sniffed) === 'xz')) {
            sourcedFrom = 'extension (family match)';
        } else {
            handler = HANDLERS.find(h => h.name === sniffed);
            sourcedFrom = 'magic (extension mismatch)';
        }
    }
    if (!handler) {
        const preview = head.slice(0, 16).toString('hex');
        const kind = describeNonArchive(head);
        throw new Error(
            kind
                ? `"${filename}" is not an archive — the content looks like ${kind}. ` +
                  `(first 16 bytes: ${preview})`
                : `Cannot detect archive type. Filename "${filename}" extension is not recognized ` +
                  `and the first 16 bytes (${preview}) don't match any known magic number. ` +
                  `Supported: .zip, .7z, .rar, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .gz, .bz2, .xz. ` +
                  `If this is a truncated base64 payload, ensure the full archive was passed.`
        );
    }
    // Attempt chain: compressed-tar handlers fall back to their single-file
    // sibling (a plain .gz/.bz2/.xz that the outer magic can't distinguish
    // from a compressed tar), and vice versa. Bounded to 2 attempts.
    const FALLBACK = { 'tar.gz': 'gz', 'tar.bz2': 'bz2', 'tar.xz': 'xz', 'gz': 'tar.gz', 'bz2': 'tar.bz2', 'xz': 'tar.xz' };
    const attempts = [handler];
    if (FALLBACK[handler.name]) attempts.push(HANDLERS.find(h => h.name === FALLBACK[handler.name]));

    const password = typeof opts.password === 'string' ? opts.password : '';
    // Parsed once up front so a password verdict can be reached even when the
    // extractor says nothing useful (unzip's silent exit 82).
    const encInfo = sourcePath ? await zipEncryptionInfoFromFile(sourcePath, size) : zipEncryptionInfo(buffer);

    const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    // When extracting into a caller-owned dir we expect read_file to follow up
    // per-entry, so default to NO inline text. Cap at 4KB / 32KB if the caller
    // explicitly asks for previews. Legacy temp-dir mode keeps the old big caps.
    const persistMode = !!opts.extractTo;
    const inlineText = opts.inlineText ?? !persistMode;
    const maxTextPerEntry = opts.maxTextBytesPerEntry ?? (persistMode ? 4_000 : MAX_TEXT_BYTES_PER_ENTRY);
    const maxTotalText = opts.maxTotalTextBytes ?? (persistMode ? 32_000 : MAX_TOTAL_TEXT_BYTES);

    const workRoot = persistMode
        ? opts.extractTo
        : path.join(os.tmpdir(), `archive-extract-${crypto.randomBytes(8).toString('hex')}`);
    const extractDir = persistMode ? workRoot : path.join(workRoot, 'out');
    // Persist mode: archive is written into a sibling tmp dir (deleted on
    // return) so the extracted output dir stays clean of the source bytes.
    const archiveStageDir = persistMode
        ? path.join(os.tmpdir(), `archive-stage-${crypto.randomBytes(8).toString('hex')}`)
        : workRoot;
    const archivePath = path.join(archiveStageDir, path.basename(filename) || 'archive.bin');
    await fs.promises.mkdir(extractDir, { recursive: true });
    if (persistMode) await fs.promises.mkdir(archiveStageDir, { recursive: true });
    // Disk pre-check: the staged copy + the extraction both land on this
    // filesystem. Refuse up front with a clear message rather than letting
    // tar die half-way with ENOSPC (which also strands a partial tree).
    const free = await freeBytesAt(extractDir);
    if (free != null && free < size * 2 + 256 * 1024 * 1024) {
        await rmrf(persistMode ? archiveStageDir : workRoot);
        throw new Error(`Not enough free disk to extract "${filename}" (${size} bytes; ${free} bytes free). Free space on the server's models volume and retry.`);
    }
    if (sourcePath) {
        // Hardlink when possible (same filesystem, zero copy); copy otherwise.
        try { await fs.promises.link(sourcePath, archivePath); }
        catch (_) { await fs.promises.copyFile(sourcePath, archivePath); }
    } else {
        await fs.promises.writeFile(archivePath, buffer);
    }
    const pathBase = opts.pathBase || extractDir;

    try {
        // Run the attempt chain: first handler that extracts cleanly wins.
        // Between attempts the output dir is emptied so a half-extracted
        // failure doesn't pollute the next attempt's listing.
        let lastErr = null;
        let used = null;
        let passwordWarning = null;
        for (const attempt of attempts) {
            if (!attempt) continue;
            if (lastErr) {
                // Clear partial output from the previous attempt (contents
                // only — extractDir itself may be caller-owned).
                const leftovers = await fs.promises.readdir(extractDir).catch(() => []);
                for (const name of leftovers) await rmrf(path.join(extractDir, name));
            }
            try {
                if (attempt.single) {
                    // Single-stream compressions (.gz / .bz2 / .xz of one
                    // file). The decompressors demand a recognized suffix, so
                    // stage a correctly-suffixed copy when the name lacks one.
                    const binMap = { gz: 'gunzip', bz2: 'bunzip2', xz: 'xz' };
                    const bin = binMap[attempt.single];
                    let srcPath = archivePath;
                    if (!new RegExp(`\\.${attempt.single}$`, 'i').test(srcPath)) {
                        srcPath = `${archivePath}.${attempt.single}`;
                        await fs.promises.copyFile(archivePath, srcPath);
                    }
                    const args = attempt.single === 'xz' ? ['-d', '-k', '-f', srcPath] : ['-k', '-f', srcPath];
                    // gunzip/bunzip2/xz with -k (keep original) write foo.ext -> foo.
                    await execFileP(bin, args, { timeout: execTimeout });
                    const stripped = srcPath.replace(/\.(gz|bz2|xz)$/i, '');
                    if (!fs.existsSync(stripped)) {
                        throw new Error(`Decompression produced no output (expected ${stripped})`);
                    }
                    // The decompressed stream may itself be a tar (a .bz2/.xz
                    // whose outer magic couldn't be peeked) — unpack the inner
                    // tar instead of returning an opaque single entry.
                    const innerHead = Buffer.alloc(263);
                    const fd = await fs.promises.open(stripped, 'r');
                    try { await fd.read(innerHead, 0, 263, 0); } finally { await fd.close(); }
                    if (innerHead.subarray(257, 262).toString('ascii') === 'ustar') {
                        await execFileP('tar', ['-xf', stripped, '-C', extractDir], { timeout: execTimeout });
                        await rmrf(stripped);
                    } else {
                        // Content isn't a tar — drop any leftover archive-ish
                        // suffix so the single entry doesn't masquerade as an
                        // archive ("data.tgz" holding plain text → "data").
                        const base = path.basename(stripped);
                        const dest = path.join(extractDir, base.replace(/\.(tgz|tbz2?|txz|tar)$/i, '') || base);
                        await fs.promises.rename(stripped, dest);
                    }
                } else {
                    const [bin, tmpl] = attempt.cmd;
                    const args = tmpl.map(a => a
                        .replace('__FILE__', archivePath)
                        .replace('__DIR__', extractDir));
                    // Password switches go at index 1 — after the subcommand
                    // (`7z x`) but before the archive name (unzip/unrar treat
                    // anything after the archive as a file selector).
                    if (attempt.pw) args.splice(1, 0, ...attempt.pw(password));
                    await execFileP(bin, args, { timeout: execTimeout, maxBuffer: 10 * 1024 * 1024 });
                }
                // An extractor that exits 0 but produces nothing (tar can on
                // some non-tar streams) is a failure — let the next attempt run.
                const produced = await fs.promises.readdir(extractDir);
                if (!produced.length) throw new Error('extractor exited cleanly but produced no files');
                used = attempt;
                lastErr = null;
                break;
            } catch (e) {
                lastErr = { attempt, err: e };
                // An encrypted archive is not a format mismatch — the fallback
                // chain can only produce a more confusing error, so stop here
                // and let the password branch below report it.
                if (isPasswordFailure(e, attempt.name, encInfo)) break;
            }
        }
        // Password failure. A mixed archive (some entries encrypted, some not)
        // still leaves the readable files on disk — keep them and warn, rather
        // than throwing away a partial extraction the model can use.
        if (lastErr && !used && isPasswordFailure(lastErr.err, lastErr.attempt.name, encInfo)) {
            const produced = await fs.promises.readdir(extractDir).catch(() => []);
            const locked = encInfo?.encrypted
                ? `${encInfo.encrypted} of ${encInfo.total} entries are encrypted${encInfo.names.length ? ` (e.g. ${encInfo.names.slice(0, 3).join(', ')})` : ''}`
                : 'its contents are encrypted';
            const advice = password
                // Echo the password that was tried: models mangle a copied
                // string as readily as they mangle a filename (live-observed:
                // the user said "infected", the tool got "infected_"), and
                // seeing it back is the only way that gets noticed.
                ? `The password that was supplied ("${password.slice(0, 40)}") was REJECTED. Check it character-for-character against what the user gave you — if it matches, ask them for the correct one. Retry with the "password" argument; do not retry with a different path.`
                : `Retry extract_archive with the "password" argument. If the user did not give one, ASK THEM for it — do not guess repeatedly, and do not retry with a different filename/archiveId (the reference was correct; the archive is simply locked).`;
            if (produced.length) {
                passwordWarning = `PARTIAL EXTRACTION: "${filename}" is password-protected (${locked}). The unencrypted entries below were extracted; the encrypted ones were skipped. ${advice}`;
                used = lastErr.attempt;
                lastErr = null;
            } else {
                throw new Error(
                    `"${filename}" is password-protected (${locked}) and could not be extracted. ${advice}`,
                );
            }
        }
        if (lastErr || !used) {
            // Surface the tool's stderr plus the leading bytes so the caller
            // can tell apart "file isn't what the extension says" from
            // "base64 got truncated in transit".
            const { attempt, err } = lastErr;
            const preview = head.slice(0, 16).toString('hex');
            const tail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
            const tried = attempts.filter(Boolean).map(a => a.name).join(' → ');
            const kind = describeNonArchive(head);
            const timedOut = err && (err.killed || /ETIMEDOUT|timed? ?out/i.test(String(err.message || '')));
            throw new Error(
                (kind ? `"${filename}" does not contain archive data — it looks like ${kind}. ` : '') +
                (timedOut ? `Extraction of ${filename} exceeded the ${Math.round(execTimeout / 1000)} s limit (ARCHIVE_EXTRACT_TIMEOUT_MAX_MS). ` : '') +
                `Extraction failed on ${filename} (size=${size}, first16=${preview}, detectedVia=${sourcedFrom}, tried=${tried}); last error (${attempt.name}): ${tail}`
            );
        }
        handler = used;

        // Persist mode hands these files to a sandboxed reader (uid 1000); the
        // archive's stored modes/owner may not grant it read/traversal, so
        // normalize before listing. Harmless to skip in legacy temp-dir mode
        // (the webapp reads everything itself, as root).
        // Walk BEFORE the chmod/chown so an escaping symlink is pruned first.
        const walked = await walkDir(extractDir);
        const files = walked.files;
        const extractedBytes = await totalBytesOf(files);
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
            // Zip-bomb / disk-exhaustion guard: throw the tree away rather
            // than leave gigabytes of junk in the workspace.
            const leftovers = await fs.promises.readdir(extractDir).catch(() => []);
            for (const name of leftovers) await rmrf(path.join(extractDir, name));
            throw new Error(`"${filename}" expanded to ${extractedBytes} bytes, over the ${MAX_EXTRACTED_BYTES}-byte extraction ceiling (ARCHIVE_MAX_EXTRACTED_BYTES). The output was discarded.`);
        }
        if (persistMode) await normalizeTreePermissions(extractDir);

        const truncated = files.length > maxEntries;
        const selected = truncated ? files.slice(0, maxEntries) : files;
        const topLevel = truncated ? summarizeTopLevel(files) : undefined;

        let totalTextBytes = 0;
        const entries = [];
        // Entries that are themselves password-protected archives. The reported
        // failure was exactly this shape (a plain zip wrapping an encrypted
        // zip): extraction "succeeds", the model then extracts the inner file
        // and hits a wall it has no way to explain to the user.
        const lockedEntries = [];
        for (const f of selected) {
            // In persist mode, expose a path relative to pathBase so the caller
            // can hand it directly to a sandboxed read_file (which is rooted at
            // the workspace mount). The legacy mode kept relative-to-extractDir.
            const relPath = persistMode
                ? path.relative(pathBase, f.fullPath).split(path.sep).join('/')
                : f.path;
            const entry = { path: relPath, size: f.size };
            if (/\.zip$/i.test(f.path) && await zipFileIsEncrypted(f.fullPath)) {
                entry.encrypted = true;
                lockedEntries.push(relPath);
            }
            if (inlineText && f.size <= maxTextPerEntry && totalTextBytes + f.size <= maxTotalText) {
                try {
                    const data = await fs.promises.readFile(f.fullPath);
                    if (isPrintableUtf8(data)) {
                        entry.text = data.toString('utf8');
                        totalTextBytes += data.length;
                    }
                } catch (_) { /* skip unreadable */ }
            } else if (persistMode && f.size <= maxTextPerEntry && totalTextBytes + f.size <= maxTotalText) {
                // Tiny preview only, so the model can sniff content type without
                // a follow-up read_file call for trivial files.
                try {
                    const data = await fs.promises.readFile(f.fullPath);
                    if (isPrintableUtf8(data)) {
                        const preview = data.slice(0, 240).toString('utf8');
                        if (preview.trim()) entry.preview = preview;
                        totalTextBytes += Math.min(data.length, 240);
                    }
                } catch (_) { /* skip */ }
            }
            entries.push(entry);
        }

        return {
            ok: true,
            archive: filename,
            format: handler.name,
            archiveBytes: size,
            entryCount: files.length,
            extractedBytes,
            entries,
            truncated,
            ...(topLevel ? { topLevel } : {}),
            ...(walked.capped ? { entryCountCapped: true } : {}),
            ...(walked.droppedSymlinks.length ? { droppedSymlinks: walked.droppedSymlinks } : {}),
            ...(lockedEntries.length ? { encryptedEntries: lockedEntries } : {}),
            ...(passwordWarning ? { partial: true, passwordProtected: true } : {}),
            note: [
                truncated ? `Listing shows the first ${maxEntries} of ${files.length}${walked.capped ? '+' : ''} files; \`topLevel\` summarizes every top-level directory (file count + bytes). Use list_directory / scan_source_files on a subdirectory to see the rest.` : '',
                walked.droppedSymlinks.length ? `${walked.droppedSymlinks.length} symlink(s) pointing outside the extraction directory were removed.` : '',
                passwordWarning || '',
                lockedEntries.length
                    ? `NOTE: ${lockedEntries.length === 1 ? 'this extracted entry is itself a password-protected zip' : 'these extracted entries are themselves password-protected zips'}: ${lockedEntries.slice(0, 5).join(', ')}. To read inside, call extract_archive again with path="<that entry>" AND the "password" argument — ask the user for the password if you do not have one (malware-sample archives are commonly locked with "infected").`
                    : '',
            ].filter(Boolean).join(' ') || undefined,
        };
    } finally {
        if (persistMode) {
            // Caller owns extractDir; only the staging dir for the source
            // bytes is ours to clean up.
            await rmrf(archiveStageDir);
        } else {
            await rmrf(workRoot);
        }
    }
}

module.exports = { extractArchive, pickHandler, execTimeoutFor, MAX_EXTRACTED_BYTES };
