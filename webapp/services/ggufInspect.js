'use strict';
// ---------------------------------------------------------------------------
// GGUF header inspection — proves a .gguf file is TRUNCATED without reading it.
//
// Why this exists: an interrupted model download leaves a partial .gguf that is
// byte-for-byte indistinguishable from a good one to a directory listing, so the
// UI happily says "Downloaded (Not Loaded)" and you only find out when
// llama.cpp exits 1 with
//     tensor 'blk.N...' data is not within the file bounds, model is corrupted
// ...after which the health monitor removes the container and its logs with it.
//
// The GGUF header carries the full tensor table (name, dims, type, offset), so
// the MINIMUM valid file size is computable offline:
//     dataStart = align(headerEnd, general.alignment)
//     minBytes  = dataStart + max(offset + nbytes(tensor))
// Compare that against the real size on disk. Only a bounded prefix of the file
// is ever read (never the 20 GB body).
//
// Contract: returns { ok, truncated, expectedMinBytes, actualBytes, reason, ... }
//   ok === true   -> parsed, file is at least as large as the tensor table needs
//   ok === false  -> parsed, file is SHORTER than the tensor table needs
//   ok === null   -> could not parse (unknown ggml type, weird header, I/O) —
//                    UNKNOWN, never reported as corrupt.
// ---------------------------------------------------------------------------

const fsp = require('fs').promises;

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

// Value type ids from the GGUF spec.
const T_UINT8 = 0, T_INT8 = 1, T_UINT16 = 2, T_INT16 = 3, T_UINT32 = 4,
      T_INT32 = 5, T_FLOAT32 = 6, T_BOOL = 7, T_STRING = 8, T_ARRAY = 9,
      T_UINT64 = 10, T_INT64 = 11, T_FLOAT64 = 12;

const SCALAR_SIZE = {
    [T_UINT8]: 1, [T_INT8]: 1, [T_UINT16]: 2, [T_INT16]: 2,
    [T_UINT32]: 4, [T_INT32]: 4, [T_FLOAT32]: 4, [T_BOOL]: 1,
    [T_UINT64]: 8, [T_INT64]: 8, [T_FLOAT64]: 8
};

// ggml type -> [blockSize (elements per block), typeSize (bytes per block)]
// Transcribed from ggml.c's type_traits table. An id absent from this map makes
// the whole inspection return ok:null rather than guessing a size.
const GGML_TYPES = {
    0:  [1, 4],     // F32
    1:  [1, 2],     // F16
    2:  [32, 18],   // Q4_0
    3:  [32, 20],   // Q4_1
    6:  [32, 22],   // Q5_0
    7:  [32, 24],   // Q5_1
    8:  [32, 34],   // Q8_0
    9:  [32, 36],   // Q8_1
    10: [256, 84],  // Q2_K
    11: [256, 110], // Q3_K
    12: [256, 144], // Q4_K
    13: [256, 176], // Q5_K
    14: [256, 210], // Q6_K
    15: [256, 292], // Q8_K
    16: [256, 66],  // IQ2_XXS
    17: [256, 74],  // IQ2_XS
    18: [256, 98],  // IQ3_XXS
    19: [256, 50],  // IQ1_S
    20: [32, 18],   // IQ4_NL
    21: [256, 110], // IQ3_S
    22: [256, 82],  // IQ2_S
    23: [256, 136], // IQ4_XS
    24: [1, 1],     // I8
    25: [1, 2],     // I16
    26: [1, 4],     // I32
    27: [1, 8],     // I64
    28: [1, 8],     // F64
    29: [256, 56],  // IQ1_M
    30: [1, 2],     // BF16
    31: [32, 18],   // Q4_0_4_4 (deprecated repack)
    32: [32, 18],   // Q4_0_4_8 (deprecated repack)
    33: [32, 18],   // Q4_0_8_8 (deprecated repack)
    34: [256, 54],  // TQ1_0
    35: [256, 66]   // TQ2_0
};

// Sanity ceilings — a corrupt/partial header can claim absurd counts, and we
// must never allocate against attacker/garbage-controlled numbers.
const MAX_TENSORS = 1_000_000;
const MAX_KV = 100_000;
const MAX_STRING_LEN = 64 * 1024 * 1024;
const MAX_ARRAY_LEN = 100_000_000;
const MAX_DIMS = 8;

const INITIAL_READ = 4 * 1024 * 1024;   // 4 MB is enough for virtually every GGUF header
const MAX_READ = 32 * 1024 * 1024;      // hard ceiling; never read more than this

class NeedMore extends Error {}

