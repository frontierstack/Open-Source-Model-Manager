'use strict';
// Decides whether a message sent WHILE a reply is still streaming should run
// as a parallel turn (its own window, on a free slot) or wait its turn in the
// same window. A follow-up to the reply in progress ("make that shorter",
// "why?", "and the second one?") cannot be answered well in parallel — the
// reply it refers to does not exist yet — so it is queued. A different topic
// runs at once. Pure + unit-tested; server.js calls it from the sidecar route.

const STOP = new Set(('a an the and or but of to in on at for with by from as is are was were be been being it its this that these those '
    + 'i you he she we they me him her us them my your his our their what which who whom whose when where why how do does did done '
    + 'can could should would will shall may might must have has had having not no yes so if then than too very just about into over '
    + 'also please tell give me some any more most much many one two three first second last new now today').split(/\s+/));

const ANAPHORA_RE = /\b(it|that|this|those|these|them|they|the (above|previous|last|first|second|other|same|earlier) (one|answer|reply|response|story|result|article|item|point|version)|your (answer|reply|response|last|previous)|(did |do |can |could )?you (said|say|wrote|write|mentioned|mention|found|find|called|call|meant|mean)|the (answer|reply|response|story|article|item|list|table|code|script|summary|version) (above|you (gave|wrote)))\b/i;
const FOLLOWUP_VERB_RE = /^(and|also|ok|okay|now|then|next|so|but|please|can you|could you|would you)?[\s,]*(expand|elaborate|explain|clarify|continue|go on|keep going|finish|summari[sz]e|shorten|make (it|that|this) (shorter|longer|simpler|clearer|more \w+)|rewrite|rephrase|reword|translate|simplify|why|how (so|come)|really|source|sources|cite|link|more (detail|details|info|information|on that|about that|like that)|another (one|example)|other (one|examples?)|instead|the (other|second|first|next|last) one|in (english|spanish|french|german|italian|portuguese|chinese|japanese)|as (a )?(table|list|bullet points|json|markdown|code)|tl;?dr|eli5|say (more|less)|too (long|short)|shorter|longer)\b/i;

function tokens(text) {
    return String(text || '').toLowerCase().replace(/[`*_#>\[\]()"'“”‘’]/g, ' ').split(/[^a-z0-9+.-]+/)
        .map(w => w.replace(/^[.+-]+|[.+-]+$/g, ''))
        .filter(w => w.length >= 3 && !STOP.has(w))
        // crude stemming so tide/tides, satellite/satellites count as one subject
        .map(w => (w.length > 4 && /[a-z]s$/.test(w) && !/ss$/.test(w)) ? w.slice(0, -1) : w);
}

function overlap(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / Math.min(A.size, B.size);
}

/**
 * @param {{ message: string, previousMessage?: string, partialReply?: string }} o
 * @returns {{ followUp: boolean, reason: string, score: number }}
 */
function classifyFollowUp({ message, previousMessage, partialReply } = {}) {
    const msg = String(message || '').trim();
    if (!msg) return { followUp: false, reason: 'empty', score: 0 };
    const words = msg.split(/\s+/).filter(Boolean);
    const mTok = tokens(msg);

    // Explicit reference to the reply in progress — always a follow-up.
    if (ANAPHORA_RE.test(msg) && words.length <= 40) {
        // "it/that/this" also appear in perfectly independent questions
        // ("What is the capital of France? Is it big?") — require that the
        // message does not carry its own full subject: few content words.
        if (mTok.length <= 6 || /\b(the (above|previous|last)|your (answer|reply|response)|(did |do )?you (said|say|wrote|mentioned|found|called|meant))\b/i.test(msg)) {
            return { followUp: true, reason: 'refers-to-current-reply', score: 1 };
        }
    }
    // Short instruction-shaped follow-ups ("make it shorter", "why?", "sources?").
    if (words.length <= 8 && FOLLOWUP_VERB_RE.test(msg)) {
        return { followUp: true, reason: 'short-instruction', score: 0.9 };
    }
    // Same subject as the previous message / the reply so far.
    const prevTok = tokens(previousMessage);
    const replyTok = tokens(String(partialReply || '').slice(0, 4000));
    const oPrev = overlap(mTok, prevTok);
    const oReply = overlap(mTok, replyTok);
    const score = Math.max(oPrev, oReply * 0.85);
    const shared = (a, b) => { const B = new Set(b); return a.filter((w, i, arr) => B.has(w) && arr.indexOf(w) === i).length; };
    const sharedMax = Math.max(shared(mTok, prevTok), shared(mTok, replyTok));
    if (mTok.length >= 2 && sharedMax >= 2 && score >= 0.34) {
        return { followUp: true, reason: oPrev >= oReply * 0.85 ? 'same-subject-as-previous' : 'same-subject-as-reply', score };
    }
    return { followUp: false, reason: 'different-topic', score };
}

module.exports = { classifyFollowUp, tokens, overlap };
