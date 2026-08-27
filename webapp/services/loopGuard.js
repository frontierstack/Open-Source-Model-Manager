// Loop-guard primitives for /api/chat/stream.
//
// The chat stream's tool loop already carries a family of SHAPE-specific
// guards (identical-args repeat, re-read cap, resolve-thrash, unproductive
// and stalled outcomes, runner-wrapper …). Every one of them is keyed on
// something about the call — its fingerprint, its path, its outcome
// signature — so a loop whose calls keep CHANGING in the keyed dimension
// escapes all of them and ran to MAX_TOOL_ITERATIONS. The live cases were
// always the same shape: the model tries a new variant every round (a new
// path, a new URL, a new script) and every variant FAILS or returns nothing —
// each failure text differs, so no signature repeats, so nothing fires for
// 50 rounds.
//
// This module adds the shape-AGNOSTIC layer:
//
//   - canonicalArgs()        fingerprints that survive key-order / whitespace
//                            differences in the model's JSON.
//   - makeProgressLedger()   "did this turn learn anything recently?" — a
//                            weighted count of consecutive calls that produced
//                            no NEW information (failed, empty, byte-identical
//                            to an earlier result, or refused by a guard).
//                            Advisory → checkpoint → synthesis thresholds.
//   - makeRepetitionDetector / makeReasoningLoopDetector /
//     makeContentLoopDetector — verbatim-repetition detection over a streamed
//                            buffer, incl. a GLOBAL recurrence check (the tail
//                            re-uses sentences from earlier in the same round)
//                            that the tail-only checks could not see, and a
//                            cut offset so a looping CONTENT stream can be
//                            rewound to where the repetition began.
//
// Everything here is pure (no I/O, no server state) so it can be unit-tested
// on its own; server.js owns the wiring and the messages to the model.

'use strict';

// ---------------------------------------------------------------------------
// Canonical tool-call arguments
// ---------------------------------------------------------------------------

function stableStringify(v) {
    if (v === null || typeof v !== 'object') {
        // JSON.stringify(undefined) is undefined; inside arrays JSON maps it to
        // null — mirror that so the output is always a string.
        const s = JSON.stringify(v);
        return s === undefined ? 'null' : s;
    }
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/**
 * Canonical form of a tool call's `arguments` JSON string: keys sorted, no
 * insignificant whitespace. Two calls that differ only in key order or
 * formatting fingerprint identically (the fp-keyed guards used the raw string,
 * so `{"path":"a"}` and `{ "path": "a" }` were two different calls). Unparseable
 * input is returned trimmed, unchanged in meaning.
 */
function canonicalArgs(raw) {
    if (raw == null) return '';
    const s = String(raw).trim();
    if (!s) return '';
    try { return stableStringify(JSON.parse(s)); } catch (_) { return s; }
}

// Bigram-Dice similarity of two argument strings (0..1). Used to tell a model
// RETRYING VARIANTS of one thing (a garbled path re-typed five ways — high
// similarity) from a model trying genuinely DIFFERENT things (six distinct
// grep patterns — low similarity): the former is flailing after three empty
// results, the latter is an audit reporting negatives and deserves a longer
// leash.
function argsSimilarity(a, b) {
    const s1 = String(a || ''), s2 = String(b || '');
    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return 0;
    const grams = (s) => { const m = new Map(); for (let i = 0; i + 1 < s.length; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const g1 = grams(s1), g2 = grams(s2);
    let inter = 0;
    for (const [g, c] of g1) if (g2.has(g)) inter += Math.min(c, g2.get(g));
    return (2 * inter) / ((s1.length - 1) + (s2.length - 1));
}

/**
 * Similarity of two CANONICAL argument strings computed over the values that
 * DIFFER between them. Two grep calls share `directory` and `regex` and differ
 * only in `pattern`; comparing the whole strings would make every pair look
 * ~95% alike, so only the differing values are compared. Unparseable input
 * falls back to whole-string similarity; identical args score 1.
 */
function argsDiffSimilarity(aCanon, bCanon) {
    const a = String(aCanon || ''), b = String(bCanon || '');
    if (a === b) return 1;
    let ao, bo;
    try { ao = JSON.parse(a); bo = JSON.parse(b); } catch (_) { return argsSimilarity(a, b); }
    if (!ao || !bo || typeof ao !== 'object' || typeof bo !== 'object' || Array.isArray(ao) || Array.isArray(bo)) {
        return argsSimilarity(a, b);
    }
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    const da = [], db = [];
    for (const k of [...keys].sort()) {
        const va = ao[k] === undefined ? '' : stableStringify(ao[k]);
        const vb = bo[k] === undefined ? '' : stableStringify(bo[k]);
        if (va !== vb) { da.push(va); db.push(vb); }
    }
    if (!da.length) return 1;
    return argsSimilarity(da.join('\n'), db.join('\n'));
}

/** True when EVERY pair in `list` (canonical arg strings) is below `threshold`. */
function allPairsDissimilar(list, threshold = 0.6) {
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            if (argsDiffSimilarity(list[i], list[j]) >= threshold) return false;
        }
    }
    return list.length > 1;
}

// ---------------------------------------------------------------------------
// Progress ledger
// ---------------------------------------------------------------------------

function envInt(name, dflt) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
}
function envFloat(name, dflt) {
    const v = parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : dflt;
}

