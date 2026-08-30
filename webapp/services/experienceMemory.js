/**
 * Experience memory — EPISODIC memory of how the assistant got tasks done.
 *
 * One record = one KIND of task the assistant has done for this account
 * ("build a browser game from a screenshot", "audit an npm package for
 * malware"), carrying the concrete approach that worked (ordered tool path
 * with argument hints), how well it went (calls / seconds / guard events),
 * the pitfalls hit on the way, and lessons distilled from failed→fixed
 * transitions. Every recurrence of a similar task refines the SAME record:
 * count++, a cleaner/faster run replaces the approach, new pitfalls and
 * lessons merge in, and the user's phrasing is added as a retrieval variant.
 *
 * Retrieval is by SIMILARITY OF THE TASK (embedding cosine over several short
 * phrasings per record — the verbatim ask, a generalized task line, a "task
 * kind" phrase, later variants — the engine keeps the best chunk score), not
 * by a coarse activity bucket. Measured on the resident potion-retrieval-32M
 * engine with multi-chunk records: "make me a space invaders game" → the
 * tank-game experience 0.49, "build a tetris clone in javascript" → 0.39,
 * "analyze this network capture for c2 beacons" → the pcap experience 0.36,
 * "what is the capital of france" → 0.09, "write a short story" → 0.22. Hence
 * RETRIEVE_SEM=0.33 / MERGE_SEM=0.62 (0.40 within the same activity — snake↔tank measured 0.43, the closest same-activity non-match 0.17).
 *
 * The old design kept ONE recipe per activity bucket ("coding: the tools that
 * got it done — run_python → create_file") — a tool-name list with no task,
 * no arguments, no outcome, no lessons — so "I did something efficient for
 * coding once" could never be recognised as "this is that same kind of task"
 * nor tell the model WHAT it did. This module replaces it; the store keeps
 * `type:'procedure'` so the Memory tab, pruning and index stay compatible.
 *
 * Pure logic lives here (testable without a server); the store mutation is
 * `memoryService.upsertExperience`, the index is `memoryIndex`, and the
 * optional LLM refinement is injected by the caller (`deps.llm`).
 */

const crypto = require('crypto');

const RETRIEVE_SEM = Number(process.env.EXPERIENCE_RETRIEVE_SEM) || 0.33;
const MERGE_SEM = Number(process.env.EXPERIENCE_MERGE_SEM) || 0.62;
const MERGE_SEM_SAME_ACTIVITY = Number(process.env.EXPERIENCE_MERGE_SEM_SAME_ACTIVITY) || 0.40;
const MAX_STEPS = 10;
// Argument hint budget. 60 cut a captured API shape mid-token
// ("dpkt.pcap.Reader, socket.inet_"), which is worse than not capturing it —
// the model reads a truncated symbol as the symbol.
const MAX_HINT = 110;
const MAX_PURPOSE = 80;      // the model's own one-line reason for a call
const MAX_STEP_HINT = 190;   // args hint + purpose, per step
const MAX_TASK = 180;
const MAX_VARIANTS = 6;
const MAX_LESSONS = 5;
const MAX_PITFALLS = 5;
const MAX_HISTORY = 6;

// ---------------------------------------------------------------------------
// Task text
// ---------------------------------------------------------------------------

/** The user's actual ask, stripped of everything the platform wrapped around
 *  it (server pre-flight notes, FILE blocks, the "User message:" label,
 *  thinking-control prefixes). Capped on a word boundary. */
function summarizeTask(userText, attachmentKinds = new Set()) {
    let t = String(userText || '');
    t = t.replace(/^\/(no_)?think\b\s*/i, '');
    // Server-side notes prepended to the latest user message ("[SYSTEM: …]\n\n",
    // "[SERVER NOTE: …]\n\n" — the account-memory block, the workspace/image/
    // base64 pre-flights). They can contain ']' inside (memory handles like
    // [#a1b2c3]), so cut at the block terminator, not the first bracket.
    for (let guard = 0; guard < 8; guard++) {
        const m = /^\s*\[(SYSTEM|SERVER NOTE)\b/.exec(t);
        if (!m) break;
        const end = t.indexOf(']\n\n', m.index);
        if (end < 0) break;
        t = t.slice(end + 3);
    }
    t = t.replace(/\[(SYSTEM|SERVER NOTE)\b[^\]]*\]\s*/g, '');
    // Client upload wrapper: "=== FILE N: … ===\n…\n=== END FILE N ===".
    t = t.replace(/=== FILE \d+:[\s\S]*?=== END FILE \d+ ===/g, '');
    const label = t.lastIndexOf('User message:');
    if (label !== -1) t = t.slice(label + 'User message:'.length);
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > MAX_TASK) t = t.slice(0, MAX_TASK).replace(/\s+\S*$/, '') + '…';
    const kinds = [...(attachmentKinds || [])];
    if (kinds.length && t) t += ` (${kinds.join('/')} input)`;
    return t;
}

