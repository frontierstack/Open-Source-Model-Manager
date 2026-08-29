'use strict';
// Diagnostic hints for preview_html: map the browser's raw error text to the
// cause a front-end developer would recognise, so the model fixes the right
// line instead of churning on the wrong one. Live-observed: an inline
// <script type="text/babel"> containing `import React from 'react'` threw
// "Cannot use import statement outside a module" from INSIDE babel.min.js —
// the model read the babel URL in the stack, rewrote the CDN <script> tags
// eight times (replace_lines got quarantined), and only recovered by
// rewriting the whole file. Pure + unit-testable; keep hints generic (error
// class → cause), never page-specific.

const RULES = [
    {
        re: /Cannot use import statement outside a module|Unexpected token 'export'|import declarations may only appear at top level of a module/i,
        hint: (ctx) => `An \`import\`/\`export\` statement is running in a NON-module script${ctx.hasBabel ? ' (the inline text/babel block — the stack points at babel.min.js because Babel is what evaluated it)' : ''}. With React/ReactDOM loaded from CDN <script> tags there is nothing to import: delete the import/export lines and use the globals (React, ReactDOM, React.useState …). The CDN <script> tags themselves are fine — do not rewrite them.`,
    },
    {
        re: /(\w+) is not defined/i,
        hint: (ctx, m) => {
            const name = m[1];
            const known = { React: 'react', ReactDOM: 'react-dom', Babel: '@babel/standalone', THREE: 'three', d3: 'd3', Chart: 'chart.js', PIXI: 'pixi.js', p5: 'p5', gsap: 'gsap', _: 'lodash', $: 'jquery', jQuery: 'jquery' };
            if (known[name]) return `\`${name}\` is not defined: the ${known[name]} <script> tag is missing, failed to load, or is placed AFTER the code that uses it. Load it in <head> (or before your script) and check failedRequests.`;
            if (/^(useState|useRef|useEffect|useCallback|useMemo|useReducer|createRoot)$/.test(name)) return `\`${name}\` is not defined: with React from a CDN, hooks are properties of the global — write \`const { ${name} } = React;\` (or React.${name}) and \`ReactDOM.createRoot\` for createRoot.`;
            return `\`${name}\` is not defined at the point it is used: it is declared later, declared inside another function/block, or misspelled. Define it before use.`;
        },
    },
    {
        re: /Unexpected token '<'|expected expression, got '<'/i,
        hint: () => `JSX (\`<Tag>\`) is being parsed by the plain JS engine. Either the script tag needs \`type="text/babel"\` (with @babel/standalone loaded FIRST) or the JSX must be replaced with React.createElement calls.`,
    },
    {
        re: /Cannot read propert(?:y|ies) of null \(reading '(getContext|appendChild|addEventListener|innerHTML|style|width|height)'\)/i,
        hint: (ctx, m) => `\`${m[1]}\` was called on null — a DOM query (getElementById/querySelector/ref) returned nothing because the element does not exist yet or the id/selector is wrong. Run the code after the DOM exists (script at the end of <body>, DOMContentLoaded, or inside useEffect) and check the id matches.`,
    },
    {
        re: /ReactDOM\.render is not a function|ReactDOM\.createRoot is not a function|createRoot is not a function/i,
        hint: () => `React version / API mismatch: React 18 uses \`ReactDOM.createRoot(el).render(<App/>)\`; React 17 and earlier use \`ReactDOM.render(<App/>, el)\`. Match the call to the CDN version actually loaded, and load react-dom AFTER react.`,
    },
    {
        re: /Identifier '(\w+)' has already been declared/i,
        hint: (ctx, m) => `\`${m[1]}\` is declared twice in the same scope (often a leftover from an earlier edit — a duplicated const/function/import). Remove one.`,
    },
    {
        re: /'return' outside of function|Illegal return statement/i,
        hint: () => `A \`return\` sits at top level — usually an earlier edit deleted the function header (or an opening brace) above it. Check the lines just before the reported line for a missing \`function …() {\`.`,
    },
    {
        re: /Unexpected end of input|Unexpected token '}'|missing \) after argument list|Unexpected token \)/i,
        hint: () => `Unbalanced braces/parentheses — a partial edit removed or duplicated a bracket. Read the reported line and the surrounding block, or rewrite the whole file cleanly rather than patching line ranges.`,
    },
    {
        re: /Maximum call stack size exceeded|too much recursion/i,
        hint: () => `Unbounded recursion — a function calls itself (or a React render triggers a state update that re-renders) without a base case. Look for setState inside the render body or a recursive call without a termination condition.`,
    },
    {
        re: /Failed to execute 'getImageData'|Failed to execute 'putImageData'|The provided (float|double) value is non-finite|IndexSizeError/i,
        hint: () => `A canvas call received an invalid size/coordinate (0, negative, NaN or beyond the canvas). Make sure canvas.width/height are set to positive integers BEFORE drawing and that computed coordinates are finite.`,
    },
];

/**
 * @param {Array<{message:string, stack?:string}>} pageErrors
 * @param {object} dom  the renderer's DOM summary (scripts[] used to detect Babel)
 * @returns {string[]} one hint per matching error class (deduplicated, ≤6)
 */
function previewErrorHints(pageErrors, dom) {
    const out = [];
    const seen = new Set();
    const scripts = (dom && Array.isArray(dom.scripts)) ? dom.scripts : [];
    const ctx = {
        hasBabel: scripts.some(s => /text\/babel|text\/jsx/i.test(String(s.type || '')) || /babel/i.test(String(s.src || ''))),
    };
    for (const e of (Array.isArray(pageErrors) ? pageErrors : [])) {
        const text = `${(e && e.message) || ''}\n${(e && e.stack) || ''}`;
        for (const r of RULES) {
            const m = text.match(r.re);
            if (!m) continue;
            const key = r.re.source;
            if (seen.has(key)) break;
            seen.add(key);
            out.push(r.hint(ctx, m));
            break;
        }
        if (out.length >= 6) break;
    }
    return out;
}

module.exports = { previewErrorHints };
