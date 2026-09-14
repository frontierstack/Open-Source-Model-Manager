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
// A runtime note closes with the `]` that ENDS A LINE (notes are joined with
// '\n\n'), not the first `]` in it — the account-memory note carries `[#id6]`
// handles mid-line, and a lazy match stopped at the first of those, leaving the
// rest of the memory block in the "user's ask" (it reached the quick brief as
// the task and fed the substantial-work check). A note with no line-ending `]`
// falls back to the first one.
function stripSystemNotes(text) {
    let t = String(text || '');
    let out = '';
    let i = 0;
    for (;;) {
        const start = t.indexOf('[SYSTEM:', i);
        if (start < 0) { out += t.slice(i); break; }
        out += t.slice(i, start);
        const rest = t.slice(start);
        const eol = rest.match(/\][ \t]*(?=\r?\n|$)/);
        const first = rest.indexOf(']');
        const end = eol ? eol.index + eol[0].length : (first >= 0 ? first + 1 : rest.length);
        out += ' ';
        i = start + end;
    }
    return out;
}
const SYSTEM_NOTE_RE = { [Symbol.replace]: (str) => stripSystemNotes(str) };
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

// The QUICK brief — the default first pass since 2026-09-13. The old first
// pass was a full delegated turn (prelude + tool catalog + router + up to
// HANDOFF_FIRST_PASS_ROUNDS rounds of tool calls) on the primary, and the lead
// sat idle until it finished; the user watched "Running first pass" for the
// whole of it. Everything the tool-using pass GATHERED can just as well be a
// background job that runs WHILE the lead writes, so the brief itself only
// needs the primary's read of the task: one no-tools completion, thinking off,
// a few hundred tokens. The workspace inventory the pre-flight already
// computed is handed in as text so the brief can point legwork at real files.
function buildQuickBriefTask({ userText, leadModel, workspaceLines = null }) {
    const ws = Array.isArray(workspaceLines) && workspaceLines.length
        ? ['', 'FILES ALREADY IN /workspace FROM EARLIER TURNS (you may name them in a legwork job):', ...workspaceLines.slice(0, 20)]
        : [];
    return [
        `${leadModel || 'The main model'} is about to work on the request below. You are the faster model of the pair: give it a brief so it can start immediately, and line up work that YOU will run in the background while it writes.`,
        'You have NO tools in this step and must not answer the request itself.',
        '',
        'THE USER ASKED:',
        askForFirstPass(userText, 4000),
        ...ws,
        '',
        'Your brief must be under 200 words (that limit is on YOUR reply, not on the answer). Use exactly these sections and nothing else:',
        'TASK — one or two sentences restating exactly what is wanted, with every constraint the USER gave (language, framework, file, format, length).',
        'PLAN — the 3-5 steps the main model should take, in order.',
        'LEGWORK — 0 to 3 jobs to hand to you to run in the background, each on its own line as `- <short name>: <one-line brief saying exactly what to find or do and what to report back>`. Every lookup, benchmark, version check or file read that your PLAN needs belongs here — you will run it while the main model writes.',
        '   Good: looking up an API, a spec, a version or current facts; gathering reference material or examples; reading or summarising a file the USER supplied; listing what is in the workspace; running an EXISTING script or test.',
        '   Bad: anything that depends on output the main model has not written yet, or the task itself. If nothing would help, write `- none`.',
        '   ' + JOB_RULE,
        'OPEN QUESTIONS — anything genuinely ambiguous, or `none`.',
        'Never invent a fact — the sections describe the task, not its answer.',
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
        JOB_RULE,
        'Reply with ONLY this section, nothing else:',
        'LEGWORK',
        '- <short name>: <one-line brief saying exactly what to find or do and what to report back>',
        'If nothing would help, reply exactly: LEGWORK\n- none',
    ].join('\n');
}

