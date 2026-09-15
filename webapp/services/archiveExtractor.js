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

// ---------------------------------------------------------------------------
// Formats
//
// Every multi-file format carries an ordered list of STRATEGIES (one per tool
// that can open it). They are tried in order, skipping tools not installed in
// this image, so a format never depends on a single extractor: 7-Zip here is
// the Debian dfsg build (no RAR codec), unzip cannot read AES/zipx methods,
// cabextract cannot read InstallShield cabs, GNU tar has no lz4/brotli, etc.
//
// Strategy fields: `bin`, `args` (tokens __FILE__ / __DIR__), optional `pw`
// (builds password switches, spliced at index 1 — after a subcommand like
// `7z x`, before the archive name, where unzip/unrar/arj treat trailing args
// as member selectors), optional `cwd` (tools that extract into the working
// directory: ar, cpio), or `run` (a custom async step).
//
// `pw` is called with '' when no password was given — 7z NEEDS the bare `-p`
// then so it fails fast with "Wrong password?" instead of the opaque "Break
// signaled" it emits when its prompt hits a closed stdin.
// ---------------------------------------------------------------------------

const S7Z = { bin: '7z', args: ['x', '-y', '-bd', '-o__DIR__', '__FILE__'], pw: (p) => [`-p${p}`] };
const BSDTAR = { bin: 'bsdtar', args: ['-x', '-f', '__FILE__', '-C', '__DIR__'], pw: (p) => (p ? ['--passphrase', p] : []) };
// unar (The Unarchiver): widest legacy coverage (RAR5, StuffIt, ACE, ARC, ZOO,
// ALZ, EGG, CPT…). -D: never invent a wrapping directory; -f: overwrite.
const UNAR = { bin: 'unar', args: ['-q', '-f', '-D', '-o', '__DIR__', '__FILE__'], pw: (p) => (p ? ['-p', p] : []) };
const TAR_AUTO = { bin: 'tar', args: ['-xf', '__FILE__', '-C', '__DIR__'] }; // GNU tar sniffs gz/bz2/xz/lzma/zst/lz/lzo/Z itself

// Single-stream compressors: decompress to stdout (never in place — the
// decompressors disagree about suffixes and -k support). 7z's `e -so` is the
// fallback wherever it knows the codec.
const CODECS = {
    gz:   { cmds: [['gzip', ['-dc']], ['7z', ['e', '-so', '-tgzip']]], suffix: /\.(gz|gzip)$/i },
    bz2:  { cmds: [['bzip2', ['-dc']], ['7z', ['e', '-so', '-tbzip2']]], suffix: /\.(bz2|bzip2|bz)$/i },
    xz:   { cmds: [['xz', ['-dc']], ['7z', ['e', '-so', '-txz']]], suffix: /\.xz$/i },
    lzma: { cmds: [['xz', ['--format=lzma', '-dc']], ['7z', ['e', '-so', '-tlzma']]], suffix: /\.lzma$/i },
    zst:  { cmds: [['zstd', ['-dcq']], ['7z', ['e', '-so', '-tzstd']]], suffix: /\.(zst|zstd)$/i },
    lz4:  { cmds: [['lz4', ['-dcq']]], suffix: /\.lz4$/i },
    lz:   { cmds: [['lzip', ['-dc']]], suffix: /\.lz$/i },
    lzo:  { cmds: [['lzop', ['-dc']]], suffix: /\.lzo$/i },
    br:   { cmds: [['brotli', ['-dc']]], suffix: /\.(br|brotli)$/i },
    Z:    { cmds: [['gzip', ['-dc']], ['uncompress', ['-c']], ['7z', ['e', '-so', '-tZ']]], suffix: /\.z$/i },
};

