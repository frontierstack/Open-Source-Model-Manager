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
const { promisify } = require('util');

const execFileP = promisify(execFile);

const EXEC_TIMEOUT_MS = 60_000;
const MAX_ENTRIES = 500;
const MAX_TEXT_BYTES_PER_ENTRY = 200_000; // 200KB
const MAX_TOTAL_TEXT_BYTES = 2_000_000;   // 2MB across all entries

// Extension → handler. Tested in order; the first whose `matches` returns
// true wins. Multi-part suffixes (.tar.gz) live before single (.gz).
const HANDLERS = [
    { name: 'tar.gz',  matches: (n) => /\.(tar\.gz|tgz)$/i.test(n),  cmd: ['tar', ['-xzf', '__FILE__', '-C', '__DIR__']] },
    { name: 'tar.bz2', matches: (n) => /\.(tar\.bz2|tbz2?)$/i.test(n), cmd: ['tar', ['-xjf', '__FILE__', '-C', '__DIR__']] },
    { name: 'tar.xz',  matches: (n) => /\.(tar\.xz|txz)$/i.test(n),  cmd: ['tar', ['-xJf', '__FILE__', '-C', '__DIR__']] },
    { name: 'tar',     matches: (n) => /\.tar$/i.test(n),            cmd: ['tar', ['-xf',  '__FILE__', '-C', '__DIR__']] },
    { name: 'zip',     matches: (n) => /\.zip$/i.test(n),            cmd: ['unzip', ['-qq', '-o', '__FILE__', '-d', '__DIR__']] },
    { name: '7z',      matches: (n) => /\.7z$/i.test(n),             cmd: ['7z', ['x', '-y', '-bd', '-o__DIR__', '__FILE__']] },
    { name: 'rar',     matches: (n) => /\.rar$/i.test(n),            cmd: ['unrar-free', ['-x', '__FILE__', '__DIR__/']] },
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

async function walkDir(root, relBase = '') {
    const out = [];
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const ent of entries) {
        const full = path.join(root, ent.name);
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
            const child = await walkDir(full, rel);
            out.push(...child);
        } else if (ent.isFile()) {
            const stat = await fs.promises.stat(full);
            out.push({ path: rel, size: stat.size, fullPath: full });
        }
        if (out.length > MAX_ENTRIES) break;
    }
    return out;
}

async function rmrf(dir) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); }
    catch (_) { /* best effort */ }
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
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('extractArchive: non-empty Buffer required');
    }
    // Try the extension first, then fall back to magic-byte sniffing.
    // If both agree, we use the extension handler. If they disagree,
    // trust the magic — renamed/mislabeled archives are common and the
    // user's intent is "extract this, whatever it is".
    const extHandler = pickHandler(filename);
    const sniffed = sniffFormat(buffer);
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
        const preview = buffer.slice(0, 16).toString('hex');
        const kind = describeNonArchive(buffer);
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
    await fs.promises.writeFile(archivePath, buffer);
    const pathBase = opts.pathBase || extractDir;

    try {
        // Run the attempt chain: first handler that extracts cleanly wins.
        // Between attempts the output dir is emptied so a half-extracted
        // failure doesn't pollute the next attempt's listing.
        let lastErr = null;
        let used = null;
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
                    await execFileP(bin, args, { timeout: EXEC_TIMEOUT_MS });
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
                        await execFileP('tar', ['-xf', stripped, '-C', extractDir], { timeout: EXEC_TIMEOUT_MS });
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
                    await execFileP(bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
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
            }
        }
        if (lastErr || !used) {
            // Surface the tool's stderr plus the leading bytes so the caller
            // can tell apart "file isn't what the extension says" from
            // "base64 got truncated in transit".
            const { attempt, err } = lastErr;
            const preview = buffer.slice(0, 16).toString('hex');
            const tail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
            const tried = attempts.filter(Boolean).map(a => a.name).join(' → ');
            const kind = describeNonArchive(buffer);
            throw new Error(
                (kind ? `"${filename}" does not contain archive data — it looks like ${kind}. ` : '') +
                `Extraction failed on ${filename} (size=${buffer.length}, first16=${preview}, detectedVia=${sourcedFrom}, tried=${tried}); last error (${attempt.name}): ${tail}`
            );
        }
        handler = used;

        const files = await walkDir(extractDir);
        const truncated = files.length > maxEntries;
        const selected = truncated ? files.slice(0, maxEntries) : files;

        let totalTextBytes = 0;
        const entries = [];
        for (const f of selected) {
            // In persist mode, expose a path relative to pathBase so the caller
            // can hand it directly to a sandboxed read_file (which is rooted at
            // the workspace mount). The legacy mode kept relative-to-extractDir.
            const relPath = persistMode
                ? path.relative(pathBase, f.fullPath).split(path.sep).join('/')
                : f.path;
            const entry = { path: relPath, size: f.size };
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
            entryCount: files.length,
            entries,
            truncated,
            note: truncated
                ? `Listing truncated at ${maxEntries} of ${files.length} entries.`
                : undefined,
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

module.exports = { extractArchive, pickHandler };
