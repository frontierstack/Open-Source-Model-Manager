import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ChevronDown, Loader2 } from 'lucide-react';
import { getHostname, colorForHostname, avatarLetter, usePreview } from './SearchSources';
import SmoothCollapse from './SmoothCollapse';
import { warmPreview } from '../../utils/linkPreview';

/**
 * Every site the turn's web calls touched, as a bundle of small square site
 * icons under the answer. Collapsed it is one row (overlapping icons + count);
 * clicked it opens a list grouped by site, each page a link.
 *
 * Sources come from the chips (`toolCalls[].sources`, filled by
 * extractSources at commit) plus the legacy message-level `searchResults`.
 * A page the model actually READ is listed before a page that only showed up
 * as a search result.
 */
const WEB_LABELS = /^(web|web_search|fetch_url|scrapling_fetch|playwright_fetch|playwright_interact|crawl_pages|count_entries)$/;

function callKind(tc) {
    const a = (tc && tc.args) || {};
    if (tc && /^(fetch_url|scrapling_fetch|playwright_fetch|playwright_interact|crawl_pages|count_entries)$/.test(tc.label || '')) return 'read';
    if (a.url || (Array.isArray(a.urls) && a.urls.length)) return 'read';
    return 'search';
}

export function collectSources(toolCalls, searchResults) {
    const pages = new Map(); // url -> {url,title,snippet,kind}
    const add = (s, kind) => {
        if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return;
        const key = s.url.replace(/#.*$/, '').replace(/\/$/, '');
        const prev = pages.get(key);
        if (prev) {
            if (kind === 'read') prev.kind = 'read';
            if (!prev.title && s.title) prev.title = s.title;
            return;
        }
        pages.set(key, { url: s.url, title: s.title || '', snippet: s.snippet || '', kind });
    };
    for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
        if (!tc || tc.status === 'failed' || !Array.isArray(tc.sources)) continue;
        if (tc.label && !WEB_LABELS.test(tc.label) && !tc.sources.length) continue;
        const kind = callKind(tc);
        // read:N on a search fetched the top results — those were read too.
        tc.sources.forEach((s) => add(s, kind === 'search' && s && s.snippet && s.snippet.length > 200 ? 'read' : kind));
    }
    for (const s of Array.isArray(searchResults) ? searchResults : []) add(s, 'search');

    const sites = new Map(); // host -> {host, pages[], read}
    for (const p of pages.values()) {
        const host = getHostname(p.url);
        if (!host) continue;
        if (!sites.has(host)) sites.set(host, { host, pages: [], read: false });
        const site = sites.get(host);
        site.pages.push(p);
        if (p.kind === 'read') site.read = true;
    }
    const list = [...sites.values()];
    list.forEach((s) => s.pages.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'read' ? -1 : 1)));
    // Read sites first; otherwise keep the order the calls found them in.
    return list.map((s, i) => ({ ...s, i })).sort((a, b) => (a.read === b.read ? a.i - b.i : a.read ? -1 : 1));
}

function SiteIcon({ host, size = 20, ring = false }) {
    const [failed, setFailed] = useState(false);
    const { bg, fg } = colorForHostname(host);
    return (
        <span
            className={'srcx-icon' + (ring ? ' srcx-icon--ring' : '')}
            style={{ width: size, height: size, background: failed ? bg : 'var(--surface)', color: fg }}
            aria-hidden="true"
        >
            {failed ? (
                <span className="srcx-letter" style={{ fontSize: Math.round(size * 0.5) }}>{avatarLetter(host)}</span>
            ) : (
                <img
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => setFailed(true)}
                />
            )}
        </span>
    );
}

// Screenshot card for one page, anchored to the row under the pointer. Shows
// the loader's already-decoded image, so a warmed page appears at once.
function PreviewCard({ page, anchor }) {
    const preview = usePreview(page.url, true);
    const [pos, setPos] = useState(null);
    useEffect(() => {
        const place = () => {
            const r = anchor && anchor.getBoundingClientRect();
            if (!r) return;
            const W = 320, H = 260, m = 8;
            let left = Math.min(Math.max(m, r.left), window.innerWidth - W - m);
            let top = r.top - H - m >= m ? r.top - H - m : Math.min(r.bottom + m, window.innerHeight - H - m);
            setPos({ left, top });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
    }, [anchor]);
    if (!pos || typeof document === 'undefined') return null;
    const host = getHostname(page.url) || '';
    return createPortal(
        <div className="src-popup" style={{ left: pos.left, top: pos.top, zIndex: 9999 }}>
            {preview.status !== 'failed' && (
                <div className="src-popup-shot">
                    {preview.status === 'ready' && preview.img ? (
                        <span
                            className="absolute inset-0"
                            ref={(el) => {
                                if (!el) return;
                                const img = preview.img;
                                if (img.parentNode !== el) { img.alt = ''; img.className = 'w-full h-full object-cover'; el.replaceChildren(img); }
                            }}
                        />
                    ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--ink-4)' }} />
                            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Rendering preview…</span>
                        </div>
                    )}
                </div>
            )}
            {page.title && <div className="src-popup-title line-clamp-2">{page.title}</div>}
            <div className="src-popup-host">{host}</div>
            {page.snippet && <div className="src-popup-text line-clamp-4">{page.snippet.slice(0, 280)}</div>}
        </div>,
        document.body,
    );
}