// Tested in order; the first whose `ext` matches the filename wins, so
// multi-part suffixes (.tar.zst) sit before single ones (.zst).
const HANDLERS = [
    { name: 'tar.gz',   ext: /\.(tar\.gz|tgz|tpz|taz\.gz)$/i, strategies: [{ bin: 'tar', args: ['-xzf', '__FILE__', '-C', '__DIR__'] }, BSDTAR] },
    { name: 'tar.bz2',  ext: /\.(tar\.bz2|tbz2?|tb2)$/i,     strategies: [{ bin: 'tar', args: ['-xjf', '__FILE__', '-C', '__DIR__'] }, BSDTAR] },
    { name: 'tar.xz',   ext: /\.(tar\.xz|txz)$/i,            strategies: [{ bin: 'tar', args: ['-xJf', '__FILE__', '-C', '__DIR__'] }, BSDTAR] },
    { name: 'tar.zst',  ext: /\.(tar\.zst|tar\.zstd|tzst)$/i, strategies: [TAR_AUTO, BSDTAR] },
    { name: 'tar.lzma', ext: /\.(tar\.lzma|tlzma)$/i,        strategies: [TAR_AUTO, BSDTAR] },
    { name: 'tar.lz',   ext: /\.(tar\.lz|tlz)$/i,            strategies: [TAR_AUTO, BSDTAR] },
    { name: 'tar.lzo',  ext: /\.(tar\.lzo|tzo)$/i,           strategies: [TAR_AUTO, BSDTAR] },
    { name: 'tar.lz4',  ext: /\.(tar\.lz4|tlz4)$/i,          strategies: [BSDTAR] },
    { name: 'tar.Z',    ext: /\.(tar\.z|taz)$/i,             strategies: [TAR_AUTO, BSDTAR] },
    { name: 'tar.br',   ext: /\.(tar\.br|tbr)$/i,            single: 'br' },
    { name: 'tar',      ext: /\.(tar|ova)$/i,                strategies: [{ bin: 'tar', args: ['-xf', '__FILE__', '-C', '__DIR__'] }, BSDTAR, S7Z] },
    // zip and the formats that ARE zips under another name. 7z/bsdtar/unar
    // follow unzip for AES encryption and zipx methods (LZMA/PPMd/xz) that
    // unzip 6.0 reports as "unsupported compression method".
    { name: 'zip',      ext: /\.(zip|jar|war|ear|aar|apk|xapk|xpi|whl|nupkg|vsix|epub|ipa|appx|appxbundle|msix|msixbundle|kmz|sb3|ora)$/i,
        strategies: [{ bin: 'unzip', args: ['-qq', '-o', '__FILE__', '-d', '__DIR__'], pw: (p) => (p ? ['-P', p] : []) }, S7Z, BSDTAR, UNAR] },
    { name: 'zipx',     ext: /\.zipx$/i,                     strategies: [S7Z, UNAR, BSDTAR] },
    { name: '7z',       ext: /\.7z$/i,                       strategies: [S7Z, UNAR, BSDTAR] },
    { name: 'rar',      ext: /\.(rar|cbr)$/i,
        strategies: [UNAR, { bin: 'unrar-free', args: ['-x', '__FILE__', '__DIR__/'], pw: (p) => (p ? ['-p', p] : []) }, BSDTAR, S7Z] },
    // Microsoft Cabinet (+ .msu Windows update packages, which are cabs).
    // cabextract (libmspack) handles MSZIP, Quantum and LZX.
    { name: 'cab',      ext: /\.(cab|msu)$/i,
        strategies: [{ bin: 'cabextract', args: ['-q', '-d', '__DIR__', '__FILE__'] }, S7Z, BSDTAR, UNAR] },
    // InstallShield cabinets share the extension but not the format ("ISc(").
    { name: 'installshield-cab', ext: null,                  strategies: [{ bin: 'unshield', args: ['-d', '__DIR__', 'x', '__FILE__'] }, UNAR] },
    // MS-DOS compress.exe / expand.exe (SZDD / KWAJ): setup.ex_, driver.sy_.
    { name: 'mslz',     ext: /\.[a-z0-9]{2}_$/i,             strategies: [S7Z, { bin: 'cabextract', args: ['-q', '-d', '__DIR__', '__FILE__'] }, UNAR] },
    { name: 'msi',      ext: /\.(msi|msp|msm)$/i,            strategies: [{ bin: 'msiextract', args: ['-C', '__DIR__', '__FILE__'] }, S7Z] },
    { name: 'deb',      ext: /\.(deb|udeb|ipk)$/i,           strategies: [{ bin: 'ar', args: ['x', '__FILE__'], cwd: true }, BSDTAR, S7Z], unwrap: 'deb' },
    { name: 'ar',       ext: /\.(ar|a|lib)$/i,               strategies: [{ bin: 'ar', args: ['x', '__FILE__'], cwd: true }, BSDTAR, S7Z] },
    { name: 'rpm',      ext: /\.(rpm|srpm)$/i,               strategies: [BSDTAR, { run: rpm2cpioStep, bin: 'rpm2cpio' }, S7Z], unwrap: 'payload' },
    { name: 'cpio',     ext: /\.cpio$/i,
        strategies: [BSDTAR, { bin: 'cpio', args: ['-idmu', '--no-absolute-filenames', '--quiet', '-F', '__FILE__'], cwd: true }, S7Z] },
    { name: 'xar',      ext: /\.(xar|pkg|mpkg|xip)$/i,       strategies: [S7Z, BSDTAR, UNAR], unwrap: 'payload' },
    { name: 'iso',      ext: /\.(iso|udf|isz)$/i,            strategies: [S7Z, BSDTAR, UNAR] },
    { name: 'dmg',      ext: /\.(dmg|hfs|hfsx|apfs)$/i,      strategies: [S7Z] },
    { name: 'wim',      ext: /\.(wim|swm|esd)$/i,            strategies: [S7Z] },
    { name: 'chm',      ext: /\.(chm|chi|chw|chq|lit|hxs)$/i, strategies: [S7Z, UNAR] },
    { name: 'arj',      ext: /\.arj$/i,
        strategies: [S7Z, { bin: 'arj', args: ['x', '-y', '__FILE__', '__DIR__/'], pw: (p) => (p ? [`-g${p}`] : []) }, UNAR] },
    { name: 'lzh',      ext: /\.(lzh|lha)$/i,                strategies: [S7Z, { bin: 'lha', args: ['-xqfw=__DIR__', '__FILE__'] }, UNAR] },
    { name: 'squashfs', ext: /\.(squashfs|sqsh|sfs|snap)$/i,
        strategies: [S7Z, { bin: 'unsquashfs', args: ['-f', '-no-xattrs', '-d', '__DIR__', '__FILE__'] }] },
    { name: 'cramfs',   ext: /\.cramfs$/i,                   strategies: [S7Z] },
    { name: 'disk-image', ext: /\.(vhd|vhdx|avhdx|vmdk|vdi|qcow2?|img|simg)$/i, strategies: [S7Z] },
    { name: 'nsis',     ext: null,                           strategies: [S7Z] },
    // Legacy / Mac / DOS formats only The Unarchiver reads.
    { name: 'unar',     ext: /\.(sit|sitx|sea|cpt|arc|ark|zoo|alz|egg|ace|pit|lbr|hqx|pak|dms|adf)$/i, strategies: [UNAR, S7Z, BSDTAR] },
    // Single-stream compressors (inner tar is detected and unpacked).
    { name: 'gz',       ext: /\.(gz|gzip)$/i,                single: 'gz' },
    { name: 'bz2',      ext: /\.(bz2|bzip2)$/i,              single: 'bz2' },
    { name: 'xz',       ext: /\.xz$/i,                       single: 'xz' },
    { name: 'lzma',     ext: /\.lzma$/i,                     single: 'lzma' },
    { name: 'zst',      ext: /\.(zst|zstd)$/i,               single: 'zst' },
    { name: 'lz4',      ext: /\.lz4$/i,                      single: 'lz4' },
    { name: 'lz',       ext: /\.lz$/i,                       single: 'lz' },
    { name: 'lzo',      ext: /\.lzo$/i,                      single: 'lzo' },
    { name: 'br',       ext: /\.(br|brotli)$/i,              single: 'br' },
    { name: 'Z',        ext: /\.z$/i,                        single: 'Z' },
];
const HANDLER_BY_NAME = new Map(HANDLERS.map(h => [h.name, h]));
for (const h of HANDLERS) h.matches = (n) => !!h.ext && h.ext.test(n);

