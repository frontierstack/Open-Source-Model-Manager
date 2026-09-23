import React, { useState, useRef } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Clock, Zap, PlayCircle, AlertCircle, User, RefreshCw, Eye, Code as CodeIcon } from 'lucide-react';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';
import ToolCallBlock from './ToolCallBlock';
import ToolMilestones, { stepVerb, callSubject } from './ToolMilestones';
import SearchSources from './SearchSources';
import FilePreviewModal, { isAttachmentPreviewable } from './FilePreviewModal';
import ChartBlock from './ChartBlock';
import ImageBlock from './ImageBlock';
import VideoBlock from './VideoBlock';
import ArtifactList from './ArtifactList';
import { useChatStore } from '../../stores/useChatStore';
import { splitNarration, totalToolMs } from '../../utils/narrationSegments';
import { modelDisplayName } from '../../utils/modelDisplayName';

// Short model names in the pairing UI; the full id always rides in title=.
const shortModel = (name) => modelDisplayName(name) || String(name || '');

// Break a reasoning blob into discrete thought-steps so long chains of
// "Let me also check…" / "Now I'll…" don't render as one giant wall.
// Splits on paragraph breaks first; if the model emitted no paragraphs,
// splits on sentence boundaries that lead into a new cue phrase.
const STEP_CUE = /(?:Let me|Let's|Now|Next|Actually|Wait|Hmm|Okay|OK|First|Then|So|Alright|But|However|Looking|Checking|I(?:'| a)?ll|I need|I should|I'll|I'm going|Maybe|Perhaps|Finally)\b/;
function splitReasoningIntoSteps(text) {
    if (!text) return [];
    const trimmed = text.trim();
    if (!trimmed) return [];
    let parts = trimmed.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) {
        const cueSplit = trimmed.split(new RegExp(`(?<=[.!?])\\s+(?=${STEP_CUE.source})`));
        if (cueSplit.length >= 3) parts = cueSplit.map(s => s.trim()).filter(Boolean);
    }
    return parts;
}

