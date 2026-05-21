// CSRF defense: tag every same-origin request with a custom header that the
// server requires on cookie-authenticated, state-changing requests. A
// cross-site page cannot set this header without a CORS preflight the server
// never approves, so it can't forge authenticated mutations using the user's
// session cookie. Patching window.fetch covers every raw fetch() call site
// without editing each one.
//
// Only same-origin (relative or current-origin) requests are tagged — adding a
// custom header to a cross-origin fetch would trigger an unwanted preflight.
// Imported first in index.js so the patch is installed before any fetch runs.
(function () {
    if (typeof window === 'undefined' || window.__csrfFetchPatched) return;
    window.__csrfFetchPatched = true;

    const origFetch = window.fetch.bind(window);

    function isSameOrigin(url) {
        if (!url) return false;
        // Relative path ("/api/..."), but not protocol-relative ("//host").
        if (url.startsWith('/')) return !url.startsWith('//');
        return url === window.location.origin || url.startsWith(window.location.origin + '/');
    }

    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input
                : (input instanceof URL) ? input.href
                : (input && input.url) || '';
            if (isSameOrigin(url)) {
                const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input && input.headers) || {});
                if (!headers.has('X-Requested-With')) headers.set('X-Requested-With', 'XMLHttpRequest');
                init = Object.assign({}, init, { headers });
            }
        } catch (_) {
            // Never let the patch break a request — fall through unmodified.
        }
        return origFetch(input, init);
    };
})();
