// Split an assistant message into the model's WORKING NARRATION (the prose it
// wrote before each tool round) and its FINAL ANSWER (what follows the last
// dispatched tool). Every chip carries `contentOffset` = the length of the
// assistant content when that tool was dispatched; chips dispatched in one
// round share the offset. A message with any chip lacking a numeric offset
// (saved before the server stamped it) is `legacy` and renders as before.
export function splitNarration(content, toolCalls) {
    const text = typeof content === 'string' ? content : '';
    const calls = Array.isArray(toolCalls) ? toolCalls.filter(Boolean) : [];
    if (!calls.length) return { segments: [], answer: text, legacy: true };
    if (calls.some(c => !Number.isFinite(c.contentOffset))) return { segments: [], answer: text, legacy: true };
    const groups = [];
    const byOffset = new Map();
    for (const c of calls) {
        // A rewind can shorten the content past an earlier offset — clamp.
        const offset = Math.max(0, Math.min(text.length, Math.floor(c.contentOffset)));
        let g = byOffset.get(offset);
        if (!g) { g = { offset, calls: [] }; byOffset.set(offset, g); groups.push(g); }
        g.calls.push(c);
    }
    groups.sort((a, b) => a.offset - b.offset);
    const segments = [];
    let prev = 0;
    for (const g of groups) {
        segments.push({ offset: g.offset, text: text.slice(prev, g.offset), calls: g.calls });
        prev = g.offset;
    }
    return { segments, answer: text.slice(prev), legacy: false };
}

// Sum of the finished chips' durations, for the notes header.
export function totalToolMs(toolCalls) {
    let ms = 0;
    for (const c of (Array.isArray(toolCalls) ? toolCalls : [])) {
        if (c && Number.isFinite(c.durationMs)) ms += c.durationMs;
    }
    return ms;
}
