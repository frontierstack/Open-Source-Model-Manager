import React from 'react';
import { Handle, Position } from '@xyflow/react';
import {
    Zap, Clock, Webhook, Bell, Cpu, Wrench, Search, Globe, Database,
    BarChart3, FileText, Timer, Variable, GitBranch, Filter, Merge, Flag, Box as BoxIcon,
    Braces, Code, Download, MessageSquare, MessagesSquare, Send,
} from 'lucide-react';

// Which handles a node exposes, by engine kind. Triggers are sources only,
// output is a sink, gates fan out on named handles, everything else is in→out.
export function handlesFor(kind, data = {}) {
    if (!kind) return { targets: ['in'], sources: ['out'] };
    if (kind.startsWith('trigger.')) return { targets: [], sources: ['out'] };
    if (kind === 'output') return { targets: ['in'], sources: [] };
    if (kind === 'gate.if') return { targets: ['in'], sources: ['true', 'false'] };
    if (kind === 'gate.switch') {
        const cases = Array.isArray(data.cases) ? data.cases : [];
        const handles = cases.map(c => c.handle || String(c.equals)).filter(Boolean);
        return { targets: ['in'], sources: [...handles, 'default'] };
    }
    return { targets: ['in'], sources: ['out'] };
}

function pickIcon(kind) {
    switch (kind) {
        case 'trigger.manual': return Zap;
        case 'trigger.schedule': return Clock;
        case 'trigger.webhook': return Webhook;
        case 'trigger.event': return Bell;
        case 'trigger.telegram': return MessagesSquare;
        case 'model': return Cpu;
        case 'web_search': return Search;
        case 'fetch_url': return Globe;
        case 'parse_json': return Braces;
        case 'render_html': return Code;
        case 'export_file': return Download;
        case 'slack': return MessageSquare;
        case 'telegram': return Send;
        case 'delay': return Timer;
        case 'set': return Variable;
        case 'gate.if': return GitBranch;
        case 'gate.switch': return GitBranch;
        case 'gate.filter': return Filter;
        case 'merge': return Merge;
        case 'output': return Flag;
        case 'tool': {
            return Wrench;
        }
        default: return BoxIcon;
    }
}

// Icon override for tool-backed connector templates (data.tool tells us which).
function iconForTool(tool) {
    switch (tool) {
        case 'query_sqlite': return Database;
        case 'render_chart': return BarChart3;
        case 'create_pdf':
        case 'create_file': return FileText;
        case 'http_request':
        case 'crawl_pages': return Globe;
        default: return Wrench;
    }
}

function categoryClass(kind) {
    if (!kind) return '';
    if (kind.startsWith('trigger.')) return 'auto-node--trigger';
    if (kind.startsWith('gate.') || kind === 'merge') return 'auto-node--gate';
    if (kind === 'output') return 'auto-node--output';
    return '';
}

function subtitleFor(kind, data) {
    if (kind === 'tool') return data.tool || 'tool';
    if (kind === 'model') return data.model || 'current model';
    if (kind === 'trigger.schedule') return data.cron || (data.intervalMs ? `every ${Math.round(data.intervalMs / 1000)}s` : 'schedule');
    if (kind === 'trigger.event') return data.event || 'event';
    if (kind === 'trigger.telegram') return data.keyword ? `“${String(data.keyword).slice(0, 18)}”` : 'message';
    if (kind === 'web_search') return data.query ? `“${String(data.query).slice(0, 24)}”` : 'query';
    if (kind === 'fetch_url') return data.url || 'url';
    if (kind === 'parse_json') return data.path ? `→ ${data.path}` : 'parse';
    if (kind === 'render_html') return 'html';
    if (kind === 'export_file') return (data.format || 'txt').toUpperCase();
    if (kind === 'slack') return 'slack';
    if (kind === 'telegram') return 'telegram';
    if (kind === 'set') return data.name || 'variable';
    return '';
}

export default function AutomationNode({ data, selected }) {
    const kind = data.kind;
    const { targets, sources } = handlesFor(kind, data);
    const Icon = kind === 'tool' ? iconForTool(data.tool) : pickIcon(kind);
    const status = data.status; // running | done | failed | undefined
    const statusClass = status === 'running' ? 'is-running' : status === 'completed' ? 'is-done' : status === 'failed' ? 'is-failed' : '';
    const sub = subtitleFor(kind, data);

    return (
        <div className={`auto-node ${categoryClass(kind)} ${statusClass} ${selected ? 'selected' : ''}`}>
            {/* target handles (left) */}
            {targets.map((t, i) => (
                <Handle
                    key={`t-${t}`}
                    type="target"
                    position={Position.Left}
                    id={t}
                    style={{ top: targets.length === 1 ? '50%' : `${((i + 1) / (targets.length + 1)) * 100}%` }}
                />
            ))}

            <div className="auto-node__head">
                <span className="auto-node__icon"><Icon size={15} strokeWidth={2} /></span>
                <span className="auto-node__title">{data.label || kind}</span>
                {status === 'running' && (
                    <span className="auto-node__status"><span className="auto-node__spinner" /></span>
                )}
            </div>
            {sub && <div className="auto-node__sub">{sub}</div>}

            {/* source handles (right), labeled when there's more than one */}
            {sources.map((s, i) => {
                const top = sources.length === 1 ? '50%' : `${((i + 1) / (sources.length + 1)) * 100}%`;
                return (
                    <React.Fragment key={`s-${s}`}>
                        <Handle type="source" position={Position.Right} id={s} style={{ top }} />
                        {sources.length > 1 && (
                            <span className="auto-node__handle-label" style={{ right: 12, top: `calc(${top} - 7px)` }}>{s}</span>
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
}