// Compressed-tar ↔ bare-stream siblings: the outer magic of a bz2/xz/zst
// stream cannot say whether a tar is inside, so each falls back to the other.
const FALLBACK = {
    'tar.gz': 'gz', 'tar.bz2': 'bz2', 'tar.xz': 'xz', 'tar.zst': 'zst', 'tar.lzma': 'lzma',
    'tar.lz': 'lz', 'tar.lzo': 'lzo', 'tar.lz4': 'lz4', 'tar.Z': 'Z',
    gz: 'tar.gz', bz2: 'tar.bz2', xz: 'tar.xz',
};

// Human list for errors and the tool description.
const SUPPORTED_FORMATS_TEXT =
    'zip (+ jar/war/apk/whl/nupkg/vsix/epub/ipa/appx/msix), zipx, 7z, rar, cab/msu (MSZIP, LZX, Quantum), InstallShield cab, ' +
    'MS-DOS SZDD compressed files (setup.ex_), msi/msp, tar and every compressed tar (tar.gz/tgz, tar.bz2, tar.xz, tar.zst, tar.lz4, tar.lz, tar.lzma, tar.lzo, tar.Z, tar.br), ' +
    'single-file gz, bz2, xz, lzma, zst, lz4, lz, lzo, br, Z, deb/ipk, rpm, cpio, ar, xar/pkg, iso/udf, dmg, wim/esd, chm, arj, lzh/lha, ' +
    'squashfs/snap, cramfs, disk images (vhd/vhdx/vmdk/vdi/qcow2/img), NSIS / 7z / RAR self-extracting .exe, Inno Setup installers, ' +
    'and StuffIt/ACE/ARC/ZOO/ALZ/EGG';

// Extensions that mean "this upload/workspace file is an archive the user
// wants opened" — the dedicated archive + compression formats. Packaging
// formats that happen to be zips (jar/apk/docx), disk images and executables
// still extract when asked, but are not auto-treated as archives on upload.
const ARCHIVE_EXT_RE = /\.(zip|zipx|7z|rar|cab|msu|msi|tar|tgz|tbz2?|txz|tzst|tlz|taz|gz|gzip|bz2|xz|lzma|zst|zstd|lz4|lz|lzo|br|z|deb|udeb|rpm|cpio|xar|pkg|iso|dmg|wim|esd|swm|arj|lzh|lha|squashfs|sit|sitx|ace|arc|zoo|alz|egg|cbr|cbz|chm)$/i;

// Strip any recognised archive/compression suffix (for legible output dirs).
function stripArchiveExt(name) {
    let s = String(name || '');
    for (let i = 0; i < 2; i++) {
        const next = s.replace(/\.(tar\.[a-z0-9]+|tgz|tbz2?|txz|tzst|tlz4?|tlzma|tzo|taz|tbr|zipx?|7z|rar|cab|msu|msi|msp|msm|tar|gz|gzip|bz2|bzip2|xz|lzma|zstd?|lz4|lz|lzo|br|z|deb|udeb|ipk|rpm|srpm|cpio|xar|pkg|mpkg|xip|iso|udf|dmg|wim|esd|swm|arj|lzh|lha|squashfs|sqsh|snap|cramfs|sitx?|sea|ace|arc|zoo|alz|egg|cbr|cbz|chm|jar|war|ear|apk|whl|nupkg|vsix|epub|ipa|appx|msix)$/i, '');
        if (next === s) break;
        s = next;
    }
    return s;
}

function pickHandler(filename) {
    const n = (filename || '').toLowerCase();
    return HANDLERS.find(h => h.matches(n)) || null;
}

// Is a binary on PATH? Positive answers are cached; a negative is re-checked
// (cheap) so a tool installed into a running container is picked up.
const _binCache = new Map();
function hasBin(bin) {
    if (_binCache.get(bin)) return true;
    for (const dir of String(process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(':')) {
        if (!dir) continue;
        try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); _binCache.set(bin, true); return true; }
        catch (_) { /* keep looking */ }
    }
    return false;
}

