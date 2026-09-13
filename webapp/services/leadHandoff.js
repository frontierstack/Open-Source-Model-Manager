'use strict';
// ───────────────────────────────────────────────────────────────────────────
// Two models on one task.
//
//     user ask
//        ↓
//     PRIMARY (fast)   answers it outright — this is the default and it is why
//        ↓             a quick question stays quick. When the ask is
//        ↓             SUBSTANTIAL it instead does a short first pass and
//        ↓             hands over a brief.
//     SECONDARY (strong) takes the lead and writes the real answer
//        ├─→ "find me the canvas API docs"  ─┐
//        │                                   ├─ the PRIMARY runs these
//        ├─→ "run the file and report back"  ─┘  CONCURRENTLY
//        └─→ results arrive mid-turn, it keeps writing
//        ↓
//     final answer
//
// The substantial-work gate is the whole point of `mode: 'auto'`: routing a
// one-line factual question through a model 2.8× slower per token is a worse
// experience, not a better one. `isSubstantialWork` is therefore conservative —
// it wants evidence of building, analysing, or multi-step work before the
// secondary is allowed to take over.
// ───────────────────────────────────────────────────────────────────────────

const MODES = ['off', 'auto', 'always'];

// Strip the runtime's own injected notes before classifying — they are the
// same on every turn and would make everything look substantial.
const SYSTEM_NOTE_RE = /\[SYSTEM:[\s\S]*?\]/g;
// The chat wraps an upload as "=== FILE n: name ===\n<content>\n=== END FILE n ===".
// Strip the WHOLE block: its contents are the user's data, not their request,
// and a pasted source file is full of build verbs and artifact nouns.
const FILE_BLOCK_RE = /===\s*FILE\s+\d+\b[\s\S]*?(?:===\s*END\s+FILE\s+\d+\s*===|$)/gi;