// ---------------------------------------------------------------------------
// Approach (the successful tool path with argument hints)
// ---------------------------------------------------------------------------

const PATH_KEYS = ['filePath', 'path', 'sourcePath', 'imagePath', 'codeFile', 'directory', 'dirPath', 'repoPath', 'outputName', 'filename', 'htmlPath', 'contentFile', 'emailPath', 'videoPath', 'archiveId'];
const QUERY_KEYS = ['query', 'pattern', 'url', 'urls', 'question', 'prompt', 'command', 'expression', 'sql'];
const FLAG_KEYS = ['psm', 'scale', 'mode', 'want', 'regex', 'recursive', 'language', 'format', 'operation', 'action', 'readonly', 'type'];

/** Cut on a separator so a hint never ends inside an identifier. */
function clip(text, max) {
    const t = String(text || '');
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf(' '), cut.lastIndexOf('('));
    return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,(]+$/, '') + '…';
}

/** Generalize a path so the hint transfers to the next task: keep the
 *  workspace area + extension, drop the specific name. */
function generalizePath(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    const ext = (s.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1];
    const area = (s.match(/^\/?workspace\/(uploads|artifacts|archives|gh-clones)\b/) || [])[1];
    if (area) return `/workspace/${area}/<${ext ? `file.${ext}` : 'path'}>`;
    if (/^https?:\/\//i.test(s)) { try { return `<${new URL(s).host}>`; } catch (_) { return '<url>'; } }
    return ext ? `<file.${ext}>` : '<path>';
}

/** The SHAPE of a script that worked: the library plus the few API calls that
 *  did the work ("dpkt: pcap.Reader, inet_ntop"). The library alone ("dpkt") is
 *  not enough to skip the iteration that a from-scratch rewrite costs — the next
 *  run still has to rediscover WHICH entry point and helpers to use, which is
 *  where the calls actually go. Generalized (no literals, no paths), capped. */
const CODE_NOISE = new Set(['print', 'open', 'len', 'str', 'int', 'format', 'append', 'get', 'items', 'keys', 'values',
    'join', 'split', 'strip', 'sort', 'sorted', 'range', 'list', 'dict', 'set', 'read', 'write', 'close', 'log', 'push', 'map', 'filter']);
function codeShape(code) {
    const text = String(code || '');
    const first = text.split('\n').find(l => /^\s*(import|from|const|require|def |function|#!)/.test(l)) || '';
    const mod = (first.match(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/) || first.match(/require\(['"]([^'"]+)['"]\)/) || [])[1];
    const apis = [];
    const re = /\b([A-Za-z_][\w]*)\.([A-Za-z_][\w.]*)\s*\(/g;
    let m;
    while ((m = re.exec(text)) && apis.length < 3) {
        const obj = m[1], meth = m[2];
        if (CODE_NOISE.has(meth.split('.').pop()) || CODE_NOISE.has(obj)) continue;
        const sig = `${obj}.${meth}`;
        if (!apis.includes(sig)) apis.push(sig);
    }
    if (!mod && !apis.length) return 'inline code';
    if (!apis.length) return `inline code (${mod})`;
    return `inline code (${mod ? `${mod}: ` : ''}${apis.join(', ')})`.slice(0, 90);
}

/** A short, generalized description of the call's salient arguments. */
function argHint(tool, args) {
    if (!args || typeof args !== 'object') return '';
    const parts = [];
    for (const k of PATH_KEYS) {
        const v = args[k];
        if (typeof v === 'string' && v) { parts.push(generalizePath(v)); break; }
    }
    for (const k of QUERY_KEYS) {
        const v = args[k];
        if (typeof v === 'string' && v) {
            if (k === 'url' || k === 'urls') { parts.push(generalizePath(v)); break; }
            if (k === 'command') { parts.push(`${k}: ${v.split(/\s+/).slice(0, 2).join(' ')}`); break; }
            // The VALUE is the transferable part — "which IOC patterns found the
            // malware" is the reusable knowledge, `pattern` alone is noise. Kept
            // short and single-line so a long SQL/prompt can't blow the budget.
            const val = v.replace(/\s+/g, ' ').trim();
            // A regex/SQL fragment often has NO spaces, and stripping the
            // trailing partial word then erased the whole value ("pattern: …").
            let short = val;
            if (val.length > 44) {
                const head = val.slice(0, 44);
                const wordSafe = head.replace(/\S*$/, '');
                short = (wordSafe.length > 20 ? wordSafe : head) + '…';
            }
            parts.push(`${k}: ${short}`);
            break;
        }
        if (Array.isArray(v) && v.length) { parts.push(`${k}[${v.length}]`); break; }
    }
    for (const k of FLAG_KEYS) {
        const v = args[k];
        if (v == null || v === '' || typeof v === 'object') continue;
        parts.push(`${k}=${String(v).slice(0, 16)}`);
        if (parts.length >= 3) break;
    }
    if (Array.isArray(args.actions) && args.actions.length) {
        const kinds = [...new Set(args.actions.map(a => a && a.type).filter(Boolean))].slice(0, 3);
        parts.push(`actions:${kinds.join('/') || args.actions.length}`);
    }
    if (typeof args.code === 'string' && args.code) {
        parts.push(codeShape(args.code));
    }
    return clip(parts.join(', '), MAX_HINT);
}

/** What THIS step was for. The platform adds a `purpose` argument to every
 *  tool and asks the model to fill it with one line saying why the call is
 *  being made — that is the single most transferable per-step signal, and it
 *  used to be thrown away here. Falls back to the generalized argument hint. */
function stepHint(chip, tool) {
    const purpose = String(chip.purpose || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PURPOSE);
    const args = argHint(tool, chip.args || chip.arguments);
    if (purpose && args) return clip(`${args} — ${purpose}`, MAX_STEP_HINT);
    return clip(purpose || args, MAX_STEP_HINT);
}

/** Ordered successful path with consecutive duplicates collapsed and the
 *  repeat count kept (×3). Long runs keep the head and the tail.
 *  REFUSED calls (loop-guard nudges, quarantine, prohibited) never ran, so they
 *  are not part of any path. */
function buildApproach(chips) {
    const ok = (chips || []).filter(c => c && c.status === 'success' && !c.refusal && (c.label || c.name));
    const steps = [];
    for (const c of ok) {
        const tool = c.label || c.name;
        const hint = stepHint(c, tool);
        const last = steps[steps.length - 1];
        if (last && last.tool === tool) {
            last.times += 1;
            // Keep the LAST version of a repeated step, not the first. A repeat
            // run of one tool is usually iteration toward something that works
            // (parse the capture by hand → parse it with dpkt), so the FIRST
            // hint is the attempt that did NOT settle it — storing that as "the
            // approach that worked" teaches the detour. The first is kept
            // alongside when it differs, because "we tried X, Y is what stuck"
            // is itself the transferable part.
            if (hint) {
                if (last.hint && last.hint !== hint && !last.firstHint) last.firstHint = last.hint;
                last.hint = hint;
            }
            continue;
        }
        steps.push({ tool, hint, times: 1 });
    }
    if (steps.length > MAX_STEPS) {
        const head = steps.slice(0, MAX_STEPS - 3);
        const tail = steps.slice(-3);
        return [...head, { tool: '…', hint: `${steps.length - MAX_STEPS} more`, times: 1 }, ...tail];
    }
    return steps;
}

// ---------------------------------------------------------------------------
// Pitfalls + lessons (from failed calls and failed→fixed transitions)
// ---------------------------------------------------------------------------

function errorClassOf(chip, errorSignature) {
    const raw = chip.error || (chip.preview && /"error"|"success":\s*false/.test(chip.preview) ? chip.preview : '');
    if (!raw) return '';
    let cls = null;
    try { cls = typeof errorSignature === 'function' ? errorSignature(raw) : null; } catch (_) { cls = null; }
    if (cls) return String(cls).slice(0, 80);
    return String(raw).replace(/\s+/g, ' ').replace(/^\{?\s*"?(error|message)"?\s*:\s*"?/i, '').slice(0, 80);
}

/** The thing a call acted ON, normalized — used to decide whether a later
 *  success actually FIXED an earlier failure or merely followed it. */
function targetKeyOf(chip) {
    const a = (chip && (chip.args || chip.arguments)) || {};
    if (!a || typeof a !== 'object') return '';
    for (const k of [...PATH_KEYS, 'url', 'urls', 'query', 'pattern']) {
        const v = a[k];
        if (typeof v === 'string' && v.trim()) {
            const s = v.trim().toLowerCase();
            // Compare on the basename / host so a corrected path still matches.
            const base = s.split(/[\\/]/).pop() || s;
            return base.slice(0, 60);
        }
    }
    return '';
}

/** Pitfalls = tool + error class for calls that genuinely FAILED (a loop-guard
 *  refusal never ran — it is flail telemetry, not a property of the tool, and
 *  storing it teaches the model to avoid a tool that works fine).
 *  Lessons = "X failed (err) → Y worked" ONLY when the success is plausibly the
 *  FIX: within the next 2 successful steps AND either the same tool (corrected
 *  retry) or the same target. Without the causal test any unrelated later call
 *  became a permanent lesson ("web failed (http-403) → read_file worked
 *  instead"), which then steers the model wrong on every future task. */
const LESSON_WINDOW = 2;

function extractPitfalls(chips, { errorSignature } = {}) {
    const list = Array.isArray(chips) ? chips : [];
    const pitfalls = [];
    const lessons = [];
    const seenP = new Set();
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || c.status === 'success' || c.refusal) continue;
        const tool = c.label || c.name || 'tool';
        const err = errorClassOf(c, errorSignature);
        // A failure with no recoverable error text says only "it failed once",
        // which is not a pitfall — it burned a lessons/pitfalls slot with noise
        // ("run_python: failed", "run_python failed once (failed) — a corrected
        // retry worked") and diluted the injected block.
        const informative = err && !/^failed$/i.test(err);
        const key = `${tool}|${err}`;
        if (informative && !seenP.has(key) && pitfalls.length < MAX_PITFALLS) {
            seenP.add(key);
            pitfalls.push(`${tool}: ${err}`);
        }
        // Candidate fixes: the next few successful steps only.
        const after = [];
        for (let j = i + 1; j < list.length && after.length < LESSON_WINDOW; j++) {
            const n = list[j];
            if (!n || n.refusal || n.status !== 'success' || !(n.label || n.name)) continue;
            after.push(n);
        }
        const tgt = targetKeyOf(c);
        const next = after.find(n => (n.label || n.name) === tool || (tgt && targetKeyOf(n) === tgt));
        if (next && informative && lessons.length < MAX_LESSONS) {
            const nt = next.label || next.name;
            const line = nt === tool
                ? `${tool} failed once (${err || 'error'}) — a corrected retry worked`
                : `${tool} failed (${err || 'error'}) → ${nt} worked instead`;
            if (!lessons.includes(line)) lessons.push(line);
        }
    }
    return { pitfalls, lessons };
}

// ---------------------------------------------------------------------------
// Quality of a run
// ---------------------------------------------------------------------------

/** Lower is better. A run that never converged (loop exhausted, cap hit, no
 *  answer) is ranked below any converged run regardless of call count. */
function runQuality(q = {}) {
    const calls = Number.isFinite(q.calls) ? q.calls : 0;
    const seconds = Number.isFinite(q.seconds) ? q.seconds : 0;
    const guards = Number.isFinite(q.guards) ? q.guards : 0;
    // Failures were invisible to the rank, so a flailing run (4 successes after
    // 20 failures) beat a clean 5-call run and REPLACED the stored approach with
    // the path extracted from the flail. A failed call costs more than a
    // successful one: it burned a round AND taught the model nothing.
    const failed = Number.isFinite(q.failed) ? q.failed : 0;
    const converged = q.converged !== false;
    return { calls, seconds, guards, failed, converged,
        rank: (converged ? 0 : 1e6) + calls * 10 + failed * 15 + guards * 25 + Math.min(600, seconds) / 60 };
}

function betterRun(a, b) { // true when a is better than b
    if (!b) return true;
    return runQuality(a).rank < runQuality(b).rank;
}

// ---------------------------------------------------------------------------
// Rendering — what the model reads
// ---------------------------------------------------------------------------

function renderApproach(steps) {
    return (steps || []).map(s => {
        const t = s.times > 1 ? `${s.tool}×${s.times}` : s.tool;
        return s.hint ? `${t}(${s.hint})` : t;
    }).join(' → ');
}

/** Detours: a repeated step whose FIRST attempt differed from the one that
 *  settled it. MEASURED HARM if this rides inside the approach text: the seed
 *  run probed a pcap header with struct before switching to dpkt, the rendered
 *  approach said "…(inline code (dpkt); first tried inline code (struct))", the
 *  LLM refinement turned that into the lesson "probe the header with struct
 *  first", and the next run duly wasted a call doing exactly that. A detour is
 *  only ever an AVOID line. */
function detoursOf(steps) {
    return (steps || [])
        .filter(s => s && s.firstHint && s.hint && s.firstHint !== s.hint)
        .map(s => `${s.tool}: the first attempt (${s.firstHint}) did not settle it — go straight to ${s.hint}`);
}

function renderOutcome(o) {
    if (!o) return '';
    const bits = [];
    if (Number.isFinite(o.calls)) bits.push(`${o.calls} call${o.calls === 1 ? '' : 's'}`);
    if (Number.isFinite(o.seconds) && o.seconds > 0) bits.push(`${Math.round(o.seconds)} s`);
    if (Number.isFinite(o.failed) && o.failed > 0) bits.push(`${o.failed} failed`);
    if (o.converged === false) bits.push('did NOT converge');
    return bits.join(', ');
}

/** The playbook line stored as `text` (and injected). Deterministic from the
 *  structured fields so a refinement never drifts from the evidence. */
function renderPlaybook(rec) {
    const parts = [];
    const task = String(rec.summary || rec.task || '').replace(/[.\s]+$/, '');
    if (task) parts.push(`Task: ${task}.`);
    const approach = renderApproach(rec.approach);
    if (approach) {
        const oc = renderOutcome(rec.outcome);
        parts.push(`Approach that worked${oc ? ` (${oc})` : ''}: ${approach}.`);
    } else if (rec.outcome && rec.outcome.totalCalls === 0) {
        // Only claim this when a real run actually needed no tools. A record
        // seeded by record_learning has an empty approach because nothing has
        // been observed yet — telling the model "no tools needed" there is
        // exactly the wrong instruction.
        parts.push('Answered directly from the message content, no tools needed.');
    }
    if (Array.isArray(rec.lessons) && rec.lessons.length) parts.push(`Lessons: ${rec.lessons.join('; ')}.`);
    const detours = detoursOf(rec.approach);
    const avoid = [...(Array.isArray(rec.pitfalls) ? rec.pitfalls : []), ...detours];
    if (avoid.length) parts.push(`AVOID (already tried, did not work): ${avoid.join('; ')}.`);
    return parts.join(' ').slice(0, 1900);
}

/** Short phrasings that are embedded as separate chunks (the engine keeps the
 *  best chunk score per record). Short↔short matches are what the static
 *  embedding does well; a long description dilutes to ~0.1 on a short ask. */
function phrasingsFor(rec) {
    const out = [];
    const push = (s) => {
        const v = String(s || '').replace(/\s+/g, ' ').trim();
        if (v && v.length >= 6 && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v.slice(0, 240));
    };
    push(rec.task);
    for (const v of (rec.variants || [])) push(v);
    push(rec.summary);
    push(rec.kind);
    if (rec.activity) push(String(rec.activity).replace(/-/g, ' '));
    const tools = (rec.approach || []).map(s => s.tool).filter(t => t && t !== '…');
    if (tools.length) push(`steps: ${[...new Set(tools)].join(' ')}`);
    // LESSONS are searchable content, not decoration. A record created by
    // `record_learning(activity=…)` has no approach, no summary and a synthetic
    // task ("web research (model lesson)"), so without this the ONLY vector for
    // the thing the model deliberately chose to remember was the bare activity
    // phrase — it could never be recalled by anything resembling its content.
    for (const l of (rec.lessons || [])) push(l);
    return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Build an episode from a finished turn
// ---------------------------------------------------------------------------

/** turn = { userText, attachmentKinds:Set, chips:[{label,args,status,error,preview}],
 *           activity, quality:{ms, rounds, nudges, checkpoints, contentLoop, capHit, answerChars} } */
function buildEpisode(turn, { errorSignature } = {}) {
    const chips = Array.isArray(turn.chips) ? turn.chips : [];
    const task = summarizeTask(turn.userText, turn.attachmentKinds);
    const approach = buildApproach(chips);
    const { pitfalls, lessons } = extractPitfalls(chips, { errorSignature });
    const q = turn.quality || {};
    // Refused calls never ran (loop-guard nudge / quarantine / prohibited) — they
    // are neither successes nor tool failures; `guards` already accounts for them.
    const real = chips.filter(c => c && !c.refusal);
    const okCalls = real.filter(c => c.status === 'success').length;
    const failedCalls = real.length - okCalls;
    const guards = (q.nudges || 0) + (q.checkpoints || 0) * 3 + (q.contentLoop ? 3 : 0);
    // A turn where EVERY tool call failed used to score calls:0 + converged:true
    // — the best possible rank — and so overwrote a good stored approach with
    // nothing. Converged now also requires that the turn actually got somewhere:
    // either it used no tools at all, or at least one of them worked.
    const converged = !q.capHit && !q.loopExhausted
        && (q.answerChars == null || q.answerChars > 0)
        && (real.length === 0 || okCalls > 0);
    const outcome = {
        calls: okCalls, totalCalls: real.length, failed: failedCalls,
        seconds: Number.isFinite(q.ms) ? Math.round(q.ms / 1000) : null,
        rounds: q.rounds ?? null, guards, converged,
    };
    return { task, activity: turn.activity || null, approach, pitfalls, lessons, outcome,
        taskKey: turn.taskKey || null,
        // A PROVISIONAL episode is a snapshot of work still in flight (the /v1
        // bridge sees a Pi task mid-run): tool names only, no arguments, no
        // timing, and an unknown ending. It may seed or update its OWN record,
        // but it must never outrank a complete, measured approach just because
        // its prefix is shorter.
        provisional: !!turn.provisional,
        kinds: [...(turn.attachmentKinds || [])] };
}

// ---------------------------------------------------------------------------
// Merge an episode into an existing record (pure)
// ---------------------------------------------------------------------------

function mergeInto(target, ep, { source = 'auto' } = {}) {
    const t = target;
    // An IN-PROGRESS snapshot of a task already recorded (the /v1 bridge
    // re-records a running Pi task as it accrues tools). It is the SAME run, so
    // it must overwrite — not count as another completion, and not be judged
    // "worse" for having more steps than its own earlier prefix. Without this a
    // single 48-call Pi task became "done 7×, best 1 call" with a 1-tool
    // approach, which then outranked every real experience.
    const sameRun = !!(ep.taskKey && t.openTaskKey && ep.taskKey === t.openTaskKey);
    const epHasApproach = Array.isArray(ep.approach) && ep.approach.length > 0;
    if (!sameRun) t.count = (t.count || 1) + 1;
    if (ep.taskKey) t.openTaskKey = ep.taskKey;
    // Keep the BEST approach: a better (converged, fewer calls/failures, fewer
    // guard events) run replaces it; a worse one only contributes lessons and
    // pitfalls. The outcome may ONLY move together with the approach it
    // describes — adopting a 0-call outcome onto a 4-call approach both lied
    // about the record and made it unbeatable (rank 0) forever.
    // A model-authored approach outranks noise, but it must not be IMMORTAL: one
    // record_learning call used to freeze the record forever, so a genuinely
    // better run could never take over. An automatic run may replace it when it
    // CONVERGED and is strictly better by run quality.
    const modelAuthored = t.textSource === 'model' && source !== 'model';
    const beatsTarget = betterRun(ep.outcome, t.outcome)
        && (!modelAuthored || (ep.outcome && ep.outcome.converged !== false));
    let replaced = false;
    if (epHasApproach && (sameRun || (!ep.provisional && beatsTarget))) {
        t.approach = ep.approach;
        t.outcome = ep.outcome;
        t.textSource = source;
        replaced = true;
    }
    if (epHasApproach && ep.outcome && Number.isFinite(ep.outcome.calls)) {
        t.bestSteps = (t.bestSteps == null) ? ep.outcome.calls : Math.min(t.bestSteps, ep.outcome.calls);
    }
    // Re-seeing a lesson/pitfall REINFORCES it: it moves to the end so the cap
    // evicts what has not recurred, instead of dropping the oldest (which threw
    // away the best-established lessons first).
    const addUnique = (arr, items, cap) => {
        let out = Array.isArray(arr) ? arr.slice() : [];
        for (const it of (items || [])) {
            if (!it) continue;
            const low = String(it).toLowerCase();
            const at = out.findIndex(x => String(x).toLowerCase() === low);
            if (at >= 0) { const [seen] = out.splice(at, 1); out.push(seen); continue; }
            if (out.length >= cap) out.shift();
            out.push(it);
        }
        return out;
    };
    t.lessons = addUnique(t.lessons, ep.lessons, MAX_LESSONS);
    t.pitfalls = addUnique(t.pitfalls, ep.pitfalls, MAX_PITFALLS);
    if (ep.task && ep.task !== t.task && ep.task.length <= 200 && !/\[#|YOUR EXPERIENCE|WHAT YOU KNOW/.test(ep.task)) {
        t.variants = addUnique(t.variants, [ep.task], MAX_VARIANTS);
    }
    const runEntry = {
        at: new Date().toISOString(), calls: ep.outcome?.calls ?? null, seconds: ep.outcome?.seconds ?? null,
        converged: ep.outcome?.converged !== false,
    };
    const hist = Array.isArray(t.history) ? t.history.slice() : [];
    if (sameRun && hist.length) hist[hist.length - 1] = runEntry;   // same run, updated
    else hist.push(runEntry);
    t.history = hist.slice(-MAX_HISTORY);
    // NEGATIVE feedback. `history` used to be write-only, so a playbook that had
    // stopped working kept its 'important' standing and its model-authored lock
    // forever. Consecutive non-converged runs demote it and release the lock so a
    // working approach can take over.
    const recent = t.history.slice(-3);
    let failStreak = 0;
    for (let i = recent.length - 1; i >= 0; i--) { if (recent[i].converged === false) failStreak++; else break; }
    t.failStreak = failStreak;
    if (failStreak >= 2) {
        if (t.impact === 'important') t.impact = 'medium';
        if (t.textSource === 'model') t.textSource = 'auto';   // stop blocking a better run
    } else if (t.count >= 3 && t.impact !== 'important') {
        t.impact = 'important';
    }
    t.text = renderPlaybook(t);
    return { replaced };
}

function newRecordFields(ep, { userId, source = 'auto', sourceConvId = null, impact = 'medium' } = {}) {
    const rec = {
        userId, type: 'procedure', source, impact,
        activity: ep.activity || null,
        task: ep.task, summary: null, kind: null, variants: [],
        approach: ep.approach, outcome: ep.outcome,
        lessons: ep.lessons, pitfalls: ep.pitfalls,
        history: [{ at: new Date().toISOString(), calls: ep.outcome?.calls ?? null, seconds: ep.outcome?.seconds ?? null, converged: ep.outcome?.converged !== false }],
        count: 1, sourceConvId, textSource: source,
        openTaskKey: ep.taskKey || null,
        provisional: ep.provisional ? true : undefined,
        bestSteps: (ep.approach && ep.approach.length) ? (ep.outcome?.calls ?? null) : null,
    };
    rec.text = renderPlaybook(rec);
    return rec;
}

// ---------------------------------------------------------------------------
// Effectiveness — was the injected playbook actually FOLLOWED, and did it help?
// ---------------------------------------------------------------------------

/** Tool names of an approach, in order (the "…" elision step dropped). */
function approachTools(steps) {
    return (steps || []).map(s => s && s.tool).filter(t => t && t !== '…');
}

/** How closely THIS turn's path followed a remembered one.
 *  `overlap` = the fraction of what the model actually did that the playbook
 *  already prescribed; `firstMatch` = it opened with a remembered step (the
 *  strongest signal that the memory front-loaded the work). */
function pathAdherence(remembered, actual) {
    const R = new Set(approachTools(remembered));
    const A = approachTools(actual);
    if (!R.size || !A.length) return { followed: false, overlap: 0, firstMatch: false };
    const hit = A.filter(t => R.has(t)).length;
    const overlap = Math.round((hit / A.length) * 100) / 100;
    const firstMatch = R.has(A[0]);
    return { followed: overlap >= 0.5 || firstMatch, overlap, firstMatch };
}

/** The measured benefit of a record so far: its FIRST recorded run happened
 *  before the record existed (nothing to recall), so it is the cold baseline;
 *  the best converged run since is what recalling it buys. */
function experienceBenefit(rec) {
    const h = Array.isArray(rec && rec.history) ? rec.history.filter(x => x && Number.isFinite(x.calls)) : [];
    if (h.length < 2) return null;
    const first = h[0].calls;
    const later = h.slice(1).filter(x => x.converged !== false).map(x => x.calls);
    if (!later.length) return null;
    const best = Math.min(...later);
    return { baselineCalls: first, bestSinceCalls: best, savedCalls: first - best, runs: h.length };
}

/** Is `score` (cosine vs an existing experience) high enough to REFINE that
 *  record rather than start a new one? */
function shouldMerge(score, sameActivity) {
    if (!Number.isFinite(score)) return false;
    if (score >= MERGE_SEM) return true;
    return sameActivity && score >= MERGE_SEM_SAME_ACTIVITY;
}

// ---------------------------------------------------------------------------
// Injection rendering
// ---------------------------------------------------------------------------

function handleOf(m) { return `#${String(m.id).replace(/-/g, '').slice(0, 6)}`; }

/** Lines for the "YOUR EXPERIENCE" block. `scored` = [{m, sem}] best-first. */
function renderExperienceBlock(scored) {
    if (!scored || !scored.length) return null;
    const lines = scored.map(({ m, sem }) => {
        const depth = m.count > 1 ? `done ${m.count}×` : 'done once';
        const best = m.outcome ? renderOutcome(m.outcome) : (m.bestSteps != null ? `${m.bestSteps} calls` : '');
        // A qualitative band, not the raw cosine: on this embedding a genuine
        // match is 0.33-0.49, and a model with no calibration for that scale
        // reads "similarity 0.36" as weak evidence and ignores the playbook.
        const sim = Number.isFinite(sem) ? `, ${sem >= 0.45 ? 'closely matching' : (sem >= 0.33 ? 'similar' : 'related')}` : '';
        return `- [${handleOf(m)}] (${depth}${best ? `, best ${best}` : ''}${sim}) ${m.text}`;
    });
    return (
        'YOUR EXPERIENCE — similar tasks you have completed for this user before. ' +
        'Each entry is the concrete approach that WORKED (tools in order, with argument hints), how efficient it was, and the pitfalls hit. ' +
        'Reuse the approach directly: skip the exploration it already paid for, go straight to the first step, avoid the listed pitfalls, and only deviate if a step fails. ' +
        // The runtime prelude tells the model to prefer answering directly and to
        // treat the interpreters as a last resort — sound as a prior, wrong when
        // a completed run has already proven which tools this task needs.
        'This is evidence from a completed run, so it takes precedence over general advice about preferring a direct answer or avoiding a tool. ' +
        'If you find a better way, refine the entry via record_learning with replaces:"<#handle>" and an `activity`. Handles are internal — never show them:\n' +
        lines.join('\n')
    );
}

// ---------------------------------------------------------------------------
// LLM refinement (optional): a generalized task line, a "task kind" phrase,
// alternative short phrasings, and cleaner lessons — written AFTER the record
// exists, so a slow/absent model never blocks recording.
// ---------------------------------------------------------------------------

const REFINE_PROMPT =
    'You maintain the assistant\'s EXPERIENCE memory: short notes about kinds of tasks it has done and how. ' +
    'You may be shown WHAT THE RECORD ALREADY SAYS (its summary, kind, known phrasings and how many times this kind of task has been done). ' +
    'When you are, GENERALIZE ACROSS all of it — the new run plus what is already there — instead of describing only the newest run: ' +
    'keep the existing summary/kind when they still fit (repeat them verbatim), and widen them only when the new run shows the record covers a broader kind of task than the wording admits. ' +
    'Given the user\'s ask and the tool trace of a completed task, write STRICT JSON with keys: ' +
    '"summary" (one line, ≤120 chars, generalized: what KIND of task this is and what was delivered — no names, no specific filenames), ' +
    '"kind" (a 3–7 word noun phrase naming the task type, e.g. "build a browser canvas game"), ' +
    '"phrasings" (3–5 SHORT alternative ways a user might ask for this KIND of task, ≤10 words each; at least two must name a DIFFERENT concrete subject of the same kind — e.g. for a tank game: "make a snake game in html", "build a space shooter in javascript"; for a pcap review: "analyze this wireshark capture"), ' +
    '"lessons" (0–3 concise, ACTIONABLE lessons a future run can START from — name the library, tool, flag or argument that worked and the shape of the solution ' +
    '("parse the capture with dpkt.pcap.Reader and aggregate by 5-tuple in one pass"), and name any detour that wasted work ("a hand-rolled struct parser did not work"); ' +
    'empty array if nothing notable). ' +
    'NEVER turn something the notes list under AVOID / pitfalls into a recommended step — those are things that already wasted a run. ' +
    'Return ONLY the JSON object.';

function parseRefinement(raw) {
    const s = String(raw || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let obj = null;
    try { obj = JSON.parse(s.slice(a, b + 1)); }
    catch (_) { try { obj = JSON.parse(require('jsonrepair').jsonrepair(s.slice(a, b + 1))); } catch (_) { return null; } }
    if (!obj || typeof obj !== 'object') return null;
    const str = (v, cap) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, cap) : '');
    const arr = (v, cap, n) => (Array.isArray(v) ? v.map(x => str(x, cap)).filter(x => x.length >= 6).slice(0, n) : []);
    const out = { summary: str(obj.summary, 140), kind: str(obj.kind, 60), phrasings: arr(obj.phrasings, 90, 5), lessons: arr(obj.lessons, 200, 3) };
    if (!out.summary && !out.kind && !out.phrasings.length) return null;
    return out;
}

function refinementInput(ep, chips, rec = null) {
    const trace = (Array.isArray(chips) ? chips : []).slice(0, 24).map(c => {
        const tool = c.label || c.name || 'tool';
        const st = c.refusal ? `refused by a guard (${c.refusal})`
            : (c.status === 'success' ? 'ok' : `FAILED${c.error ? `: ${String(c.error).slice(0, 100)}` : ''}`);
        const hint = stepHint(c, tool);
        return `- ${tool}${hint ? `(${hint})` : ''} → ${st}`;
    }).join('\n');
    const parts = [];
    if (rec && (rec.summary || rec.kind || (rec.variants || []).length)) {
        const known = [];
        if (rec.summary) known.push(`summary: ${rec.summary}`);
        if (rec.kind) known.push(`kind: ${rec.kind}`);
        if ((rec.variants || []).length) known.push(`known phrasings: ${rec.variants.slice(0, 6).join(' | ')}`);
        known.push(`times done: ${rec.count || 1}`);
        if (Array.isArray(rec.lessons) && rec.lessons.length) known.push(`lessons so far: ${rec.lessons.join('; ')}`);
        parts.push(`WHAT THE RECORD ALREADY SAYS:\n${known.join('\n')}`);
    }
    parts.push(`USER ASK (this run):\n${ep.task}`);
    parts.push(`TOOL TRACE (in order):\n${trace || '(no tools)'}`);
    parts.push(`OUTCOME: ${renderOutcome(ep.outcome) || 'n/a'}`);
    return parts.join('\n\n');
}

module.exports = {
    RETRIEVE_SEM, MERGE_SEM, MERGE_SEM_SAME_ACTIVITY,
    summarizeTask, generalizePath, argHint, buildApproach, extractPitfalls,
    runQuality, betterRun, renderApproach, renderOutcome, renderPlaybook, phrasingsFor,
    approachTools, pathAdherence, experienceBenefit, stepHint, targetKeyOf, codeShape, detoursOf,
    buildEpisode, mergeInto, newRecordFields, shouldMerge,
    renderExperienceBlock, handleOf,
    REFINE_PROMPT, parseRefinement, refinementInput,
};