// Points per non-progress call. A refusal (the model re-issued something a
// guard already flagged) and a byte-identical repeat of an earlier result
// (nothing new could possibly have been learned) weigh double; a fresh
// attempt that merely failed or came back empty weighs one — a model working
// through a list of lookups that legitimately come back negative should not
// hit the checkpoint as fast as one ignoring the guards.
const WEIGHT_FRESH = 1;
const WEIGHT_REPEAT = 2;
const WEIGHT_REFUSED = 2;

/**
 * Turn-scoped progress ledger.
 *
 * "Progress" = a call that succeeded, returned a non-empty result, AND whose
 * result bytes have not been seen earlier in this turn. Everything else is
 * non-progress and accumulates weighted points; any progress call resets the
 * streak. The caller reads `shouldAdvise()` (attach a warning to the tool
 * result, non-blocking) and `shouldCheckpoint()` (restate the task; the
 * second checkpoint-level hit forces synthesis), then `reset()` after acting.
 *
 * The byte-identical test uses the FULL result hash on purpose (not the
 * VOLATILE-stripped outcome signature): stripping echoed fields makes a
 * download of ten different URLs look like ten identical receipts — fine for
 * an "unproductive" check that also requires the outcome to be empty, wrong
 * for a progress test, which must stay conservative.
 */