// Stream a decompressor's stdout into a file. Byte-counted so a
// decompression bomb is killed at the extraction ceiling instead of filling
// the disk first. Rejects with {code, stderr, killed} like execFileP.
function decompressToFile(bin, args, outPath, { timeout, maxBytes } = {}) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = fs.createWriteStream(outPath);
        let stderr = '', bytes = 0, killedFor = null, settled = false;
        const timer = timeout ? setTimeout(() => { killedFor = 'timeout'; child.kill('SIGKILL'); }, timeout) : null;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (err) { out.destroy(); reject(err); } else resolve({ bytes });
        };
        child.stdout.on('data', (chunk) => {
            bytes += chunk.length;
            if (maxBytes && bytes > maxBytes && !killedFor) { killedFor = 'size'; child.kill('SIGKILL'); }
        });
        child.stdout.pipe(out);
        child.stderr.on('data', (d) => { if (stderr.length < 8000) stderr += d.toString(); });
        child.on('error', (e) => finish(e));
        child.on('close', (code) => {
            out.end(() => {
                if (killedFor === 'size') {
                    const e = new Error(`decompressed stream exceeded the ${maxBytes}-byte extraction ceiling (ARCHIVE_MAX_EXTRACTED_BYTES)`);
                    e.sizeExceeded = true; return finish(e);
                }
                if (killedFor === 'timeout') { const e = new Error(`${bin} timed out`); e.killed = true; e.stderr = stderr; return finish(e); }
                if (code !== 0) { const e = new Error(`${bin} exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`); e.code = code; e.stderr = stderr; return finish(e); }
                finish(null);
            });
        });
    });
}

// rpm → cpio payload → files, for images without bsdtar.
async function rpm2cpioStep(file, dir, { timeout, maxBytes }) {
    const payload = path.join(path.dirname(file), `${path.basename(file)}.cpio`);
    await decompressToFile('rpm2cpio', [file], payload, { timeout, maxBytes });
    try {
        await execFileP('cpio', ['-idmu', '--no-absolute-filenames', '--quiet', '-F', payload], { cwd: dir, timeout });
    } finally { await rmrf(payload); }
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

// 7-Zip "Type = …" values that are NOT archives: extracting them yields
// executable sections or decoded text, never the files a user means.
const NON_ARCHIVE_7Z_TYPES = new Set(['PE', 'ELF', 'MachO', 'Mub', 'COFF', 'TE', 'Base64', 'IHex', 'Hash', 'FLV', 'SWF', 'SWFc', 'Ppmd']);

// Unknown extension + unknown magic: let the broad-coverage tools identify
// it. Returns a synthetic handler or null.
async function probeUnknownFormat(sourcePath, buffer, filename) {
    let file = sourcePath, tmp = null;
    try {
        if (!file) {
            tmp = path.join(os.tmpdir(), `archive-probe-${crypto.randomBytes(6).toString('hex')}-${path.basename(filename || 'file')}`);
            await fs.promises.writeFile(tmp, buffer);
            file = tmp;
        }
        let type = null;
        if (hasBin('7z')) {
            // Bare -p: an encrypted-header 7z must fail fast, not prompt.
            const r = await execFileP('7z', ['l', '-slt', '-p', file], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }).catch(e => e);
            const m = String(r?.stdout || '').match(/^Type = (.+)$/m);
            type = m ? m[1].trim() : null;
        }
        if (type && !NON_ARCHIVE_7Z_TYPES.has(type)) {
            return { name: `7z:${type.toLowerCase()}`, probedType: type, strategies: [S7Z, UNAR, BSDTAR] };
        }
        if (type === 'PE') {
            // A plain Windows executable: only an installer format 7-Zip does
            // not recognise is still worth trying (Inno Setup; unar knows a few more).
            return {
                name: 'windows-installer', probedType: 'PE executable', nonArchiveHint: 'a Windows executable',
                strategies: [{ bin: 'innoextract', args: ['-e', '-q', '-d', '__DIR__', '__FILE__'], pw: (p) => (p ? ['--password', p] : []) }, UNAR],
            };
        }
        if (type) return null;
        if (hasBin('lsar')) {
            const ok = await execFileP('lsar', [file], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).then(() => true).catch(() => false);
            if (ok) return { name: 'unar', probedType: 'lsar', strategies: [UNAR, BSDTAR] };
        }
        return null;
    } finally {
        if (tmp) await rmrf(tmp);
    }
}

