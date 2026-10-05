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
    [/\.(zip|zipx|tar|tgz|gz|bz2|xz|zst|lz4|lzma|7z|rar|cab|msu|msi|deb|rpm|cpio|iso|dmg|wim|arj|lzh)$/i, 'archive'],
    [/\.(pcap|pcapng|cap|evtx)$/i, 'capture'],
    [/\.(csv|tsv|xlsx?|ods)$/i, 'spreadsheet'],
    [/\.(pdf|docx?|odt|rtf|pptx?)$/i, 'document'],
    [/\.(log|txt|md|json|ya?ml|xml|ini|conf|toml)$/i, 'log'],
    [/\.(js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|sql|swift|scala|sol|vue|svelte)$/i, 'code'],
    [/\.(png|jpe?g|gif|bmp|webp|tiff?|heic|svg)$/i, 'image'],
    [/\.(mp3|wav|m4a|flac|ogg|mp4|mov|mkv|webm|avi)$/i, 'media'],
];
function attachmentKindsFromText(text) {
    const kinds = new Set();
    // The filename is the first `name.ext` token: the size header nests
    // parentheses — "(23,198 bytes (22.7 KB); 22,926 chars)" — and the old
    // `\([^)]*\)` group stopped at the inner `)`, so every upload of 1 KB or
    // more came back with no kind at all.
    const re = /===\s*FILE\s+\d+\s*:\s*(.+?\.[A-Za-z0-9]{1,10})(?=\s*(?:\(|===))/gi;
    let m;
    const src = String(text || '');
    while ((m = re.exec(src)) !== null) {
        const name = m[1].trim();
        const hit = EXT_KIND.find(([rx]) => rx.test(name));
        let kind = hit ? hit[1] : 'file';
        // A pasted log or text file is heavy only when it is big — a 500-char
        // paste is a question with context, a 20k-char one is data to analyse.
        if (kind === 'log') {
            const header = src.slice(m.index, src.indexOf('===', m.index + m[0].length) + 3);
            const chars = header.match(/([\d,]+)\s*chars/i);
            if (chars && parseInt(chars[1].replace(/,/g, ''), 10) >= 20000) kind = 'log-large';
        }
        kinds.add(kind);
    }
    return [...kinds];
}

// Words in the ask, ignoring anything the runtime injected.
function askLength(text) {
    return cleanAsk(text).split(/\s+/).filter(Boolean).length;
}

// ── Refinements measured on 86 real asks (2026-09-23 audit) ───────────────
// A build is a build VERB whose OBJECT is an artifact — two independent tests
// fired on one token ("what is a swift CODE?" was "builds an artifact") and on
// the page being READ ("read the release page, then write a summary").
const BUILD_VERB2 = new RegExp(BUILD_VERB.source.replace('build|', 'build|enhance|upgrade|harden|'), 'i');
const BUILD_OBJ = new RegExp(BUILD_VERB2.source + '(?:\\W+\\w+){0,5}?\\W+' + ARTIFACT.source.replace(/^\\b/, ''), 'i');
// A small thing to write is light work, not a two-model job ("a python script
// that prints the first 20 primes" took 9 s on the fast model alone).
const SMALL_ARTIFACT = /\b(?:function|script|snippet|regex|query|command|one-?liner|formula|config|table|headings?|list|paragraph|bullets?|email|message|readme|test)\b/i;
const SMALL_MOD = /\b(?:short|small|quick|simple|tiny|brief|single|one-?line|basic|little|minimal)\b/i;
const SMALL_CREATE_VERB = /^(?:write|create|make|generate|code|draft|compose|produce|give me|add (?:a|an|the))\b/i;
// "no web searches", "without tools", "no file" — negated clauses are not
// signals (ARTIFACT matched the "file" in "no file"), and a negated tool
// clause means the user ruled out legwork.
const NEG_TOOLISH = /\b(?:no|without|never|don'?t|do not|not)\s+(?:(?:use|using|perform|performing|do|doing|run|running|make|making|create|creating|write|writing|include|need|any|a|an|the|more|other)\s+){0,3}(?:web[- ]?|internet |online |file |local |external )?(?:search(?:es|ing)?|tools?|files?|browsing|lookups?|look-?ups?|internet|web)\b/gi;
// "summarize" is a rework of text unless it is aimed at something to fetch or
// read, so it is not in the analysis verbs here (see HEAVY_ARTIFACT below).
const ANALYSIS_VERB2 = new RegExp(ANALYSIS_VERB.source.replace('summari[sz]e|', ''), 'i');
// "Perform analysis on the file served by this url" — the noun form.
const ANALYSIS_NOUN = /\b(analysis|audit|investigation|assessment|deep[- ]dive|teardown|triage|post[- ]?mortem|root[- ]cause|code review|security review)\b/i;
const HEAVY_ARTIFACT = /\b(repo|repository|codebase|archive|binary|executable|package|dataset|dump|logs?|capture|project|source(?: code)?|jar|apk|installer|msi|exe)\b/i;
// MULTI_STEP without a bare "complete" ("can't complete the registration").
const MULTI_STEP2 = new RegExp(MULTI_STEP.source.replace('complete(?:ly)?|', 'complete (?:app|application|game|implementation|solution|rewrite|overhaul|project|website)|'), 'i');
// A bare repo or file link IS the task ("audit it"): the heaviest real turns
// in the corpus (80-1,419 s) were a GitHub link and nothing else.
const CODE_HOST_OR_FILE = /(?:github|gitlab|bitbucket|npmjs|pypi|codeberg)\.(?:com|org)\/|\.(?:zip|tgz|tar\.gz|jar|exe|msi|apk|pdf|docx?|xlsx?|pcapng?|evtx)\b/i;
// "ok, do the cabinet decompressions then" continues the previous task.
const CONTINUE_RE = /^(?:ok(?:ay)?|yes|yeah|yep|sure|alright|go ahead|do it|do that|continue|proceed|now|then|also|and|please do|keep going|sounds good)\b/i;
const OFFER_RE = /\b(?:want me to|should i|shall i|would you like me to|do you want me to|i can (?:also )?\w+ (?:it|that|this|them)|let me know if you(?:'d| would) like me to)\b[^?]{0,200}\?\s*$/i;

function stripNegatedTools(ask) {
    const hits = ask.match(NEG_TOOLISH) || [];
    return {
        ask: hits.length ? ask.replace(NEG_TOOLISH, ' ').replace(/\s+/g, ' ').trim() : ask,
        toolsForbidden: /\b(?:search|tools?|browsing|lookups?|look-?ups?|internet|web)\b/i.test(hits.join(' ')),
    };
}

/**
 * Is this turn substantial enough that two models should work it together?
 * Conservative on purpose — a false positive costs the user real seconds.
 * `previousText` (the previous user message) and `lastAssistantText` let a
 * short go-ahead inherit the verdict of the work it resumes.
 *
 * @returns {{substantial:boolean, reason:string, explicit:boolean, toolsForbidden:boolean}}
 */
function isSubstantialWork({ text, hasAttachments = false, attachmentKinds = [], minWords = 6, previousText = null, lastAssistantText = null } = {}) {
    const raw = cleanAsk(text);
    if (!raw) return { substantial: false, reason: 'empty', explicit: false, toolsForbidden: false };

    if (EXPLICIT_OFF_RE.test(raw)) return { substantial: false, reason: 'user asked for a quick single-model answer', explicit: true, toolsForbidden: false };
    if (EXPLICIT_RE.test(raw)) return { substantial: true, reason: 'user asked for the models to work together', explicit: true, toolsForbidden: false };

    const { ask, toolsForbidden } = stripNegatedTools(raw);
    let smallBuild = false;
    const out = (substantial, reason) => ({ substantial, reason, explicit: false, toolsForbidden, smallBuild });
    const words = ask.split(/\s+/).filter(Boolean).length;
    const url = URL_RE.test(ask);
    const code = CODE_FENCE_RE.test(ask);
    const multi = MULTI_STEP2.test(ask);

    // A file/repo/archive to work through is substantial on its own; a plain
    // image usually is not (OCR, "what is this") unless the ask says otherwise.
    const heavyAttachment = hasAttachments && attachmentKinds.some(k => /archive|repo|code|pdf|spreadsheet|csv|document|data|capture|log-large/i.test(String(k)));

    const buildHit = BUILD_OBJ.exec(ask);
    let build = !!buildHit;
    if (build) {
        // Only WRITING a small new thing is light; debugging, fixing or
        // optimising one is real work whatever its size, and so is a small
        // thing over heavy input ("a script that parses these logs").
        const obj = buildHit[0];
        const lastWord = obj.split(/\s+/).slice(-1)[0];
        const creates = SMALL_CREATE_VERB.test(obj);
        const artifacts = (ask.match(new RegExp(ARTIFACT.source, 'gi')) || []).length;
        const small = creates && !HEAVY_ARTIFACT.test(ask) && artifacts <= 1
            && (SMALL_MOD.test(obj) || (SMALL_ARTIFACT.test(lastWord) && words <= 20));
        if (small && words < 40 && !multi && !code) { build = false; smallBuild = true; }
    }
    if (build) return out(true, 'builds an artifact');
    if (heavyAttachment) return out(true, 'works through an attached file');
    // Security work is never a quick lookup — reading files, greping for
    // indicators and judging intent is exactly what the stronger model is for.
    if (SECURITY_RE.test(ask)) return out(true, 'security or forensics work');
    if (url) {
        const rest = ask.replace(/\S*(?:https?|hxxps?):\/\/\S+|\S*(?:github|gitlab|bitbucket|codeberg)\.(?:com|org)\/\S+/gi, ' ').split(/\s+/).filter(Boolean).length;
        if (rest <= 3 && CODE_HOST_OR_FILE.test(ask)) return out(true, 'a bare repo or file link');
        // Something to fetch AND something to do with it.
        if (FETCH_VERB.test(ask) || BUILD_VERB.test(ask) || ANALYSIS_VERB2.test(ask) || ANALYSIS_NOUN.test(ask)) return out(true, 'works through a linked page or repo');
    }
    const analysis = ANALYSIS_VERB2.test(ask) || ANALYSIS_NOUN.test(ask);
    // An analysis verb aimed at a concrete THING needs no length test — "scan
    // the extracted files" is four words and is real work.
    if (analysis && ARTIFACT.test(ask)) return out(true, 'analysis or investigation');
    // Summarising something heavy (logs, a repo, a dataset) is analysis.
    if (/\bsummari[sz]e\b/i.test(ask) && (HEAVY_ARTIFACT.test(ask) || hasAttachments)) return out(true, 'analysis or investigation');
    // Same for fetching one: "download this repo and tell me if it is safe".
    if (FETCH_VERB.test(ask) && HEAVY_ARTIFACT.test(ask) && words >= 5) return out(true, 'fetches and works through something');
    if (RESEARCH_RE.test(ask) && words >= 5) return out(true, 'multi-source research');
    if (analysis && (words >= minWords || hasAttachments)) return out(true, 'analysis or investigation');
    if (multi && words >= minWords) return out(true, 'multi-step request');
    if (code && words >= 12) return out(true, 'works on supplied code');

    // A short go-ahead resumes the work it answers: the previous request, or
    // the assistant's own offer ("want me to write the script?" → "yes").
    if (CONTINUE_RE.test(ask) && !/\?\s*$/.test(ask) && words <= 25) {
        if (previousText && isSubstantialWork({ text: previousText }).substantial) return out(true, 'continues the previous task');
        const offer = lastAssistantText ? String(lastAssistantText).trim().slice(-400).match(OFFER_RE) : null;
        if (offer && isSubstantialWork({ text: offer[0].replace(/^(?:want me to|should i|shall i|would you like me to|do you want me to)\s*/i, '') }).substantial) {
            return out(true, 'accepts an offer to do real work');
        }
    }

    // Everything else — including a long-winded factual question — stays on one
    // fast model.
    if (LOOKUP_RE.test(ask)) return out(false, 'lookup question');
    return out(false, 'no substantial-work signal');
}

// ── Easy turns stay on the fast model ───────────────────────────────────────
// "Easy" = work whose quality does not depend on the model's size: a greeting
// or thanks, arithmetic, reworking text that is ALREADY in the conversation
// (summarise, shorten, reformat), a small code snippet, tool-free formatting.
// Deliberately NOT easy: questions that need world knowledge, translation and
// creative writing — that is exactly where a smaller model falls down.
// Measured on the 14B/27B pair: the 14B answered "who wrote Dune?" with
// "Sandfield" and the capital of Australia with "Australia itself" (3/3 with
// thinking off, Melbourne/Sydney with it on), left a paragraph half in
// English when asked to translate, and wrote a limerick that did not rhyme;
// the 27B got all of them right. Measured on the same pair with mode=always:
// "hi" took 6.3 s to first text (brief on the 14B, then the 27B's cold
// prefill) where the 14B alone answers in ~1 s; "write a haiku" got a brief
// AND a web search for the haiku syllable rule; "summarize that in 3 bullets,
// no web searches" took 9.4 s. An easy turn runs on the primary in EVERY mode;
// only an explicit request for both models or picking the secondary in the
// composer overrides it.
const GREETING_RE = /^(?:hi+|hello|hey+|hiya|howdy|yo|sup|greetings|thanks|thank you|thx|ty|cheers|cool|great|nice|awesome|perfect|got it|good (?:morning|afternoon|evening|night)|bye|goodbye|see (?:you|ya)|lol|haha)\b/i;
// (Bare affirmatives — "yes", "ok", "sure" — are NOT here: after an offer
// like "want me to write the script?" they are a go-ahead for real work.)
// Work on text that is ALREADY in the conversation.
const TRANSFORM_VERB = /\b(summari[sz]e|tl;?dr|shorten|condense|trim|rephrase|reword|rewrite|simplify|reformat|format|bullet(?:s|ize)?|turn (?:it|this|that) into|make (?:it|this|that) (?:shorter|longer|simpler|clearer|more \w+|less \w+|formal|casual|friendlier)|expand on|elaborate on|explain (?:that|this|it)|proofread|fix the (?:grammar|typos?|spelling))\b/i;
const ANAPHORA = /\b(that|this|it|them|those|above|previous|earlier|your (?:answer|reply|response|summary|list|draft|last (?:answer|reply|message))|what you (?:said|wrote|just)|the (?:article|text|answer|reply|response|summary|list|table|paragraph|email|message|story|poem|essay|post|explanation|draft|above)|the (?:first|second|third|fourth|last|next|previous|opening|final|closing|intro(?:duction)?|\d+(?:st|nd|rd|th)) (?:paragraph|section|line|sentence|bullet|point|item|step|part))\b/i;
const CODEISH = /\b(code|function|script|class|method|program|query|regex|bug|tests?|app|repo|file|files)\b/i;
// Short creative pieces the fast model writes as well as the strong one.
const SHORT_CREATIVE = /\b(haiku|limerick|poem|joke|pun|riddle|tongue[- ]twister|slogan|tagline|motto|toast|caption|tweet|one[- ]liner|rhyme|acrostic|sonnet|name ideas|names? for|nicknames?|pickup line|fun fact|story|lyrics|song)\b/i;
const SINGLE_COMMAND_RE = /^(?:please\s+|can you\s+|could you\s+)?(?:start|stop|restart|reload|kill|launch|open|close|turn (?:on|off)|turn (?:the |my )?\w+ (?:on|off)|shut ?down|reboot|power off|mute|unmute|pause|resume|list|show|print|cd|mkdir|delete|remove|rename|move|copy|clear|empty|lock|unlock|mount|unmount)\b/i;
const TRANSLATE_RE = /\b(translat\w*|in (?:spanish|french|german|italian|portuguese|chinese|japanese|korean|russian|arabic|hindi|dutch|polish|turkish|vietnamese|thai|indonesian|swedish|greek|hebrew))\b/i;
const LONG_DEMAND = /\b(\d{3,}[- ]?words?|long|detailed|in[- ]depth|comprehensive|thorough|essay|article|chapter|report|story)\b/i;
// Current / changing facts need retrieval — worth the pair's legwork.
const FRESH_RE = /\b(latest|newest|new|recent|recently|current(?:ly)?|today|tonight|yesterday|tomorrow|this (?:week|month|year)|right now|news|update[sd]?|released?|announced|upcoming|next|price|prices|stock|weather|score|standings|election|race|polls?|polling|odds|forecast|predict\w*|likely to|20[2-9]\d)\b/i;
// A forecast or a judgement over current facts is research, not one fact.
const FORECAST_RE = /\b(most likely|likely to|chances?|odds|forecast|predict\w*|who (?:will|would) win|which .{0,30} will|polls?|polling|projected)\b/i;
const SUMMARY_OF_MANY = /\b(what'?s new|what is new|what(?:'s| has| have)? changed|changes|changelog|features?|differences?|improvements?|highlights|vs\.?|versus|and (?:what|why|how)|explain|overview|summar\w*)\b/i;
const ARITH_RE = /^[\s\d+\-*/().,^%x×÷=?]+$/;
// A short go-ahead ("can you do it?", "go ahead", "try again") resumes the
// WORK of the previous turn — it is not a one-hop question.
const GO_AHEAD_RE = /\b(do it|go ahead|proceed|continue|carry on|keep going|try again|retry|redo|implement (?:it|that|this)|build (?:it|that|this)|fix (?:it|that|this)|run (?:it|that|this)|finish (?:it|that|this)|make (?:it|that|this) work|start (?:it|that|this|on (?:it|that|this))|start over)\b/i;
// The user said not to use tools / the web on this turn.
const NO_TOOLS_RE = /\b(?:no|without|don'?t (?:use|do|run|perform)|do not (?:use|do|run|perform)|never use|avoid)\s+(?:any\s+)?(?:the\s+)?(?:tools?|web(?:\s*search(?:es|ing)?)?|search(?:es|ing)?|internet|browsing|looking (?:it |this |that )?up|lookups?|online (?:search(?:es)?|sources?))\b/i;

function forbidsTools(text) {
    const ask = cleanAsk(text);
    return NO_TOOLS_RE.test(ask) || stripNegatedTools(ask).toolsForbidden;
}

// Does answering need anything LOOKED UP — current facts, research, a
// comparison, a linked page? Decides whether the brief (which exists to plan
// background lookups) is worth a call at all: building, writing and coding
// turns skip it, lookup turns get a brief that is asked for its jobs.
const LOOKUP_NEED_RE = /\b(research|look (?:it |this |that )?up|find out|search (?:for|the web|online)|sources?|citations?|compare|comparison|vs\.?|versus|alternatives?|best|reviews?|recommend\w*|options for|what'?s new|changelog)\b/i;
// An EXPLICIT user directive to go and search/research the web — an imperative,
// not a passing mention. When the user says this, research is a REQUIREMENT of
// the turn, not something the planner may optimise away (measured: on "Perform
// web searches to research the best methods…" the first pass wrote "LEGWORK:
// none" and the lead ran a single search then reverted to brute-forcing).
const USER_RESEARCH_DIRECTIVE_RE = /\bweb\s+search(?:es|ing)?\b|\bsearch\s+(?:the\s+web|online|the\s+internet|google)\b|\bresearch\s+(?:online|on\s+the\s+web|the\s+best|how\b|methods?|approaches?|techniques?|ways?\b)|\blook\s+up\s+(?:how|the\s+best|online|ways?)\b|\buse\s+web\s+search|\bgoogle\s+(?:it|how|the)\b|\bsearch\s+for\s+(?:the\s+best|how|information|guides?|methods?)\b/i;
function userDemandsResearch(text) {
    const raw = cleanAsk(text);
    if (!raw) return false;
    const { ask, toolsForbidden } = stripNegatedTools(raw);
    if (toolsForbidden) return false; // "no web searches" wins
    return USER_RESEARCH_DIRECTIVE_RE.test(ask);
}
function needsLookup(text) {
    const raw = cleanAsk(text);
    if (!raw) return false;
    const { ask, toolsForbidden } = stripNegatedTools(raw);
    if (toolsForbidden) return false;
    if (USER_RESEARCH_DIRECTIVE_RE.test(ask)) return true; // explicit "search/research the web" is a hard lookup need
    // "Summarize <url>" is one read for the lead. Planned as a lookup, the
    // brief invented background research the user never asked for, and the
    // lead tried to hand the one page off (refused as read_it_yourself — a
    // wasted round and a failed chip).
    if (isSingleReadAsk(ask)) return false;
    if (URL_RE.test(ask)) return true;
    if (BUILD_OBJ.test(ask) && !RESEARCH_RE.test(ask) && !LOOKUP_NEED_RE.test(ask)) return false;
    // One current fact (a score, a price, the weather, a date) is one search
    // for the lead — a background job would only add its start-up time.
    const words = ask.split(/\s+/).filter(Boolean).length;
    if (words <= 10 && LOOKUP_RE.test(ask) && FRESH_RE.test(ask) && !SUMMARY_OF_MANY.test(ask) && !RESEARCH_RE.test(ask) && !LOOKUP_NEED_RE.test(ask) && !FORECAST_RE.test(ask)) return false;
    // A comparison on its own is not a lookup: "Compare TCP and UDP" or
    // "Python vs Go vs Rust on speed and safety" is the lead's own knowledge,
    // and the planner sent each one out as three background web jobs (24 s
    // and 115 s instead of a direct answer). It needs a lookup only when it is
    // about something CURRENT — FRESH_RE, a model or version number, prices,
    // reviews, benchmarks — or the rest of the ask needs one.
    if (COMPARE_RE.test(ask) && !FRESH_RE.test(ask) && !/\d/.test(ask) && !MARKET_RE.test(ask)) {
        const rest = ask.replace(COMPARE_RE_G, ' ');
        return RESEARCH_RE.test(rest) || LOOKUP_NEED_RE.test(rest) || FORECAST_RE.test(rest);
    }
    return FRESH_RE.test(ask) || RESEARCH_RE.test(ask) || LOOKUP_NEED_RE.test(ask) || FORECAST_RE.test(ask);
}
const COMPARE_SRC = '\\b(?:compare[sd]?|comparing|comparison|vs\\.?|versus|differences? between|pros and cons|tradeoffs?|trade-offs?)(?![\\w-])';
const COMPARE_RE = new RegExp(COMPARE_SRC, 'i');
const COMPARE_RE_G = new RegExp(COMPARE_SRC, 'gi');
const MARKET_RE = /\b(prices?|pricing|cost|costs|plans?|subscriptions?|benchmarks?|reviews?|ratings?|specs?|market share|sales|revenue|salar(?:y|ies)|deals?|cheapest|best|top|alternatives?|recommend\w*)\b/i;

// Does the answer mainly depend on facts that have to be LOOKED UP (research,
// current facts, comparing sources) rather than on something the lead BUILDS?
// Decides whether the lead should outline-then-await its jobs or keep working.
function isRetrievalShaped(text) {
    const ask = cleanAsk(text);
    if (!ask) return false;
    if (USER_RESEARCH_DIRECTIVE_RE.test(ask)) return true; // an explicit research directive is retrieval-shaped
    if (BUILD_VERB.test(ask) && ARTIFACT.test(ask)) return false;
    return RESEARCH_RE.test(ask) || FRESH_RE.test(ask) || (ANALYSIS_VERB.test(ask) && !CODEISH.test(ask)) || LOOKUP_RE.test(ask);
}

/**
 * Is this an EASY turn — one the fast primary should answer alone?
 * @returns {{easy:boolean, reason:string}}
 */
function isEasyTurn({ text, hasAttachments = false, attachmentKinds = [], hasHistory = false, previousText = null, lastAssistantText = null } = {}) {
    const ask = cleanAsk(text);
    if (!ask) return { easy: true, reason: 'empty ask' };
    if (EXPLICIT_RE.test(ask)) return { easy: false, reason: 'user asked for the models to work together' };
    if (hasAttachments || (attachmentKinds && attachmentKinds.length)) return { easy: false, reason: 'has an attachment' };
    if (URL_RE.test(ask)) return { easy: false, reason: 'names a link' };
    if (SECURITY_RE.test(ask)) return { easy: false, reason: 'security work' };
    const words = ask.split(/\s+/).filter(Boolean).length;
    if (ARITH_RE.test(ask) && /\d/.test(ask)) return { easy: true, reason: 'arithmetic' };
    if (GO_AHEAD_RE.test(ask)) return { easy: false, reason: 'resumes earlier work' };
    if (words <= 10 && GREETING_RE.test(ask) && !BUILD_VERB.test(ask) && !ANALYSIS_VERB.test(ask) && !FORECAST_RE.test(ask)) {
        return { easy: true, reason: 'greeting or acknowledgement' };
    }
    // A rewrite of what the conversation already holds: no tools needed.
    // (Translation is a language skill, and creative writing a craft — both
    // stay with the stronger model.)
    if (hasHistory && words <= 40 && TRANSFORM_VERB.test(ask) && ANAPHORA.test(ask) && !CODEISH.test(ask) && !TRANSLATE_RE.test(ask) && !SHORT_CREATIVE.test(ask)) {
        return { easy: true, reason: 'reworks text already in the conversation' };
    }
    if (words <= 8 && /\bsay (?:hello|hi|goodbye)\b/i.test(ask)) return { easy: true, reason: 'a greeting' };
    // One operational command ("restart nginx", "turn the computer off",
    // "list the files here") — what it needs is the tool call, not capability.
    if (words <= 12 && SINGLE_COMMAND_RE.test(ask) && (ask.match(/\band\b/gi) || []).length === 0
        && !ANALYSIS_VERB.test(ask) && !MULTI_STEP2.test(ask) && !SECURITY_RE.test(ask) && !/\bthen\b/i.test(ask)) {
        return { easy: true, reason: 'a single command' };
    }
    const verdict = isSubstantialWork({ text, hasAttachments, attachmentKinds, previousText, lastAssistantText });
    if (verdict.substantial) return { easy: false, reason: verdict.reason };
    // A small new piece of code or text ("a python script that prints the
    // first 20 primes and run it" — 9 s on the fast model alone).
    if (verdict.smallBuild) return { easy: true, reason: 'a small piece of code or text' };
    // The user ruled out tools: nothing to delegate, so the pair adds only
    // latency — unless it is a long piece of writing.
    if (verdict.toolsForbidden && words <= 40 && !LONG_DEMAND.test(ask) && !MULTI_STEP2.test(ask)) {
        return { easy: true, reason: 'tools ruled out and nothing long to write' };
    }
    // Questions — one-hop or not — need world knowledge or a lookup, and a
    // wrong fact is worse than a slower right one (see the measurements above).
    return { easy: false, reason: verdict.reason };
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
function planHandoff({ roles, targetModel, userText, mode, running, hasAttachments, attachmentKinds, hasHistory = false, previousText = null, lastAssistantText = null, secondaryBusy = false } = {}) {
    const r = roles || {};
    const m = MODES.includes(mode) ? mode : (MODES.includes(r.mode) ? r.mode : 'auto');
    const loaded = running instanceof Set ? running : new Set(Array.isArray(running) ? running : []);
    const isLoaded = (name) => !!name && (loaded.size === 0 || loaded.has(name));

    const primary = r.primary || null;
    const secondary = r.secondary || null;
    const requested = targetModel || null;
    const verdict = isSubstantialWork({ text: userText, hasAttachments, attachmentKinds, previousText, lastAssistantText });
    const easy = isEasyTurn({ text: userText, hasAttachments, attachmentKinds, hasHistory, previousText, lastAssistantText });

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
            primary, secondary: null, reason, substantial: verdict.substantial, easy: easy.easy,
            partner, partnerLegwork: !!partner && r.legwork !== false && !verdict.toolsForbidden,
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
    // THE fast path: an easy turn never reaches the slower model — in 'always'
    // too. "Every turn" means every turn with real work in it; a greeting, a
    // one-hop question or a rewrite of the last answer is faster AND as good
    // on the primary.
    if (easy.easy) return alone(`easy turn: ${easy.reason}`, soloOn);
    if (m === 'auto' && !verdict.substantial) return alone(verdict.reason, soloOn);
    // The secondary has one slot and something else holds it: light work
    // starts now on the primary instead of queueing behind that generation.
    if (secondaryBusy && !verdict.substantial && !verdict.explicit && !wantsSecondary) return alone('the secondary is busy — light work stays on the primary', soloOn);

    // One page or one file to read: the lead reads it itself in one call, so
    // there is nothing to plan and nothing to hand off (unless the user asked
    // the models to work together).
    const singleRead = !verdict.explicit && isSingleReadAsk(userText);
    return {
        runOn: secondary,
        switched: secondary !== requested,
        engaged: true,
        // The user ruled out searching / tools: legwork is off the table, so
        // there is nothing for a brief to plan either.
        firstPass: r.firstPass !== false && !verdict.toolsForbidden && !singleRead,
        legwork: r.legwork !== false && !verdict.toolsForbidden && !singleRead,
        singleRead,
        toolsForbidden: !!verdict.toolsForbidden,
        primary,
        secondary,
        reason: m === 'always' ? (verdict.substantial ? verdict.reason : 'the secondary takes every turn with real work') : verdict.reason,
        substantial: verdict.substantial, easy: false,
        partner: primary, partnerLegwork: r.legwork !== false && !verdict.toolsForbidden, secondaryLoaded: secondary,
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
// The conversation the ask belongs to, for the brief and the legwork prompts.
// They used to see ONLY the latest user message, so on a follow-up ("is getting
// a D.U.N.S free?") the 14B guessed the subject — two different wrong
// expansions on two turns — and started jobs researching a thing that does not
// exist while the lead answered correctly from the history. The previous ask
// plus the head of the last reply is enough to pin the subject.
function buildConversationContext(messages, { maxChars = 1200 } = {}) {
    if (!Array.isArray(messages) || messages.length < 2) return '';
    const text = (m) => {
        if (!m) return '';
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
        return '';
    };
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i] && messages[i].role === 'user') { lastUser = i; break; }
    if (lastUser <= 0) return '';
    let prevAssistant = null, prevUser = null;
    for (let i = lastUser - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m) continue;
        if (!prevAssistant && m.role === 'assistant' && text(m).trim()) prevAssistant = m;
        else if (prevAssistant && m.role === 'user') { prevUser = m; break; }
    }
    if (!prevAssistant) return '';
    const u = prevUser ? cleanAsk(text(prevUser)).slice(0, 400) : '';
    const aBudget = Math.max(200, maxChars - u.length - 40);
    const a = String(text(prevAssistant)).replace(/\s+/g, ' ').trim();
    const aHead = a.length > aBudget ? a.slice(0, aBudget).replace(/\s+\S*$/, '') + ' …' : a;
    return [u ? `Previous request: ${u}` : null, `Previous answer (start): ${aHead}`].filter(Boolean).join('\n');
}

// What a background job is FOR. Measured before this rule: jobs that read one
// file, listed the workspace or "verified" code the lead had not written yet
// each cost 15-60 s of a delegated turn for something the lead does in one call,
// and landed after the lead had done it; the old "list 1 to 3 jobs" prompt made
// the model copy its own example categories ("check version", "find
// examples") on asks that needed no lookup at all.
const LEGWORK_RULE = [
    'A background job is worth it only when it takes SEVERAL tool calls on the server: a web search AND reading the pages that answer it, comparing several sources, checking CURRENT facts (versions, prices, dates, news, benchmarks, adoption or job-market data), or running a long script over a large file the user supplied. One job per independent question, at most 3.',
    'Write `- none` when the whole request can be answered well from general knowledge or from the conversation, when it is mainly writing or coding that the main model will do itself, or when the user ruled out searching or tools.',
    'NOT legwork: a single file read, a directory listing, a grep, one command, testing or verifying code the main model has not written yet, reviewing its draft, or the whole task.',
].join(' ');

// The ONE first-pass call, made only when the request needs something looked
// up (needsLookup): the fast model lists the lookups to run in the background
// while the lead writes. Asked for jobs alone it lists them well; asked for a
// brief with a LEGWORK section it wrote "- none" under a plan full of searches
// on every ask tried — and the lead no longer reads a brief, so the only thing
// this call has to produce is the jobs.
function buildLegworkTask({ userText, leadModel, context = '', hostNote = '' }) {
    return [
        `${leadModel || 'The main model'} is about to answer the request below. You are the faster model of the pair and will run background LOOKUPS for it while it writes.`,
        'You have NO tools in this step and must not answer the request.',
        ...(context ? ['', 'THE CONVERSATION SO FAR (context only — the request is the LAST message):', context] : []),
        '',
        'THE REQUEST:',
        askForFirstPass(userText, 3000),
        '',
        'List 1 to 3 background jobs, one for each independent question the answer needs LOOKED UP on the web now: current facts, versions, releases, prices, news, benchmarks, or what several sources say. Each job is a web search plus reading the pages that answer it, and must be about the user\'s request itself — not a side topic, not the writing, not code the main model will write.',
        JOB_RULE,
        ...(hostNote ? [hostNote] : []),
        'Reply with ONLY this section, nothing else:',
        'LEGWORK',
        '- <short name>: <what to find and what to report back>',
        'If nothing needs looking up, reply exactly: LEGWORK\n- none',
    ].join('\n');
}

// Rescue for a background job that did its lookups but wrote no report: a
// fresh, tools-free prompt holding only the job and what its tools returned,
// so the model has no tool-call history to imitate.
function buildReportSalvageTask({ task, evidence, partial = '' }) {
    return [
        'You ran a background lookup job for another model. Your tools are finished — write the REPORT now, from the tool results below only.',
        '',
        'THE JOB:',
        String(task || '').slice(-2500),
        '',
        'WHAT YOUR TOOLS RETURNED:',
        String(evidence || '').slice(0, 16000),
        ...(partial ? ['', 'WHAT YOU HAD WRITTEN SO FAR:', String(partial).slice(0, 800)] : []),
        '',
        'Report format: 3-10 bullets of facts relevant to the job, each with its source (URL or file path), then one line on anything you could not confirm. Only facts that appear in the tool results. No tool calls, no introduction.',
    ].join('\n');
}

// Continuous delegation that does not depend on the lead remembering to ask.
// Measured on the user's turns: after the automatic first batch the lead never
// called ask_assistant again (it even blocked on await_assistant for 188 s),
// so "delegation is continuous" was only ever true in the prompt. Each time a
// batch lands, the ASSISTANT reads what came back and proposes the next jobs.
function buildFollowUpLegworkTask({ userText, leadModel, jobs = [], leadSteps = [], plan = [], maxJobs = 3, context = '' }) {
    const done = jobs.slice(-12).map((j) => {
        const head = String(j.answer || '').replace(/\s+/g, ' ').trim().slice(0, 420);
        return `- ${j.name}: ${String(j.task || '').slice(0, 200)} → ${j.status}${head ? ` — result: ${head}` : ''}`;
    });
    const steps = leadSteps.slice(-12).map((s) => `- ${String(s).slice(0, 160)}`);
    const planLines = plan.slice(0, 6).map((st, i) => `${i + 1}. ${String(st).slice(0, 200)}`);
    return [
        `${leadModel || 'The main model'} is still working on the request below. You have been running background jobs for it; their results are summarised underneath.`,
        `Propose the NEXT background jobs (at most ${maxJobs}) ONLY if the answer to the user's question still has a gap: a fact the results left open, or two results that contradict each other and need a third source. Each job must answer part of THE USER'S question — never a side topic the results happened to mention (a tool, a library or a product one report named in passing), never a check of code or text the main model is writing, and never a repeat of a job already done or a step the main model already took.`,
        'Most of the time the answer is `- none`: say so rather than inventing work.',
        LEGWORK_RULE,
        JOB_RULE,
        ...(context ? ['', 'THE CONVERSATION SO FAR (context only):', context] : []),
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

// Reworded duplicates. A lead re-dispatching a running job under its own
// wording ("tcl-firmware: Find the current TCL C8K firmware version…" for
// "current TCL TV firmware version: find the exact firmware version…") shares
// ~30% of its words — the same as two genuinely different jobs on one topic —
// so the word check cannot see it. Right before a job starts, jobs whose text
// embeds close to it are shown to the assistant model for one short verdict.
function buildDuplicateJudgeTask({ job, existing = [] }) {
    const letters = 'ABCDEFGHIJKL';
    return [
        'Background research jobs are running for one user request. Decide whether the NEW job would mostly find the same information as one of the EXISTING jobs.',
        'It is a DUPLICATE only when existing work already covers its main question — a reworded or more detailed version of the same lookup, the same file or URL processed the same way by the main model\'s own step (e.g. "decompile the MSI" after the main model already ran an MSI analysis tool on that file), or a question an existing result already answers. A job asking for a different or narrower fact that the existing work does not cover is NEW (a follow-up that fills a gap in a result is NEW).',
        '',
        'EXISTING WORK:',
        ...existing.slice(0, letters.length).map((e, i) => {
            const report = String(e.report || '').replace(/\s+/g, ' ').trim();
            const label = e.leadStep ? `(done by the main model itself) ${e.task}` : `${e.name}: ${String(e.task || '').replace(/\s+/g, ' ').slice(0, 320)}`;
            return `${letters[i]}. ${label}${report ? `\n   ${e.leadStep ? 'Its result' : 'Its report'}: ${report.slice(0, 600)}` : ' (still running)'}`;
        }),
        '',
        'NEW JOB:',
        `${job.name}: ${String(job.task || '').replace(/\s+/g, ' ').slice(0, 480)}`,
        '',
        'Reply with exactly one line: "DUPLICATE OF <letter>" or "NEW".',
    ].join('\n');
}

// A job that names only files the lead has ALREADY processed whole with a
// whole-file tool, and asks to analyse/extract them again, repeats the lead's
// own step — the judge model let a reworded "run dotnet-decompile on
// Set-up.msi" through after the lead had run inspect_msi on it.
const WHOLE_FILE_TOOLS = new Set(['inspect_msi', 'extract_archive', 'tar_extract', 'unzip_file', 'extract_strings', 'scan_source_files', 'read_pdf', 'outline_file']);
const REPROCESS_VERB = /\b(?:decompil|disassembl|analy[sz]|inspect|dump|extract|unpack|unzip|untar|list|parse|examine|review|read|open|scan|strings)\w*/i;
// An archive the job asks to extract whose folder already exists under
// /workspace/archives (from this turn or an earlier one) is done work: a
// follow-up "extract the inner Software_Cloud.zip" ran after turn 1 had
// extracted it to archives/Software_Cloud/.
const ARCHIVE_NAME_RE = /[A-Za-z0-9][\w.()-]{0,120}?\.(?:zip|zipx|7z|rar|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|gz|bz2|xz|zst|cab|iso|msi|deb|rpm)\b/gi;
const EXTRACT_VERB = /\b(?:extract|unpack|unzip|untar|unrar|decompress|open up)\w*/i;
function alreadyExtractedArchive(job, archiveDirs = []) {
    const task = String((job && job.task) || '');
    if (!archiveDirs.length || !EXTRACT_VERB.test(task)) return null;
    const key = (s) => String(s || '').toLowerCase().replace(/\.(?:tar\.(?:gz|bz2|xz)|[a-z0-9]{1,5})$/i, '').replace(/[^a-z0-9]/g, '');
    const names = [...new Set((task.match(ARCHIVE_NAME_RE) || []).map(n => n.split('/').pop().trim()))];
    if (!names.length) return null;
    const dirs = archiveDirs.map(d => ({ d, k: String(d).toLowerCase().replace(/[^a-z0-9]/g, '') }));
    const hits = names.map((n) => {
        const k = key(n);
        if (k.length < 5) return null;
        return dirs.find(x => x.k === k || (x.k.startsWith(k) && x.k.length - k.length <= 7)) || null;
    });
    if (!hits.every(Boolean)) return null;
    return { id: 'extracted', name: 'already extracted', leadStep: true, status: 'done', tool: 'extract_archive', task: `already extracted to ${hits.map(h => `/workspace/archives/${h.d}/`).join(', ')}` };
}

// A proposal model can loop inside the task text (seen live: "CustomActionData64,
// CustomActionArguments64, CustomActionData32, …" for 2,000 chars). Such a
// task is not a brief anyone can act on.
function isDegenerateTask(task) {
    const words = String(task || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
    if (words.length < 40) return false;
    return new Set(words).size / words.length < 0.3;
}

function coveredByLeadStep(job, steps = [], archiveDirs = []) {
    const extracted = alreadyExtractedArchive(job, archiveDirs);
    if (extracted) return extracted;
    const task = String((job && job.task) || '');
    const norm = (p) => String(p || '').replace(/[.,;:)'"`\]]+$/, '').replace(/\/+$/, '');
    const paths = [...new Set([...task.matchAll(/\/workspace\/[A-Za-z0-9._\/-]+/g)].map(m => norm(m[0])))];
    if (!paths.length || !REPROCESS_VERB.test(task)) return null;
    const hits = paths.map(p => (steps || []).find(st => st && st.leadStep && WHOLE_FILE_TOOLS.has(st.tool) && norm(st.target) === p));
    return hits.every(Boolean) ? hits[0] : null;
}

function parseDuplicateVerdict(text, existing = []) {
    const t = String(text || '').replace(/\*\*/g, '').trim();
    const m = t.match(/\bDUPLICATE\s+(?:OF\s+)?(?:JOB\s+)?\(?([A-L])\b/i);
    if (m) {
        const idx = m[1].toUpperCase().charCodeAt(0) - 65;
        return existing[idx] || null;
    }
    return null;
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
// One URL, one file or one listing with nothing to search for: 1-3 s for the
// model doing the work, a 15-40 s delegated turn for the assistant (measured:
// "read-file" 18.8 s for a 530-char paste already in the message; a workspace
// listing 25.8 s while the lead listed it itself). A long script over a big
// file ("run", two paths) is still legwork.
const SINGLE_READ_VERB = /\b(read|open|fetch|extract|summari[sz]e|list|view|show|get|load|print|download|look at|check the contents of|inspect)\b/i;
// Analysing one supplied file (a binary, an installer, a nested archive) for
// what it contains or does is several calls, not a read — the artifact-
// analysis batches below name exactly one path per job.
const MULTI_STEP_VERB = /\b(search|find|look\s*up|research|compare|gather|collect|investigate|identify|determine|survey|cross[- ]check|verify against|which|latest|current|versions?|releases?|prices?|analy[sz]e|decompile|disassemble|deobfuscate|decode|iocs?|indicators?|custom actions?|embedded|every|all (?:urls|domains|ips|strings|scripts|files))\b/i;
// The whole ask is reading one linked page or one /workspace file ("summarize
// <url>", "read /workspace/x.log") — nothing a background job could add.
function isSingleReadAsk(text) {
    const ask = cleanAsk(text);
    if (!ask || RESEARCH_RE.test(ask.replace(/https?:\/\/\S+/g, ' ')) || LOOKUP_NEED_RE.test(ask.replace(/https?:\/\/\S+/g, ' '))) return false;
    return isSingleReadJob(ask);
}

function isSingleReadJob(task) {
    const t = String(task || '');
    const refs = (t.match(/https?:\/\/\S+/g) || []).length + (t.match(/\/workspace\/[A-Za-z0-9._\/-]+/g) || []).length;
    if (refs !== 1) return false;
    const words = t.replace(/https?:\/\/\S+|\/workspace\/[A-Za-z0-9._\/-]+/g, ' ');
    return SINGLE_READ_VERB.test(words) && !MULTI_STEP_VERB.test(words);
}

// A Pi agent works on the USER'S machine; its background jobs run on the
// server. A job about a bare local file ("read pi.md", "check webserver.py")
// cannot be done there — it would web-search for a file that only exists on
// the user's disk.
function isHostFileJob(task) {
    const t = String(task || '');
    if (/https?:\/\/|\/workspace\//i.test(t)) return false;
    if (/\b(search|look\s*up|research|find (?:out|online|docs?|documentation)|documentation|docs for|release notes|changelog)\b/i.test(t)) return false;
    return /(?:^|[\s'"`(])(?:~?\/?[\w.-]+\/)*[\w-]+\.(?:md|txt|py|js|ts|json|ya?ml|toml|ini|cfg|conf|sh|ps1|bat|log|csv|html?|css|env|lock|xml|sql|rb|go|rs|java|c|h|cpp)\b/i.test(t);
}

function isWorkableJob(job) {
    const name = String(job && job.name || '').trim();
    const task = String(job && job.task || '').trim();
    if (task.length < 15) return false;
    if (isDegenerateTask(task)) return false;
    if (isSingleReadJob(task)) return false;
    // The proposal prompt's own template echoed back ("<short name>: <one-line
    // brief…>", "If nothing would help, reply exactly: …") is not a job. Seen
    // live: both lines started as jobs and ran 34 s and 61 s each.
    if (/<[^>]{2,40}>/.test(`${name} ${task}`) || /^<[^<>]{2,200}>\.?$/.test(task)) return false;
    if (/^(?:if nothing\b|reply (?:exactly|with only)\b)/i.test(name) || /\breply exactly\b/i.test(`${name} ${task}`)) return false;
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
function buildJobBrief({ job, goal, plan = [], siblings = [], findings = [], leadModel, budgetLine, context = '' }) {
    const L = [];
    if (budgetLine) L.push(budgetLine);
    L.push(`You are running ONE background job for ${leadModel || 'the main model'}, which is writing the answer to the user's request while you work. Your report is the only thing it will see from you.`);
    // Sections are capped so the brief stays small next to a job's own tool
    // results in a per-slot context window.
    if (context) L.push('', 'THE CONVERSATION SO FAR (context only):', String(context).trim().slice(0, 700));
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

function jobNameFromTask(task) {
    return String(task || '').replace(/^(please\s+|go\s+|now\s+)/i, '')
        .split(/(?<=[.;:,])\s|\n/)[0].trim().replace(/[.;:,]$/, '').slice(0, 48) || 'job';
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
        let name = split ? split[1].trim() : line.slice(0, 50);
        const task = split ? split[2].trim() : line;
        if (task.length < 8) continue;
        // Small models copy the template's `<short name>` verbatim and then
        // write a real brief after it (seen live: every job of a brief dropped
        // as "no legwork proposed"). Name it from its task instead.
        if (/^<[^>]{2,40}>$/.test(name)) name = jobNameFromTask(task);
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
// The note the LEAD gets. It used to carry the whole brief — the faster
// model's restatement of a request the lead can read for itself — and the lead
// followed its mistakes: it read stale files the plan named, listed a
// directory the plan invented, and opened answers by correcting the brief's
// misreading of the subject. The brief now feeds the JOBS (goal + plan in
// buildJobBrief); the lead is only told what is running for it. With nothing
// running there is no note at all (the lead prelude already explains
// ask_assistant).
function renderBriefNote({ brief, assistantModel, firstPassSeconds, toolCalls, legworkAvailable = true, startedJobs = null, quick = false, retrieval = false, userAsked = false }) {
    const body = String(brief || '').trim();
    if (!body) return '';
    const who = assistantModel || 'the primary model';
    const started = Array.isArray(startedJobs) ? startedJobs.filter(Boolean) : [];
    if (!legworkAvailable || !started.length) return '';
    const meta = [
        assistantModel ? `on ${assistantModel}` : null,
        typeof firstPassSeconds === 'number' ? `planned in ${firstPassSeconds}s` : null,
    ].filter(Boolean).join(', ');
    const list = started.map(j => (typeof j === 'string' ? `- "${j}"` : `- "${j.name}": ${String(j.task || '').slice(0, 220)}`)).join('\n');
    const open = (() => {
        const q = String(briefSection(body, 'OPEN QUESTIONS') || '').replace(/^[\s:—–-]+/, '').trim();
        return q && !/^[`'"*\s-]*none\b/i.test(q) ? q.split('\n')[0].slice(0, 240) : '';
    })();
    // Research-shaped work: the jobs ARE the lookups the answer depends on —
    // writing first means writing around holes, searching yourself repeats
    // them (measured: the lead ran the same searches its jobs were running).
    // The user's own instructions asked for delegation: anything the reports
    // leave open goes back to the assistant, never to the lead's own search.
    const leftOpen = userAsked
        ? `for anything their reports leave open, hand it to ${who} with \`ask_assistant\` — the user's instructions ask you to delegate this work, so do not search yourself`
        : 'search yourself only for what their reports leave open';
    const howToWork = retrieval
        ? `These jobs are fetching the facts this answer depends on. Outline the answer now (structure, what you already know for certain), then call \`await_assistant\` for the reports; ${leftOpen}.`
        : `Do not sit and wait for them: start the work now — the parts only you can do. Call \`await_assistant\` only when you have nothing left to do without a result.`;
    const more = userAsked
        ? `Hand any further lookup or research to ${who} with \`ask_assistant\`.`
        : `Hand over more with \`ask_assistant\` only for another lookup that takes several steps.`;
    return [
        `[SYSTEM: TWO MODELS — you are the main model on this task and you write the final answer. ${started.length} background job${started.length === 1 ? ' is' : 's are'} ALREADY RUNNING${meta ? ` (${meta})` : ''}:`,
        list,
        `Do NOT redo that work yourself and do NOT dispatch it again under another name — each result is delivered to you when it lands. ${howToWork} Never put a placeholder, "pending" marker or "results to follow" note in the answer: write around a missing piece and fill it in when its result arrives.${open ? ` Open question noted by ${who}: ${open}` : ''} ${more}]`,
    ].join('\n');
}

// Late results revise the draft by EDITS, not a rewrite. Measured: the lead
// regenerated the whole answer (1,743 tokens, 45 s) for a +158-character
// change, and 2,216 tokens / 63 s on another turn. The draft is already in the
// lead's prompt cache, so a reply of "NO CHANGES" or a few SEARCH/REPLACE
// blocks costs seconds; the server applies them to the draft on screen.
const REVISION_EDITS_PROMPT = [
    'The background results above arrived after you drafted your reply (your previous message). Check the draft against them.',
    'If the draft needs no change, reply with exactly: NO CHANGES',
    'Otherwise reply ONLY with edit blocks, one per change, in exactly this format:',
    '<<<<<<< SEARCH',
    'text copied character-for-character from your draft (a whole line or sentence, unique in the draft)',
    '=======',
    'the replacement text',
    '>>>>>>> REPLACE',
    'To add new material, SEARCH a nearby line and REPLACE it with that same line followed by the new text. Correct anything the results contradict, fill in anything you had to leave out, and remove any claim that information was unavailable when the results supply it. Keep the same format and style as the draft. Never mention the brief, the background results, the assistant or the revision. Do not call tools now, and write nothing outside the edit blocks.',
].join('\n');

const REVISION_EDITS_RETRY = 'That reply was not in the required format, so nothing was applied. Reply again with ONLY one of: exactly NO CHANGES, or edit blocks (<<<<<<< SEARCH / exact text from your draft / ======= / replacement / >>>>>>> REPLACE). No other words.';

const EDIT_BLOCK_RE = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n?={5,}\s*\n([\s\S]*?)\n?>{5,}\s*REPLACE/g;

function stripEditBlocks(text) {
    return String(text || '').replace(EDIT_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Locate `needle` in `hay`: exact first, then ignoring whitespace differences
// (models re-flow spaces and trailing blanks when they copy a line).
function locateText(hay, needle) {
    const n = String(needle || '');
    if (!n.trim()) return null;
    const at = hay.indexOf(n);
    if (at >= 0) return { start: at, end: at + n.length };
    const trimmed = n.trim();
    const at2 = hay.indexOf(trimmed);
    if (at2 >= 0) return { start: at2, end: at2 + trimmed.length };
    const parts = trimmed.split(/\s+/).map(escapeRe);
    if (parts.length > 400) return null;
    const m = new RegExp(parts.join('\\s+')).exec(hay);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
}

// → { kind: 'none'|'edits'|'full'|'invalid', text, applied, failed }
function applyRevisionEdits(draft, output) {
    const base = String(draft || '');
    const out = String(output || '').replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '').trim();
    const blocks = [...out.matchAll(EDIT_BLOCK_RE)];
    if (!blocks.length) {
        if (/^[`*_"'\s]*NO\s+CHANGES?\b/i.test(out) && out.length < 80) return { kind: 'none', text: base, applied: 0, failed: 0 };
        // "The draft is consistent with the results…" — a no-change verdict in
        // prose. Measured: read as invalid, it cost a 125 s full rewrite.
        if (out.length < Math.max(1200, base.length * 0.4)
            && /\b(?:no\s+(?:further\s+)?(?:changes?|edits?|revisions?)\s+(?:are\s+|is\s+)?(?:needed|required|necessary)|(?:draft|answer|reply)\s+(?:is\s+(?:already\s+)?)?(?:consistent|accurate|correct|complete)|already\s+(?:covers|includes|reflects|contains|accounts\s+for)|nothing\s+(?:to\s+change|needs?\s+(?:to\s+be\s+)?chang))/i.test(out)
            && !/\b(?:however|but\s+(?:the|it)|should\s+(?:be\s+)?(?:updated|changed|corrected)|incorrect|contradict)/i.test(out)) {
            return { kind: 'none', text: base, applied: 0, failed: 0 };
        }
        // The model ignored the format and rewrote the answer: use it when it
        // is plausibly the whole answer, never a fragment.
        if (out.length >= Math.max(200, base.length * 0.6) && !/<{5,}|>{5,}/.test(out)) return { kind: 'full', text: out, applied: 0, failed: 0 };
        return { kind: 'invalid', text: base, applied: 0, failed: 0 };
    }
    let text = base;
    let applied = 0;
    let failed = 0;
    for (const b of blocks) {
        const loc = locateText(text, b[1]);
        if (!loc) { failed++; continue; }
        text = text.slice(0, loc.start) + b[2] + text.slice(loc.end);
        applied++;
    }
    if (failed) return { kind: 'invalid', text: base, applied, failed };
    return { kind: 'edits', text, applied, failed };
}

// Framing for the lead turn itself, appended to the shared prelude.
// Did the user's own words — their chosen system prompt / persona, or the ask —
// tell the model to hand work to the assistant? ("leverage the assistant as
// much as possible", "offload easy work to the helper", "delegate"). Measured
// on the "Malware" persona: the instruction was there and the lead still made
// zero hand-offs, because nothing on the server read it.
const DELEGATION_WISH_RE = /\b(?:(?:use|using|leverage|leveraging|utili[sz]e|involve|lean on|rely on|make use of)\s+(?:of\s+)?(?:the|your|an?|my)\s+(?:assistant|helper|second(?:ary)? model|other model|sub-?agents?|workers?)|(?:off-?load|hand(?:\s+(?:it|this|work))?\s*(?:off|over)|delegate|farm out|outsource|pass)\b[^.\n]{0,80}?\b(?:assistant|helper|other model|sub-?agents?|workers?)|delegat(?:e|ion|ing)\b|off-?load\b)/i;
const DELEGATION_NEG_RE = /\b(?:don'?t|do not|never|no|without|avoid)\s+(?:\w+\s+){0,3}$/i;
function wantsDelegation(text) {
    const t = String(text || '');
    if (!t) return false;
    const re = new RegExp(DELEGATION_WISH_RE.source, 'gi');
    let m;
    while ((m = re.exec(t)) !== null) {
        const before = t.slice(Math.max(0, m.index - 40), m.index);
        if (!DELEGATION_NEG_RE.test(before)) return true;
    }
    return false;
}

// Is this turn an ANALYSIS of files the user supplied (an uploaded archive,
// binary, capture or repo — or files already extracted in the workspace from
// an earlier turn)? Such a turn has plenty of independent legwork (a nested
// installer, a folder of scripts, a group of binaries) but none of it is a
// web lookup, so the lookup-only first pass skipped it and the lead did it
// all itself.
const ARTIFACT_KINDS = new Set(['archive', 'capture', 'code', 'log-large', 'file', 'spreadsheet', 'document']);
const CONTENTS_Q_RE = /\b(decompil\w*|disassembl\w*|iocs?|indicators?|post[- ]?install\w*|custom actions?|embedded|imports|hashes)\b/i;
function isArtifactAnalysis({ text, attachmentKinds = [], workspaceHasContent = false } = {}) {
    const raw = cleanAsk(text);
    if (!raw) return false;
    const { ask, toolsForbidden } = stripNegatedTools(raw);
    if (toolsForbidden) return false;
    const heavy = (attachmentKinds || []).some(k => ARTIFACT_KINDS.has(k)) || CODE_HOST_OR_FILE.test(ask) || !!workspaceHasContent;
    if (!heavy) return false;
    // Real analysis intent only: "read the license and check the installer's
    // size" names files too, and a fan-out there made the lead hand trivial
    // reads to the assistant.
    return ANALYSIS_VERB.test(ask) || ANALYSIS_NOUN.test(ask) || SECURITY_RE.test(ask) || CONTENTS_Q_RE.test(ask);
}

// The assistant proposes ANALYSIS jobs over the files on disk (no tools in this
// step). Asked once the lead has something concrete in the workspace — after
// an extraction, or at the start of a follow-up turn over files already there.
function buildArtifactLegworkTask({ userText, leadModel, inventory = [], leadSteps = [], jobs = [], maxJobs = 3, context = '', instructions = '' }) {
    const inv = inventory.filter(Boolean).slice(0, 80).map(l => `  ${String(l).trim().slice(0, 200)}`);
    const steps = leadSteps.slice(-12).map(s => `- ${String(s).slice(0, 160)}`);
    const done = jobs.slice(-12).map(j => `- ${j.name}: ${String(j.task || '').slice(0, 200)} → ${j.status}`);
    return [
        `${leadModel || 'The main model'} is analysing the files below for the user and will write the answer. You are the faster model of the pair: you will run background ANALYSIS JOBS on parts of these files, in parallel, while it works.`,
        'You have NO tools in this step and must not answer the request.',
        ...(context ? ['', 'THE CONVERSATION SO FAR (context only):', context] : []),
        '',
        'THE USER ASKED:',
        askForFirstPass(userText, 2500),
        ...(instructions ? ['', 'THE USER\'S STANDING INSTRUCTIONS (the jobs must follow them too):', String(instructions).trim().slice(0, 1800)] : []),
        '',
        'FILES ON DISK:',
        ...(inv.length ? inv : ['  (see the steps below)']),
        '',
        'STEPS THE MAIN MODEL ALREADY TOOK:',
        ...(steps.length ? steps : ['- none yet']),
        ...(done.length ? ['', 'JOBS ALREADY RUNNING OR DONE (do not repeat them):', ...done] : []),
        '',
        `Split the remaining analysis into at most ${maxJobs} INDEPENDENT jobs. Each job covers a DIFFERENT part of these files and takes several tool calls on the server — for example one nested archive or installer (unpack it and identify what it installs and runs), one group of binaries (extract their strings and identify URLs, IPs, domains, registry keys, commands), or one folder of scripts (grep for URLs, base64, eval/atob, download-and-execute, install hooks). Use the exact /workspace paths from the list. Each job reports concrete findings with the file path each came from.`,
        'NOT a job: the whole task, one file read or one listing, writing the report, anything already done above, or a web search for general information.',
        JOB_RULE,
        'Reply with ONLY this section, nothing else:',
        'LEGWORK',
        '- <short name>: <what to analyse (with its /workspace path) and exactly what to report back>',
        'If nothing would help, reply exactly: LEGWORK\n- none',
    ].join('\n');
}

function buildLeadPrelude({ assistantModel, maxParallel, artifact = false, userAsked = false, researchDemanded = false }) {
    const who = assistantModel ? `the faster model (${assistantModel})` : 'the faster model';
    return [
        `TWO MODELS — YOU LEAD. You are the stronger model and you write the final answer; ${who} is your assistant and runs jobs in the background${maxParallel > 1 ? ` (${maxParallel} at once, more queue)` : ''}. The user sees only your answer.`,
        ...(researchDemanded ? ['THE USER ASKED FOR WEB RESEARCH: searching and reading sources is required on this turn — hand the searches to your assistant as jobs so they run while you work, and do not conclude after a single search. Skip only a search the user forbade.'] : []),
        ...(userAsked ? ['THE USER\'S INSTRUCTIONS ASK YOU TO USE YOUR ASSISTANT: hand every independent lookup or piece of legwork to it rather than doing those steps yourself.'] : []),
        `HAND OFF with \`ask_assistant\` ({name, task} each — it returns at once and each report is delivered into your context when it lands): work that takes several steps and does not depend on what you are writing — a search plus reading the pages that answer it, comparing sources, checking current versions, prices, dates or docs, or analysing one part of files already in /workspace (an archive, a group of binaries, a folder of scripts; no web search needed for that).`,
        ...(artifact ? ['THIS TURN ANALYSES SUPPLIED FILES: once they are extracted or listed, keep the overall picture and the write-up for yourself and hand the independent parts (each named by its /workspace path) to the assistant in ONE ask_assistant call, then carry on with your own part.'] : []),
        'DO NOT hand off: the answer, the design or the code (that is your job); anything that needs output you have not written yet (it cannot read a file you have not created); or a single step — one page, one file, one command is faster done yourself than as a background job.',
        'GOOD JOBS: one subject each, written as a complete brief — what to find or do, where to look (URLs, paths), and what to report (the facts, with their URLs). The assistant sees only the brief, never this conversation. Dispatch everything you will need at the START in one ask_assistant call, then carry on with your own part. Do not search for what a running job is already finding, and call `await_assistant` only when you have nothing left to write without its result.',
        'WHEN A REPORT LANDS, use it as it stands — do not re-fetch or re-check what it already covers unless two reports conflict or it says it could not find something. Delegation continues only while it is needed: if a report leaves a gap the answer cannot do without, hand that gap over and carry on; do not dispatch jobs just to add depth or detail nobody asked for, and never invent work to keep the assistant busy.',
    ].join(' ');
}

// Framing for a turn the PRIMARY answers alone while the stronger model is
// loaded and idle: primary → secondary. (Or the mirror image when the user
// aimed a small turn at the secondary on purpose.)
function buildPartnerPrelude({ partnerModel, partnerIsStronger, maxParallel }) {
    const who = partnerModel || 'the other model';
    return [
        `TWO MODELS — YOU ANSWER THIS TURN; the ${partnerIsStronger ? 'STRONGER' : 'FASTER'} model of the pair (${who}) is idle as your assistant.`,
        `\`ask_assistant\` hands it a job ({name, task}) and returns at once — it works in the background${maxParallel > 1 ? ` (up to ${maxParallel} at once, more queue)` : ''} and each report is delivered into your context when it lands.`,
        partnerIsStronger
            ? 'HAND OFF what needs more capability than you have — a hard design decision, tricky reasoning or a proof to check, a difficult piece of code or analysis, a review of a draft section — plus independent legwork (a lookup, a file to read, a script to run).'
            : 'HAND OFF independent legwork — a lookup, a file to read or summarise, a script to run and report on, a claim to check — and keep the thinking, design and writing for yourself.',
        'Write each job as a complete brief (what to do, where to look, what to report): it cannot see this conversation. Never hand off the whole task or anything that depends on output you have not written yet. Delegation is CONTINUOUS: hand over more whenever your work reveals it; when nothing more is needed simply carry on — never invent work for it.',
    ].join(' ');
}

// One line for a JOB that may hand the other model of the pair a little work
// back (the "primary <-> secondary" half). Deliberately tight.
function buildJobPartnerLine({ partnerModel, maxJobs }) {
    const who = partnerModel || 'the other model';
    return `The other model of the pair (${who}) is available through \`ask_assistant\` for at most ${Math.max(1, maxJobs || 1)} thing${(maxJobs || 1) === 1 ? '' : 's'} you genuinely cannot do well yourself (a hard judgment, a check of tricky reasoning) — it runs in the background and the result is delivered to you; do the rest of your task yourself and never hand it the whole task.`;
}

module.exports = {
    alreadyExtractedArchive,
    isDegenerateTask,
    coveredByLeadStep,
    wantsDelegation,
    isArtifactAnalysis,
    buildArtifactLegworkTask,
    REVISION_EDITS_PROMPT,
    REVISION_EDITS_RETRY,
    applyRevisionEdits,
    stripEditBlocks,
    buildDuplicateJudgeTask,
    parseDuplicateVerdict,
    MODES,
    buildFollowUpLegworkTask,
    buildJobBrief,
    parsePlan,
    isDuplicateJob,
    isWorkableJob,
    isSingleReadJob,
    isSingleReadAsk,
    isHostFileJob,
    buildPartnerPrelude,
    buildJobPartnerLine,
    cleanAsk,
    askForFirstPass,
    parseLegwork,
    attachmentKindsFromText,
    askLength,
    isSubstantialWork,
    isEasyTurn,
    stripNegatedToolClauses: (text) => stripNegatedTools(String(text || '')).ask,
    isRetrievalShaped,
    needsLookup,
    userDemandsResearch,
    forbidsTools,
    planHandoff,
    buildFirstPassTask,
    buildLegworkTask,
    buildReportSalvageTask,
    buildConversationContext,
    LEGWORK_RULE,
    renderBriefNote,
    buildLeadPrelude,
};
