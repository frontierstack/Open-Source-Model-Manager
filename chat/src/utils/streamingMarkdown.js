// Close the markdown constructs a stream has OPENED but not yet closed, so the
// tail of an in-progress answer renders formatted instead of showing raw
// symbols until the closing token arrives: an open ``` fence (the whole rest
// of the answer would otherwise render as prose), `**bold` / `` `code `` left
// open on the last line, a table whose header row has arrived but whose
// delimiter row has not (GFM shows raw pipes until then), a heading marker with
// no text yet, and a half-typed link. Only the TAIL is touched and nothing is
// ever removed from finished text; the finalized message is rendered from the
// real content, never from this.

function countUnescaped(line, token) {
    let n = 0;
    for (let i = 0; i <= line.length - token.length; i++) {
        if (line[i] === '\\') { i++; continue; }
        if (line.startsWith(token, i)) { n++; i += token.length - 1; }
    }
    return n;
}

function tableCells(line) {
    const t = line.trim();
    if (!t.startsWith('|')) return 0;
    return t.replace(/^\|/, '').replace(/\|$/, '').split('|').length;
}

export function completeStreamingMarkdown(text) {
    if (!text) return text;
    let out = String(text);

    // 1. Code fences: an odd number of fence lines means one is open.
    const fenceLines = out.match(/^[ \t]{0,3}(```|~~~)/gm) || [];
    if (fenceLines.length % 2 === 1) {
        return out + (out.endsWith('\n') ? '' : '\n') + fenceLines[fenceLines.length - 1].trim().slice(0, 3);
    }

    const lines = out.split('\n');
    let last = lines.length - 1;
    // Work on the last line that has text (a trailing newline is fine).
    while (last > 0 && lines[last].trim() === '') last--;
    let line = lines[last];

    // 2. A bare heading / list marker with nothing after it yet.
    if (/^\s{0,3}#{1,6}\s*$/.test(line)) {
        lines[last] = '';
        return lines.join('\n');
    }

    // 3. Table header without its delimiter row: synthesize one so the table
    //    renders now. Only when the line above is not itself a table row.
    const prev = last > 0 ? lines[last - 1] : '';
    const cells = tableCells(line);
    if (cells >= 2 && /\|\s*$/.test(line) && !tableCells(prev)) {
        lines.splice(last + 1, 0, '|' + ' --- |'.repeat(cells));
        return lines.join('\n');
    }

    // 4. Inline constructs on the last line (skip inside inline code).
    if (countUnescaped(line, '`') % 2 === 1) {
        line += '`';
    } else {
        const noCode = line.replace(/`[^`]*`/g, '');
        // A half-typed link: "[text](http..." or "[text" → show the text plain.
        const openLink = noCode.match(/\[([^\]]*)\]\([^)]*$/);
        if (openLink) line = line.slice(0, line.lastIndexOf(openLink[0])) + openLink[1];
        else if (/\[[^\]]*$/.test(noCode)) line = line.replace(/\[([^\]]*)$/, '$1');
        const bold = countUnescaped(line.replace(/`[^`]*`/g, ''), '**');
        if (bold % 2 === 1) {
            // "**" followed by nothing yet renders as literal asterisks; drop it.
            line = /\*\*\s*$/.test(line) ? line.replace(/\*\*\s*$/, '') : line.replace(/\s+$/, '') + '**';
        }
    }
    lines[last] = line;
    return lines.join('\n');
}
