import React from 'react';
import { iconForTool } from '../../utils/toolIcons';
import { colorForHostname } from './SearchSources';

// Bundled square tool icons — the same look as the source cluster's site
// icons (srcx-bar), one tile per distinct tool, "+N" past `max`.
export function ToolTile({ name, size = 20, ring = false, className = '' }) {
    const Icon = iconForTool(name);
    const { bg } = colorForHostname(String(name || 'tool'));
    return (
        <span
            className={`srcx-icon tool-tile${ring ? ' srcx-icon--ring' : ''}${className ? ' ' + className : ''}`}
            style={{ width: size, height: size, '--tile': bg }}
            title={name}
            aria-hidden="true"
        >
            <Icon strokeWidth={2} style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6) }} />
        </span>
    );
}

export default function ToolIconStack({ tools, max = 6 }) {
    const list = Array.isArray(tools) ? tools : [];
    if (!list.length) return null;
    const shown = list.slice(0, max);
    const extra = list.length - shown.length;
    return (
        <span className="srcx-stack">
            {shown.map(n => <ToolTile key={n} name={n} ring />)}
            {extra > 0 && <span className="srcx-icon srcx-icon--ring srcx-more">+{extra}</span>}
        </span>
    );
}
