// sandboxPreview.js — helpers for rendering untrusted (model-generated) HTML
// inside an OPAQUE-ORIGIN sandboxed iframe (sandbox WITHOUT allow-same-origin).
//
// The opaque origin is the real security boundary: allow-scripts + allow-same-
// origin together would let the framed code reach window.parent, the app's
// cookies and storage — a full sandbox escape. We deliberately keep the opaque
// origin, but it has one user-visible side effect: `window.localStorage` and
// `window.sessionStorage` THROW a SecurityError on access ("the document is
// sandboxed and lacks the 'allow-same-origin' flag"). Plenty of legitimate
// snippets (a game saving a high score, a widget remembering a tab) touch
// storage and would otherwise crash with an uncaught SecurityError.
//
// Fix: inject a tiny in-memory polyfill that SHADOWS the throwing accessors
// with a per-document data property, so storage reads/writes succeed (scoped to
// the iframe's lifetime — exactly the right semantics for an ephemeral preview).
// This keeps the secure sandbox intact while letting the code run.

// The polyfill is a self-invoking script. It only installs a shim when the real
// storage object is unreachable, so a future allow-same-origin frame is left
// untouched. A Proxy backs both method access (getItem/setItem/…) and the
// property-style access (`localStorage.highScore = 5`) real Storage supports.
// NB: the closing tag is split (`<\/script>`) so this string can never
// prematurely terminate a <script> context if ever inlined.
export const STORAGE_POLYFILL = [
    '<script>(function(){',
    'function mk(){var m=Object.create(null);',
    'var api={',
    'getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},',
    'setItem:function(k,v){m[String(k)]=String(v);},',
    'removeItem:function(k){delete m[String(k)];},',
    'clear:function(){for(var k in m){delete m[k];}},',
    'key:function(i){var ks=Object.keys(m);return (i>=0&&i<ks.length)?ks[i]:null;}',
    '};',
    'return new Proxy(api,{',
    'get:function(t,p){if(p===\'length\')return Object.keys(m).length;',
    'if(p in t){var v=t[p];return typeof v===\'function\'?v.bind(t):v;}',
    'return Object.prototype.hasOwnProperty.call(m,p)?m[p]:undefined;},',
    'set:function(t,p,v){if(p in t){t[p]=v;}else{m[String(p)]=String(v);}return true;},',
    'has:function(t,p){return (p in t)||Object.prototype.hasOwnProperty.call(m,p);},',
    'deleteProperty:function(t,p){if(Object.prototype.hasOwnProperty.call(m,p)){delete m[p];}return true;},',
    'ownKeys:function(){return Object.keys(m);},',
    'getOwnPropertyDescriptor:function(t,p){return Object.prototype.hasOwnProperty.call(m,p)?{enumerable:true,configurable:true,writable:true,value:m[p]}:undefined;}',
    '});}',
    '[\'localStorage\',\'sessionStorage\'].forEach(function(name){',
    'var ok=false;try{var s=window[name];if(s){void s.getItem;ok=true;}}catch(e){ok=false;}',
    'if(!ok){try{Object.defineProperty(window,name,{value:mk(),configurable:true,writable:true});}catch(e){}}',
    '});',
    '})();<\/script>',
].join('');

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inject the storage polyfill (and, optionally, a <base href> so a snippet's
// relative URLs still resolve against where it was served) at the very start of
// the document's <head>, so it runs BEFORE any of the page's own scripts.
// Falls back to wrapping in a <head> or prepending when the markup has none.
export function injectSandboxPreview(html, { baseHref } = {}) {
    const inject = (baseHref ? `<base href="${escapeAttr(baseHref)}">` : '') + STORAGE_POLYFILL;
    if (!html) return inject;
    const headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
        const at = headMatch.index + headMatch[0].length;
        return html.slice(0, at) + inject + html.slice(at);
    }
    const htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
        const at = htmlMatch.index + htmlMatch[0].length;
        return html.slice(0, at) + '<head>' + inject + '</head>' + html.slice(at);
    }
    return inject + html;
}