// Bounded little-endian cursor over the header prefix. Any read past the end
// throws NeedMore, which makes the caller re-read a bigger prefix.
class Cursor {
    constructor(buf) { this.buf = buf; this.off = 0; }
    need(n) { if (this.off + n > this.buf.length) throw new NeedMore(); }
    u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
    i32() { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
    u64() {
        this.need(8);
        const v = this.buf.readBigUInt64LE(this.off); this.off += 8;
        return v;
    }
    skip(n) { this.need(n); this.off += n; }
    str() {
        const len = Number(this.u64());
        if (!Number.isSafeInteger(len) || len < 0 || len > MAX_STRING_LEN) {
            throw new Error(`implausible string length ${len}`);
        }
        this.need(len);
        const s = this.buf.toString('utf8', this.off, this.off + len);
        this.off += len;
        return s;
    }
}

// Read a metadata value; returns the value only for the scalar/string cases we
// actually care about (general.alignment), otherwise null after skipping it.
function readValue(cur, type) {
    if (type === T_STRING) return cur.str();
    if (SCALAR_SIZE[type] != null) {
        const n = SCALAR_SIZE[type];
        cur.need(n);
        let v;
        switch (type) {
            case T_UINT8:   v = cur.buf.readUInt8(cur.off); break;
            case T_INT8:    v = cur.buf.readInt8(cur.off); break;
            case T_UINT16:  v = cur.buf.readUInt16LE(cur.off); break;
            case T_INT16:   v = cur.buf.readInt16LE(cur.off); break;
            case T_UINT32:  v = cur.buf.readUInt32LE(cur.off); break;
            case T_INT32:   v = cur.buf.readInt32LE(cur.off); break;
            case T_FLOAT32: v = cur.buf.readFloatLE(cur.off); break;
            case T_BOOL:    v = cur.buf.readUInt8(cur.off) !== 0; break;
            case T_UINT64:  v = Number(cur.buf.readBigUInt64LE(cur.off)); break;
            case T_INT64:   v = Number(cur.buf.readBigInt64LE(cur.off)); break;
            case T_FLOAT64: v = cur.buf.readDoubleLE(cur.off); break;
        }
        cur.off += n;
        return v;
    }
    if (type === T_ARRAY) {
        const elemType = cur.u32();
        const len = Number(cur.u64());
        if (!Number.isSafeInteger(len) || len < 0 || len > MAX_ARRAY_LEN) {
            throw new Error(`implausible array length ${len}`);
        }
        if (elemType === T_STRING) {
            for (let i = 0; i < len; i++) cur.str();
        } else if (SCALAR_SIZE[elemType] != null) {
            cur.skip(SCALAR_SIZE[elemType] * len);
        } else if (elemType === T_ARRAY) {
            for (let i = 0; i < len; i++) readValue(cur, T_ARRAY);
        } else {
            throw new Error(`unknown array element type ${elemType}`);
        }
        return null;
    }
    throw new Error(`unknown metadata value type ${type}`);
}

// Parse the header out of `buf`. Throws NeedMore when the prefix is too short.
function parseHeader(buf) {
    const cur = new Cursor(buf);
    const magic = cur.u32();
    if (magic !== GGUF_MAGIC) {
        const err = new Error('not a GGUF file (bad magic)');
        err.notGguf = true;
        throw err;
    }
    const version = cur.u32();
    if (version < 1 || version > 10) throw new Error(`unsupported GGUF version ${version}`);

    let tensorCount, kvCount;
    if (version === 1) {
        // v1 used 32-bit counts.
        tensorCount = cur.u32();
        kvCount = cur.u32();
    } else {
        tensorCount = Number(cur.u64());
        kvCount = Number(cur.u64());
    }
    if (!Number.isSafeInteger(tensorCount) || tensorCount < 0 || tensorCount > MAX_TENSORS) {
        throw new Error(`implausible tensor count ${tensorCount}`);
    }
    if (!Number.isSafeInteger(kvCount) || kvCount < 0 || kvCount > MAX_KV) {
        throw new Error(`implausible kv count ${kvCount}`);
    }

    let alignment = 32;
    let architecture = null;
    for (let i = 0; i < kvCount; i++) {
        const key = cur.str();
        const type = cur.u32();
        const val = readValue(cur, type);
        if (key === 'general.alignment' && typeof val === 'number' && val > 0) alignment = val;
        else if (key === 'general.architecture' && typeof val === 'string') architecture = val;
    }

    // Tensor infos.
    let maxEnd = 0n;
    for (let i = 0; i < tensorCount; i++) {
        cur.str(); // tensor name
        const nDims = version === 1 ? cur.u32() : cur.u32();
        if (nDims > MAX_DIMS) throw new Error(`implausible tensor dim count ${nDims}`);
        let nElements = 1n;
        for (let d = 0; d < nDims; d++) {
            const dim = version === 1 ? BigInt(cur.u32()) : cur.u64();
            nElements *= dim;
        }
        const ggmlType = cur.u32();
        const offset = version === 1 ? BigInt(cur.u32()) : cur.u64();
        const t = GGML_TYPES[ggmlType];
        if (!t) throw new Error(`unknown ggml type ${ggmlType}`);
        const [blck, tsize] = t;
        // nbytes = nElements / blockSize * typeSize
        const nBytes = (nElements / BigInt(blck)) * BigInt(tsize);
        const end = offset + nBytes;
        if (end > maxEnd) maxEnd = end;
    }

    // Tensor data starts at the next `alignment` boundary after the header.
    const align = BigInt(alignment);
    const headerEnd = BigInt(cur.off);
    const dataStart = ((headerEnd + align - 1n) / align) * align;

    return {
        version,
        tensorCount,
        kvCount,
        alignment,
        architecture,
        headerBytes: cur.off,
        dataStart,
        expectedMinBytes: dataStart + maxEnd
    };
}

/**
 * Inspect a .gguf file for truncation.
 * @returns {Promise<{ok:boolean|null, truncated:boolean, expectedMinBytes:number|null,
 *                     actualBytes:number|null, missingBytes:number, percent:number|null,
 *                     reason:string, tensorCount?:number, architecture?:string}>}
 */
async function inspectGguf(filePath) {
    let actualBytes = null;
    try {
        const st = await fsp.stat(filePath);
        actualBytes = st.size;
    } catch (e) {
        return { ok: null, truncated: false, expectedMinBytes: null, actualBytes: null,
                 missingBytes: 0, percent: null, reason: `cannot stat file: ${e.message}` };
    }

    if (actualBytes < 24) {
        return { ok: false, truncated: true, expectedMinBytes: null, actualBytes,
                 missingBytes: 0, percent: 0,
                 reason: 'file is smaller than a GGUF header — download barely started' };
    }

    let fh = null;
    try {
        fh = await fsp.open(filePath, 'r');
        let readSize = Math.min(INITIAL_READ, actualBytes);
        let header = null;
        for (;;) {
            const buf = Buffer.alloc(readSize);
            const { bytesRead } = await fh.read(buf, 0, readSize, 0);
            const slice = buf.subarray(0, bytesRead);
            try {
                header = parseHeader(slice);
                break;
            } catch (e) {
                if (e instanceof NeedMore) {
                    // Ran off the end of the prefix. If we already hold the whole
                    // file, the header itself is incomplete => truncated.
                    if (bytesRead >= actualBytes) {
                        return { ok: false, truncated: true, expectedMinBytes: null, actualBytes,
                                 missingBytes: 0, percent: null,
                                 reason: 'GGUF header is incomplete — file ends inside the header/tensor table' };
                    }
                    if (readSize >= MAX_READ) {
                        return { ok: null, truncated: false, expectedMinBytes: null, actualBytes,
                                 missingBytes: 0, percent: null,
                                 reason: `GGUF header exceeds the ${MAX_READ} byte inspection budget` };
                    }
                    readSize = Math.min(Math.min(readSize * 4, MAX_READ), actualBytes);
                    continue;
                }
                if (e.notGguf) {
                    return { ok: null, truncated: false, expectedMinBytes: null, actualBytes,
                             missingBytes: 0, percent: null, reason: e.message };
                }
                return { ok: null, truncated: false, expectedMinBytes: null, actualBytes,
                         missingBytes: 0, percent: null, reason: `unparseable GGUF header: ${e.message}` };
            }
        }

        const expected = header.expectedMinBytes;               // BigInt
        const actual = BigInt(actualBytes);
        const truncated = actual < expected;
        const expectedNum = Number(expected);
        const missing = truncated ? Number(expected - actual) : 0;
        const percent = expectedNum > 0
            ? Math.min(100, Math.round((actualBytes / expectedNum) * 1000) / 10)
            : null;

        return {
            ok: !truncated,
            truncated,
            expectedMinBytes: expectedNum,
            actualBytes,
            missingBytes: missing,
            percent,
            tensorCount: header.tensorCount,
            architecture: header.architecture,
            alignment: header.alignment,
            reason: truncated
                ? `file is ${missing} bytes short of the ${expectedNum} bytes its tensor table requires (${percent}%) — truncated/incomplete download`
                : 'GGUF tensor table fits within the file'
        };
    } catch (e) {
        return { ok: null, truncated: false, expectedMinBytes: null, actualBytes,
                 missingBytes: 0, percent: null, reason: `inspection failed: ${e.message}` };
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Cache: /api/models is polled, and each inspection is a few file reads. Key on
// path + size + mtime so any change to the file invalidates the entry (a
// resuming download grows the file, which changes both).
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_MAX = 500;

async function inspectGgufCached(filePath) {
    let st;
    try {
        st = await require('fs').promises.stat(filePath);
    } catch (e) {
        return { ok: null, truncated: false, expectedMinBytes: null, actualBytes: null,
                 missingBytes: 0, percent: null, reason: `cannot stat file: ${e.message}` };
    }
    const key = `${filePath}:${st.size}:${st.mtimeMs}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const result = await inspectGguf(filePath);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, result);
    return result;
}

module.exports = { inspectGguf, inspectGgufCached, GGML_TYPES, _parseHeader: parseHeader };
