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
const MAX_HINT = 60;
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
            parts.push(`${k}`);
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
        const first = args.code.split('\n').find(l => /^\s*(import|from|const|require|def |function|#!)/.test(l)) || '';
        const mod = (first.match(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/) || first.match(/require\(['"]([^'"]+)['"]\)/) || [])[1];
        parts.push(mod ? `inline code (${mod})` : 'inline code');
    }
    return parts.join(', ').slice(0, MAX_HINT);
}

/** Ordered successful path with consecutive duplicates collapsed and the
 *  repeat count kept (×3). Long runs keep the head and the tail. */
function buildApproach(chips) {
    const ok = (chips || []).filter(c => c && c.status === 'success' && (c.label || c.name));
    const steps = [];
    for (const c of ok) {
        const tool = c.label || c.name;
        const hint = argHint(tool, c.args || c.arguments);
        const last = steps[steps.length - 1];
        if (last && last.tool === tool) {
            last.times += 1;
            if (!last.hint && hint) last.hint = hint;
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

/** Pitfalls = tool + error class for calls that failed or were refused by a
 *  guard; lessons = "X failed (err) → Y worked" when a failure is followed by
 *  a different successful step (or the same tool succeeding after a change). */
function extractPitfalls(chips, { errorSignature } = {}) {
    const list = Array.isArray(chips) ? chips : [];
    const pitfalls = [];
    const lessons = [];
    const seenP = new Set();
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || c.status === 'success') continue;
        const tool = c.label || c.name || 'tool';
        const err = errorClassOf(c, errorSignature);
        const key = `${tool}|${err}`;
        if (!seenP.has(key) && pitfalls.length < MAX_PITFALLS) {
            seenP.add(key);
            pitfalls.push(err ? `${tool}: ${err}` : `${tool} failed`);
        }
        // The next successful step after this failure = what fixed it.
        const next = list.slice(i + 1).find(n => n && n.status === 'success' && (n.label || n.name));
        if (next && lessons.length < MAX_LESSONS) {
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
    const converged = q.converged !== false;
    return { calls, seconds, guards, converged,
        rank: (converged ? 0 : 1e6) + calls * 10 + guards * 25 + Math.min(600, seconds) / 60 };
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

function renderOutcome(o) {
    if (!o) return '';
    const bits = [];
    if (Number.isFinite(o.calls)) bits.push(`${o.calls} call${o.calls === 1 ? '' : 's'}`);
    if (Number.isFinite(o.seconds) && o.seconds > 0) bits.push(`${Math.round(o.seconds)} s`);
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
    } else {
        parts.push('Answered directly from the message content, no tools needed.');
    }
    if (Array.isArray(rec.lessons) && rec.lessons.length) parts.push(`Lessons: ${rec.lessons.join('; ')}.`);
    if (Array.isArray(rec.pitfalls) && rec.pitfalls.length) parts.push(`Pitfalls seen: ${rec.pitfalls.join('; ')}.`);
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
    const okCalls = chips.filter(c => c && c.status === 'success').length;
    const guards = (q.nudges || 0) + (q.checkpoints || 0) * 3 + (q.contentLoop ? 3 : 0);
    const converged = !q.capHit && !q.loopExhausted && (q.answerChars == null || q.answerChars > 0);
    const outcome = {
        calls: okCalls, totalCalls: chips.length,
        seconds: Number.isFinite(q.ms) ? Math.round(q.ms / 1000) : null,
        rounds: q.rounds ?? null, guards, converged,
    };
    return { task, activity: turn.activity || null, approach, pitfalls, lessons, outcome,
        kinds: [...(turn.attachmentKinds || [])] };
}

// ---------------------------------------------------------------------------
// Merge an episode into an existing record (pure)
// ---------------------------------------------------------------------------

function mergeInto(target, ep, { source = 'auto' } = {}) {
    const t = target;
    t.count = (t.count || 1) + 1;
    // Keep the BEST approach: a better (converged, fewer calls, fewer guard
    // events) run replaces it; a worse one only contributes lessons/pitfalls.
    const modelAuthored = t.textSource === 'model' && source !== 'model';
    let replaced = false;
    if (!modelAuthored && betterRun(ep.outcome, t.outcome)) {
        if (ep.approach && ep.approach.length) t.approach = ep.approach;
        t.outcome = ep.outcome;
        t.textSource = source;
        replaced = true;
    }
    if (ep.outcome && Number.isFinite(ep.outcome.calls)) {
        t.bestSteps = (t.bestSteps == null) ? ep.outcome.calls : Math.min(t.bestSteps, ep.outcome.calls);
    }
    const addUnique = (arr, items, cap) => {
        const out = Array.isArray(arr) ? arr.slice() : [];
        for (const it of (items || [])) {
            if (!it || out.some(x => x.toLowerCase() === String(it).toLowerCase())) continue;
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
    t.history = (Array.isArray(t.history) ? t.history : []).concat([{
        at: new Date().toISOString(), calls: ep.outcome?.calls ?? null, seconds: ep.outcome?.seconds ?? null,
        converged: ep.outcome?.converged !== false,
    }]).slice(-MAX_HISTORY);
    if (t.count >= 3 && t.impact !== 'important') t.impact = 'important';
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
        bestSteps: ep.outcome?.calls ?? null,
    };
    rec.text = renderPlaybook(rec);
    return rec;
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
        const sim = Number.isFinite(sem) ? `, similarity ${sem.toFixed(2)}` : '';
        return `- [${handleOf(m)}] (${depth}${best ? `, best ${best}` : ''}${sim}) ${m.text}`;
    });
    return (
        'YOUR EXPERIENCE — similar tasks you have completed for this user before. ' +
        'Each entry is the concrete approach that WORKED (tools in order, with argument hints), how efficient it was, and the pitfalls hit. ' +
        'Reuse the approach directly: skip the exploration it already paid for, go straight to the first step, avoid the listed pitfalls, and only deviate if a step fails. ' +
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
    'Given the user\'s ask and the tool trace of a completed task, write STRICT JSON with keys: ' +
    '"summary" (one line, ≤120 chars, generalized: what KIND of task this is and what was delivered — no names, no specific filenames), ' +
    '"kind" (a 3–7 word noun phrase naming the task type, e.g. "build a browser canvas game"), ' +
    '"phrasings" (3–5 SHORT alternative ways a user might ask for this KIND of task, ≤10 words each; at least two must name a DIFFERENT concrete subject of the same kind — e.g. for a tank game: "make a snake game in html", "build a space shooter in javascript"; for a pcap review: "analyze this wireshark capture"), ' +
    '"lessons" (0–3 concise, transferable lessons from the trace about what worked or what to avoid next time; empty array if nothing notable). ' +
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

function refinementInput(ep, chips) {
    const trace = (Array.isArray(chips) ? chips : []).slice(0, 24).map(c => {
        const tool = c.label || c.name || 'tool';
        const st = c.status === 'success' ? 'ok' : `FAILED${c.error ? `: ${String(c.error).slice(0, 100)}` : ''}`;
        const hint = argHint(tool, c.args || c.arguments);
        return `- ${tool}${hint ? `(${hint})` : ''} → ${st}`;
    }).join('\n');
    return `USER ASK:\n${ep.task}\n\nTOOL TRACE (in order):\n${trace || '(no tools)'}\n\nOUTCOME: ${renderOutcome(ep.outcome) || 'n/a'}`;
}

module.exports = {
    RETRIEVE_SEM, MERGE_SEM, MERGE_SEM_SAME_ACTIVITY,
    summarizeTask, generalizePath, argHint, buildApproach, extractPitfalls,
    runQuality, betterRun, renderApproach, renderOutcome, renderPlaybook, phrasingsFor,
    buildEpisode, mergeInto, newRecordFields, shouldMerge,
    renderExperienceBlock, handleOf,
    REFINE_PROMPT, parseRefinement, refinementInput,
};
