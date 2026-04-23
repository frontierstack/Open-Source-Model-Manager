// Strict base64 detector used by the chat stream handler to auto-invoke
// the base64_decode skill. The model is inconsistent at picking
// base64_decode out of a 70+ tool catalog — it often guesses the decoded
// value inline instead of calling the tool. Detecting base64 server-side
// and injecting a completed tool call makes invocation deterministic.
//
// "Strict" means: valid base64 alphabet, round-trips cleanly, decodes to
// mostly-printable UTF-8, no replacement characters. This rejects random
// hex strings, hashes, JWT segments (which aren't standard base64), and
// binary blobs that happen to be base64 but aren't text payloads.

function decodeCandidate(s) {
    if (typeof s !== 'string' || s.length < 16) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    try {
        const padLen = (4 - (s.length % 4)) % 4;
        const padded = s + '='.repeat(padLen);
        const buf = Buffer.from(padded, 'base64');
        if (!buf.length) return null;
        // Round-trip check — Buffer.from tolerates garbage and silently
        // drops invalid chars. Re-encoding must match (minus padding).
        const reenc = buf.toString('base64').replace(/=+$/, '');
        if (reenc !== s.replace(/=+$/, '')) return null;
        const text = buf.toString('utf8');
        if (!text || text.includes('�')) return null;
        let printable = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if ((code >= 32 && code < 127) || code === 10 || code === 13 || code === 9) {
                printable++;
            }
        }
        if (printable / text.length < 0.7) return null;
        return text;
    } catch {
        return null;
    }
}

function findBase64InText(text, { minLength = 16 } = {}) {
    if (typeof text !== 'string' || !text) return [];
    const out = [];
    const seen = new Set();
    const pattern = new RegExp(`[A-Za-z0-9+/]{${minLength},}={0,2}`, 'g');
    let m;
    while ((m = pattern.exec(text)) !== null) {
        const candidate = m[0];
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const decoded = decodeCandidate(candidate);
        if (decoded !== null) {
            out.push({ encoded: candidate, decoded });
        }
    }
    return out;
}

function extractTextFromContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
    }
    return '';
}

module.exports = {
    decodeCandidate,
    findBase64InText,
    extractTextFromContent,
};