function cleanAsk(text) {
    return String(text || '')
        .replace(SYSTEM_NOTE_RE, ' ')
        .replace(FILE_BLOCK_RE, ' ')
        .replace(/^\/(no_?think|think)\b/i, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// "Do this together" / "use both models" — an explicit request always wins,
// including over the substantial-work test.
const EXPLICIT_RE = /\b(work together|both models|two models|team up|with the (?:big|bigger|large|larger|strong|stronger|smart|smarter) model|hand (?:it |this )?off|use the (?:expert|stronger|bigger) model|pair (?:up|on)|collaborat\w*)\b/i;
// "Do it yourself / quickly" — an explicit opt-out.
const EXPLICIT_OFF_RE = /\b(just you|yourself only|don'?t (?:hand|pass) (?:it |this )?off|no (?:hand-?off|collaboration)|quick(?:ly)? answer|one liner|one-liner|short answer|just tell me)\b/i;

// Security / forensics work is never a quick lookup: it means reading files,
// greping for indicators and reasoning about intent. Reported by the user after
// a repo malware review ran entirely on the primary.
const SECURITY_RE = /\b(malware|malicious|trojan|backdoor|ransomware|spyware|keylogger|rootkit|payload|exfiltrat\w*|obfuscat\w*|deobfuscat\w*|c2|command[- ]and[- ]control|beacon\w*|phish\w*|exploit|vulnerab\w*|cve-\d|ioc|indicators? of compromise|threat intel\w*|forensic\w*|reverse[- ]engineer\w*|suspicious|compromised|breach)\b/i;
// A URL or repo reference plus something to DO with it — fetching a page or a
// repository and working through it is real work, whatever the verb.
const URL_RE = /\b(https?:\/\/\S+|github\.com\/\S+|gitlab\.com\/\S+|npmjs\.com\/\S+|\S+\.(?:com|org|net|io|dev|ai|co|gov|edu)\/\S+)/i;
const FETCH_VERB = /\b(check|scan|analy[sz]e|audit|review|inspect|examine|read|download|fetch|clone|crawl|browse|go through|look (?:at|into|through)|dig (?:into|through)|work through|walk through|vet|verify|assess|evaluate|summari[sz]e|extract|pull)\b/i;
// Research that needs several sources and a synthesis, as opposed to one fact.
const RESEARCH_RE = /\b(what (?:are )?people (?:are )?(?:saying|think)|latest (?:news|developments|state)|state of|compare|comparison|pros and cons|tradeoffs?|landscape|survey|round[- ]?up|options for|alternatives to|best practices|how do (?:i|we|you)\b.{0,60}\b(?:set up|build|implement|configure|deploy))\b/i;

// Verbs that mean the model is about to PRODUCE something substantial.
const BUILD_VERB = /\b(build|write|code|implement|create|make|develop|design|refactor|rewrite|port|migrate|scaffold|generate|produce|draft|compose|architect|automate|debug|fix|optimi[sz]e|improve|extend|add (?:a|an|the)|convert|translate)\b/i;
// Things worth building. Kept concrete: a "make me a sandwich" joke should not
// route through two models.
const ARTIFACT = /\b(app|application|game|script|program|tool|library|module|package|component|page|website|site|web ?app|api|endpoint|server|service|bot|parser|scraper|crawler|pipeline|workflow|automation|dashboard|report|spreadsheet|document|pdf|docx|presentation|slide|chart|graph|diagram|test|tests|suite|class|function|algorithm|model|schema|database|query|migration|config|dockerfile|ci|readme|plugin|extension|patch|feature|prototype|mock ?up|wireframe|landing page|form|ui|frontend|backend|cli|repo|repository|codebase|project|gist|commit|branch|binary|executable|archive|capture|dataset|dump|log|logs|file|files|folder|directory|code|bug|bugs|stack ?trace|regression|crash)\b/i;
// Analysis / investigation work.
const ANALYSIS_VERB = /\b(analy[sz]e|audit|review|investigate|inspect|examine|diagnose|troubleshoot|compare|contrast|evaluate|assess|benchmark|profile|research|study|summari[sz]e|explain how|walk me through|figure out|work out|reverse[- ]engineer|decompile|trace|scan|deobfuscat\w*|cross[- ]reference|go through|dig (?:into|through)|look (?:into|through)|work through|walk through|vet)\b/i;
// Multi-part shapes.
const MULTI_STEP = /\b(step[- ]by[- ]step|first.{0,40}\bthen\b|and then|after that|as well as|in addition|multiple|several|each of|for each|all of the|one by one|end[- ]to[- ]end|from scratch|full(?:y)? working|complete(?:ly)?|comprehensive|in depth|in-depth|thorough)\b/i;
// A question that is just a lookup.
const LOOKUP_RE = /^(?:what|who|when|where|which|how (?:much|many|old|far|long)|is|are|was|were|does|do|did|can|could|should|will|would|has|have)\b/i;

const CODE_FENCE_RE = /```|\bfunction\s+\w+\s*\(|\bclass\s+\w+|\bdef\s+\w+\s*\(|=>|;\s*$/m;

// What KIND of things were attached, read off the chat's own upload markers
// ("=== FILE 1: capture.pcap (2.1 MB) ==="). Used only to tell a heavy
// attachment (repo, capture, spreadsheet) from a snapshot someone pasted.
const EXT_KIND = [
    [/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i, 'archive'],
    [/\.(pcap|pcapng|cap)$/i, 'capture'],
    [/\.(csv|tsv|xlsx?|ods)$/i, 'spreadsheet'],
    [/\.(pdf|docx?|odt|rtf|pptx?)$/i, 'document'],
    [/\.(log|txt|md|json|ya?ml|xml|ini|conf|toml)$/i, 'log'],
    [/\.(js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|sql|swift|scala|sol|vue|svelte)$/i, 'code'],
    [/\.(png|jpe?g|gif|bmp|webp|tiff?|heic|svg)$/i, 'image'],
    [/\.(mp3|wav|m4a|flac|ogg|mp4|mov|mkv|webm|avi)$/i, 'media'],
];
function attachmentKindsFromText(text) {
    const kinds = new Set();
    const re = /===\s*FILE\s+\d+\s*:\s*([^=\n(]+?)\s*(?:\([^)]*\))?\s*===/gi;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const name = m[1].trim();
        const hit = EXT_KIND.find(([rx]) => rx.test(name));
        kinds.add(hit ? hit[1] : 'file');
    }
    return [...kinds];
}

// Words in the ask, ignoring anything the runtime injected.
function askLength(text) {
    return cleanAsk(text).split(/\s+/).filter(Boolean).length;
}

/**
 * Is this turn substantial enough that two models should work it together?
 * Conservative on purpose — a false positive costs the user real seconds.
 *
 * @returns {{substantial:boolean, reason:string, explicit:boolean}}
 */
function isSubstantialWork({ text, hasAttachments = false, attachmentKinds = [], minWords = 6 } = {}) {
    const ask = cleanAsk(text);
    if (!ask) return { substantial: false, reason: 'empty', explicit: false };

    if (EXPLICIT_OFF_RE.test(ask)) return { substantial: false, reason: 'user asked for a quick single-model answer', explicit: true };
    if (EXPLICIT_RE.test(ask)) return { substantial: true, reason: 'user asked for the models to work together', explicit: true };

    const words = ask.split(/\s+/).filter(Boolean).length;
    const build = BUILD_VERB.test(ask) && ARTIFACT.test(ask);
    const analysis = ANALYSIS_VERB.test(ask);
    const multi = MULTI_STEP.test(ask);
    const code = CODE_FENCE_RE.test(ask);

    // A file/repo/archive to work through is substantial on its own; a plain
    // image usually is not (OCR, "what is this") unless the ask says otherwise.
    const heavyAttachment = hasAttachments && attachmentKinds.some(k => /archive|repo|code|pdf|spreadsheet|csv|document|data|capture|log/i.test(String(k)));

    if (build) return { substantial: true, reason: 'builds an artifact', explicit: false };
    if (heavyAttachment) return { substantial: true, reason: 'works through an attached file', explicit: false };
    // Security work is never a quick lookup — reading files, greping for
    // indicators and judging intent is exactly what the stronger model is for.
    if (SECURITY_RE.test(ask)) return { substantial: true, reason: 'security or forensics work', explicit: false };
    // Something to fetch AND something to do with it.
    if (URL_RE.test(ask) && (FETCH_VERB.test(ask) || BUILD_VERB.test(ask) || ANALYSIS_VERB.test(ask))) {
        return { substantial: true, reason: 'works through a linked page or repo', explicit: false };
    }
    // An analysis verb aimed at a concrete THING needs no length test — "scan
    // the extracted files" is four words and is real work.
    if (analysis && ARTIFACT.test(ask)) return { substantial: true, reason: 'analysis or investigation', explicit: false };
    // Same for fetching one: "download this repo and tell me if it is safe".
    if (FETCH_VERB.test(ask) && ARTIFACT.test(ask) && words >= 5) {
        return { substantial: true, reason: 'fetches and works through something', explicit: false };
    }
    if (RESEARCH_RE.test(ask) && words >= 5) return { substantial: true, reason: 'multi-source research', explicit: false };
    if (analysis && (words >= minWords || hasAttachments)) return { substantial: true, reason: 'analysis or investigation', explicit: false };
    if (multi && words >= minWords) return { substantial: true, reason: 'multi-step request', explicit: false };
    if (code && words >= 12) return { substantial: true, reason: 'works on supplied code', explicit: false };

    // Everything else — including a long-winded factual question — stays on one
    // fast model.
    if (LOOKUP_RE.test(ask)) return { substantial: false, reason: 'lookup question', explicit: false };
    return { substantial: false, reason: 'no substantial-work signal', explicit: false };
}

/**
 * Plan the two-model turn.
 *
 * The PRIMARY answers by default — that is what keeps trivial turns fast. The
 * SECONDARY takes over and writes the answer only when `mode` says so:
 * 'off' never, 'auto' only on substantial work, 'always' every turn.
 *
 * The pair only applies when the turn's model IS one of the two. A user who
 * deliberately picks some third model in the composer gets that model alone;
 * one who deliberately picks the SECONDARY gets the secondary answering.
 *
 * @returns {{
 *   runOn: string,            the model this turn should actually run on
 *   switched: boolean,        true when that differs from the requested model
 *   engaged: boolean,         is the secondary taking the lead
 *   firstPass: boolean,       should the primary prepare a brief first
 *   legwork: boolean,         may the secondary hand jobs back to the primary
 *   primary: string|null, secondary: string|null,
 *   reason: string, substantial: boolean
 * }}
 */
function planHandoff({ roles, targetModel, userText, mode, running, hasAttachments, attachmentKinds } = {}) {
    const r = roles || {};
    const m = MODES.includes(mode) ? mode : (MODES.includes(r.mode) ? r.mode : 'auto');
    const loaded = running instanceof Set ? running : new Set(Array.isArray(running) ? running : []);
    const isLoaded = (name) => !!name && (loaded.size === 0 || loaded.has(name));

    const primary = r.primary || null;
    const secondary = r.secondary || null;
    const requested = targetModel || null;
    const verdict = isSubstantialWork({ text: userText, hasAttachments, attachmentKinds });

    // Picking the strong model in the composer is a deliberate choice — honour
    // it even when the turn is trivial.
    const wantsSecondary = !!(secondary && requested === secondary);
    // The OTHER loaded model of the pair when a turn runs alone: the primary
    // answering by itself may still hand the stronger model the hard parts
    // (primary → secondary), and a turn deliberately aimed at the secondary
    // may hand legwork down (secondary → primary). Null when the pair is
    // off, not loaded, or the same model.
    const partnerOf = (on) => {
        if (!on || !primary || !secondary || secondary === primary) return null;
        if (m === 'off' || !isLoaded(primary) || !isLoaded(secondary)) return null;
        return on === primary ? secondary : on === secondary ? primary : null;
    };
    const alone = (reason, runOn) => {
        const on = runOn || requested;
        const partner = partnerOf(on);
        return {
            runOn: on,
            switched: !!(on && on !== requested),
            engaged: false, firstPass: false, legwork: false,
            primary, secondary: null, reason, substantial: verdict.substantial,
            partner, partnerLegwork: !!partner && r.legwork !== false,
            secondaryLoaded: (secondary && secondary !== primary && isLoaded(secondary)) ? secondary : null,
        };
    };

    if (!primary || !isLoaded(primary)) {
        // No usable primary: nothing to route, leave the turn alone.
        return alone('no primary model configured');
    }
    // Only take over a turn that was aimed at this pair.
    if (requested && requested !== primary && requested !== secondary) {
        return alone(`the turn names a third model (${requested})`);
    }
    const soloOn = wantsSecondary ? secondary : primary;

    if (!secondary || secondary === primary) return alone('no secondary model configured', soloOn);
    if (!isLoaded(secondary)) return alone('the secondary model is not loaded', soloOn);
    if (m === 'off') return alone('the secondary is switched off', soloOn);
    // THE fast path: a quick question never reaches the slower model.
    if (m === 'auto' && !verdict.substantial) return alone(verdict.reason, soloOn);

    return {
        runOn: secondary,
        switched: secondary !== requested,
        engaged: true,
        firstPass: r.firstPass !== false,
        legwork: r.legwork !== false,
        primary,
        secondary,
        reason: m === 'always' ? 'the secondary takes every turn' : verdict.reason,
        substantial: verdict.substantial,
        partner: primary, partnerLegwork: r.legwork !== false, secondaryLoaded: secondary,
    };
}

// The brief the fast model produces before the primary starts. Deliberately
// bounded: the primary is waiting on it, so it must be quick and must not try
// to do the actual job.
//
// The LEGWORK section is what makes the pair actually work in parallel. Left to
// itself the primary just does everything (measured: two full builds, zero
// ask_assistant calls) — general "you may delegate" guidance loses to the
// model's habit. Handing it a SHORT LIST OF CONCRETE JOBS, chosen by a model
// that has just read the task, turns the decision into "dispatch these" rather
// than "invent something to delegate".
// The chat prepends runtime context to the latest user message — a /no_think
// switch, the account-memory block, the experience block, workspace and image
// pre-flight notes, and whole uploaded files. Measured at 7,043 characters on
// an ordinary turn, which meant `userText.slice(0, 6000)` handed the first pass
// nothing but the memory block: it replied "the user did not specify any task"
// and proposed no legwork. Strip the runtime blocks, keep a marker for each
// attachment, and if it is still long keep the TAIL — the notes are prepended,
// so the user's own words are at the end.
function askForFirstPass(userText, limit = 6000) {
    let t = String(userText || '').replace(/^\s*\/(no_?think|think)\b\s*/i, '');
    t = t.replace(SYSTEM_NOTE_RE, ' ');
    t = t.replace(
        /===\s*FILE\s+(\d+)\s*:\s*([^=\n]+?)\s*===[\s\S]*?(?:===\s*END\s+FILE\s+\1\s*===|(?![\s\S]))/gi,
        (_m, _n, name) => `[the user attached a file: ${String(name).trim()}]`,
    );
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > limit) t = '…' + t.slice(-limit);
    return t;
}

function buildFirstPassTask({ userText, leadModel, toolBudget = 3 }) {
    return [
        'You are the FIRST PASS on a task that the main model is about to take over.',
        `Your job is NOT to answer it. Your job is to hand ${leadModel || 'the main model'} a short, useful brief so it can start immediately — and to line up work that YOU can do in parallel while it writes.`,
        '',
        'THE USER ASKED:',
        askForFirstPass(userText),
        '',
        'Produce, in under 300 words, exactly these sections:',
        '1. TASK — one or two sentences restating exactly what is wanted, including any constraint the user gave (language, framework, file, format, length).',
        '2. WHAT I FOUND — only facts you actually verified this turn: existing files in /workspace and their paths, the shape of any supplied data, a version or API detail you looked up. Write "nothing needed" if you looked and there was nothing.',
        '3. PLAN — the 3-6 steps you would take, in order.',
        '4. LEGWORK — 0 to 3 jobs the main model should hand BACK to you to run in the background while it works. Each on its own line as `- <short name>: <one-line brief>`.',
        '   A good legwork job is independent of anything the main model has not written yet: looking up an API, a spec, a version or current facts; gathering reference material or examples; reading or summarising a file the USER supplied; running an EXISTING script or test.',
        '   A bad one depends on output that does not exist yet ("check the file it writes"), or is the task itself. If there is genuinely nothing useful, write "- none".',
        '5. OPEN QUESTIONS — anything genuinely ambiguous, or "none".',
        '',
        `Use at most ${toolBudget} tool calls, and only for things that are cheap and clearly needed (listing the workspace, reading a supplied file, one lookup). Do NOT start building, do NOT write the code, do NOT write the final answer.`,
        'Never invent a fact to fill a section — an empty section is better than a wrong one.',
    ].join('\n');
}

// A second, cheaper ask when the brief came back with NO legwork: the small
// first-pass model sometimes answers the WHAT I FOUND section ("workspace is
// empty") and stops, leaving the lead to run every lookup itself (measured:
// a 37-char brief, then ten retrieval calls on the lead, zero hand-offs).
// One focused question, no tools, a few seconds.
function buildLegworkOnlyTask({ userText, leadModel }) {
    return [
        `${leadModel || 'The main model'} is about to work on the request below and you will run background jobs for it while it writes.`,
        '',
        'THE USER ASKED:',
        askForFirstPass(userText, 3000),
        '',
        'List 1 to 3 background jobs you can do IN PARALLEL that would genuinely help — each independent of anything the main model has not written yet: a lookup of current facts, a spec, a version or an API; gathering reference material or examples; reading or summarising a file the user supplied; running an existing script.',
        'Reply with ONLY this section, nothing else:',
        'LEGWORK',
        '- <short name>: <one-line brief saying exactly what to find or do and what to report back>',
        'If nothing would help, reply exactly: LEGWORK\n- none',
    ].join('\n');
}

// Pull the LEGWORK lines back out of the brief so the note can tell the primary
// to dispatch exactly those. Tolerant of the shapes a small model produces
// (numbered or bare heading, "- name: brief" or "name — brief").
function parseLegwork(brief) {
    // Models write the section as markdown — `**4. LEGWORK**`, `### LEGWORK`,
    // and job names in backticks. Strip the decoration before matching;
    // a bolded heading silently produced zero jobs, which is why the secondary
    // never dispatched anything (user-reported: "not seeing any queue jobs").
    const text = String(brief || '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/`/g, '')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '');
    // NOTE: the trailing alternative must be (?![\s\S]), not $ — the /m flag
    // makes $ mean end-of-LINE, which cut the section off after its first job.
    const m = text.match(/^\s*(?:\d+[.)]\s*)?LEGWORK\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:\d+[.)]\s*)?[A-Z][A-Z ]{3,}\b|(?![\s\S]))/mi);
    if (!m) return [];
    const jobs = [];
    for (const raw of m[1].split('\n')) {
        const line = raw.replace(/^\s*[-*•]\s*/, '').trim();
        if (!line) continue;
        if (/^none\b/i.test(line) || /^n\/a\b/i.test(line)) continue;
        const split = line.match(/^(.{2,60}?)\s*[:—–-]\s+(.+)$/);
        const name = split ? split[1].trim() : line.slice(0, 50);
        const task = split ? split[2].trim() : line;
        if (task.length < 8) continue;
        jobs.push({ name: name.replace(/[."]+$/, ''), task });
        if (jobs.length >= 3) break;
    }
    return jobs;
}

// The note the primary sees. Goes in the LATEST USER MESSAGE (never a trailing
// system message — templates that require alternating roles 500 on those, and
// the user slot is prefix-cache friendly).
function renderBriefNote({ brief, assistantModel, firstPassSeconds, toolCalls, legworkAvailable = true, startedJobs = null }) {
    const body = String(brief || '').trim();
    if (!body) return '';
    const meta = [
        assistantModel ? `by ${assistantModel}` : null,
        typeof firstPassSeconds === 'number' ? `${firstPassSeconds}s` : null,
        typeof toolCalls === 'number' ? `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(', ');
    const who = assistantModel || 'the primary model';
    const jobs = legworkAvailable ? parseLegwork(body) : [];
    const started = Array.isArray(startedJobs) ? startedJobs.filter(Boolean) : [];
    const tail = !legworkAvailable
        ? 'You are working alone on this one.'
        : started.length
            ? `${started.length} background job${started.length === 1 ? ' is' : 's are'} ALREADY RUNNING on ${who} right now (${started.map(n => `"${n}"`).join(', ')}) — do NOT redo that work yourself. Start on the parts only you can do; each result is delivered to you as it lands. As your work reveals further independent legwork, hand it over with \`ask_assistant\` right away (it queues past the parallel limit) — and if nothing more is needed, just carry on.`
            : jobs.length
            ? `${who} is idle and waiting for work. Your FIRST action should be a single \`ask_assistant\` call dispatching the LEGWORK jobs above (${jobs.map(j => `"${j.name}"`).join(', ')}) — it returns immediately and they run on ${who}'s own GPU while you write. Then start writing without waiting; each result is delivered to you as it lands.`
            : `${who} is standing by — hand it any lookup, file read or script run you would otherwise stop to do yourself with \`ask_assistant\`, and keep working while it runs.`;
    return [
        `[SYSTEM: FIRST-PASS BRIEF${meta ? ` (${meta})` : ''} — you are the main model on this task and you write the final answer.`,
        '',
        body,
        '',
        `Treat the brief as a starting point, not as truth: re-check anything it asserts that matters, and ignore its plan if you have a better one. Do the substantive work — the design, the code, the writing — yourself. ${tail}]`,
    ].join('\n');
}

// Framing for the lead turn itself, appended to the shared prelude.
function buildLeadPrelude({ assistantModel, maxParallel }) {
    const who = assistantModel ? `the faster primary model (${assistantModel})` : 'a faster primary model';
    return [
        'YOU ARE THE LEAD ON THIS TASK.',
        `You are the stronger of the two models loaded, and this task was handed up to you. ${who.charAt(0).toUpperCase()}${who.slice(1)} has already done a first pass and is now standing by as your assistant. You write the final answer — the user sees your work, not its, so do the designing, the writing and the code yourself.`,
        `\`ask_assistant\` hands it a job and returns IMMEDIATELY — the assistant works in the background${maxParallel > 1 ? ` (up to ${maxParallel} at once)` : ''} while you carry on, and each result is delivered into your context the moment it lands.`,
        'HAND OFF things that are independent of what you are writing and that you would otherwise stop to do: looking up an API, a version, a spec or current facts; gathering reference material or examples; reading or summarising a file the USER supplied; running an existing script or test and reporting what it printed; checking an external claim.',
        'DO NOT hand off: the actual answer or code (that is your job); anything that depends on output you have not produced yet — it cannot read a file you have not written, and asking it to "verify /workspace/x" before you create x just wastes it; or a step so small you would finish it before the reply came back.',
        'Dispatch what you will need EARLY — at the start, alongside your first real step — so it runs while you write, and then keep going without waiting. `await_assistant` blocks and is only for when you genuinely cannot continue.',
        'DELEGATION IS CONTINUOUS, not a one-off: whenever your own progress or a delivered result reveals another independent lookup, read, run or check, hand it over right then and carry on — jobs past the parallel limit queue and start on their own. When a batch lands and nothing more is needed, simply carry on; never invent work to keep the assistant busy.',
    ].join(' ');
}

// Framing for a turn the PRIMARY answers alone while the stronger model is
// loaded and idle: primary → secondary. (Or the mirror image when the user
// aimed a small turn at the secondary on purpose.)
function buildPartnerPrelude({ partnerModel, partnerIsStronger, maxParallel }) {
    const who = partnerModel || 'the other model';
    return [
        partnerIsStronger
            ? `You are answering this turn yourself; the STRONGER model of the pair (${who}) is loaded and idle as your assistant.`
            : `You are answering this turn yourself; the FASTER model of the pair (${who}) is loaded and idle as your assistant.`,
        `\`ask_assistant\` hands it a job and returns IMMEDIATELY — it works in the background${maxParallel > 1 ? ` (up to ${maxParallel} at once, more queue)` : ''} while you carry on, and each result is delivered into your context the moment it lands.`,
        partnerIsStronger
            ? 'HAND OFF the parts that need more capability than you have — a hard design decision, tricky reasoning or a proof to check, a difficult piece of code or analysis, a review of a draft section — plus any independent legwork (a lookup, a file to read, a script to run). Give it the context it needs in the brief; it cannot see your conversation.'
            : 'HAND OFF independent legwork — a lookup, a file to read or summarise, a script to run and report on, a claim to check — and keep the thinking, design and writing for yourself.',
        'DO NOT hand off the whole task, and never something that depends on output you have not written yet. Delegation is CONTINUOUS: hand over more whenever your work reveals it, and when nothing more is needed simply carry on — never invent work for it.',
    ].join(' ');
}

// One line for a JOB that may hand the other model of the pair a little work
// back (the "primary <-> secondary" half). Deliberately tight.
function buildJobPartnerLine({ partnerModel, maxJobs }) {
    const who = partnerModel || 'the other model';
    return `The other model of the pair (${who}) is available through \`ask_assistant\` for at most ${Math.max(1, maxJobs || 1)} thing${(maxJobs || 1) === 1 ? '' : 's'} you genuinely cannot do well yourself (a hard judgment, a check of tricky reasoning) — it runs in the background and the result is delivered to you; do the rest of your task yourself and never hand it the whole task.`;
}

module.exports = {
    MODES,
    buildLegworkOnlyTask,
    buildPartnerPrelude,
    buildJobPartnerLine,
    cleanAsk,
    askForFirstPass,
    parseLegwork,
    attachmentKindsFromText,
    askLength,
    isSubstantialWork,
    planHandoff,
    buildFirstPassTask,
    renderBriefNote,
    buildLeadPrelude,
};