// Continuous delegation that does not depend on the lead remembering to ask.
// Measured on the user's turns: after the automatic first batch the lead never
// called ask_assistant again (it even blocked on await_assistant for 188 s),
// so "delegation is continuous" was only ever true in the prompt. Each time a
// batch lands, the ASSISTANT reads what came back and proposes the next jobs.
function buildFollowUpLegworkTask({ userText, leadModel, jobs = [], leadSteps = [], plan = [], maxJobs = 3 }) {
    const done = jobs.slice(-12).map((j) => {
        const head = String(j.answer || '').replace(/\s+/g, ' ').trim().slice(0, 420);
        return `- ${j.name}: ${String(j.task || '').slice(0, 200)} → ${j.status}${head ? ` — result: ${head}` : ''}`;
    });
    const steps = leadSteps.slice(-12).map((s) => `- ${String(s).slice(0, 160)}`);
    const planLines = plan.slice(0, 6).map((st, i) => `${i + 1}. ${String(st).slice(0, 200)}`);
    return [
        `${leadModel || 'The main model'} is still working on the request below. You have been running background jobs for it; their results are summarised underneath.`,
        `Propose the NEXT background jobs (at most ${maxJobs}) that would genuinely help it finish: a gap those results left open, a claim worth checking against a second independent source, a detail the final answer will need. Each job must be independent of anything the main model has not written yet, and must NOT repeat a job already done or a step the main model already took.`,
        'If nothing more would help, say so — do not invent work.',
        JOB_RULE,
        '',
        'THE USER ASKED:',
        askForFirstPass(userText, 2500),
        '',
        ...(planLines.length ? ['THE MAIN MODEL\'S PLAN (its roadmap — not yet done unless a job or step below covers it):', ...planLines, ''] : []),
        'JOBS SO FAR:',
        ...(done.length ? done : ['- none']),
        '',
        'STEPS THE MAIN MODEL ALREADY TOOK:',
        ...(steps.length ? steps : ['- none recorded']),
        '',
        'Reply with ONLY this section, nothing else:',
        'LEGWORK',
        '- <short name>: <one-line brief saying exactly what to find or do and what to report back>',
        'If nothing would help, reply exactly: LEGWORK\n- none',
    ].join('\n');
}