// Unpack archive members of a package in place. `deb`: control.tar.* and
// data.tar.* → control/ and data/. `payload`: a compressed cpio/tar payload
// (7-Zip's view of an rpm, a xar/pkg component's Payload/Scripts) → a
// directory beside it, or the root when it is the only thing extracted.
// Returns the list of unpacked member paths.
async function unwrapContainer(kind, extractDir, opts) {
    const done = [];
    const candidates = [];
    async function scan(dir, rel, depth) {
        const ents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const ent of ents) {
            const full = path.join(dir, ent.name);
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory() && kind === 'payload' && depth < 3) await scan(full, r, depth + 1);
            else if (ent.isFile()) candidates.push({ full, rel: r, name: ent.name, depth });
        }
    }
    await scan(extractDir, '', 0);
    const topLevel = candidates.filter(c => c.depth === 0);
    for (const c of candidates) {
        let target = null;
        if (kind === 'deb') {
            const m = c.depth === 0 && c.name.match(/^(data|control)\.tar(\.[a-z0-9]+)?$/i);
            if (m) target = path.join(extractDir, m[1].toLowerCase());
        } else {
            if (!/(^Payload$|^Scripts$|\.cpio(\.[a-z0-9]+)?$|\.tar(\.[a-z0-9]+)?$)/i.test(c.name)) continue;
            const head = Buffer.alloc(4096);
            const fd = await fs.promises.open(c.full, 'r').catch(() => null);
            if (!fd) continue;
            try { await fd.read(head, 0, head.length, 0); } finally { await fd.close(); }
            const fmt = sniffStrong(head);
            if (!fmt || !/^(cpio|tar|tar\.\w+|gz|bz2|xz|zst|lzma|lz4|lz|Z)$/.test(fmt)) continue;
            const stem = c.name.replace(/(\.cpio|\.tar)?(\.[a-z0-9]+)?$/i, '') || c.name;
            target = (c.depth === 0 && topLevel.length === 1)
                ? path.join(extractDir, `.unwrap-${crypto.randomBytes(4).toString('hex')}`)
                : path.join(path.dirname(c.full), c.name === stem ? `${stem}.d` : stem);
        }
        if (!target) continue;
        try {
            await fs.promises.mkdir(target, { recursive: true });
            await extractArchive(null, c.name, {
                sourcePath: c.full, extractTo: target, pathBase: target,
                inlineText: false, maxEntries: 1, _depth: (opts._depth || 0) + 1,
            });
            await rmrf(c.full);
            if (path.basename(target).startsWith('.unwrap-')) {
                for (const n of await fs.promises.readdir(target)) {
                    await fs.promises.rename(path.join(target, n), path.join(extractDir, n)).catch(() => {});
                }
                await rmrf(target);
            }
            done.push(c.rel);
        } catch (_) {
            if (path.basename(target).startsWith('.unwrap-')) await rmrf(target);
            /* leave the member as-is */
        }
    }
    return done;
}

// Stage the other parts of a multi-volume archive next to the staged first
// part (hardlinks, copy fallback). Bounded: ≤ 200 parts from the SAME
// directory, matched by name pattern — never a directory-wide copy, except a
// chained cabinet, whose next-part names live in its header (all .cab files
// in the directory, ≤ 64).
async function stageVolumeSiblings(sourcePath, archivePath, head) {
    const base = path.basename(sourcePath);
    if (base !== path.basename(archivePath)) return { multiVolume: false, staged: [] };
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re = null, m;
    if ((m = base.match(/^(.*)\.part0*1\.rar$/i))) re = new RegExp(`^${esc(m[1])}\\.part\\d+\\.rar$`, 'i');
    else if ((m = base.match(/^(.*)\.rar$/i))) re = new RegExp(`^${esc(m[1])}\\.(r\\d{2}|s\\d{2})$`, 'i');
    else if ((m = base.match(/^(.*)\.0{1,3}1$/))) re = new RegExp(`^${esc(m[1])}\\.\\d{2,4}$`);
    else if ((m = base.match(/^(.*)\.zip$/i))) re = new RegExp(`^${esc(m[1])}\\.z\\d{2}$`, 'i');
    else if (asciiAt(head, 0, 'MSCF') && head.length >= 32 && (head.readUInt16LE(30) & 0x0002)) re = /\.cab$/i;
    // RAR 4 main header: type 0x73 at offset 9, flag 0x0001 = "volume".
    const rar4Volume = head.length >= 12 && asciiAt(head, 0, 'Rar!\x1a\x07\x00') && head[9] === 0x73 && (head.readUInt16LE(10) & 0x0001);
    let multiVolume = !!(re && (/\.part0*1\.rar$|\.0{1,3}1$/i.test(base) || re.source === '\\.cab$' || rar4Volume));
    if (!re) return { multiVolume: false, staged: [] };
    const dir = path.dirname(sourcePath);
    const names = (await fs.promises.readdir(dir).catch(() => [])).filter(n => n !== base && re.test(n));
    const cap = re.source === '\\.cab$' ? 64 : 200;
    const staged = [];
    for (const n of names.slice(0, cap)) {
        const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
        if (!st || !st.isFile()) continue;
        const dest = path.join(path.dirname(archivePath), n);
        try { await fs.promises.link(path.join(dir, n), dest); }
        catch (_) { await fs.promises.copyFile(path.join(dir, n), dest).catch(() => {}); }
        staged.push(n);
    }
    if (staged.length) multiVolume = true;
    return { multiVolume, staged };
}

// Sniff the archive format from the leading bytes. Protects against
// files whose extension lies (a .7z that's actually a zip, a renamed
// tarball, etc.) — we trust the magic over the extension when they
// disagree. Returns a handler name matching HANDLERS[].name, or null.
const bytesAt = (buf, off, arr) => buf.length >= off + arr.length && arr.every((b, i) => buf[off + i] === b);
const asciiAt = (buf, off, s) => buf.length >= off + s.length && buf.subarray(off, off + s.length).toString('latin1') === s;
// Magics too short to trust against an extension that says otherwise.
const WEAK_SNIFFS = new Set(['arj', 'lzh', 'cpio', 'mslz', 'lzma']);

function sniffFormat(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    const strong = sniffStrong(buf);
    if (strong) return strong;
    // Formats whose magic sits beyond the first bytes or is short/weak.
    if (asciiAt(buf, 32769, 'CD001') || asciiAt(buf, 34817, 'CD001') || asciiAt(buf, 32769, 'BEA01')) return 'iso';
    if (buf.length >= 22 && asciiAt(buf, 2, '-lh') && buf[6] === 0x2D) return 'lzh';
    if (bytesAt(buf, 0, [0x60, 0xEA])) return 'arj';
    if (bytesAt(buf, 0, [0xC7, 0x71]) || bytesAt(buf, 0, [0x71, 0xC7])) return 'cpio';
    if (buf.length >= 13 && buf[0] === 0x5D && buf[1] === 0x00 && buf[2] === 0x00) return 'lzma';
    return null;
}

