/**
 * Code written THROUGH a tool call (create_file / run_python / …) — helpers
 * shared by the Artifacts panel (committed messages) and the live stream.
 *
 * The model writes most deliverables via tool calls, not prose fences, so the
 * source of a page/script only ever exists inside the call's JSON arguments.
 * While the call streams, those arguments arrive as `tool_call_delta`
 * fragments; `extractCodeDraft` reads the code string out of the PARTIAL JSON
 * (no closing quote yet) so the Artifacts panel can show the file being
 * written live — exactly like an unclosed ``` fence in prose.
 */

// Tools whose arguments carry source the user wants to watch being written.
export const CODE_WRITE_TOOLS = new Set([
    'create_file', 'write_file', 'update_file', 'append_to_file', 'replace_lines',
    'run_python', 'run_node', 'html_to_pdf', 'create_pdf',
]);
// Whole-file writers — safe to surface as a committed artifact after the call
// (an append/replace chunk would be a misleading "file").
export const WHOLE_FILE_TOOLS = new Set(['create_file', 'write_file', 'update_file', 'run_python', 'run_node']);

const CODE_KEYS = ['content', 'code', 'newContent', 'html', 'htmlContent', 'markdown', 'text'];
const PATH_KEYS = ['filePath', 'path', 'filename', 'fileName', 'outputName', 'codeFile', 'outputPath'];

function unescapeJson(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, g) => {
        switch (g[0]) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case 'b': return '\b';
            case 'f': return '\f';
            case 'u': return String.fromCharCode(parseInt(g.slice(1), 16));
            default: return g; // \" \\ \/ and anything else
        }
    });
}

function pickString(text, keys) {
    for (const k of keys) {
        const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(text);
        if (m) return unescapeJson(m[1]);
    }
    return '';
}

/** Language for a file name / path (mirrors the Artifacts panel's table). */
export function languageForTool(name, filePath, langFromName) {
    if (filePath && typeof langFromName === 'function') {
        const l = langFromName(filePath);
        if (l && l !== 'text') return l;
    }
    if (name === 'run_python') return 'python';
    if (name === 'run_node') return 'javascript';
    if (name === 'html_to_pdf') return 'html';
    if (name === 'create_pdf') return 'markdown';
    return filePath && typeof langFromName === 'function' ? langFromName(filePath) : 'text';
}

/**
 * Read the code string out of a (possibly partial) JSON arguments text.
 * Returns null when the tool is not a code writer or no code key has started.
 * `complete` is false while the string's closing quote has not arrived.
 */
export function extractCodeDraft(name, argsText) {
    if (!CODE_WRITE_TOOLS.has(name) || typeof argsText !== 'string' || !argsText) return null;
    let start = -1;
    let key = null;
    for (const k of CODE_KEYS) {
        const m = new RegExp('"' + k + '"\\s*:\\s*"').exec(argsText);
        if (m && (start < 0 || m.index < start)) { key = k; start = m.index + m[0].length; }
    }
    if (start < 0) return null;
    const raw = argsText.slice(start);
    let end = -1;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '\\') { i++; continue; }
        if (c === '"') { end = i; break; }
    }
    let body = end >= 0 ? raw.slice(0, end) : raw;
    if (end < 0) {
        // An escape cut mid-way (`\` or `\u00`) would decode wrong — trim it.
        if (/(^|[^\\])(\\\\)*\\$/.test(body)) body = body.slice(0, -1);
        body = body.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    }
    return { key, filePath: pickString(argsText, PATH_KEYS), source: unescapeJson(body), complete: end >= 0 };
}

/** Source + path from a COMMITTED tool call (arguments object or JSON string). */
export function codeFromToolCall(tc) {
    const name = tc?.name;
    if (!WHOLE_FILE_TOOLS.has(name)) return null;
    let args = tc.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); }
        catch (_) {
            const d = extractCodeDraft(name, args);
            return d && d.source.trim() ? { filePath: d.filePath, source: d.source } : null;
        }
    }
    if (!args || typeof args !== 'object') return null;
    const source = CODE_KEYS.map(k => args[k]).find(v => typeof v === 'string' && v.trim());
    if (!source) return null;
    const filePath = PATH_KEYS.map(k => args[k]).find(v => typeof v === 'string' && v) || '';
    return { filePath, source };
}
