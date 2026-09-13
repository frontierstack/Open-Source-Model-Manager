// Short display name for a model id: owner prefix and file extension dropped,
// then the leading family + size tokens are kept up to the LAST segment that
// looks like a size ("35B", "A3B", "8x7B", "1.7B") and everything after it
// (quant, variant, author tags) is cut. With no size token the name is
// clipped to 24 chars. Always show the full id in a title= next to it.
const SIZE_RE = /^(?:\d+(?:\.\d+)?x\d+(?:\.\d+)?B|A\d+(?:\.\d+)?B|\d+(?:\.\d+)?B)$/i;
export function modelDisplayName(name) {
    const full = String(name || '').trim();
    if (!full) return '';
    let base = full.slice(full.lastIndexOf('/') + 1).replace(/\.(gguf|safetensors|bin)$/i, '');
    const segs = base.split(/[-_]/).filter(Boolean);
    let last = -1;
    segs.forEach((s, i) => { if (SIZE_RE.test(s)) last = i; });
    if (last >= 0) return segs.slice(0, last + 1).join('-');
    if (base.length <= 24) return base;
    return base.slice(0, 23).replace(/[-_.\s]+$/, '') + '…';
}
