// Removes a PROCESS preamble from the start of a finished answer: the
// sentence a model writes between its last tool round and the answer itself —
// "I have all the data. Let me compile the comparison." / "All three reports
// have arrived. I will now compile the final answer…" / "I know the answer to
// this classic literary question." Measured on the 27B lead: 5 of 11 test
// answers opened like that, and the prompt rule against it (system prompt AND
// the latest user message) still left 2 of 5 tool-using answers with one.
//
// Deliberately narrow: only WHOLE leading sentences that match PROCESS are
// removed, each at most 200 characters, at most 400 in total, and only when a
// substantive answer follows. A normal lead-in ("Here is the comparison:"),
// an answer that happens to start with "I" ("I recommend Go for…") and
// anything inside the answer body are never touched.

const LEAD_IN = '(?:(?:great|perfect|excellent|okay|ok|alright|good|done|right)[,!.]?\\s+)?';
const PROCESS_SENTENCES = [
    // "I have all the data", "I now have the pricing for all three", "I've gathered everything"
    /^(?:now,? )?i(?: now)?(?:'ve| have)(?: now)? (?:all|everything|enough|the|what|verified|confirmed|current|complete|full|up-to-date|official|\w+ed\b)\b.{0,90}\b(?:data|information|info|results?|reports?|details|numbers|facts|figures|pricing|prices|versions|sources|findings|answers?|everything|need(?:ed)?)\b.{0,80}$/i,
    /^i(?:'ve| have) (?:now )?(?:got|gathered|collected|compiled|received)\b.{0,120}$/i,
    /^now (?:that )?i(?:'ve| have) (?:all|everything|enough|the|got)\b.{0,120}$/i,
    // "All three reports have arrived", "The verification jobs have completed"
    /^(?:all|both)(?: (?:three|two|four|five|\d+))?(?: of)?(?: the| my)?(?: \w+){0,2} (?:reports?|results?|jobs?|lookups?|searches|research|data)\b.{0,40}?\b(?:(?:arrived|completed|complete|finished|done|landed|returned|ready|came back|come back)\b.{0,60}|(?:in|back)[.!;:]?)$/i,
    /^the(?: \w+){0,3} (?:jobs?|reports?|results?|research|searches|lookups?|background work)\b.{0,30}?\b(?:(?:have|has|are|is)\b.{0,15}?\b)?(?:(?:arrived|completed|complete|finished|done|landed|returned|ready|came back|come back)\b.{0,60}|(?:in|back)[.!;:]?)$/i,
    // "All three runtimes have been researched", "Everything has been checked"
    /^(?:all|both|each|everything|every \w+)(?: (?:three|two|four|five|\d+))?(?: of)?(?: the)?(?: \w+){0,2} (?:have|has) (?:now )?been (?:researched|checked|looked up|verified|gathered|collected|covered|found|confirmed)\b.{0,60}$/i,
    // "...the benchmarks are still running"
    /^.{0,120}\b(?:jobs?|reports?|benchmarks?|results?|research|searches|lookups?)\b.{0,20}\b(?:is|are) still (?:running|in progress|pending|coming)\b.{0,80}$/i,
    // "Let me compile the comparison", "I'll now put together the final answer", "Now I will write it up"
    // — only when the object is the answer itself, never "I'll create a chart"
    /^(?:now,? )?(?:let me|i'll|i will|i'm going to|i am going to|time to)(?: now)? (?:compile|put together|write(?: up)?|summari[sz]e|present|format|assemble|draft|organi[sz]e|combine|pull together|lay out)\b.{0,40}\b(?:answer|comparison|summary|table|response|results|findings|overview|everything|it all|it|this|them|release notes|report|data)\b.{0,60}$/i,
    // A reaction to a runtime note: "The system indicates that the Node.js research is already done…"
    /^the system (?:indicates|says|reports|shows|notes|tells me)\b.{0,140}$/i,
    // "Based on the research completed by my assistant:" — a lead-in that only names the process
    /^based on (?:the|my|all the|all of the) (?:research|results?|reports?|findings|lookups?|jobs?|work|data)\b.{0,50}\b(?:assistant|jobs?|workers?|reports?|lookups?|searches|research)[.:]?$/i,
    // "Let me proceed." / "Let me proceed with the answer."
    /^(?:now,? )?let me (?:proceed|continue|get started|begin)(?: (?:with|to) (?:the|my|an) (?:answer|response|summary|comparison|write-up))?[.!:]?$/i,
    // "I know the answer to this classic question"
    /^i know (?:the answer|this one)\b.{0,90}$/i,
];
const LEAD_IN_RE = new RegExp(`^${LEAD_IN}`, 'i');
const SOLO_INTERJECTION = /^(?:great|perfect|excellent|okay|ok|alright|good|done|right)[!.]?$/i;

function isProcessSentence(sentence) {
    const s = String(sentence || '').trim().replace(/\*\*/g, '');
    if (!s || s.length > 200) return false;
    const body = s.replace(LEAD_IN_RE, '');
    return PROCESS_SENTENCES.some(re => re.test(body));
}
const isInterjection = (sentence) => SOLO_INTERJECTION.test(String(sentence || '').trim().replace(/\*\*/g, ''));

// `text` is the ANSWER segment only (after the last tool call). Returns
// { text, removed } — `removed` is the stripped preamble ('' when none).
function stripProcessPreamble(text, { maxRemoved = 400, minRemaining = 40 } = {}) {
    const src = String(text || '');
    const lead = (src.match(/^\s*/) || [''])[0];
    let rest = src.slice(lead.length);
    let removed = '';
    // A lone "Done." / "Perfect!" is kept unless a real process sentence
    // follows it: for "create the file", "Done." is part of the answer.
    let pending = '';
    let pendingRest = null;
    for (let guard = 0; guard < 5; guard++) {
        // The next clause ends at . ! ? : or ; followed by whitespace, or at
        // a line break — a preamble never spans a paragraph.
        const m = rest.match(/^([^\n]*?[.!?:;])(?=\s|$)|^([^\n]+)(?=\n)/);
        if (!m) break;
        const sentence = m[1] || m[2];
        const next = rest.slice(sentence.length).replace(/^\s+/, '');
        if (!pending && !removed && isInterjection(sentence)) {
            pending = sentence.trim();
            pendingRest = rest;
            rest = next;
            continue;
        }
        if (!isProcessSentence(sentence)) break;
        if (removed.length + pending.length + sentence.length > maxRemoved) break;
        if (next.replace(/\s+/g, ' ').length < minRemaining) break;
        removed += (removed ? ' ' : '') + (pending ? `${pending} ` : '') + sentence.trim();
        pending = '';
        pendingRest = null;
        rest = next;
    }
    if (pending) rest = pendingRest;
    if (!removed) return { text: src, removed: '' };
    return { text: lead + rest, removed };
}

module.exports = { stripProcessPreamble, isProcessSentence };