// Hover (desktop) or first tap (touch) previews; a second tap follows the link.
function usePreviewHover() {
    const [hover, setHover] = useState(null);   // { page, anchor }
    const timer = useRef(null);
    const coarse = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: none)').matches;
    const bind = (page) => ({
        onMouseEnter: (e) => {
            const anchor = e.currentTarget;
            warmPreview(page.url, { urgent: true });
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setHover({ page, anchor }), 120);
        },
        onMouseLeave: () => { clearTimeout(timer.current); setHover(null); },
        onFocus: (e) => { warmPreview(page.url, { urgent: true }); setHover({ page, anchor: e.currentTarget }); },
        onBlur: () => setHover(null),
        onClick: (e) => {
            if (!coarse()) return;
            if (hover && hover.page.url === page.url) return;
            e.preventDefault();
            warmPreview(page.url, { urgent: true });
            setHover({ page, anchor: e.currentTarget });
        },
    });
    useEffect(() => () => clearTimeout(timer.current), []);
    return { hover, bind, close: () => setHover(null) };
}

export default function SourceCluster({ toolCalls, searchResults, maxIcons = 6 }) {
    const sites = useMemo(() => collectSources(toolCalls, searchResults), [toolCalls, searchResults]);
    const [open, setOpen] = useState(false);
    const { hover, bind, close } = usePreviewHover();
    const rootRef = useRef(null);
    // Warm the screenshots while the cluster is on (or near) the screen, so
    // opening the list and hovering a page shows its preview at once.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || !sites.length) return undefined;
        const warm = () => {
            const read = sites.flatMap(s => s.pages.filter(p => p.kind === 'read'));
            const rest = sites.flatMap(s => s.pages.filter(p => p.kind !== 'read'));
            read.concat(rest).slice(0, 12).forEach(p => warmPreview(p.url));
        };
        if (typeof IntersectionObserver === 'undefined') { warm(); return undefined; }
        const io = new IntersectionObserver((items) => {
            if (items.some(it => it.isIntersecting)) { warm(); io.disconnect(); }
        }, { rootMargin: '400px 0px' });
        io.observe(el);
        return () => io.disconnect();
    }, [sites]);
    useEffect(() => {
        if (!hover) return undefined;
        const onDown = (e) => { if (!(e.target.closest && e.target.closest('.srcx-list'))) close(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
    }, [hover]);
    if (!sites.length) return null;
    const pageCount = sites.reduce((n, s) => n + s.pages.length, 0);
    const readCount = sites.filter((s) => s.read).length;
    const shown = sites.slice(0, maxIcons);
    const extra = sites.length - shown.length;

    return (
        <div ref={rootRef} className={'srcx' + (open ? ' srcx--open' : '')}>
            <button
                type="button"
                className="srcx-bar"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                title={sites.map((s) => s.host).join(', ')}
            >
                <span className="srcx-stack">
                    {shown.map((s) => <SiteIcon key={s.host} host={s.host} ring />)}
                    {extra > 0 && <span className="srcx-icon srcx-icon--ring srcx-more">+{extra}</span>}
                </span>
                <span className="srcx-label">
                    {sites.length} site{sites.length === 1 ? '' : 's'}
                    {readCount > 0 && readCount < sites.length ? ` · ${readCount} read` : ''}
                    {pageCount > sites.length ? ` · ${pageCount} pages` : ''}
                </span>
                <ChevronDown className="srcx-chev" style={{ width: 14, height: 14 }} strokeWidth={1.75} />
            </button>
            <SmoothCollapse open={open}>
                <ul className="srcx-list">
                    {sites.map((s) => (
                        <li key={s.host} className="srcx-site">
                            <a className="srcx-site-head" href={s.pages[0].url} target="_blank" rel="noopener noreferrer" {...bind(s.pages[0])}>
                                <SiteIcon host={s.host} size={18} />
                                <span className="srcx-host">{s.host}</span>
                                {s.read && <span className="srcx-tag">read</span>}
                            </a>
                            <ul className="srcx-pages">
                                {s.pages.map((p) => (
                                    <li key={p.url}>
                                        <a href={p.url} target="_blank" rel="noopener noreferrer" {...bind(p)}>
                                            <span className="srcx-title">{p.title || p.url.replace(/^https?:\/\/(www\.)?/i, '')}</span>
                                            <ExternalLink className="srcx-ext" style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    ))}
                </ul>
            </SmoothCollapse>
            {hover && <PreviewCard page={hover.page} anchor={hover.anchor} />}
        </div>
    );
}