// Map a tool name to a short present-tense verb phrase shown next to
// the 3-dot ThinkingIndicator while that tool is running. Falls back
// to humanizing the snake_case name (e.g. extract_archive → "Extract
// archive") so newly-added skills still get a reasonable label.
const TOOL_VERBS = {
    web: 'Browsing the web',
    web_search: 'Searching the web',
    fetch_url: 'Fetching page',
    crawl_pages: 'Crawling pages',
    playwright_fetch: 'Loading page',
    playwright_interact: 'Interacting with page',
    scrapling_fetch: 'Loading page',
    download_html: 'Downloading page',
    dns_lookup: 'Resolving DNS',
    virustotal_lookup: 'Checking VirusTotal',
    base64_decode: 'Decoding',
    load_skill: 'Loading skill',
    render_chart: 'Rendering chart',
    fetch_timeseries: 'Fetching data',
    read_file: 'Reading file',
    head_file: 'Reading file',
    tail_file: 'Reading file',
    write_file: 'Writing file',
    create_file: 'Writing file',
    append_to_file: 'Editing file',
    replace_lines: 'Editing file',
    edit_file: 'Editing file',
    move_file: 'Moving file',
    copy_file: 'Copying file',
    delete_file: 'Deleting file',
    list_directory: 'Listing files',
    grep_code: 'Searching code',
    outline_file: 'Outlining file',
    create_pdf: 'Creating PDF',
    create_docx: 'Creating document',
    create_xlsx: 'Creating spreadsheet',
    read_xlsx: 'Reading spreadsheet',
    query_sqlite: 'Querying database',
    workspace_db: 'Querying database',
    transform_image: 'Editing image',
    transcribe_audio: 'Transcribing audio',
    extract_archive: 'Expanding archive',
    send_file: 'Sending file',
    run_python: 'Running script',
    run_node: 'Running script',
    make_downloadable: 'Preparing download',
    delegate: 'Running worker agents',
    first_pass: 'Preparing a brief',
    ask_assistant: 'Handing work to the other model',
    await_assistant: 'Waiting on the other model',
};
function verbFor(t) {
    const name = (t && (t.label || t.name)) || '';
    return TOOL_VERBS[name] || (name ? name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Working');
}
function runningToolsOf(toolCalls) {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.filter(t => t && (t.status === 'partial' || t.status === 'running'));
}
// Label for the tools still in flight. EVERY running tool is named, not just
// the newest — a turn that fans out three parallel web reads used to read as
// one call, and when two finished the label went back to "Generating" while
// the third was still stuck. The longest-running call carries the elapsed
// time so a hung tool is visible as such.
function describeRunningTool(toolCalls, now = Date.now()) {
    const running = runningToolsOf(toolCalls);
    if (!running.length) return null;
    const elapsedOf = (t) => (t.startedAt ? Math.max(0, Math.round((now - t.startedAt) / 1000)) : 0);
    const oldest = running.reduce((a, b) => (elapsedOf(b) > elapsedOf(a) ? b : a), running[0]);
    const secs = elapsedOf(oldest);
    const clock = secs >= 4 ? ` (${secs}s)` : '';
    if (running.length === 1) {
        const t = running[0];
        const verb = verbFor(t);
        // The model's own one-line purpose is the most informative label.
        return (t.purpose ? `${verb} — ${t.purpose}` : verb) + clock;
    }
    const verbs = [...new Set(running.map(verbFor))].join(' / ');
    const purpose = oldest.purpose ? ` — ${oldest.purpose}` : '';
    return `${running.length} tools running · ${verbs}${purpose}${clock}`;
}

// Derive the most informative live label for the streaming bubble.
// Precedence: running tool > server-driven phase (chunking/synth) >
// reasoning-only > content streaming > fallback. This keeps the
// indicator visible AT ALL TIMES while the assistant is producing
// output, not just before the first content token.
function deriveStreamingLabel({ toolCalls, streamingStatus, handoff, hasContent, hasReasoning, now, startsRef }) {
    // With two models paired, naming BOTH of them is the most informative
    // one-liner there is — the user could otherwise not tell that the turn had
    // been handed over to the secondary at all.
    const pairLabel = describeHandoff(handoff, now, startsRef);
    if (pairLabel) return pairLabel;
    const toolLabel = describeRunningTool(toolCalls, now);
    if (toolLabel) return toolLabel;
    if (streamingStatus && streamingStatus.text && !hasContent) return streamingStatus.text;
    if (!hasContent && hasReasoning) return 'Thinking';
    if (hasContent) return 'Generating';
    return 'Thinking';
}

// ── Two-model pairing: primary answers, secondary takes over ──────────────
// The primary is the everyday model and answers most turns alone. When the ask
// is substantial the secondary TAKES THE LEAD and writes the answer, while the
// primary prepares the brief up front and then runs background jobs
// CONCURRENTLY for it. Both of those are invisible without the frames the
// server streams (`handoff`, `assistant_progress`).
//
// In those frames `assistant` (legacy: `helper`) is the model doing the
// legwork — the primary — and `lead` (legacy: `primary`) is the model writing
// — the secondary, once it has taken over. That inversion is exactly why they
// are NOT read as the `primary`/`secondary` role names.

function runningJobsOf(handoff) {
    const jobs = (handoff && Array.isArray(handoff.jobs)) ? handoff.jobs : [];
    // Queued jobs (past the parallel limit, waiting for a slot) are pending too.
    return jobs.filter(j => j && (j.status === 'running' || j.status === 'queued' || !j.status));
}

// Who is on each side of this turn, preferring the current field names.
// Null = nothing worth saying — including the `solo` phase, where the primary
// answered the turn by itself: naming it is the meta row's job, and a live row
// saying "one model is writing" would only restate the ordinary indicator.
function handoffActors(handoff) {
    if (!handoff || handoff.phase === 'solo') return null;
    const assistant = handoff.assistant || handoff.helper || '';
    const lead = handoff.lead || handoff.primary || '';
    const reviewer = handoff.reviewer || '';
    if (!assistant && !lead && !(handoff.reviewing && reviewer)) return null;
    return { assistant, lead, reviewer };
}

// One-line summary naming whichever models are busy.
function describeHandoff(handoff, now = Date.now(), startsRef = null) {
    // Unnamed = nothing worth saying; fall through to the ordinary tool label.
    const actors = handoffActors(handoff);
    if (!actors) return null;
    const { assistant, lead, reviewer } = actors;
    const phase = handoff.phase || 'lead';
    if (phase === 'first_pass') {
        // Same elapsed clock as a running tool label — the first pass is one
        // call the user is waiting on, and the clock makes the wait legible.
        let clock = '';
        if (startsRef) {
            const starts = startsRef.current || (startsRef.current = {});
            if (!starts.first_pass) starts.first_pass = now;
            const secs = Math.max(0, Math.round((now - starts.first_pass) / 1000));
            if (secs >= 4) clock = ` (${secs}s)`;
        }
        return `${assistant || 'The primary'} is preparing a brief…${clock}`;
    }
    if (handoff.reviewing) return `${reviewer || assistant || lead} is reviewing the answer`;
    if (phase === 'revising') {
        const who = lead || assistant || 'The lead';
        return assistant && lead ? `${lead} is revising the answer with ${assistant}'s results` : `${who} is revising the answer with background results`;
    }
    if (!lead) return null;
    const running = runningJobsOf(handoff);
    if (running.length && assistant) {
        const current = running[0].current || verbFor(running[0]);
        const count = running.length > 1 ? ` (${running.length} jobs)` : '';
        return `${lead} writing · ${assistant}: ${current}${count}`;
    }
    return assistant ? `${lead} is writing · ${assistant} standing by` : `${lead} is writing`;
}

// One row per model that is DOING something right now, so when both work at
// the same time both are visible, each with its own activity and clock.
// `startsRef` remembers when each row's work began — the server frames carry
// no start timestamps, and the clock must not restart on every re-render.
function handoffRows({ handoff, toolCalls, now, startsRef }) {
    const actors = handoffActors(handoff);
    if (!actors) return [];
    const { assistant, lead, reviewer } = actors;
    const phase = handoff.phase || 'lead';
    const starts = startsRef.current || (startsRef.current = {});
    const since = (key) => {
        if (!starts[key]) starts[key] = now;
        return Math.max(0, Math.round((now - starts[key]) / 1000));
    };
    const rows = [];

    // The model that took the lead — writing the answer, plus whatever tool it
    // has in flight.
    if (phase !== 'first_pass' && lead) {
        const running = runningToolsOf(toolCalls);
        const parts = [handoff.reviewing ? 'answer written' : phase === 'revising' ? 'revising with background results' : 'writing the answer'];
        if (running.length) {
            const elapsedOf = (t) => (t.startedAt ? now - t.startedAt : 0);
            const oldest = running.reduce((a, b) => (elapsedOf(b) > elapsedOf(a) ? b : a), running[0]);
            const extra = running.length > 1 ? ` (+${running.length - 1})` : '';
            parts.push(`${verbFor(oldest)}${oldest.purpose ? ` — ${oldest.purpose}` : ''}${extra}`);
        }
        rows.push({ key: 'lead', model: lead, parts, seconds: since('lead') });
    }

    // The everyday model — its up-front brief, then the QUEUE of background
    // jobs the lead handed it. Every job gets its own row: an aggregate
    // "(3 jobs)" line hid exactly what the user asked to see — which jobs the
    // two models passed each other and where each one is. Finished jobs stay
    // on screen so the exchange accumulates instead of flickering past.
    const allJobs = (handoff && Array.isArray(handoff.jobs)) ? handoff.jobs : [];
    if (assistant) {
        const running = runningJobsOf(handoff);
        if (phase === 'first_pass') {
            rows.push({ key: 'assistant', model: assistant, parts: ['preparing a brief'], seconds: since('first_pass') });
        } else if (allJobs.length) {
            const done = allJobs.filter(j => j && j.status && j.status !== 'running' && j.status !== 'queued').length;
            rows.push({
                key: 'assistant',
                model: assistant,
                parts: [`${allJobs.length} job${allJobs.length === 1 ? '' : 's'} from ${lead || 'the lead'}`
                    + (done ? ` · ${done} done` : '')],
                seconds: running.length ? since('queue') : 0,
            });
            for (const j of allJobs) {
                const jobKey = `job:${j.id || j.name || 'job'}`;
                const isQueued = j.status === 'queued';
                const isRunning = j.status === 'running' || isQueued || !j.status;
                const parts = [j.name || 'job'];
                if (isQueued) {
                    parts.push('queued · waiting for a free slot');
                } else if (isRunning) {
                    parts.push(j.current || verbFor(j));
                } else if (j.status === 'failed' || j.status === 'cancelled') {
                    parts.push(j.status);
                } else {
                    parts.push(`done${j.calls ? ` · ${j.calls} tool call${j.calls === 1 ? '' : 's'}` : ''}`);
                }
                rows.push({
                    key: jobKey,
                    indent: true,
                    done: !isRunning,
                    failed: j.status === 'failed' || j.status === 'cancelled',
                    model: j.model || assistant,
                    parts,
                    seconds: isRunning ? since(jobKey) : (typeof j.seconds === 'number' ? Math.round(j.seconds) : 0),
                });
            }
        }
    }

    // Whoever is looking the finished answer over — the secondary, including
    // on a turn the primary answered alone and never handed over.
    if (handoff.reviewing) {
        const who = reviewer || assistant || lead;
        if (who) rows.push({ key: 'review', model: who, parts: ['reviewing the answer'], seconds: since('review') });
    }
    return rows;
}

// Compact, quiet live block — one line per busy model, plus an indented line
// per background job so the queue the two models pass back and forth is
// visible while it happens. It disappears with the turn; the durable record
// lives on the `first_pass` / `ask_assistant` chips in the finished message.
function HandoffRows({ rows }) {
    if (!rows.length) return null;
    return (
        <div className="msg-turn msg-turn--live" aria-live="polite">
            <div className="msg-turn-head">
                <span className="msg-turn-label">Two models working</span>
            </div>
            <ol className="msg-turn-timeline">
                {rows.map(r => {
                    const state = r.done ? (r.failed ? 'failed' : 'done') : 'running';
                    return (
                        <li key={r.key} className={`msg-turn-event${r.indent ? ' msg-turn-event--job' : ''}`} data-state={state}>
                            <span className="msg-turn-dot" aria-hidden="true" />
                            <div className="msg-turn-line">
                                {!r.indent && <span className="msg-turn-pill" title={r.model}>{shortModel(r.model)}</span>}
                                <span className="msg-turn-text">
                                    {r.indent
                                        ? <><span className="msg-turn-job-name">{r.parts[0]}</span>{r.parts.slice(1).length ? <span className="msg-turn-muted">{' \u00b7 ' + r.parts.slice(1).join(' \u00b7 ')}</span> : null}</>
                                        : r.parts.join(' \u00b7 ')}
                                </span>
                                {r.seconds >= 1 && <span className="msg-turn-meta">{r.seconds}s</span>}
                            </div>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

// The durable record of a two-model turn, built from the hand-off chips the
// server emits (`first_pass`, `ask_assistant`, `await_assistant`). It renders
// ALWAYS-VISIBLE above the collapsed "N tool calls" strip: folding the
// exchange in with ordinary tool calls is what made the pairing invisible —
// the user had to know to expand a generic strip to find out the two models
// had talked at all.
// One plain sentence per hand-off, naming BOTH models and WHAT passed between
// them — "X briefed Y on ...", "Y delegated N tasks to X" — rather than a bare
// step label. User's ask, verbatim: "I want to see things like 'primary gave so
// and so info to secondary', 'secondary delegated the task xyz'".
function clipSentence(text, max = 110) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const first = t.split(/(?<=[.;:])\s/)[0].replace(/[.;:,]$/, '');
    const out = first.length > 12 ? first : t;
    return out.length > max ? out.slice(0, max - 1).replace(/\s+\S*$/, '') + '\u2026' : out;
}

// A brief's own TASK/PLAN line is the most useful one-liner about what was
// handed over; fall back to its first substantial line.
function briefSubject(brief) {
    const t = String(brief || '');
    const m = t.match(/^[ \t]*(?:\*+[ \t]*)?(?:\d[.)][ \t]*)?(?:TASK|PLAN)\b[^\n:]*:?[ \t]*(.+)$/im);
    if (m) return clipSentence(m[1]);
    const line = t.split('\n').map(l => l.replace(/^[\s*#\d.)-]+/, '').trim()).find(l => l.length > 20);
    return clipSentence(line || t);
}

function exchangeSteps(toolCalls, review) {
    const steps = [];
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    for (const tc of calls) {
        const label = tc && (tc.label || tc.name);
        if (label === 'first_pass') {
            const r = tc.result || {};
            const to = r.handedTo;
            // A committed message keeps the chip's `purpose` but not its full
            // `result`, so the brief's subject is recovered from the purpose
            // sentence ("Prepared a brief for X: <subject>") after a reload.
            const fromPurpose = String(tc.purpose || '').match(/^(?:Prepared a brief for|Briefed)\s+\S+?(?::|\son)\s+(.+)$/i);
            const subject = r.brief ? briefSubject(r.brief) : (fromPurpose ? clipSentence(fromPurpose[1]) : '');
            const extras = [];
            if (r.toolCalls) extras.push(`${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}`);
            if (Array.isArray(r.proposedJobs) && r.proposedJobs.length) extras.push(`proposed ${r.proposedJobs.length} task${r.proposedJobs.length === 1 ? '' : 's'}`);
            steps.push({
                key: `fp${steps.length}`,
                kind: 'brief',
                from: tc.model || r.model,
                to,
                text: tc.status === 'failed' ? 'could not prepare a brief' : `prepared a brief${to ? ` for ${shortModel(to)}` : ''}`,
                detail: subject,
                meta: extras.join(' \u00b7 '),
                seconds: typeof r.seconds === 'number' ? r.seconds : (typeof tc.durationMs === 'number' ? tc.durationMs / 1000 : undefined),
                failed: tc.status === 'failed',
            });
        } else if (label === 'ask_assistant') {
            const jobs = Array.isArray(tc.assistantJobs) ? tc.assistantJobs : [];
            // The chip's ARGS carry each job's task text; the job rows carry the
            // outcome. Join them so every line says what was actually asked for.
            const asked = {};
            const reqs = (tc.args && (tc.args.requests || tc.args.tasks)) || [];
            if (Array.isArray(reqs)) for (const r of reqs) if (r && r.name) asked[r.name] = r.task;
            const to = jobs.length ? jobs[0].model : undefined;
            const n = jobs.length || (Array.isArray(reqs) ? reqs.length : 0);
            steps.push({
                key: `aa${steps.length}`,
                kind: 'delegate',
                from: tc.model,
                to,
                text: n
                    ? `delegated ${n} ${tc.args && tc.args.followUp ? 'follow-up ' : ''}task${n === 1 ? '' : 's'}${to ? ` to ${shortModel(to)}` : ''}`
                    : 'handed work to the other model',
                jobs: jobs.map(j => ({ ...j, task: asked[j.name] })),
            });
        } else if (label === 'await_assistant') {
            steps.push({ key: `aw${steps.length}`, kind: 'wait', from: tc.model, text: 'waited for the delegated results' });
        }
    }
    // The secondary's pass over the finished answer. In EDIT mode it rewrites
    // the answer in place and appends NOTHING to it, so this row is the only
    // place the user can see that it happened and what it changed.
    if (review && review.reviewer) {
        const n = Number(review.issues) || 0;
        const text = review.edited
            ? `reviewed and polished the answer${n ? ` \u00b7 ${n} correction${n === 1 ? '' : 's'}` : ''}`
            : review.verdict === 'issues'
                ? `found ${n} issue${n === 1 ? '' : 's'} but could not rewrite \u2014 treat those points as unverified`
                : review.verdict === 'pass'
                    ? 'read the answer \u00b7 no changes needed'
                    : 'review did not complete';
        steps.push({
            key: 'review',
            kind: 'review',
            from: review.reviewer,
            text,
            detail: review.edited && review.summary ? clipSentence(review.summary, 140) : '',
            seconds: typeof review.seconds === 'number' ? review.seconds : undefined,
            warn: review.verdict === 'issues' && !review.edited,
        });
    }
    return steps;
}

function fmtSecs(sec) {
    if (!(sec >= 0.1)) return '';
    if (sec < 60) return `${Math.round(sec)}s`;
    return `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;
}

function ExchangeJob({ job }) {
    const [open, setOpen] = useState(false);
    const failed = job.status === 'failed' || job.status === 'cancelled';
    const pending = job.status === 'running' || job.status === 'queued';
    const state = failed ? 'failed' : pending ? 'running' : 'done';
    const meta = [];
    if (job.calls) meta.push(`${job.calls} call${job.calls === 1 ? '' : 's'}`);
    if (typeof job.seconds === 'number') meta.push(fmtSecs(job.seconds));
    if (failed) meta.push(job.status);
    return (
        <li className="msg-turn-job" data-state={state}>
            <button
                type="button"
                className="msg-turn-job-row"
                onClick={() => job.task && setOpen(v => !v)}
                aria-expanded={job.task ? open : undefined}
                title={job.model ? `Ran on ${job.model}` : undefined}
            >
                <span className="msg-turn-glyph" aria-hidden="true">{failed ? '\u00d7' : pending ? '\u25cc' : '\u2713'}</span>
                <span className="msg-turn-job-name">{job.name || 'task'}</span>
                {job.task && <span className={`msg-turn-job-task${open ? ' is-open' : ''}`}>{job.task}</span>}
                {meta.length > 0 && <span className="msg-turn-meta">{meta.join(' \u00b7 ')}</span>}
            </button>
        </li>
    );
}

function ExchangePanel({ steps }) {
    if (!steps.length) return null;
    // The pair: the brief's author is the assistant and its recipient the lead;
    // a delegation runs the other way.
    const brief = steps.find(s => s.kind === 'brief');
    const deleg = steps.find(s => s.kind === 'delegate');
    const lead = (brief && brief.to) || (deleg && deleg.from) || '';
    const assistant = (brief && brief.from) || (deleg && deleg.to) || '';
    const jobs = steps.flatMap(s => s.jobs || []);
    const batches = steps.filter(s => s.kind === 'delegate' && (s.jobs || []).length).length;
    const calls = jobs.reduce((n, j) => n + (Number(j.calls) || 0), 0);
    const jobSecs = jobs.reduce((n, j) => n + (typeof j.seconds === 'number' ? j.seconds : 0), 0);
    const totals = [];
    if (jobs.length) totals.push(`${jobs.length} task${jobs.length === 1 ? '' : 's'} delegated${batches > 1 ? ` in ${batches} batches` : ''}`);
    if (calls) totals.push(`${calls} call${calls === 1 ? '' : 's'}`);
    if (jobSecs >= 1) totals.push(fmtSecs(jobSecs));
    const pill = (name) => {
        if (!name) return null;
        const role = name === lead ? 'lead' : name === assistant ? 'assist' : 'other';
        return <span className={`msg-turn-pill msg-turn-pill--${role}`} title={name}>{shortModel(name)}</span>;
    };
    return (
        <section className="msg-turn" aria-label="Two models on this turn">
            <header className="msg-turn-head">
                <span className="msg-turn-label">Two models on this turn</span>
                <span className="msg-turn-pair">
                    {pill(lead)}
                    {lead && assistant && <span className="msg-turn-muted" aria-hidden="true">+</span>}
                    {pill(assistant)}
                </span>
                {totals.length > 0 && <span className="msg-turn-totals">{totals.join(' \u00b7 ')}</span>}
            </header>
            <ol className="msg-turn-timeline">
                {steps.map(st => (
                    <li key={st.key} className="msg-turn-event" data-state={st.failed ? 'failed' : st.warn ? 'warn' : 'done'} data-kind={st.kind}>
                        <span className="msg-turn-dot" aria-hidden="true" />
                        <div className="msg-turn-line">
                            {pill(st.from || '')}
                            <span className="msg-turn-text">{st.text}</span>
                            {(st.meta || st.seconds >= 0.1) && (
                                <span className="msg-turn-meta">{[st.meta, fmtSecs(st.seconds)].filter(Boolean).join(' \u00b7 ')}</span>
                            )}
                        </div>
                        {st.detail && <div className="msg-turn-detail" title={st.detail}>{st.detail}</div>}
                        {(st.jobs || []).length > 0 && (
                            <ul className="msg-turn-jobs">
                                {st.jobs.map((j, i) => <ExchangeJob key={`${st.key}j${i}`} job={j} />)}
                            </ul>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}

// The model's working narration and the tool calls it made, in order, above
// the answer — as a numbered timeline of STEPS (user: "make the working notes
// easier to follow and better structured"). One step = the prose the model
// wrote before a tool round + that round's calls. Each step opens with a
// one-line summary of what it did ("Read stick_fighter.html · Browsed the web
// ×2"), a state dot and its duration, then the narration, then the calls —
// live milestone lines while streaming, the chip blocks once committed (the
// chips are the same objects the bubble's charts/images/artifacts passes read).
function fmtMs(ms) {
    if (!(ms > 0)) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
function stepSummary(calls) {
    const groups = [];
    for (const tc of calls) {
        if (!tc) continue;
        const name = tc.label || tc.name || 'tool';
        const last = groups[groups.length - 1];
        if (last && last.name === name) last.calls.push(tc);
        else groups.push({ name, calls: [tc] });
    }
    return groups.map(g => {
        const done = !g.calls.some(c => c.status === 'partial' || c.status === 'running');
        const verb = stepVerb(g.name, done);
        // The call's own `purpose` reads best ("Write cfg.json with three keys");
        // fall back to the argument subject, clipped so a raw shell command or
        // a long path never becomes the headline.
        const clip = (v, n) => (v.length > n ? v.slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026' : v);
        let subject = '';
        if (g.calls.length === 1) {
            const c = g.calls[0];
            const purpose = String(c.purpose || '').replace(/\s+/g, ' ').trim();
            subject = purpose ? `\u2014 ${clip(purpose, 72)}` : clip(callSubject(c), 40);
        }
        const count = g.calls.length > 1 ? ` \u00d7${g.calls.length}` : '';
        return `${verb}${subject ? ` ${subject}` : ''}${count}`;
    });
}
function stepState(calls) {
    if (calls.some(c => c && (c.status === 'partial' || c.status === 'running'))) return 'running';
    if (calls.some(c => c && c.status === 'failed')) return 'failed';
    return 'done';
}
function WorkingNotes({ segments, toolCalls, open, onToggle, isStreaming }) {
    const calls = Array.isArray(toolCalls) ? toolCalls.length : 0;
    const dur = fmtMs(totalToolMs(toolCalls));
    const failed = Array.isArray(toolCalls) ? toolCalls.filter(t => t && t.status === 'failed').length : 0;
    const meta = [`${segments.length} step${segments.length === 1 ? '' : 's'}`];
    if (calls !== segments.length) meta.push(`${calls} tool call${calls === 1 ? '' : 's'}`);
    if (failed) meta.push(`${failed} failed`);
    if (dur) meta.push(dur);
    return (
        <div className="msg-notes">
            <button
                type="button"
                className="msg-notes-toggle"
                onClick={onToggle}
                aria-expanded={open}
                aria-label={open ? 'Collapse working notes' : 'Expand working notes'}
            >
                <ChevronDown strokeWidth={2} />
                <span className="msg-turn-label">Working notes</span>
                <span className="msg-turn-totals">{meta.join(' \u00b7 ')}</span>
            </button>
            {open && (
                <ol className="msg-notes-steps">
                    {segments.map((seg, i) => {
                        const state = stepState(seg.calls);
                        const summary = stepSummary(seg.calls);
                        const stepMs = totalToolMs(seg.calls);
                        const text = seg.text.trim();
                        return (
                            <li key={i} className="msg-notes-step" data-state={state}>
                                <span className="msg-notes-step-dot" aria-hidden="true" />
                                <div className="msg-notes-step-head">
                                    <span className="msg-notes-step-n">Step {i + 1}</span>
                                    <span className="msg-notes-step-sum" title={summary.join(' \u00b7 ')}>{summary.join(' \u00b7 ')}</span>
                                    {state === 'running'
                                        ? <span className="msg-turn-meta">in progress</span>
                                        : (stepMs > 0 ? <span className="msg-turn-meta">{fmtMs(stepMs)}</span> : null)}
                                </div>
                                {text ? (
                                    <div className="msg-notes-text">
                                        <MessageContent content={seg.text} isStreaming={isStreaming} />
                                    </div>
                                ) : null}
                                {/* The same chip view live and committed (user: the notes
                                    "have a different view when all responses are done") — a
                                    running chip carries its clock, a finished one its result. */}
                                <div className="msg-notes-calls">
                                    <div className="msg-tools-list">
                                        {seg.calls.map((tc, j) => <ToolCallBlock key={tc.tool_call_id || tc.toolCallId || j} tool={tc} />)}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}

export default React.memo(function ChatMessage({
    id,
    role,
    content,
    reasoning,
    timestamp,
    attachments,
    isStreaming,
    streamingContent,
    streamingReasoning,
    responseTime,
    tokenCount,
    needsContinuation,
    isPartial,
    onContinue,
    isLoading,
    toolCalls,
    searchResults,
    modelName,
    // Tooltip for the name — e.g. why the secondary stayed out of this turn.
    modelTitle,
    // The secondary's pass over the answer. In edit mode the polish is silent,
    // so this is what makes it visible without touching the answer itself.
    review,
    // Two-model turns: the model that did the first pass + background legwork
    // for whoever wrote the answer. Undefined on a single-model chat.
    assistedBy,
    onOpenArtifacts,
    streamingStatus,
    handoff,
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [previewAttachment, setPreviewAttachment] = useState(null);
    // Tool-call group collapse. Always rendered as a collapsible
    // summary — chips fold to a one-line "N tool calls · names"
    // header by default. While streaming we keep them expanded so
    // in-flight chips stay visible; once streaming ends (or for
    // already-loaded messages) they collapse to the summary line.
    // For chart calls the chart itself surfaces in the main bubble
    // body anyway, so the chip strip is purely a transparency footer.
    const [toolsExpanded, setToolsExpanded] = useState(false);
    // A delegate call in flight is the one chip worth watching (each worker
    // agent's tool calls stream into it) — unfold the strip for it unless the
    // user has folded it by hand.
    const toolsToggledRef = useRef(false);
    const delegateRunning = !!(isStreaming && Array.isArray(toolCalls) && toolCalls.some(tc => tc && (tc.name === 'delegate' || tc.label === 'delegate') && (tc.status === 'partial' || tc.status === 'running')));
    React.useEffect(() => {
        if (delegateRunning && !toolsToggledRef.current) setToolsExpanded(true);
    }, [delegateRunning]);
    // Re-render once a second while a tool is in flight so the running-tool
    // label's elapsed clock advances (nothing else in the bubble changes
    // while the model waits on a tool).
    // ...and while a two-model hand-off is live, whose per-model rows carry
    // their own clocks even when no tool of the primary's is in flight.
    const handoffActive = !!(isStreaming && handoffActors(handoff));
    const hasRunningTool = !!(isStreaming && runningToolsOf(toolCalls).length) || handoffActive;
    const [, setToolTick] = useState(0);
    const handoffStartsRef = useRef({});
    // The server swapped the draft in place (held revision / checker edit):
    // flash the bubble for ~a second so the change reads as a polish.
    const revisedAt = useChatStore(state => state.streamingRevisedAt);
    const revised = !!(isStreaming && revisedAt && Date.now() - revisedAt < 1000);
    React.useEffect(() => {
        if (!revised) return undefined;
        const t = setTimeout(() => setToolTick(x => x + 1), 1000);
        return () => clearTimeout(t);
    }, [revisedAt]);
    // Working notes (narration + chips before the answer): open while the
    // turn streams and LEFT open when it commits — folding them at that
    // moment shoves the answer up just as the user starts reading it. A
    // fresh mount (reload, switching back) starts folded.
    const [notesOpen, setNotesOpen] = useState(() => {
        if (isStreaming) return true;
        // Just committed from a stream (foreground or reconnect) — keep open.
        return !!(id && useChatStore.getState().notesOpenMessageId === id);
    });
    React.useEffect(() => {
        if (!hasRunningTool) return undefined;
        const id = setInterval(() => setToolTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, [hasRunningTool]);
    const prevStreamingRef = useRef(isStreaming);
    React.useEffect(() => {
        if (prevStreamingRef.current && !isStreaming) {
            setToolsExpanded(false);
        }
        prevStreamingRef.current = isStreaming;
    }, [isStreaming]);
    const reasoningRef = useRef(null);

    // Collapse state lives in the Zustand store so it survives remounts during streaming.
    const collapseKey = id || (isStreaming ? '__streaming__' : null);
    const bodyCollapsed = useChatStore(state => collapseKey ? !!state.collapsedMessageIds[collapseKey] : false);
    const toggleMessageCollapsed = useChatStore(state => state.toggleMessageCollapsed);
    const setMessageCollapsed = useChatStore(state => state.setMessageCollapsed);

    const isUser = role === 'user';
    const displayContent = isStreaming ? streamingContent : content;
    const displayReasoning = isStreaming ? streamingReasoning : reasoning;

    // Narration/answer split, keyed on each chip's contentOffset. Legacy
    // messages (chips without an offset) and a turn that never reached an
    // answer keep the old layout.
    const split = React.useMemo(() => splitNarration(displayContent, toolCalls), [displayContent, toolCalls]);
    const notesLayout = !isUser && !split.legacy && Array.isArray(toolCalls) && toolCalls.length > 0
        && (isStreaming || !!split.answer.trim());
    const answerText = notesLayout ? split.answer : displayContent;

    // Deduped image grids for the bubble. The server now dedups find_image
    // results across calls within one reply, but this stays as the display
    // safety net: (1) already-saved messages from before that fix, and (2) the
    // model repeating a grid image as its own markdown ![](url) in the prose —
    // the prose copy keeps the model's caption/layout, so the GRID tile is the
    // one suppressed. A spec whose images all dedup away is dropped entirely.
    const bubbleImageSpecs = React.useMemo(() => {
        if (isUser || !Array.isArray(toolCalls)) return [];
        const specs = toolCalls.filter(tc => tc?.imageSpec && Array.isArray(tc.imageSpec.images)).map(tc => tc.imageSpec);
        if (!specs.length) return [];
        const norm = (u) => (typeof u === 'string' && !/^data:/i.test(u)
            ? u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase()
            : '');
        const seen = new Set();
        // Images the model already embedded in the prose as markdown.
        const md = typeof displayContent === 'string' ? displayContent : '';
        const mdImg = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
        let m;
        while ((m = mdImg.exec(md))) { const k = norm(m[1]); if (k) seen.add(k); }
        const out = [];
        for (const spec of specs) {
            const images = spec.images.filter(im => {
                const keys = [norm(im?.thumbnail), norm(im?.url)].filter(Boolean);
                if (!keys.length) return true; // data-url-only capture — can't key it, keep it
                if (keys.some(k => seen.has(k))) return false;
                keys.forEach(k => seen.add(k));
                return true;
            });
            if (images.length) out.push(images.length === spec.images.length ? spec : { ...spec, images });
        }
        return out;
    }, [isUser, toolCalls, displayContent]);

    const handleToggleReasoning = (e) => {
        e.stopPropagation();
        setReasoningExpanded(!reasoningExpanded);
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(displayContent || '');
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    // Shared inline styles that use the design palette bridge.
    const aiBubble = {
        background: 'var(--bubble-ai-bg)',
        color: 'var(--ink)',
        border: 'var(--bubble-border)',
        borderRadius: 'var(--bubble-radius)',
        padding: 'var(--bubble-pad-y) var(--bubble-pad-x)',
        boxShadow: 'var(--bubble-shadow)',
        alignSelf: 'stretch',
        maxWidth: '100%',
        // Same overflow guard as the user bubble — a long unbroken token in
        // prose can't wrap at a space and would push past the edge. Code
        // blocks are unaffected (their own overflow-x container + white-space:
        // pre override wrapping).
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
    };
    // User bubble stays as a proper bubble even in flat-bubble mode
    // so right-aligned user text reads as a message, not a highlight.
    const userBubble = {
        background: 'var(--bubble-user-bg)',
        color: 'var(--bubble-user-ink)',
        borderRadius: 16,
        borderBottomRightRadius: 6,
        padding: '10px 15px',
        maxWidth: '78%',
        alignSelf: 'flex-end',
        // Long unbroken pastes (URLs, hashes, base64, file paths) have no
        // space to wrap at, so without this they overflow the bubble's right
        // edge. `anywhere` both breaks the run AND lets the box shrink to fit;
        // `pre-wrap` on children preserves multi-line paste layout.
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
    };
    const collapseBtn = {
        transition: 'opacity .12s, background .12s, color .12s',
        opacity: hovered || bodyCollapsed ? 1 : 0.4,
    };
    const actionsRow = {
        transition: 'opacity .12s',
        opacity: hovered ? 1 : 0,
    };

    return (
        <div
            style={{
                gap: 6,
                width: '100%',
                marginBottom: 'var(--msg-gap)',
            }}
            className={`msg-root flex flex-col min-w-0 ${isUser ? 'items-end' : 'items-start'} ${isStreaming ? '' : 'animate-fade-in'}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {/* File attachments above user messages — clickable to open
                FilePreviewModal. Only enable the click when the persisted
                attachment carries previewable data (content / dataUrl /
                sheets); old conversations may have only a filename stub. */}
            {isUser && attachments && attachments.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 2, maxWidth: '85%', justifyContent: 'flex-end' }}>
                    {attachments.map((att, i) => {
                        const previewable = isAttachmentPreviewable(att);
                        if (!previewable) {
                            return (
                                <div key={i} className="msg-attach-chip" title={att.filename || att.name}>
                                    <span>{att.filename || att.name}</span>
                                </div>
                            );
                        }
                        return (
                            <button
                                key={i}
                                type="button"
                                onClick={() => setPreviewAttachment(att)}
                                className="msg-attach-chip"
                                title="Click to preview"
                            >
                                <span>{att.filename || att.name}</span>
                                <Eye strokeWidth={1.75} />
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Meta row: badge + name + time + collapse toggle */}
            <div className="msg-meta" style={{
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                flexDirection: isUser ? 'row-reverse' : 'row',
                width: isUser ? undefined : '100%',
            }}>
                {isUser && (
                    <div className="msg-badge msg-badge-user">
                        <User strokeWidth={2.25} />
                    </div>
                )}
                <span className="msg-name" title={!isUser ? (modelTitle || modelName || undefined) : undefined}>{isUser ? 'You' : (modelName ? modelName.replace(/[^·\s][^·]*$/, (m) => shortModel(m.trim())) : 'Assistant')}</span>
                {!isUser && assistedBy && (
                    <span className="msg-time" title={`${assistedBy} prepared the brief and ran background jobs for this answer`}>
                        with {shortModel(assistedBy)}
                    </span>
                )}
                {timeStr && <span className="msg-time">{timeStr}</span>}
                {!isUser && displayContent && !isStreaming && collapseKey && (
                    <button
                        onClick={() => toggleMessageCollapsed(collapseKey)}
                        className="message-collapse-btn msg-collapse-btn ui-chip-btn"
                        style={collapseBtn}
                        title={bodyCollapsed ? 'Expand response' : 'Collapse response'}
                    >
                        <span style={{ display: 'inline-flex', transform: bodyCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform .15s' }}>
                            <ChevronDown strokeWidth={2} />
                        </span>
                        <span>{bodyCollapsed ? 'Expand' : 'Collapse'}</span>
                    </button>
                )}
            </div>

            {/* Skip bubble entirely for user message with no content (paste-as-file case) */}
            {isUser && !displayContent ? null : (
                <div style={isUser ? userBubble : aiBubble} className={isUser ? 'message-user' : `message-assistant${revised ? ' bubble-revised' : ''}`}>
                    {/* Reasoning / thinking dropdown */}
                    {displayReasoning && (
                        <div ref={reasoningRef} style={{ marginBottom: 10, marginLeft: -6 }}>
                            <button
                                onClick={handleToggleReasoning}
                                className="msg-thinking-toggle"
                                aria-expanded={reasoningExpanded}
                            >
                                <span>{isStreaming && !displayContent ? 'Thinking' : 'Thought process'}</span>
                                <span className="msg-thinking-count">· {displayReasoning.length.toLocaleString()} chars</span>
                                {reasoningExpanded
                                    ? <ChevronUp strokeWidth={2} />
                                    : <ChevronDown strokeWidth={2} />
                                }
                            </button>
                            {reasoningExpanded && (() => {
                                const steps = splitReasoningIntoSteps(displayReasoning);
                                const structured = steps.length >= 3;
                                return (
                                    <div className="msg-thinking-panel" style={{ marginLeft: 6 }}>
                                        {structured ? (
                                            <ol>
                                                {steps.map((step, i) => (
                                                    <li key={i}>
                                                        <span className="msg-thinking-n">{i + 1}.</span>
                                                        <span style={{ whiteSpace: 'pre-wrap', flex: 1 }}>{step}</span>
                                                    </li>
                                                ))}
                                            </ol>
                                        ) : (
                                            <p>{displayReasoning}</p>
                                        )}
                                    </div>
                                );
                            })()}

                        </div>
                    )}

                    {/* Live tool-call milestones — short breadcrumb per
                        in-flight / completed tool so the user gets running
                        narration of what the model is actually doing
                        (separate from the bottom dot-chip). Only during
                        streaming; the collapsed chip strip below takes
                        over once the message is committed. */}
                    {isStreaming && !notesLayout && Array.isArray(toolCalls) && toolCalls.length > 0 && (
                        <ToolMilestones toolCalls={toolCalls} />
                    )}

                    {/* Two-model pairing: one live row per model that is
                        working right now, so "the secondary is writing WHILE
                        the primary runs two background jobs" is visible
                        instead of reading as a single silent model. */}
                    {isStreaming && handoffActive && (
                        <HandoffRows rows={handoffRows({ handoff, toolCalls, now: Date.now(), startsRef: handoffStartsRef })} />
                    )}

                    {/* Working notes → divider → answer. The two-model exchange
                        record sits above the notes so the order reads exchange,
                        notes, answer. */}
                    {notesLayout && !isStreaming && !bodyCollapsed && (
                        <ExchangePanel steps={exchangeSteps(toolCalls, review)} />
                    )}
                    {notesLayout && !bodyCollapsed && (
                        <WorkingNotes
                            segments={split.segments}
                            toolCalls={toolCalls}
                            open={notesOpen}
                            onToggle={() => setNotesOpen(v => !v)}
                            isStreaming={isStreaming}
                        />
                    )}
                    {/* The ANSWER label is held until the turn ends: while it
                        streams, text after the last call may still turn out to
                        be narration (the next tool call moves it up into the
                        notes), so an unlabelled rule of the same height keeps
                        the separation without asserting what the text is. */}
                    {notesLayout && !bodyCollapsed && !!split.answer.trim() && (
                        <div className={`msg-answer-divider${isStreaming ? ' msg-answer-divider--pending' : ''}`} aria-hidden="true">
                            <span>{isStreaming ? '' : 'Answer'}</span>
                        </div>
                    )}

                    {/* Body content */}
                    {isStreaming && !displayContent ? (
                        <ThinkingIndicator label={deriveStreamingLabel({
                            toolCalls,
                            streamingStatus,
                            handoff,
                            hasContent: false,
                            hasReasoning: !!displayReasoning,
                            now: Date.now(),
                            startsRef: handoffStartsRef,
                        })} />
                    ) : bodyCollapsed ? (
                        (() => {
                            const cleaned = (displayContent || '')
                                .replace(/```[\s\S]*?```/g, '[code]')
                                .replace(/`([^`]+)`/g, '$1')
                                .replace(/\*\*([^*]+)\*\*/g, '$1')
                                .replace(/\*([^*]+)\*/g, '$1')
                                .replace(/^#{1,6}\s+/gm, '')
                                .replace(/^[-*+]\s+/gm, '')
                                .replace(/^\d+\.\s+/gm, '');
                            const firstLine = (cleaned.split('\n').find(l => l.trim().length > 0) || '').trim();
                            const MAX = 90;
                            const preview = firstLine.length > MAX
                                ? firstLine.slice(0, MAX).replace(/\s+\S*$/, '') + '…'
                                : firstLine;
                            const chars = (displayContent || '').length;
                            return (
                                <button
                                    onClick={() => collapseKey && setMessageCollapsed(collapseKey, false)}
                                    className="msg-collapsed-preview"
                                >
                                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {preview || 'Collapsed response'}
                                    </span>
                                    <span style={{ color: 'var(--ink-4)', '--fs': '11.5px', flexShrink: 0 }}>
                                        {chars.toLocaleString()} chars · click to expand
                                    </span>
                                </button>
                            );
                        })()
                    ) : (
                        <MessageContent content={answerText} isStreaming={isStreaming} />
                    )}

                    {/* Live status footer — keeps the activity indicator
                        visible WHILE content streams. Pre-content the
                        ThinkingIndicator above is shown instead. Hidden
                        once streaming finishes. */}
                    {isStreaming && displayContent && !bodyCollapsed && (() => {
                        const label = deriveStreamingLabel({
                            toolCalls,
                            streamingStatus,
                            handoff,
                            hasContent: true,
                            hasReasoning: !!displayReasoning,
                            now: Date.now(),
                            startsRef: handoffStartsRef,
                        });
                        return (
                            <div
                                className="streaming-status-chip"
                                aria-live="polite"
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    marginTop: 10,
                                    padding: '0 10px 0 8px',
                                    borderRadius: 999,
                                    background: 'color-mix(in oklab, var(--accent, #6366f1) 10%, transparent)',
                                    border: '1px solid color-mix(in oklab, var(--accent, #6366f1) 22%, transparent)',
                                    color: 'var(--ink-3)',
                                    '--fs': '12px',
                                    lineHeight: 1,
                                    maxWidth: '100%',
                                }}
                            >
                                <div className="flex items-center gap-1">
                                    <div className="thinking-dot" style={{ animationDelay: '0s' }} />
                                    <div className="thinking-dot" style={{ animationDelay: '0.2s' }} />
                                    <div className="thinking-dot" style={{ animationDelay: '0.4s' }} />
                                </div>
                                <span style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    maxWidth: 360,
                                }}>{label}</span>
                            </div>
                        );
                    })()}

                    {/* Inline charts — surface render_chart results in the
                        main response body so users don't have to expand the
                        tool chip to see the visual. Charts also still render
                        inside the chip dropdown for transparency, but this
                        is where they belong as a first-class part of the
                        assistant's reply. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.some(tc => tc?.chartSpec) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: displayContent ? 12 : 0 }}>
                            {toolCalls.filter(tc => tc?.chartSpec).map((tc, idx) => (
                                <ChartBlock
                                    key={`bubble-chart-${idx}`}
                                    spec={tc.chartSpec}
                                    summary={tc.chartSummary || ''}
                                />
                            ))}
                        </div>
                    )}

                    {/* Inline images — surface find_image results as a thumbnail
                        grid in the main response body, same first-class treatment
                        as charts. The picture is what the user asked for, so it
                        belongs in the reply, not buried in the tool chip. */}
                    {!isUser && !bodyCollapsed && bubbleImageSpecs.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: displayContent ? 12 : 0 }}>
                            {bubbleImageSpecs.map((spec, idx) => (
                                <ImageBlock key={`bubble-image-${idx}`} spec={spec} />
                            ))}
                        </div>
                    )}

                    {/* Inline videos — surface find_video results as click-to-play
                        players in the main response body, same first-class
                        treatment as images/charts. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.some(tc => tc?.videoSpec) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: displayContent ? 12 : 0 }}>
                            {toolCalls.filter(tc => tc?.videoSpec).map((tc, idx) => (
                                <VideoBlock key={`bubble-video-${idx}`} spec={tc.videoSpec} />
                            ))}
                        </div>
                    )}

                    {/* Inline downloadable artifacts — surface every file the
                        model produced (PDFs, docx, xlsx, anything written to
                        /artifacts/) as a download card in the bubble itself,
                        same pattern as charts. The chip dropdown still shows
                        them for transparency, but the user shouldn't have to
                        expand a tool chip to grab a file they just asked for. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && (() => {
                        const all = [];
                        for (const tc of toolCalls) {
                            if (Array.isArray(tc?.artifacts)) {
                                for (const a of tc.artifacts) {
                                    if (a && a.url && a.name) all.push(a);
                                }
                            }
                        }
                        if (all.length === 0) return null;
                        // Images the reply already embeds as markdown are not
                        // previewed a second time.
                        const embeddedImgs = typeof displayContent === 'string'
                            ? (displayContent.match(/!\[[^\]]*\]\(([^)\s]+)/g) || []).map(m => m.replace(/^!\[[^\]]*\]\(/, ''))
                            : [];
                        return (
                            <div style={{ marginTop: displayContent ? 12 : 0 }}>
                                <ArtifactList artifacts={all} skipPreviewUrls={embeddedImgs} />
                            </div>
                        );
                    })()}

                    {/* Inline artifact chip — shown when the assistant response
                        contains one or more fenced code blocks. Click opens the
                        right-rail Artifacts panel. */}
                    {!isUser && !isStreaming && !bodyCollapsed && displayContent && onOpenArtifacts && (() => {
                        const matches = (displayContent || '').match(/```[\w-]*\s*(?:\[[^\]]+\])?\n[\s\S]*?```/g);
                        const count = matches ? matches.length : 0;
                        if (count === 0) return null;
                        const firstMatch = matches[0];
                        const langMatch = firstMatch.match(/^```(\w+)/);
                        const lang = langMatch ? langMatch[1] : 'code';
                        return (
                            <button
                                onClick={onOpenArtifacts}
                                className="msg-artifact-card"
                            >
                                <div className="msg-artifact-icon">
                                    <CodeIcon strokeWidth={1.75} />
                                </div>
                                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                    <div className="msg-artifact-title">
                                        {count} code artifact{count === 1 ? '' : 's'}
                                    </div>
                                    <div className="msg-artifact-sub">
                                        {lang}{count > 1 ? ` + ${count - 1} more` : ''} · Open in panel
                                    </div>
                                </div>
                                <Eye style={{ width: 14, height: 14, color: 'var(--ink-3)', flexShrink: 0 }} strokeWidth={1.75} />
                            </button>
                        );
                    })()}

                    {/* Search source chips */}
                    {!isUser && !isStreaming && !bodyCollapsed && Array.isArray(searchResults) && searchResults.length > 0 && (
                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--rule-2)' }}>
                            <SearchSources sources={searchResults} />
                        </div>
                    )}

                    {/* Tool calls — always wrapped in a collapsible summary
                        so the chip strip stays unobtrusive. Defaults to
                        folded post-stream; expanded during streaming so
                        users see live progress. Charts also surface in the
                        main body above (see ChartBlock pass) — this strip
                        is the transparency footer. */}
                    {!isUser && !bodyCollapsed && !isStreaming && !notesLayout && (
                        <ExchangePanel steps={exchangeSteps(toolCalls, review)} />
                    )}

                    {!isUser && !bodyCollapsed && !notesLayout && Array.isArray(toolCalls) && toolCalls.length > 0 && (() => {
                        // Group header summary: count unique tool names so the user
                        // sees "web_search, fetch_url (x5)" rather than a raw count.
                        const counts = {};
                        for (const tc of toolCalls) {
                            const nm = tc?.name || tc?.label || tc?.type || 'tool';
                            counts[nm] = (counts[nm] || 0) + 1;
                        }
                        const summary = Object.entries(counts)
                            .map(([n, c]) => c > 1 ? `${n} ×${c}` : n)
                            .join(', ');
                        return (
                            <div className="msg-tools-section">
                                <button
                                    type="button"
                                    onClick={() => { toolsToggledRef.current = true; setToolsExpanded(v => !v); }}
                                    className="msg-tools-toggle"
                                    aria-expanded={toolsExpanded}
                                    aria-label={toolsExpanded ? 'Collapse tool calls' : 'Expand tool calls'}
                                >
                                    <ChevronDown strokeWidth={2} />
                                    <span className="msg-tools-count">
                                        {toolCalls.length} tool {toolCalls.length === 1 ? 'call' : 'calls'}
                                    </span>
                                    <span style={{ color: 'var(--ink-4)' }}>·</span>
                                    <span className="msg-tools-summary">{summary}</span>
                                </button>
                                {toolsExpanded && (
                                    <div className="msg-tools-list">
                                        {toolCalls.map((tc, idx) => (
                                            <ToolCallBlock key={idx} tool={tc} />
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Partial / interrupted indicator */}
                    {!isUser && !isStreaming && (needsContinuation || isPartial) && (
                        <div className="msg-partial-banner">
                            <AlertCircle strokeWidth={2} />
                            <span>Response cut off</span>
                        </div>
                    )}
                </div>
            )}

            {/* Hover-revealed action row (assistant messages) */}
            {!isUser && displayContent && !isStreaming && (
                <div className="message-actions-row" style={{ ...actionsRow, alignSelf: 'stretch', marginLeft: -8 }}>
                    <button
                        onClick={handleCopy}
                        className={`ui-chip-btn ${copied ? 'is-active' : ''}`}
                        title={copied ? 'Copied!' : 'Copy response'}
                    >
                        {copied ? <Check strokeWidth={2.25} /> : <Copy strokeWidth={1.75} />}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>

                    {(needsContinuation || isPartial) && onContinue && (
                        <button
                            onClick={() => onContinue(id, content)}
                            disabled={isLoading}
                            className={`ui-chip-btn ${isLoading ? '' : 'is-accent'}`}
                            title="Continue generating"
                        >
                            <PlayCircle strokeWidth={1.75} className={isLoading ? 'animate-pulse' : ''} />
                            <span>{isLoading ? 'Continuing…' : 'Continue'}</span>
                        </button>
                    )}

                    <span className="msg-stats">
                        {responseTime && (
                            <span title="Response time">
                                <Clock strokeWidth={1.75} />
                                {responseTime < 1000 ? `${responseTime}ms` : `${(responseTime / 1000).toFixed(1)}s`}
                            </span>
                        )}
                        {tokenCount && (
                            <span title="Tokens">
                                <Zap strokeWidth={1.75} />
                                {tokenCount.toLocaleString?.() || tokenCount}
                            </span>
                        )}
                    </span>
                </div>
            )}

            {previewAttachment && (
                <FilePreviewModal
                    attachment={previewAttachment}
                    onClose={() => setPreviewAttachment(null)}
                />
            )}
        </div>
    );
});
