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
    // gzip: 1F 8B — could be .gz or .tar.gz. We can't tell from the
    // outer magic; default to tar.gz since that's the overwhelming case
    // for multi-file archives, and tar will cleanly fail on a single
    // gzipped file (caller can retry as 'gz').
    if (buf[0] === 0x1F && buf[1] === 0x8B) return 'tar.gz';
    // bzip2: 42 5A 68 ("BZh") — same ambiguity as gzip
    if (buf[0] === 0x42 && buf[1] === 0x5A && buf[2] === 0x68) return 'tar.bz2';
    // xz: FD 37 7A 58 5A 00
    if (buf.slice(0, 6).equals(Buffer.from([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]))) return 'tar.xz';
    // tar: "ustar" at offset 257 (POSIX), or just a valid-looking tar
    // header — skip; we only hit this path when the extension also fails
    if (buf.length >= 263 && buf.slice(257, 262).toString('ascii') === 'ustar') return 'tar';
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
 * @param {object} opts - { maxEntries, maxTextBytesPerEntry, maxTotalTextBytes }
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
        // Extension and magic disagree — magic wins.
        handler = HANDLERS.find(h => h.name === sniffed);
        sourcedFrom = 'magic (extension mismatch)';
    }
    if (!handler) {
        const preview = buffer.slice(0, 16).toString('hex');
        throw new Error(
            `Cannot detect archive type. Filename "${filename}" extension is not recognized ` +
            `and the first 16 bytes (${preview}) don't match any known magic number. ` +
            `Supported: .zip, .7z, .rar, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .gz, .bz2, .xz. ` +
            `If this is a truncated base64 payload, ensure the full archive was passed.`
        );
    }

    const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    const maxTextPerEntry = opts.maxTextBytesPerEntry ?? MAX_TEXT_BYTES_PER_ENTRY;
    const maxTotalText = opts.maxTotalTextBytes ?? MAX_TOTAL_TEXT_BYTES;

    const workRoot = path.join(os.tmpdir(), `archive-extract-${crypto.randomBytes(8).toString('hex')}`);
    const extractDir = path.join(workRoot, 'out');
    const archivePath = path.join(workRoot, path.basename(filename) || 'archive.bin');
    await fs.promises.mkdir(extractDir, { recursive: true });
    await fs.promises.writeFile(archivePath, buffer);

    try {
        // Single-stream compressions (.gz / .bz2 / .xz of one file) — write
        // alongside archive, strip the outer suffix, and treat the result
        // as the sole entry.
        if (handler.single) {
            const binMap = { gz: 'gunzip', bz2: 'bunzip2', xz: 'xz' };
            const bin = binMap[handler.single];
            const args = handler.single === 'xz' ? ['-d', '-k', archivePath] : ['-k', archivePath];
            // gunzip/bunzip2/xz with -k (keep original) write foo.ext -> foo.
            await execFileP(bin, args, { timeout: EXEC_TIMEOUT_MS });
            const stripped = archivePath.replace(/\.(gz|bz2|xz)$/i, '');
            if (!fs.existsSync(stripped)) {
                throw new Error(`Decompression produced no output (expected ${stripped})`);
            }
            const dest = path.join(extractDir, path.basename(stripped));
            await fs.promises.rename(stripped, dest);
        } else {
            const [bin, tmpl] = handler.cmd;
            const args = tmpl.map(a => a
                .replace('__FILE__', archivePath)
                .replace('__DIR__', extractDir));
            try {
                await execFileP(bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
            } catch (e) {
                // Surface the tool's stderr plus the leading bytes so the
                // caller can tell apart "file isn't what the extension
                // says" from "base64 got truncated in transit".
                const preview = buffer.slice(0, 16).toString('hex');
                const tail = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').slice(-3).join(' ');
                throw new Error(
                    `${bin} failed on ${filename} (size=${buffer.length}, first16=${preview}, detectedVia=${sourcedFrom}): ${tail}`
                );
            }
        }

        const files = await walkDir(extractDir);
        const truncated = files.length > maxEntries;
        const selected = truncated ? files.slice(0, maxEntries) : files;

        let totalTextBytes = 0;
        const entries = [];
        for (const f of selected) {
            const entry = { path: f.path, size: f.size };
            if (f.size <= maxTextPerEntry && totalTextBytes + f.size <= maxTotalText) {
                try {
                    const data = await fs.promises.readFile(f.fullPath);
                    if (isPrintableUtf8(data)) {
                        entry.text = data.toString('utf8');
                        totalTextBytes += data.length;
                    }
                } catch (_) { /* skip unreadable */ }
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
        await rmrf(workRoot);
    }
}

module.exports = { extractArchive, pickHandler };