function makeProgressLedger(opts = {}) {
    const adviseAfter = opts.adviseAfter ?? envInt('LOOP_STAGNATION_ADVISE', 5);
    const checkpointAfter = opts.checkpointAfter ?? envInt('LOOP_STAGNATION_CHECKPOINT', 8);
    const seenResults = new Set();
    let stale = 0;          // weighted points since the last progress call
    let staleCalls = 0;     // raw number of calls since the last progress call
    let totalCalls = 0;     // executed + refused, whole turn
    let progressCalls = 0;
    let resets = 0;
    let lastAdviseAt = -1;  // staleCalls value at the last advisory
    let tally = freshTally();

    function freshTally() {
        return { failed: 0, empty: 0, repeated: 0, refused: 0, byTool: new Map() };
    }
    function bump(kind, toolName, weight) {
        stale += weight;
        staleCalls++;
        tally[kind]++;
        const t = tally.byTool.get(toolName) || { failed: 0, empty: 0, repeated: 0, refused: 0, total: 0 };
        t[kind]++;
        t.total++;
        tally.byTool.set(toolName, t);
    }

    return {
        get adviseAfter() { return adviseAfter; },
        get checkpointAfter() { return checkpointAfter; },
        get stale() { return stale; },
        get staleCalls() { return staleCalls; },
        get totalCalls() { return totalCalls; },
        get progressCalls() { return progressCalls; },
        get resets() { return resets; },

        /**
         * Record an EXECUTED call. Returns { progress, kind } where kind is
         * 'progress' | 'failed' | 'empty' | 'repeated'.
         */
        record({ toolName, resultHash, failed, empty }) {
            totalCalls++;
            const name = toolName || 'tool';
            const hash = String(resultHash || '');
            const seen = hash ? seenResults.has(hash) : false;
            if (hash) seenResults.add(hash);
            if (failed) { bump('failed', name, seen ? WEIGHT_REPEAT : WEIGHT_FRESH); return { progress: false, kind: 'failed' }; }
            if (empty) { bump('empty', name, seen ? WEIGHT_REPEAT : WEIGHT_FRESH); return { progress: false, kind: 'empty' }; }
            if (seen) { bump('repeated', name, WEIGHT_REPEAT); return { progress: false, kind: 'repeated' }; }
            stale = 0;
            staleCalls = 0;
            lastAdviseAt = -1;
            tally = freshTally();
            progressCalls++;
            return { progress: true, kind: 'progress' };
        },

        /** Record a call a guard REFUSED to run (nudge, quarantine, prohibition). */
        noteRefused(toolName) {
            totalCalls++;
            bump('refused', toolName || 'tool', WEIGHT_REFUSED);
        },

        /**
         * Advisory cadence: first at `adviseAfter` non-progress calls, then
         * every other call, so a stagnating turn is warned repeatedly but
         * the tool results are not spammed on every call.
         */
        shouldAdvise() {
            if (staleCalls < adviseAfter) return false;
            if (lastAdviseAt < 0) return true;
            return staleCalls - lastAdviseAt >= 2;
        },
        markAdvised() { lastAdviseAt = staleCalls; },

        shouldCheckpoint() { return stale >= checkpointAfter; },

        /** After a checkpoint: fresh streak, memory of results kept. */
        reset() {
            stale = 0;
            staleCalls = 0;
            lastAdviseAt = -1;
            tally = freshTally();
            resets++;
        },

        /** Snapshot of the current non-progress streak for messages/logs. */
        summary() {
            const parts = [];
            if (tally.failed) parts.push(`${tally.failed} failed`);
            if (tally.empty) parts.push(`${tally.empty} returned nothing`);
            if (tally.repeated) parts.push(`${tally.repeated} repeated an earlier result byte-for-byte`);
            if (tally.refused) parts.push(`${tally.refused} refused by the loop guard`);
            const byTool = [...tally.byTool.entries()]
                .sort((a, b) => b[1].total - a[1].total)
                .map(([n, t]) => `${n}×${t.total}`);
            return {
                staleCalls,
                stale,
                text: parts.join(', ') || 'no new information',
                byToolText: byTool.join(', '),
                worstTool: byTool.length ? [...tally.byTool.entries()].sort((a, b) => b[1].total - a[1].total)[0][0] : null,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Repetition detectors
// ---------------------------------------------------------------------------

// Unique word-trigram ratio over a text window. Looping text reuses the same
// trigrams (low ratio); progressing text keeps minting new ones (high ratio).
function uniqueTrigramRatio(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 3) return 1; // too little to judge — treat as diverse
    const seen = new Set();
    let total = 0;
    for (let i = 0; i + 2 < words.length; i++) {
        seen.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
        total++;
    }
    return total ? seen.size / total : 1;
}

// Split a buffer into sentence/line segments, keeping the RAW offset of each
// segment so a detector can hand back a cut position in the original text.
// Segments shorter than minLen (after whitespace collapse) are dropped — they
// are structural noise (list bullets, "}", short labels) that legitimately
// repeats.
function segmentize(text, startOffset, minLen) {
    const out = [];
    const re = /[^\n.!?]+/g;
    re.lastIndex = startOffset;
    let m;
    while ((m = re.exec(text)) !== null) {
        const raw = m[0];
        const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ');
        if (norm.length >= minLen) {
            // Offset of the first non-space char of the raw segment.
            const lead = raw.length - raw.trimStart().length;
            out.push({ norm, idx: m.index + lead });
        }
        if (m[0].length === 0) re.lastIndex++;
    }
    return out;
}

/**
 * Generic verbatim-repetition detector over a streamed buffer. Returns a
 * function `detect(buffer, startOffset)` → `{ reason, cutAt } | null`.
 *
 * cfg:
 *   granularity     re-scan only after this many new chars (SSE hot path)
 *   tailChars       window for the tail-only checks
 *   phrases         [{pattern, name}] known loop phrases (tail, ≥ phraseMin)
 *   phraseMin
 *   segMinLen       min normalized segment length to count
 *   segMinRepeat    one segment repeated at least this many times in the tail…
 *   segRatio        …and making up at least this share of the tail's segments
 *   recurrenceWindow / recurrenceRatio — GLOBAL check: of the last N segments
 *                   of the round, this share already occurred EARLIER in the
 *                   round. Catches "A B C D A B C D …" cycles where no single
 *                   segment dominates the tail (each is 1/N of it) and the
 *                   trigram diversity stays high inside any 4k window.
 *   hardCap/lowDiversity, absCap/absDiversity — length caps gated on trigram
 *                   diversity (0 disables a cap).
 *
 * `cutAt` is the absolute offset where the repetition BEGAN (the second
 * occurrence of the first repeated segment), so a caller can keep the good
 * prefix and discard the loop. null when it cannot be located.
 */
function makeRepetitionDetector(cfg) {
    const granularity = cfg.granularity ?? 1500;
    const tailChars = cfg.tailChars ?? 4000;
    const phrases = cfg.phrases || [];
    const phraseMin = cfg.phraseMin ?? 8;
    const segMinLen = cfg.segMinLen ?? 20;
    const segMinRepeat = cfg.segMinRepeat ?? 6;
    const segRatio = cfg.segRatio ?? 0.40;
    const recurrenceWindow = cfg.recurrenceWindow ?? 0;
    const recurrenceRatio = cfg.recurrenceRatio ?? 0.6;
    const hardCap = cfg.hardCap ?? 0;
    const lowDiversity = cfg.lowDiversity ?? 0.40;
    const absCap = cfg.absCap ?? 0;
    const absDiversity = cfg.absDiversity ?? 0.55;

    let lastCheckAt = 0;

    // Offset of the SECOND occurrence of `norm` among segs (the point where
    // the repetition started), or null.
    const secondOccurrence = (segs, norm) => {
        let seenOnce = false;
        for (const s of segs) {
            if (s.norm !== norm) continue;
            if (seenOnce) return s.idx;
            seenOnce = true;
        }
        return null;
    };

    return function detect(buffer, startOffset = 0) {
        const text = String(buffer || '');
        const len = text.length - startOffset;
        if (len - lastCheckAt < granularity) return null;
        lastCheckAt = len;
        const tailStart = Math.max(startOffset, text.length - tailChars);
        const tail = text.slice(tailStart);

        // 1. Known loop phrases in the tail.
        for (const { pattern, name } of phrases) {
            pattern.lastIndex = 0;
            const matches = tail.match(pattern);
            if (matches && matches.length >= phraseMin) {
                return { reason: `"${name}" repeated ${matches.length}x in recent output`, cutAt: null };
            }
        }

        // 2. Verbatim-segment repetition inside the tail.
        const tailSegs = segmentize(text, tailStart, segMinLen);
        if (tailSegs.length >= segMinRepeat) {
            const counts = new Map();
            let top = 0, topSeg = '';
            for (const s of tailSegs) {
                const c = (counts.get(s.norm) || 0) + 1;
                counts.set(s.norm, c);
                if (c > top) { top = c; topSeg = s.norm; }
            }
            if (top >= segMinRepeat && top / tailSegs.length >= segRatio) {
                // Locate the cut in the WHOLE round (the first repeat may be
                // before the tail window).
                const allSegs = segmentize(text, startOffset, segMinLen);
                return {
                    reason: `the same segment repeated ${top}x ("${topSeg.slice(0, 40)}…")`,
                    cutAt: secondOccurrence(allSegs, topSeg),
                };
            }
        }

        // 3. Global recurrence: the recent segments are re-runs of earlier ones.
        if (recurrenceWindow > 0) {
            const allSegs = segmentize(text, startOffset, segMinLen);
            if (allSegs.length >= recurrenceWindow * 2) {
                const cut = allSegs.length - recurrenceWindow;
                const earlier = new Set();
                for (let i = 0; i < cut; i++) earlier.add(allSegs[i].norm);
                let hits = 0;
                for (let i = cut; i < allSegs.length; i++) if (earlier.has(allSegs[i].norm)) hits++;
                if (hits / recurrenceWindow >= recurrenceRatio) {
                    // Cut where the FIRST recurring segment of the whole round
                    // re-appears — i.e. the earliest second occurrence.
                    let cutAt = null;
                    const seen = new Set();
                    for (const s of allSegs) {
                        if (seen.has(s.norm)) { cutAt = s.idx; break; }
                        seen.add(s.norm);
                    }
                    return {
                        reason: `${hits} of the last ${recurrenceWindow} segments repeat earlier ones (cycling without progress)`,
                        cutAt,
                    };
                }
            }
        }

        // 4/5. Length caps, diversity-gated (a genuinely diverse long trace
        // never trips — only low-entropy rambling does).
        if (hardCap > 0 && len > hardCap) {
            const ratio = uniqueTrigramRatio(tail);
            if (absCap > 0 && len > absCap && ratio < absDiversity) {
                return { reason: `absolute cap (${absCap}+ chars, low-diversity tail ${ratio.toFixed(2)})`, cutAt: null };
            }
            if (ratio < lowDiversity) {
                return { reason: `${hardCap}+ chars of low-diversity output (trigram diversity ${ratio.toFixed(2)})`, cutAt: null };
            }
        }
        return null;
    };
}

// --- Reasoning stream ------------------------------------------------------
// Env-tunable (no rebuild); recovery is graceful (nudge + re-stream, then
// synthesis), so these can be tuned per deployment without risking a
// dead-stopped turn.
const REASONING_HARD_CAP = envInt('REASONING_HARD_CAP', 15000);
const REASONING_ABSOLUTE_CAP = envInt('REASONING_ABSOLUTE_CAP', 40000);
const REASONING_LOOP_MAX_RETRIES = envInt('REASONING_LOOP_MAX_RETRIES', 2);
const REASONING_CHECK_GRANULARITY = 1500;
const REASONING_LOW_DIVERSITY = 0.40;        // soft-cap diversity gate (strict)
const REASONING_ABSOLUTE_DIVERSITY = 0.55;   // absolute-cap diversity gate (looser)
const REASONING_REPEAT_MIN = 6;
const REASONING_REPEAT_MIN_LEN = 20;
const REASONING_REPEAT_RATIO = 0.40;
const REASONING_RECURRENCE_WINDOW = envInt('REASONING_RECURRENCE_WINDOW', 24);
const REASONING_RECURRENCE_RATIO = envFloat('REASONING_RECURRENCE_RATIO', 0.6);
const REASONING_LOOP_PHRASES = [
    { pattern: /\bWait,\s*I\s+will\b/gi, name: 'Wait, I will' },
    { pattern: /\bLet'?s\s+(go|start)\b/gi, name: "Let's go/start" },
    { pattern: /\bOkay,?\s+let'?s\b/gi, name: "Okay, let's" },
];

/**
 * Reasoning-stream loop detector (one per ROUND — the granularity cursor
 * resets). Returns a reason STRING or null, the contract the stream handler
 * has always used. Signals: known loop phrases; one step restated 6+ times
 * and ≥40% of the tail; the last 24 steps mostly re-runs of earlier steps
 * (cycling); diversity-gated length caps.
 */
function makeReasoningLoopDetector() {
    const detect = makeRepetitionDetector({
        granularity: REASONING_CHECK_GRANULARITY,
        tailChars: 4000,
        phrases: REASONING_LOOP_PHRASES,
        phraseMin: 8,
        segMinLen: REASONING_REPEAT_MIN_LEN,
        segMinRepeat: REASONING_REPEAT_MIN,
        segRatio: REASONING_REPEAT_RATIO,
        recurrenceWindow: REASONING_RECURRENCE_WINDOW,
        recurrenceRatio: REASONING_RECURRENCE_RATIO,
        hardCap: REASONING_HARD_CAP,
        lowDiversity: REASONING_LOW_DIVERSITY,
        absCap: REASONING_ABSOLUTE_CAP,
        absDiversity: REASONING_ABSOLUTE_DIVERSITY,
    });
    return function (reasoningBuffer, startOffset = 0) {
        const hit = detect(reasoningBuffer, startOffset);
        return hit ? hit.reason : null;
    };
}

// --- Content stream --------------------------------------------------------
// Visible output. Stricter than reasoning: real answers legitimately carry
// repeated structure (table rows, list prefixes, code), so a segment must be
// longer, repeat more, and dominate the tail harder before it counts. No
// phrase list and no length caps — a long diverse answer is never clipped;
// only verbatim repetition fires.
const CONTENT_LOOP_MIN_REPEAT = envInt('CONTENT_LOOP_MIN_REPEAT', 8);
const CONTENT_LOOP_RATIO = envFloat('CONTENT_LOOP_RATIO', 0.5);
const CONTENT_LOOP_MIN_LEN = envInt('CONTENT_LOOP_MIN_LEN', 24);
const CONTENT_LOOP_RECURRENCE_WINDOW = envInt('CONTENT_LOOP_RECURRENCE_WINDOW', 24);
const CONTENT_LOOP_RECURRENCE_RATIO = envFloat('CONTENT_LOOP_RECURRENCE_RATIO', 0.75);

/**
 * Content-stream loop detector (one per round). Returns `{reason, cutAt}` or
 * null; cutAt is where the repetition began so the caller can rewind the
 * visible answer to its last good character.
 */
function makeContentLoopDetector() {
    return makeRepetitionDetector({
        granularity: 1200,
        tailChars: 4000,
        phrases: [],
        segMinLen: CONTENT_LOOP_MIN_LEN,
        segMinRepeat: CONTENT_LOOP_MIN_REPEAT,
        segRatio: CONTENT_LOOP_RATIO,
        recurrenceWindow: CONTENT_LOOP_RECURRENCE_WINDOW,
        recurrenceRatio: CONTENT_LOOP_RECURRENCE_RATIO,
        hardCap: 0,
        absCap: 0,
    });
}


// --- Tool-call ARGUMENT stream ---------------------------------------------
// The third place a model can loop, and the one nothing bounded: the JSON
// arguments of a tool call it is still emitting. Live incident (an OSINT turn,
// 2026-08-27): a run_python `code` argument grew to 125k chars / 1873 lines of
// `print("RUST:", len(re.findall(r'\brust\b', html)))` — every line a NEW
// keyword, so no verbatim-segment detector fires and the word-trigram
// diversity stays high — until the round hit TOOL_ROUND_MAX_TOKENS (~21 min at
// local speeds), was EXECUTED (SyntaxError), and then happened AGAIN. Two such
// rounds put ~64k tokens of garbage into the context and left 1026 tokens of
// output budget. The user stopped the turn after 50 minutes with no answer.
//
// The signal that survives a varying keyword is the SHAPE of the lines: with
// string/number/identifier literals normalized away, the loop is one shape
// repeated forever. Legit code has bounded runs of same-shape statements, and
// DATA rows (a chart array, a CSV, a dict literal) are excluded from the
// shape test — only STATEMENT lines (identifier-led) count — so an inline
// dataset never trips it. Three checks, cheapest first, all gated on a
// minimum size so short calls are never examined:
//   1. absolute size (TOOL_ARGS_MAX_CHARS) — no chat tool argument is
//      legitimately this big; the skill prompts say to chunk via
//      create_file + append_to_file / codeFile;
//   2. one normalized line verbatim-repeated across most of the tail;
//   3. the last TOOL_ARGS_SHAPE_WINDOW statement lines collapse to
//      ≤ TOOL_ARGS_SHAPE_MAX_DISTINCT shapes.
const TOOL_ARGS_LOOP_MIN_CHARS = envInt('TOOL_ARGS_LOOP_MIN_CHARS', 6000);
const TOOL_ARGS_MAX_CHARS = envInt('TOOL_ARGS_MAX_CHARS', 80000);
const TOOL_ARGS_SHAPE_WINDOW = envInt('TOOL_ARGS_SHAPE_WINDOW', 40);
const TOOL_ARGS_SHAPE_MAX_DISTINCT = envInt('TOOL_ARGS_SHAPE_MAX_DISTINCT', 3);
const TOOL_ARGS_CHECK_GRANULARITY = 1500;
const TOOL_ARGS_VERBATIM_MIN = 12;
const TOOL_ARGS_VERBATIM_RATIO = 0.5;

// Normalize a code/text line to its structural shape: string literals → S,
// numbers → N, identifiers → I (keywords kept so `print(S, len(I(I, I)))` and
// `x = foo(S)` differ), whitespace collapsed. Returns null for a line that is
// not statement-shaped (data rows, brackets, comments, blank) so the shape
// window only ever counts statements.
const SHAPE_KEYWORDS = new Set(['print', 'len', 're', 'findall', 'search', 'match', 'sub', 'return', 'if', 'else', 'elif',
    'for', 'while', 'in', 'and', 'or', 'not', 'import', 'from', 'def', 'class', 'try', 'except', 'with', 'as',
    'const', 'let', 'var', 'function', 'await', 'async', 'console', 'log', 'require', 'json', 'str', 'int', 'float',
    'list', 'dict', 'set', 'open', 'read', 'write', 'append', 'push', 'map', 'filter', 'join', 'split', 'strip']);
function lineShape(line) {
    const t = String(line || '').trim();
    if (!t || t.length < 8) return null;
    if (/^(#|\/\/|\/\*|\*|["'`{}\[\]()0-9,.-])/.test(t)) return null;   // comment / data / bracket line
    if (!/^[A-Za-z_$][\w$.]*\s*[(=:.\[]/.test(t) && !/^[A-Za-z_$][\w$.]*\s+[A-Za-z_$(]/.test(t)) return null;
    let s = t
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, 'S')
        .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
        .replace(/\b[A-Za-z_$][\w$]*\b/g, (w) => (SHAPE_KEYWORDS.has(w.toLowerCase()) ? w.toLowerCase() : 'I'))
        .replace(/\s+/g, '');
    return s;
}

// Examine an argument string (or a code body) for degeneration. Returns a
// reason string or null. Pure; safe on any input size (line-bounded work).
function toolArgsDegenerationReason(text, opts = {}) {
    const minChars = opts.minChars ?? TOOL_ARGS_LOOP_MIN_CHARS;
    const maxChars = opts.maxChars ?? TOOL_ARGS_MAX_CHARS;
    const window = opts.shapeWindow ?? TOOL_ARGS_SHAPE_WINDOW;
    const maxDistinct = opts.shapeMaxDistinct ?? TOOL_ARGS_SHAPE_MAX_DISTINCT;
    const s = String(text || '');
    if (maxChars > 0 && s.length > maxChars) {
        return `${s.length} characters of arguments — far beyond what any tool call needs (limit ${maxChars})`;
    }
    if (s.length < minChars) return null;
    // Work on the tail only: the loop is at the end, and this runs on the SSE
    // hot path. Streamed JSON args carry "\n" as an escape — unescape so the
    // line structure is visible while the call is still being emitted.
    const tail = s.slice(-24000).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    const lines = tail.split('\n');
    // 2. Verbatim: one normalized line dominating the last 60 lines.
    const recent = lines.slice(-60).map(l => l.trim().replace(/\s+/g, ' ')).filter(l => l.length >= 16);
    if (recent.length >= TOOL_ARGS_VERBATIM_MIN) {
        const counts = new Map();
        let top = 0, topLine = '';
        for (const l of recent) { const c = (counts.get(l) || 0) + 1; counts.set(l, c); if (c > top) { top = c; topLine = l; } }
        if (top >= TOOL_ARGS_VERBATIM_MIN && top / recent.length >= TOOL_ARGS_VERBATIM_RATIO) {
            return `the same line repeated ${top}x ("${topLine.slice(0, 50)}…")`;
        }
    }
    // 3. Shape: the last `window` STATEMENT lines are near-identical in structure.
    const shapes = [];
    for (let i = lines.length - 1; i >= 0 && shapes.length < window; i--) {
        const sh = lineShape(lines[i]);
        if (sh) shapes.push(sh);
    }
    if (shapes.length >= window) {
        const distinct = new Set(shapes).size;
        if (distinct <= maxDistinct) {
            return `${window} consecutive statements of the same shape (${distinct} distinct pattern${distinct === 1 ? '' : 's'}) — a keyword-enumeration loop, not a program`;
        }
    }
    return null;
}

/**
 * Per-round detector over STREAMING tool-call arguments. `detect(index,
 * name, argsSoFar)` re-examines a call only after TOOL_ARGS_CHECK_GRANULARITY
 * new chars (per index) and returns `{ reason, name, chars }` or null.
 */
function makeToolArgsLoopDetector() {
    const lastCheck = new Map();
    return function detect(index, name, args) {
        const len = String(args || '').length;
        const prev = lastCheck.get(index) || 0;
        if (len - prev < TOOL_ARGS_CHECK_GRANULARITY) return null;
        lastCheck.set(index, len);
        const reason = toolArgsDegenerationReason(args);
        return reason ? { reason, name: name || 'tool', chars: len } : null;
    };
}

// --- Interpreter usage classifiers ----------------------------------------
// Does a run_python / run_node program make its own network requests? Used to
// steer the model to the purpose-built retrieval tools (web / http_request /
// dns_lookup) instead of hand-rolling HTTP in a sandbox script — the OSINT
// turn wrote 24 such scripts in a row, each a fresh urllib client with
// hand-built headers, where one `web` call reads the same page (with TLS,
// bot-wall and JS handling the script cannot have).
const NET_CODE_RE = /\b(urllib\.request|urllib\.parse\.urlencode|urlopen\(|http\.client|\brequests\.(get|post|head|put|delete|request|Session)\b|\bhttpx\b|\baiohttp\b|socket\.(create_connection|getaddrinfo|gethostbyname|connect)|ssl\.(create_default_context|_create_unverified_context)|dns\.resolver|\bfetch\s*\(\s*['"`]?https?:|\baxios\b|\bhttps?\.(get|request)\s*\(|require\(['"]node-fetch['"]\)|\bgot\s*\(\s*['"]https?:|\bcurl\s+-|subprocess\.[a-z_]+\([^)]*\b(curl|wget|dig|nslookup|whois)\b|\bwhois\b|\bnslookup\b)/;
function codeMakesNetworkRequests(code) {
    const s = String(code || '');
    if (!s) return false;
    return NET_CODE_RE.test(s);
}
// URLs / hostnames a network script targets (for the "use the web tool on
// these instead" hint). Bounded and de-duplicated.
function codeNetworkTargets(code, cap = 8) {
    const s = String(code || '');
    const out = [];
    const seen = new Set();
    const push = (v) => { if (v && !seen.has(v) && out.length < cap) { seen.add(v); out.push(v); } };
    for (const m of s.matchAll(/https?:\/\/[^\s"'`<>)\]},{]+/g)) push(m[0].replace(/[.,;:]+$/, ''));
    for (const m of s.matchAll(/\b(?:host|hostname|domain)\s*=\s*["']([a-z0-9.-]+\.[a-z]{2,})["']/gi)) push(m[1]);
    return out;
}

module.exports = {
    canonicalArgs,
    stableStringify,
    argsSimilarity,
    argsDiffSimilarity,
    allPairsDissimilar,
    makeProgressLedger,
    uniqueTrigramRatio,
    segmentize,
    makeRepetitionDetector,
    makeReasoningLoopDetector,
    makeContentLoopDetector,
    makeToolArgsLoopDetector,
    toolArgsDegenerationReason,
    lineShape,
    codeMakesNetworkRequests,
    codeNetworkTargets,
    TOOL_ARGS_MAX_CHARS,
    TOOL_ARGS_LOOP_MIN_CHARS,
    REASONING_HARD_CAP,
    REASONING_ABSOLUTE_CAP,
    REASONING_LOOP_MAX_RETRIES,
    REASONING_LOOP_PHRASES,
    WEIGHT_FRESH,
    WEIGHT_REPEAT,
    WEIGHT_REFUSED,
};