const JOB_STOP = new Set('the a an and or of to for in on at by with from is are be it its this that what which find report back current latest check verify get look up'.split(' '));
function jobTokens(text) {
    return new Set(String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, (u) => u.replace(/[^a-z0-9]+/g, ' '))
        .split(/[^a-z0-9.]+/).filter((w) => w.length > 2 && !JOB_STOP.has(w)));
}
// A proposed job that restates one already done (same name, or most of its
// task words) is dropped — re-running a finished lookup is pure latency.
function isDuplicateJob(candidate, existing = [], threshold = 0.6) {
    const name = String(candidate && candidate.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const ct = jobTokens(`${candidate && candidate.name} ${candidate && candidate.task}`);
    for (const e of existing) {
        const en = String(e && e.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (name && en && name === en) return true;
        const et = jobTokens(`${e && e.name} ${e && e.task}`);
        if (!ct.size || !et.size) continue;
        let inter = 0;
        for (const w of ct) if (et.has(w)) inter++;
        if (inter / Math.min(ct.size, et.size) >= threshold) return true;
    }
    return false;
}

// A proposed job the assistant cannot actually do. Seen live: a follow-up
// named "Connect the TCL TV to your PC via USB cable" — a step for the USER on
// their own hardware, which a server-side model has no access to; it burned a
// job slot and six tool calls producing nothing. A job must be work done with
// lookups, reading files or running scripts on the server.
const USER_STEP_START = /^(?:please\s+)?(?:connect|plug|unplug|press|hold|tap|click|reboot|restart|power(?:\s+(?:on|off|cycle))?|insert|remove|pair|unpair|open|go\s+to|navigate\s+to|turn\s+(?:on|off)|enable|disable|toggle|install|uninstall|select|choose|enter|type|set\s+up|set|change|make\s+sure|ensure|wait|try|use|log\s+in|sign\s+in|reset|factory\s+reset|update\s+(?:the|your)|attach|disconnect|swipe|scroll)\b/i;
const HARD_USER_STEP_NAME = /^(?:please\s+)?(?:connect|plug|unplug|press|hold|tap|click|reboot|restart|power|insert|pair|attach|disconnect|swipe|factory\s+reset)\b/i;
const RESEARCH_VERB = /\b(?:find|look\s*up|search|research|compare|summari[sz]e|document|investigate|determine|identify|gather|collect|extract|read|fetch|list|report|check\s+whether|verify\s+whether|confirm\s+whether|find\s+out)\b/i;
const USER_DEVICE = /\b(?:your|the\s+user'?s)\s+(?:tv|pc|computer|laptop|phone|device|router|console|remote|screen|cable|machine)\b/i;
function isWorkableJob(job) {
    const name = String(job && job.name || '').trim();
    const task = String(job && job.task || '').trim();
    if (task.length < 15) return false;
    if (HARD_USER_STEP_NAME.test(name) || HARD_USER_STEP_NAME.test(task)) return false;
    if (USER_STEP_START.test(task) && !RESEARCH_VERB.test(task)) return false;
    if (USER_DEVICE.test(task) && !RESEARCH_VERB.test(task)) return false;
    return true;
}

const JOB_RULE = 'A job is work done with web lookups, reading files or running scripts on the server. It is NEVER a step for the user to perform on their own device (connect a cable, press a button, open a settings menu, reboot) — you have no access to the user\'s hardware. Start each brief with what to find or check.';

// One section of a brief. Section boundaries are the brief's OWN headings,
// matched case-sensitively: a case-insensitive "any capitalised word" boundary
// cut a plan off at its first numbered step ("2. Research the firmware…")
// and at any line starting with a capitalised word.
const SECTION_HEADS = 'TASK|WHAT I FOUND|PLAN|LEGWORK|OPEN QUESTIONS?';
function briefSection(brief, name) {
    const text = String(brief || '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/`/g, '')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '');
    const titled = name.charAt(0) + name.slice(1).toLowerCase();
    // A heading at the start of a line (either case), or run into a one-line
    // brief mid-line (upper case followed by a colon or dash).
    const headRe = new RegExp(`^[ \\t]*(?:\\d+[.)][ \\t]*)?(?:${name}|${titled})\\b[ \\t]*[—–:-]*[ \\t]*|[ \\t](?:\\d+[.)][ \\t]*)?${name}[ \\t]*[—–:-]+[ \\t]*`, 'm');
    const m = headRe.exec(text);
    if (!m) return null;
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(new RegExp(`(?:^|[ \\t])(?:\\d+[.)][ \\t]*)?(?:${SECTION_HEADS})\\b`, 'm'));
    return end >= 0 ? rest.slice(0, end) : rest;
}

// The PLAN section of a brief, as steps (the lead's roadmap; jobs and
// follow-ups are told where they fit in it).
function parsePlan(brief) {
    const body = briefSection(brief, 'PLAN');
    if (!body) return [];
    const steps = [];
    for (const raw of body.split(/\n|(?<=[.;])\s+(?=\d+[.)]\s)/)) {
        const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
        if (line.length >= 6 && !/^none\b/i.test(line)) steps.push(line);
        if (steps.length >= 8) break;
    }
    return steps;
}

// What a background job is handed. A bare one-line task left the job blind:
// it did not know the user's goal, the lead's plan, what its sibling jobs
// cover (so two jobs researched the same thing) or what was already found
// (so it re-found it). This frames the task as ONE part of shared work.
function buildJobBrief({ job, goal, plan = [], siblings = [], findings = [], leadModel, budgetLine }) {
    const L = [];
    if (budgetLine) L.push(budgetLine);
    L.push(`You are running ONE background job for ${leadModel || 'the main model'}, which is writing the answer to the user's request while you work. Your report is the only thing it will see from you.`);
    // Sections are capped so the brief stays small next to a job's own tool
    // results in a per-slot context window.
    if (goal) L.push('', 'THE USER\'S GOAL:', String(goal).trim().slice(0, 1200));
    if (plan.length) L.push('', 'THE MAIN MODEL\'S PLAN:', ...plan.slice(0, 6).map((st, i) => `${i + 1}. ${String(st).slice(0, 200)}`));
    // Other jobs by identity (two jobs may share a derived name); a failed or
    // cancelled job covers nothing, so it is not listed as covered.
    const self = (sb) => (job.id != null && sb.id != null) ? sb.id === job.id : sb.name === job.name && sb.task === job.task;
    const others = siblings
        .filter(sb => sb && sb.name && !self(sb) && sb.status !== 'failed' && sb.status !== 'cancelled')
        .slice(-8);
    if (others.length) L.push('', 'OTHER JOBS COVER THESE (do not repeat them):', ...others.map(sb => `- ${sb.name}${sb.task ? `: ${String(sb.task).slice(0, 140)}` : ''}${sb.status === 'done' ? ' (done)' : ' (in progress)'}`));
    const found = findings.filter(f => f && f.text).slice(-4);
    if (found.length) L.push('', 'ALREADY FOUND (build on it, do not re-find it):', ...found.map(f => `- ${f.name ? `${f.name}: ` : ''}${String(f.text).replace(/\s+/g, ' ').trim().slice(0, 300)}`));
    L.push('', 'YOUR JOB:', String(job.task || '').trim().slice(0, 1500));
    L.push('', 'Report format: 3-10 bullets of facts with a source for each (URL or file path), then one line on anything you could not confirm. Only what THIS job asked for — no introduction, no advice on the rest of the request.');
    return L.join('\n');
}

// Pull the LEGWORK lines back out of the brief so the note can tell the primary
// to dispatch exactly those. Tolerant of the shapes a small model produces
// (numbered or bare heading, "- name: brief" or "name — brief").
function parseLegwork(brief) {
    // Models write the section as markdown — `**4. LEGWORK**`, `### LEGWORK`,
    // and job names in backticks; briefSection strips the decoration (a bolded
    // heading silently produced zero jobs). The heading may carry the first job
    // on ITS OWN line ("LEGWORK — - name: brief"), and a one-line brief may run
    // every section together; split on " - " job starts.
    const section = briefSection(brief, 'LEGWORK');
    if (section == null) return [];
    const body = section
        .replace(/\s+-\s+(?=[^\n]{1,60}?\s*[:—–-]\s+)/g, '\n- ');
    const jobs = [];
    for (const raw of body.split('\n')) {
        const line = raw.replace(/^\s*[-*•]\s*/, '').trim();
        if (!line) continue;
        if (/^none\b/i.test(line) || /^n\/a\b/i.test(line)) continue;
        const split = line.match(/^(.{2,60}?)\s*[:—–-]\s+(.+)$/);
        const name = split ? split[1].trim() : line.slice(0, 50);
        const task = split ? split[2].trim() : line;
        if (task.length < 8) continue;
        const job = { name: name.replace(/[."]+$/, ''), task };
        if (!isWorkableJob(job)) continue;
        jobs.push(job);
        if (jobs.length >= 3) break;
    }
    return jobs;
}

// The note the primary sees. Goes in the LATEST USER MESSAGE (never a trailing
// system message — templates that require alternating roles 500 on those, and
// the user slot is prefix-cache friendly).
function renderBriefNote({ brief, assistantModel, firstPassSeconds, toolCalls, legworkAvailable = true, startedJobs = null, quick = false }) {
    const body = String(brief || '').trim();
    if (!body) return '';
    const meta = [
        assistantModel ? `by ${assistantModel}` : null,
        typeof firstPassSeconds === 'number' ? `${firstPassSeconds}s` : null,
        quick ? 'quick brief, no tools' : (typeof toolCalls === 'number' ? `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}` : null),
    ].filter(Boolean).join(', ');
    const who = assistantModel || 'the primary model';
    const jobs = legworkAvailable ? parseLegwork(body) : [];
    const started = Array.isArray(startedJobs) ? startedJobs.filter(Boolean) : [];
    const tail = !legworkAvailable
        ? 'You are working alone on this one.'
        : started.length
            ? `${started.length} background job${started.length === 1 ? ' is' : 's are'} ALREADY RUNNING on ${who} right now:\n${started.map(j => (typeof j === 'string' ? `- "${j}"` : `- "${j.name}": ${String(j.task || '').slice(0, 220)}`)).join('\n')}\nDo NOT redo that work yourself and do NOT dispatch it again under another name — each of those results is delivered to you when it lands. Do not sit and wait for them: start writing NOW — the structure of the answer, every step or fact you already know, the parts only you can do. Never put a placeholder, "pending" marker or "results to follow" note in the answer: write around the missing piece and fill it in when its result is delivered to you (each one is, as it lands). Call \`await_assistant\` only when you have nothing left to write without it. ${who} may propose further jobs as results come in; hand over more yourself with \`ask_assistant\` whenever your work reveals another independent lookup (it queues past the parallel limit) — and if nothing more is needed, just carry on.`
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
    buildFollowUpLegworkTask,
    buildJobBrief,
    parsePlan,
    isDuplicateJob,
    isWorkableJob,
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
    buildQuickBriefTask,
    renderBriefNote,
    buildLeadPrelude,
};