function sniffStrong(buf) {
    if (asciiAt(buf, 0, 'MSCF') && bytesAt(buf, 4, [0, 0, 0, 0])) return 'cab';
    if (asciiAt(buf, 0, 'ISc(')) return 'installshield-cab';
    if (bytesAt(buf, 0, [0x53, 0x5A, 0x44, 0x44, 0x88, 0xF0, 0x27, 0x33]) ||   // SZDD
        bytesAt(buf, 0, [0x4B, 0x57, 0x41, 0x4A, 0x88, 0xF0, 0x27, 0xD1])) return 'mslz'; // KWAJ
    if (bytesAt(buf, 0, [0x28, 0xB5, 0x2F, 0xFD])) return 'zst';
    if (bytesAt(buf, 0, [0x04, 0x22, 0x4D, 0x18]) || bytesAt(buf, 0, [0x02, 0x21, 0x4C, 0x18])) return 'lz4';
    if (asciiAt(buf, 0, 'LZIP')) return 'lz';
    if (bytesAt(buf, 0, [0x89, 0x4C, 0x5A, 0x4F, 0x00, 0x0D, 0x0A, 0x1A, 0x0A])) return 'lzo';
    if (bytesAt(buf, 0, [0x1F, 0x9D])) return 'Z';
    if (asciiAt(buf, 0, '!<arch>\n')) return asciiAt(buf, 8, 'debian-binary') ? 'deb' : 'ar';
    if (bytesAt(buf, 0, [0xED, 0xAB, 0xEE, 0xDB])) return 'rpm';
    if (asciiAt(buf, 0, '070701') || asciiAt(buf, 0, '070702') || asciiAt(buf, 0, '070707')) return 'cpio';
    if (asciiAt(buf, 0, 'xar!')) return 'xar';
    if (asciiAt(buf, 0, 'MSWIM\0\0\0')) return 'wim';
    if (asciiAt(buf, 0, 'ITSF')) return 'chm';
    if (asciiAt(buf, 0, 'hsqs') || asciiAt(buf, 0, 'sqsh')) return 'squashfs';
    if (bytesAt(buf, 0, [0x45, 0x3D, 0xCD, 0x28])) return 'cramfs';
    if (asciiAt(buf, 0, 'SIT!') || asciiAt(buf, 0, 'StuffIt') || asciiAt(buf, 10, 'rLau')) return 'unar';
    if (asciiAt(buf, 7, '**ACE**') || asciiAt(buf, 0, 'ALZ\x01') || asciiAt(buf, 0, 'EGGA') || asciiAt(buf, 20, '\xDC\xA7\xC4\xFD')) return 'unar';
    return sniffClassic(buf);
}

