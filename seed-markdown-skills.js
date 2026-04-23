#!/usr/bin/env node
// Seed a library of markdown skills for the chat model to load on demand.
// Each entry is an instructional procedure — the model reads it via the
// `load_skill` tool when a user request matches the name / description /
// triggers, then uses the real tool catalog (web_search, fetch_url, the
// sandboxed file-op skills, etc.) to carry the steps out.
//
// Usage:
//   API_KEY=... API_SECRET=... node seed-markdown-skills.js [--force]
//     --force   delete + recreate a skill even if the id already exists
//
// Skills are created as "global" (no userId) so every user sees them.

const https = require('https');

const BASE = process.env.BASE_URL || 'https://localhost:3001';
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const FORCE = process.argv.includes('--force');
if (!API_KEY || !API_SECRET) {
    console.error('API_KEY and API_SECRET env vars required');
    process.exit(2);
}

// Skills are declared here inline. Keep bodies terse — they're injected into
// the model's context on load, so every sentence costs tokens. Focus on:
//   - concrete steps
//   - which tool to call at each step (from the catalog)
//   - success criteria / output shape
const SKILLS = [
    {
        name: 'GitHub repo research',
        description: 'Gather stars, language, recent activity, and purpose of a GitHub repository',
        triggers: 'github, repo, repository, project info',
        body: `## Goal
Collect a concise profile of a GitHub repository: purpose, popularity,
primary language, recent activity, and notable contributors.

## Steps
1. Call \`fetch_url\` on \`https://github.com/<owner>/<repo>\` to get the
   landing-page HTML (title, tagline, README preview, stars, watchers).
2. If the README preview is truncated, \`fetch_url\` the raw README at
   \`https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md\`.
3. \`fetch_url\` \`https://api.github.com/repos/<owner>/<repo>\` for
   structured metadata (\`stargazers_count\`, \`forks_count\`,
   \`pushed_at\`, \`language\`, \`topics\`).
4. \`fetch_url\` \`https://api.github.com/repos/<owner>/<repo>/commits?per_page=5\`
   for the 5 most recent commits (dates + messages).

## Output
Produce a 6-bullet summary:
- One-line purpose
- Stars / forks / primary language
- Last push date (relative)
- 3 most interesting recent changes (from commits)
- License (if in metadata)
- Noteworthy topics or the README's setup section if relevant`,
    },
    {
        name: 'Summarize URL',
        description: 'Fetch a web page and produce a tight structured summary',
        triggers: 'summarize, summary, article, url, page',
        body: `## Goal
Convert a long article / documentation page into a 5–7 bullet
ready-to-share summary.

## Steps
1. \`fetch_url\` the page (maxLength 20000).
2. Discard boilerplate (nav, ads, related-posts sidebar).
3. Identify thesis, then scan for supporting facts: numbers, dates,
   named entities, direct quotes.
4. If the content is code-heavy, grab ONE representative snippet.

## Output
\`\`\`
TITLE: <page title>
THESIS: <one sentence>
• <key point 1 with a number or named entity>
• <key point 2>
• <key point 3>
• <key point 4>
• <key point 5>
SOURCE: <url>
\`\`\`
Stop there — don't editorialize.`,
    },
    {
        name: 'Compare options',
        description: 'Produce a structured comparison of two or more alternatives',
        triggers: 'compare, comparison, alternatives, vs',
        body: `## Goal
Let the user decide between 2–5 alternatives by showing the axes that
actually differ.

## Steps
1. For each option, \`web_search\` "<option> vs <other>" AND
   "<option> review N" to gather current opinion.
2. Pick 4–6 axes that differ materially (price, performance, lock-in,
   ecosystem, learning curve — whatever applies).
3. Dismiss axes where everything is equivalent; don't pad the table.

## Output
Markdown table, one row per axis, one column per option, plus a final
row "Best for …" with the scenario each option wins. End with a
one-sentence recommendation only if the user asked for one.`,
    },
    {
        name: 'Find recent news',
        description: 'Research what has happened on a topic in the last weeks/months',
        triggers: 'news, recent, latest, developments, update',
        body: `## Goal
Surface the last 30 days of real developments on a topic, with sources.

## Steps
1. \`web_search\` "<topic> news" — allow the catalog's auto-date
   filter to scope to recent results.
2. Dedupe by story: if 3 outlets cover the same event, keep the
   earliest / most detailed one.
3. \`fetch_url\` the top 3 results to verify dates and get real
   quotes. Ignore anything older than 60 days unless it's directly
   referenced by a recent story.

## Output
\`\`\`
<date>  <one-line headline>
        <outlet> — <url>
        <2-sentence context of why it matters>
\`\`\`
List 4–7 entries. If the topic is quiet, say so rather than padding.`,
    },
    {
        name: 'Debug Python error',
        description: 'Systematic workflow for diagnosing a Python stack trace',
        triggers: 'error, exception, traceback, python, debug, stack trace',
        body: `## Goal
Identify the root cause of a Python exception and propose a fix.

## Steps
1. Read the traceback bottom-up: the innermost frame is where the
   exception was raised, not where the bug necessarily lives.
2. Classify: \`TypeError\` / \`AttributeError\` usually = wrong shape of
   data; \`KeyError\` / \`IndexError\` = missing entry; \`ImportError\` =
   environment problem; \`UnicodeDecodeError\` = encoding mismatch.
3. If the error mentions a library function, \`fetch_url\` that
   library's docs for that function's signature and expected inputs.
4. If it's an \`ImportError\` / \`ModuleNotFoundError\`, \`web_search\`
   "<package> install" — often needs a specific extras_require.

## Output
1. One-sentence diagnosis ("The function expects a list but got a
   generator").
2. The smallest code change that fixes it, as a diff-style snippet.
3. A one-line explanation of WHY the original code was wrong.`,
    },
    {
        name: 'Code review',
        description: 'Review a code snippet and produce actionable feedback',
        triggers: 'review, code review, feedback, critique',
        body: `## Goal
Give a code author high-signal feedback they can act on in < 15 minutes.

## Steps
Scan the snippet along four dimensions, in order:
1. **Correctness bugs** — off-by-one, wrong comparison, resource leak,
   race condition, unhandled None/null. This is the ONLY dimension
   where "severity: critical" is appropriate.
2. **Security** — injection, path traversal, SSRF, untrusted input
   deserialization, secret logging.
3. **Readability** — unclear names, dead branches, comments that
   explain *what* instead of *why*.
4. **Design** — wrong abstraction level, circular deps, one function
   doing 3 jobs.

Skip style nitpicks unless the user asked for them — a linter's job.

## Output
\`\`\`
[🔴 critical|🟡 important|🔵 nit] <file>:<line> — <one-line observation>
Fix: <what to do>
\`\`\`
Max 7 items. End with "Looks good otherwise" only if you actually
scanned the whole snippet.`,
    },
    {
        name: 'Explain concept',
        description: 'Break down a technical concept at an appropriate level',
        triggers: 'explain, concept, what is, how does',
        body: `## Goal
Teach a concept so the user can reason about it, not just recite it.

## Steps
1. One-sentence definition. No jargon the user hasn't already used.
2. A concrete analogy from a domain the user clearly knows
   (infer from how they phrased the question).
3. The minimal mental model: "You only need to hold 2–3 ideas in
   your head: X, Y, Z."
4. One worked example: show X=1, Y=2, trace through.
5. The sharpest misconception: "Common mistake: people think … but
   actually …"
6. Where this breaks down (every concept has an edge where the
   simple model stops being true).

## Output
Prose, ~250 words. Avoid bullet lists unless the user's question
suggested they want a reference.`,
    },
    {
        name: 'Choose library',
        description: 'Help pick between similar libraries for a specific task',
        triggers: 'library, package, which should I use, pick, choose',
        body: `## Goal
Pick the right library for THIS task — not the most popular overall.

## Steps
1. Clarify the task first: what inputs, what outputs, what scale,
   what platform. If the user was vague, ask before searching.
2. \`web_search\` "<task> python library" (or language). Collect
   candidates — usually 2–4 names dominate.
3. For each, \`fetch_url\` its docs index to check:
   - Last release date (anything > 18 months stale is risky)
   - License (GPL may be a blocker)
   - Dependencies count (fewer is better for most cases)
4. Score on: matches my exact need / is actively maintained /
   has docs / reasonable API surface.

## Output
Recommendation with one paragraph of reasoning. Mention the
runner-up and why you rejected it. If the user's task is better
solved without a library (10 lines of stdlib), say so.`,
    },
    {
        name: 'Analyze CSV',
        description: 'Workflow for exploring and summarizing a CSV file',
        triggers: 'csv, spreadsheet, tabular, data, analyze',
        body: `## Goal
Give the user a useful picture of a CSV file they haven't looked at
yet.

## Steps
1. \`read_file\` the CSV. Note size.
2. Peek at first 5 rows to see column names and shape.
3. Count rows. Infer types per column: numeric / string / date /
   boolean. Flag columns that look mixed.
4. Compute per-column:
   - Numeric: min / max / mean / missing count
   - Categorical: top 5 distinct values + their counts
   - Date: earliest / latest
5. Look for obvious issues: duplicate rows, entirely-empty columns,
   "N/A" strings in numeric columns.

## Output
\`\`\`
SHAPE: <rows> x <cols>
COLUMNS:
  - <name>  type=<type>  <stats or top values>
ISSUES:
  - <any that matter>
INTERESTING:
  - <one observation the user probably didn't know>
\`\`\``,
    },
    {
        name: 'Write README',
        description: 'Draft a project README from sparse notes',
        triggers: 'readme, documentation, project docs',
        body: `## Goal
Produce a README a new user can read in 2 minutes and then
successfully install and run the project.

## Steps
If the user gave sparse info, ask for:
- Project name + one-sentence elevator pitch
- How to install (pip / npm / go get / etc.)
- How to run the simplest example
- Who it's for (audience)

## Output
Markdown sections, in this order:
\`\`\`
# <Name>

<One-sentence pitch.>

## Install

<Single command or 3-line recipe.>

## Quick example

<Minimal working snippet that produces visible output.>

## What it does

<2 paragraphs — problem, approach.>

## Configuration

<Table of env vars / flags, only if any. Skip if none.>

## License
\`\`\`
Do NOT invent sections the project doesn't have (Contributing,
Roadmap, Sponsors). Less is more.`,
    },
    {
        name: 'Draft professional email',
        description: 'Compose a clear professional email from bullet points',
        triggers: 'email, draft, write message, compose',
        body: `## Goal
Turn bullet notes into a polished email that gets the recipient to
respond or act.

## Steps
1. Identify the ONE thing you want the recipient to do (reply with X,
   approve Y, call back). That goes in the first sentence of the body
   and in the subject.
2. Pick register: formal / collegial / warm. Match the recipient's
   usual register if you have past threads — don't out-formalize them.
3. Keep to 4 paragraphs max: context / ask / detail / close.
4. Remove filler: "I hope this finds you well", "Just wanted to
   reach out", "As discussed" — only keep if factually true and
   useful.

## Output
\`\`\`
Subject: <concrete, contains the ask>

Hi <name>,

<Ask in sentence 1.>

<1–2 sentences of why / context.>

<Specifics: dates, numbers, attachments.>

<Clear close: "Does Thursday 2pm work?" / "Happy to expand if
useful." — something actionable.>

Thanks,
<signature>
\`\`\``,
    },
    {
        name: 'Plan research task',
        description: 'Break a fuzzy question into a research plan before diving in',
        triggers: 'plan, research, approach, how should I',
        body: `## Goal
Before spending 30 minutes searching, spend 2 minutes deciding what
"done" looks like.

## Steps
1. Restate the question in one sentence. If that's hard, the question
   isn't clear yet — ask the user what would make the answer useful.
2. Name the format of the deliverable: comparison table? numbered
   list of pros/cons? code snippet? 2-paragraph summary?
3. Enumerate what you need to find: 3–5 facts / numbers / quotes.
   Be specific: not "pricing info" but "price for the 10-seat tier".
4. Pick the cheapest source first: existing docs > a single
   authoritative page > a broad search.

## Output
\`\`\`
QUESTION: <one sentence>
DELIVERABLE: <format>
UNKNOWNS:
  - <fact 1>
  - <fact 2>
PLAN:
  1. <first lookup>
  2. <next>
STOP-CONDITION: <what makes this "done enough">
\`\`\`
Then execute. Don't ask the user to approve the plan unless it
diverges materially from their original ask.`,
    },
    {
        name: 'Competitive analysis',
        description: 'Research a company\'s competitors and position them',
        triggers: 'competitor, competitive, market, positioning',
        body: `## Goal
Map 3–6 competitors of a company with enough detail that a PM can
use it in a strategy doc.

## Steps
1. \`web_search\` "<company> competitors" AND "<company> alternatives".
2. \`web_search\` "<category> market leaders 202X" for the broader
   landscape.
3. For each competitor, \`fetch_url\` their homepage + /pricing.
   Note: target customer, price anchor, key differentiator.
4. Classify each as: direct (same customer + same job), adjacent
   (overlaps on one axis), or aspirational (where target wants to go).

## Output
\`\`\`
MARKET: <one-sentence category definition>
COMPETITOR             | TYPE      | KEY DIFF           | PRICE ANCHOR
<name>                 | direct    | <3-5 words>        | <$/user/mo>
...
POSITION: Where <company> sits that's underserved / crowded / empty.
\`\`\`
Flag weaknesses in the data — "pricing not public for X" — don't
invent numbers.`,
    },
    {
        name: 'API integration guide',
        description: 'Produce a step-by-step integration guide for a third-party API',
        triggers: 'api, integration, webhook, oauth, endpoint',
        body: `## Goal
Let the reader go from zero to a working integration.

## Steps
1. \`fetch_url\` the API's /docs or developer landing page.
2. Determine auth method: API key / OAuth / JWT / mTLS. Write down
   the SHORTEST path to a first valid request.
3. Pick the ONE endpoint that matters for the user's use case; don't
   dump the whole reference. Note: method, path, required params,
   required auth scope.
4. Look up: rate limits, idempotency keys, webhook signature
   verification if applicable.

## Output
\`\`\`
## Setup
<auth in 3 steps max>

## First call
<curl example that will actually work>

## Error handling
<common failure modes + how to retry>

## Gotchas
<things the docs don't warn you about — rate limits, clock skew,
 eventual consistency>
\`\`\``,
    },
    {
        name: 'Summarize meeting',
        description: 'Produce action items and decisions from a meeting transcript',
        triggers: 'meeting, transcript, notes, minutes, action items',
        body: `## Goal
Turn 30 minutes of transcript into the 5 things someone absent needs
to know.

## Steps
1. \`read_file\` the transcript.
2. First pass: identify speakers + their roles.
3. Second pass: extract every sentence that contains a commitment
   ("I'll …", "let's …", "we decided to …"). Those are decisions
   + action items.
4. Third pass: flag open questions — phrases like "we should figure
   out", "need to check with X".

## Output
\`\`\`
DECISIONS
  - <decision> — decided by <person>
ACTION ITEMS
  - [ ] <task>  —  <owner>  —  <deadline or "TBD">
OPEN QUESTIONS
  - <question>  —  needs input from <person>
KEY CONTEXT
  - <fact that shaped the decisions>
\`\`\`
Don't include every topic discussed. The test is: if this document
is the only thing the absentee reads, do they know what to do next?`,
    },
    {
        name: 'Security audit dependency',
        description: 'Check a third-party package for known issues before adopting',
        triggers: 'security, vulnerability, dependency, cve, audit',
        body: `## Goal
Before adopting a new library, catch the obvious security / supply
chain risks.

## Steps
1. \`web_search\` "<package> CVE" and "<package> vulnerability".
2. \`fetch_url\` the package's registry page (npm / PyPI / crates.io)
   to get: last release date, maintainer count, weekly downloads.
3. \`fetch_url\` the package's GitHub: open issues count, last commit,
   whether it has a SECURITY.md.
4. \`fetch_url\` \`https://github.com/<owner>/<repo>/security/advisories\`
   if applicable.

## Risk flags
- Sole maintainer + > 10k downloads = supply-chain risk
- No release in > 18 months = abandonment risk
- Unpatched high-severity CVE = active risk
- Post-install scripts (npm) that do more than file copies = audit them

## Output
\`\`\`
PACKAGE: <name>@<version>
MAINTENANCE: <active | quiet | stale>
KNOWN CVES: <count — list only high/critical>
MAINTAINERS: <count>  DOWNLOADS: <weekly>
VERDICT: <safe to adopt | adopt with monitoring | avoid>
RATIONALE: <one sentence>
\`\`\``,
    },
    {
        name: 'Troubleshoot Docker',
        description: 'Systematic workflow for a Docker problem',
        triggers: 'docker, container, image, build, compose',
        body: `## Goal
Narrow a Docker problem to the actual broken layer quickly.

## Steps
1. Identify the phase: build / run / network / volume / exit. Errors
   sound different in each — match the error to the phase first.
2. **Build fails:** check the step number. Is it a RUN command?
   Likely a package install or missing file. Is it a COPY? Check
   \`.dockerignore\` and the build context.
3. **Run fails immediately:** \`docker logs <container>\` — usually
   one of: wrong CMD/ENTRYPOINT, missing env var, bind-mount path
   doesn't exist, port already in use.
4. **Run exits cleanly but service unreachable:** check
   \`docker inspect\` for the published port and \`netstat -tulpn\`
   on the host for conflicts.
5. **Networking between containers:** they must be on the same
   user-defined network, and hostname is the service name.

## Quick wins to try
- \`docker compose config\` — catches YAML / interpolation errors
- \`docker run --rm -it <image> sh\` — interactive shell to test
  paths and env
- \`docker system prune\` — only if you've confirmed there's no
  cleanup you care about pending

## Output
One-line diagnosis + the specific command to verify / fix it.`,
    },
    {
        name: 'Generate test cases',
        description: 'Produce a good test case list for a given function',
        triggers: 'tests, test cases, unit tests, coverage',
        body: `## Goal
List the test cases that matter — cover semantics, not line count.

## Steps
Enumerate along these axes:
1. **Happy path** — the one most-common input. 1–2 cases.
2. **Boundaries** — empty input, single-item input, max-size input,
   off-by-one around any threshold. Often the highest-yield bugs.
3. **Error inputs** — null, wrong type, malformed, negative numbers
   where positive expected. Does the function raise? Return a
   default? Be explicit.
4. **Concurrency / state** — if the function mutates shared state
   or is reentrant, test ordering and interleaving.
5. **Cross-cutting** — locales, time zones, encoding, big vs little
   endian — only if applicable.

## Output
Numbered list, one line per test:
\`\`\`
1. <name>: <input>  →  expect <output> [boundary | error | happy]
\`\`\`
Include a brief "Skipped" section for cases you considered but
decided weren't worth it, with reason. That prevents pointless
feedback loops.`,
    },
    {
        name: 'SQL query help',
        description: 'Workflow for writing or debugging a SQL query',
        triggers: 'sql, query, database, select, join',
        body: `## Goal
Get to a working SQL query that the user can run against their DB.

## Steps
1. Ask if you don't already know: dialect (Postgres / MySQL /
   SQLite / BigQuery) and the table schema. Different dialects
   differ on JSON, window functions, string funcs.
2. Write the query in stages:
   - FROM + JOINs first — get the relationship right
   - WHERE next — filter before grouping
   - GROUP BY + aggregates
   - SELECT projection last
3. Test mentally with a 3-row example per table. If you can't trace
   it, neither can the DB.
4. Explicitly note anything that will tank performance: cartesian
   joins, N+1 subqueries, missing index on the JOIN column.

## Output
The query, formatted with one clause per line. A 2-sentence
explanation of what it does. A final line with suggested indexes
if it's non-trivial.`,
    },
    {
        name: 'Extract structured data',
        description: 'Pull structured fields from unstructured text',
        triggers: 'extract, parse, structure, fields',
        body: `## Goal
Given a blob of text, produce a clean JSON object with the fields
the user needs.

## Steps
1. Confirm the target shape — what keys, what types. If ambiguous,
   ask before extracting.
2. Extract literal spans from the source; don't paraphrase values
   unless the user explicitly asked for normalization.
3. For fields you can't find, return \`null\` — never invent.
4. Dates: ISO 8601 (\`YYYY-MM-DD\`). Money: minor units as int
   (cents / pence), plus a \`currency\` field. Names: preserve the
   original spelling/capitalization.

## Output
Valid JSON only, no commentary. If multiple records, an array of
objects with identical keys. If you had to guess on any field,
include a \`_confidence\` key at the top mapping field → 0–1.`,
    },
];

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE + path);
        const data = body ? JSON.stringify(body) : null;
        const req = https.request({
            method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            rejectUnauthorized: false,
            headers: {
                'X-API-Key': API_KEY,
                'X-API-Secret': API_SECRET,
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
            },
        }, res => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = out ? JSON.parse(out) : null; } catch (_) { parsed = out; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function slugify(name) {
    return name.toLowerCase().replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 64);
}

(async () => {
    const existing = await request('GET', '/api/markdown-skills');
    if (existing.status !== 200) {
        console.error('GET /api/markdown-skills failed:', existing);
        process.exit(1);
    }
    const existingIds = new Set((existing.body || []).map(s => s.id));
    console.log(`existing markdown skills: ${existingIds.size}`);

    let created = 0, skipped = 0, replaced = 0, failed = 0;
    for (const skill of SKILLS) {
        const id = slugify(skill.name);
        if (existingIds.has(id)) {
            if (!FORCE) {
                console.log(`  = ${id} (exists, skip)`);
                skipped++;
                continue;
            }
            const del = await request('DELETE', `/api/markdown-skills/${id}`);
            if (del.status === 200) replaced++;
        }
        const r = await request('POST', '/api/markdown-skills', skill);
        if (r.status === 201) {
            console.log(`  + ${id}`);
            created++;
        } else {
            console.log(`  ! ${id} — ${r.status} ${JSON.stringify(r.body)}`);
            failed++;
        }
    }

    console.log(`\nsummary: created=${created} replaced=${replaced} skipped=${skipped} failed=${failed}`);
})().catch(e => { console.error(e); process.exit(1); });