function sniffClassic(buf) {
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

const PASSWORD_ERROR_RE = /unable to get password|incorrect password|wrong password|bad password|cannot open encrypted|encrypted archive|password is incorrect|need password|password required|requires a password|missing password|passphrase required|incorrect passphrase|wrong passphrase/i;

// Does this extractor failure mean "the archive is encrypted and we don't have
// the right password"? unzip is the tricky one: a wrong -P password exits 82
// with NO output at all, so the exit code has to carry the verdict.
function isPasswordFailure(err, tool, encInfo) {
    const text = `${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`;
    if (PASSWORD_ERROR_RE.test(text)) return true;
    // unzip exit 82 = "nothing extracted". Only a password verdict when the
    // central directory actually says entries are encrypted — otherwise 82 is
    // an ordinary empty/filtered archive and must keep its own error.
    if (tool === 'unzip' && err?.code === 82 && encInfo?.encrypted > 0) return true;
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
    const family = (n) => n.startsWith('tar.') ? n.slice(4) : n;
    if (!handler && sniffed) {
        handler = HANDLER_BY_NAME.get(sniffed);
        sourcedFrom = 'magic';
    } else if (handler && sniffed && handler.name !== sniffed) {
        // Extension and magic disagree. Within the same compression family
        // (xz↔tar.xz, zst↔tar.zst) the magic side is a blind GUESS (we can't
        // peek inside the stream), while the extension is an informed claim —
        // keep the extension. gzip is the exception: sniffGzipInner positively
        // identified the inner content, so its verdict wins. A weak (1-3 byte)
        // magic never overrides an extension. Any other cross-family mismatch
        // (a .tgz that's really a zip, an .apk that's a gzip'd tar) → magic.
        const sameFamily = family(handler.name) === family(sniffed);
        if ((sameFamily && family(sniffed) !== 'gz') || WEAK_SNIFFS.has(sniffed)) {
            sourcedFrom = sameFamily ? 'extension (family match)' : 'extension (weak magic ignored)';
        } else {
            handler = HANDLER_BY_NAME.get(sniffed);
            sourcedFrom = 'magic (extension mismatch)';
        }
    }
    if (!handler) {
        const preview = head.slice(0, 16).toString('hex');
        const kind = describeNonArchive(head);
        if (kind) {
            throw new Error(`"${filename}" is not an archive — the content looks like ${kind}. (first 16 bytes: ${preview})`);
        }
        // Unknown extension, unknown magic, binary content: ask 7-Zip what it
        // is (it recognises ~50 container formats by structure, including
        // self-extracting .exe and NSIS installers), then fall back to the
        // other broad-coverage tools.
        handler = await probeUnknownFormat(sourcePath, buffer, filename);
        sourcedFrom = handler ? `probe (${handler.probedType || handler.name})` : sourcedFrom;
        if (!handler) {
            throw new Error(
                `Cannot detect archive type. Filename "${filename}" extension is not recognized ` +
                `and the first 16 bytes (${preview}) don't match any known archive format. ` +
                `Supported: ${SUPPORTED_FORMATS_TEXT}. ` +
                `If this is a truncated base64 payload, ensure the full archive was passed.`
            );
        }
    }
    // Attempt chain: every installed tool for the format, then (for a
    // compressed tar / bare stream) the sibling interpretation.
    const attemptHandlers = [handler];
    if (FALLBACK[handler.name]) attemptHandlers.push(HANDLER_BY_NAME.get(FALLBACK[handler.name]));
    const attempts = [];
    const missingTools = new Set();
    for (const h of attemptHandlers) {
        if (!h) continue;
        if (h.single) {
            const cmds = CODECS[h.single].cmds.filter(([bin]) => hasBin(bin) || (missingTools.add(bin), false));
            if (cmds.length) attempts.push({ name: h.name, handler: h, single: h.single, cmds, tool: cmds.map(c => c[0]).join('|') });
            continue;
        }
        for (const s of h.strategies) {
            if (!hasBin(s.bin)) { missingTools.add(s.bin); continue; }
            attempts.push({ name: h.name, handler: h, strategy: s, pw: s.pw, tool: s.bin });
        }
    }
    if (!attempts.length) {
        throw new Error(`"${filename}" is a ${handler.name} archive, but none of the tools that open it are installed on this server (${[...missingTools].join(', ')}).`);
    }

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
    let volumeInfo = { multiVolume: false, staged: [] };
    if (sourcePath) {
        // Hardlink when possible (same filesystem, zero copy); copy otherwise.
        try { await fs.promises.link(sourcePath, archivePath); }
        catch (_) { await fs.promises.copyFile(sourcePath, archivePath); }
        // Multi-volume sets (x.part2.rar, x.r00, x.7z.002, x.z01, chained
        // cabinets) only open with every part beside the first one.
        volumeInfo = await stageVolumeSiblings(sourcePath, archivePath, head).catch(() => volumeInfo);
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
        const attemptErrors = [];
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
                    // Single-stream compression of one file. Decompress to a
                    // sibling of the staged archive, trying each installed tool.
                    const base = path.basename(archivePath);
                    let outName = base.replace(/\.(t(gz|pz|bz2?|b2|xz|zst|lzma|lz4?|zo|az|br))$/i, '.tar');
                    if (outName === base) outName = base.replace(CODECS[attempt.single].suffix, '');
                    if (!outName || outName === base) outName = `${base}.out`;
                    // Written INSIDE extractDir under a hidden temp name: the
                    // staging dir may sit on another filesystem (/tmp vs the
                    // models volume), where the final rename would be a copy.
                    const tmpDir = path.join(extractDir, `.decompressing-${crypto.randomBytes(4).toString('hex')}`);
                    const stripped = path.join(tmpDir, outName);
                    await fs.promises.mkdir(tmpDir, { recursive: true });
                    let decErr = null;
                    for (const [bin, cargs] of attempt.cmds) {
                        try {
                            await decompressToFile(bin, [...cargs, archivePath], stripped, { timeout: execTimeout, maxBytes: MAX_EXTRACTED_BYTES });
                            decErr = null;
                            attempt.tool = bin;
                            break;
                        } catch (e) {
                            decErr = e;
                            attempt.tool = bin;
                            if (e.sizeExceeded) break;
                        }
                    }
                    if (decErr) { await rmrf(tmpDir); throw decErr; }
                    const st = await fs.promises.stat(stripped).catch(() => null);
                    if (!st || !st.size) { await rmrf(tmpDir); throw new Error('decompression produced no output'); }
                    // The decompressed stream may itself be a tar or cpio (a
                    // .xz/.zst whose outer magic couldn't be peeked, an
                    // initramfs .cpio.gz) — unpack it instead of returning one
                    // opaque entry. Anything else stays a single file.
                    const innerHead = Buffer.alloc(263);
                    const fd = await fs.promises.open(stripped, 'r');
                    try { await fd.read(innerHead, 0, 263, 0); } finally { await fd.close(); }
                    const inner = sniffStrong(innerHead);
                    if (innerHead.subarray(257, 262).toString('ascii') === 'ustar') {
                        await execFileP('tar', ['-xf', stripped, '-C', extractDir], { timeout: execTimeout });
                        attempt.inner = 'tar';
                    } else if (inner === 'cpio' && (hasBin('bsdtar') || hasBin('cpio'))) {
                        // bsdtar refuses absolute and ../ member names by default.
                        if (hasBin('bsdtar')) await execFileP('bsdtar', ['-x', '-f', stripped, '-C', extractDir], { timeout: execTimeout });
                        else await execFileP('cpio', ['-idmu', '--no-absolute-filenames', '--quiet', '-F', stripped], { cwd: extractDir, timeout: execTimeout });
                        attempt.inner = 'cpio';
                    } else {
                        // Not a tar — drop any leftover archive-ish suffix so
                        // the entry doesn't masquerade ("data.tgz" → "data").
                        const dest = path.join(extractDir, outName.replace(/\.(tar|cpio)$/i, '') || outName);
                        await fs.promises.rename(stripped, dest);
                        if (inner) attempt.innerArchive = inner;
                    }
                    await rmrf(tmpDir);
                } else if (attempt.strategy.run) {
                    await attempt.strategy.run(archivePath, extractDir, { timeout: execTimeout, maxBytes: MAX_EXTRACTED_BYTES, password });
                } else {
                    const s = attempt.strategy;
                    const args = s.args.map(a => a
                        .replace('__FILE__', archivePath)
                        .replace('__DIR__', extractDir));
                    // Password switches go at index 1 — after the subcommand
                    // (`7z x`) but before the archive name (unzip/unrar treat
                    // anything after the archive as a file selector).
                    if (s.pw) args.splice(1, 0, ...s.pw(password));
                    await execFileP(s.bin, args, { timeout: execTimeout, maxBuffer: 10 * 1024 * 1024, ...(s.cwd ? { cwd: extractDir } : {}) });
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
                const tailOf = (x) => String(x?.stderr || x?.stdout || x?.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
                attemptErrors.push(`${attempt.name} via ${attempt.tool}: ${tailOf(e)}`);
                // An encrypted archive is not a format mismatch — the fallback
                // chain can only produce a more confusing error, so stop here
                // and let the password branch below report it. A bomb stops too.
                if (isPasswordFailure(e, attempt.tool, encInfo) || e.sizeExceeded) break;
            }
        }
        // Password failure. A mixed archive (some entries encrypted, some not)
        // still leaves the readable files on disk — keep them and warn, rather
        // than throwing away a partial extraction the model can use.
        if (lastErr && !used && isPasswordFailure(lastErr.err, lastErr.attempt.tool, encInfo)) {
            // 7-Zip creates each output file BEFORE decrypting it, so a wrong
            // password leaves empty/garbage files named in its error lines —
            // remove those, or they would pass for a partial extraction.
            const errText = `${lastErr.err?.stderr || ''}\n${lastErr.err?.stdout || ''}`;
            for (const m of errText.matchAll(/(?:Wrong password|Data Error in encrypted file\. Wrong password\?|CRC Failed in encrypted file\. Wrong password\?)\s*:\s*(.+)$/gm)) {
                const victim = path.resolve(extractDir, m[1].trim());
                if (victim.startsWith(extractDir + path.sep)) await rmrf(victim);
            }
            let produced = (await walkDir(extractDir, { pruneEscapingSymlinks: false }).catch(() => ({ files: [] }))).files;
            // unar/bsdtar/7z create an entry before decrypting it; a locked
            // entry is left as a 0-byte placeholder. unzip skips cleanly.
            if (lastErr.attempt.tool !== 'unzip') {
                for (const f of produced) if (!f.size) await rmrf(f.fullPath);
                produced = produced.filter(f => f.size);
            }
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
            const { err } = lastErr;
            const preview = head.slice(0, 16).toString('hex');
            const kind = describeNonArchive(head);
            const timedOut = err && (err.killed || /ETIMEDOUT|timed? ?out/i.test(String(err.message || '')));
            if (err?.sizeExceeded) throw new Error(`"${filename}" ${err.message}. The output was discarded.`);
            throw new Error(
                (kind && !sniffed ? `"${filename}" does not contain archive data — it looks like ${kind}. ` : '') +
                (handler.nonArchiveHint ? `"${filename}" is ${handler.nonArchiveHint} that is not a self-extracting archive or a supported installer (7z/RAR/zip SFX, NSIS, Inno Setup, cab). ` : '') +
                (timedOut ? `Extraction of ${filename} exceeded the ${Math.round(execTimeout / 1000)} s limit (ARCHIVE_EXTRACT_TIMEOUT_MAX_MS). ` : '') +
                `Extraction failed on ${filename} (size=${size}, first16=${preview}, detectedVia=${sourcedFrom}). ` +
                `Tried, in order: ${attemptErrors.join(' | ')}` +
                (missingTools.size ? ` (not installed: ${[...missingTools].join(', ')})` : '') +
                (volumeInfo.multiVolume
                    ? ` This looks like one part of a MULTI-VOLUME archive${volumeInfo.staged.length ? ` (found ${volumeInfo.staged.length} other part(s) beside it)` : ' and no other parts were found beside it'} — every part must sit in the same workspace directory with its original name; pass the FIRST part.`
                    : '')
            );
        }
        handler = used;

        // Package formats whose members are themselves archives: a .deb is an
        // ar of control.tar.* + data.tar.*, an rpm/xar opened by 7z yields a
        // compressed cpio "payload". Unpack those so the model sees files.
        const unwrapped = (used.handler?.unwrap && (opts._depth || 0) < 2)
            ? await unwrapContainer(used.handler.unwrap, extractDir, opts).catch(() => [])
            : [];

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
            tool: handler.tool,
            ...(unwrapped.length ? { unwrapped } : {}),
            ...(handler.innerArchive ? { innerFormat: handler.innerArchive } : {}),
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
                unwrapped.length ? `Nested package payloads were unpacked in place: ${unwrapped.join(', ')}.` : '',
                handler.innerArchive ? `The decompressed file is itself a ${handler.innerArchive} archive — call extract_archive again with path set to that entry to open it.` : '',
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

module.exports = { extractArchive, pickHandler, sniffFormat, execTimeoutFor, stripArchiveExt, MAX_EXTRACTED_BYTES, ARCHIVE_EXT_RE, SUPPORTED_FORMATS_TEXT };
