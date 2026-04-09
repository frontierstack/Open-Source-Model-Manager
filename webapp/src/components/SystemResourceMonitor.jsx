import React, { useMemo } from 'react';
import { Box, Card, CardContent, Typography, LinearProgress, Chip } from '@mui/material';
import MemoryIcon from '@mui/icons-material/Memory';
import BoltIcon from '@mui/icons-material/Bolt';
import DeveloperBoardIcon from '@mui/icons-material/DeveloperBoard';
import SpeedIcon from '@mui/icons-material/Speed';

/**
 * SystemResourceMonitor
 *
 * Renders a live CPU/RAM/GPU dashboard fed by `system_stats` WebSocket
 * messages. Draws pure-SVG sparklines so the panel stays dependency-free.
 *
 * Props:
 *   current:  the most recent `system_stats` payload (or null)
 *   history:  array of the last N `system_stats` payloads (oldest first)
 */

const SPARKLINE_WIDTH = 220;
const SPARKLINE_HEIGHT = 38;

// Draws a single series. `values` are assumed to be numbers in the 0..100
// range (percentages). We normalize and map to SVG coordinates.
function Sparkline({ values, color, fillOpacity = 0.15 }) {
    const width = SPARKLINE_WIDTH;
    const height = SPARKLINE_HEIGHT;

    // Need at least 2 points to draw a line
    if (!values || values.length < 2) {
        return (
            <svg width={width} height={height} style={{ display: 'block' }}>
                <line
                    x1={0} y1={height - 1}
                    x2={width} y2={height - 1}
                    stroke={color}
                    strokeOpacity={0.25}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                />
            </svg>
        );
    }

    // Always scale against 100 (these are percentages) so the y-axis stays
    // comparable between panels. Pin the bottom at 0 so "idle" looks idle.
    const yMax = 100;
    const step = width / (values.length - 1);

    const points = values.map((v, i) => {
        const x = i * step;
        const normalized = Math.max(0, Math.min(yMax, v || 0));
        const y = height - (normalized / yMax) * (height - 2) - 1;
        return [x, y];
    });

    const linePath = points
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
        .join(' ');

    const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

    return (
        <svg width={width} height={height} style={{ display: 'block' }}>
            <defs>
                <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={fillOpacity * 2} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#grad-${color.replace('#', '')})`} />
            <path
                d={linePath}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
            />
        </svg>
    );
}

// Compact stat card: icon + label + current value + bar + sparkline
function StatCard({ icon, label, valueText, percent, color, series, subline }) {
    return (
        <Box
            sx={{
                flex: '1 1 240px',
                minWidth: 240,
                p: 1.5,
                borderRadius: 1.5,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'rgba(255,255,255,0.02)',
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{
                    width: 26, height: 26, borderRadius: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    bgcolor: `${color}22`, color,
                }}>
                    {icon}
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: '0.7rem' }}>
                    {label}
                </Typography>
                <Typography
                    variant="body2"
                    sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color }}
                >
                    {valueText}
                </Typography>
            </Box>
            <LinearProgress
                variant="determinate"
                value={Math.max(0, Math.min(100, percent || 0))}
                sx={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    '& .MuiLinearProgress-bar': { backgroundColor: color, borderRadius: 2 },
                }}
            />
            <Sparkline values={series} color={color} />
            {subline && (
                <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.68rem', fontVariantNumeric: 'tabular-nums' }}>
                    {subline}
                </Typography>
            )}
        </Box>
    );
}

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${mb.toFixed(0)} MB`;
}

function SystemResourceMonitor({ current, history }) {
    // Derive series arrays once per render
    const { cpuSeries, memSeries, gpuSeriesByIndex } = useMemo(() => {
        const cpuSeries = [];
        const memSeries = [];
        const gpuSeriesByIndex = new Map();

        for (const sample of history) {
            if (sample?.cpu?.percent != null) cpuSeries.push(sample.cpu.percent);
            if (sample?.memory?.percent != null) memSeries.push(sample.memory.percent);
            if (Array.isArray(sample?.gpus)) {
                for (const gpu of sample.gpus) {
                    if (!gpuSeriesByIndex.has(gpu.index)) {
                        gpuSeriesByIndex.set(gpu.index, { util: [], vram: [] });
                    }
                    gpuSeriesByIndex.get(gpu.index).util.push(gpu.utilizationPct || 0);
                    gpuSeriesByIndex.get(gpu.index).vram.push(gpu.vramUsedPct || 0);
                }
            }
        }

        return { cpuSeries, memSeries, gpuSeriesByIndex };
    }, [history]);

    const hasData = !!current;
    const cpu = current?.cpu;
    const mem = current?.memory;
    const gpus = current?.gpus || [];
    const models = current?.models || [];

    return (
        <Card sx={{ flexShrink: 0 }}>
            <CardContent sx={{ p: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                    <SpeedIcon sx={{ fontSize: 22, color: 'primary.main' }} />
                    <Box>
                        <Typography sx={{ fontWeight: 600, fontSize: '1rem' }}>System Resources</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            Live CPU, RAM and GPU usage — updated every 3s
                        </Typography>
                    </Box>
                    {!hasData && (
                        <Chip
                            label="Waiting for data..."
                            size="small"
                            sx={{ ml: 'auto', fontSize: '0.7rem' }}
                        />
                    )}
                    {hasData && models.length > 0 && (
                        <Chip
                            label={`${models.length} model${models.length === 1 ? '' : 's'} loaded`}
                            size="small"
                            color="primary"
                            variant="outlined"
                            sx={{ ml: 'auto', fontSize: '0.7rem' }}
                        />
                    )}
                </Box>

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                    {/* CPU */}
                    <StatCard
                        icon={<DeveloperBoardIcon sx={{ fontSize: 16 }} />}
                        label="CPU"
                        valueText={cpu?.percent != null ? `${cpu.percent.toFixed(0)}%` : '—'}
                        percent={cpu?.percent}
                        color="#60a5fa"
                        series={cpuSeries}
                        subline={cpu ? `${cpu.cores} cores` : null}
                    />

                    {/* RAM */}
                    <StatCard
                        icon={<MemoryIcon sx={{ fontSize: 16 }} />}
                        label="RAM"
                        valueText={mem?.percent != null ? `${mem.percent.toFixed(0)}%` : '—'}
                        percent={mem?.percent}
                        color="#a78bfa"
                        series={memSeries}
                        subline={
                            mem
                                ? `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}`
                                : null
                        }
                    />

                    {/* Per-GPU cards */}
                    {gpus.map((gpu) => {
                        const seriesPair = gpuSeriesByIndex.get(gpu.index);
                        return (
                            <StatCard
                                key={`gpu-${gpu.index}`}
                                icon={<BoltIcon sx={{ fontSize: 16 }} />}
                                label={`GPU ${gpu.index} · ${gpu.name}`}
                                valueText={`${gpu.utilizationPct}%`}
                                percent={gpu.utilizationPct}
                                color="#34d399"
                                series={seriesPair?.util || []}
                                subline={
                                    `VRAM ${(gpu.vramUsedMb / 1024).toFixed(1)} / ${(gpu.vramTotalMb / 1024).toFixed(1)} GB (${gpu.vramUsedPct}%)` +
                                    `  ·  ${gpu.temperatureC}°C  ·  ${gpu.powerW.toFixed(0)}W`
                                }
                            />
                        );
                    })}
                </Box>

                {/* Models summary row */}
                {models.length > 0 && (
                    <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                        {models.map((m) => (
                            <Chip
                                key={m.name}
                                size="small"
                                label={
                                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                                        <Box component="span" sx={{
                                            width: 7, height: 7, borderRadius: '50%',
                                            bgcolor: m.status === 'running' ? '#22c55e'
                                                : m.status === 'loading' ? '#f59e0b'
                                                : '#6b7280',
                                        }} />
                                        {m.name}
                                        <Box component="span" sx={{ color: 'text.secondary', ml: 0.5 }}>
                                            · {m.backend} · {m.contextSize ?? '—'} ctx · :{m.port}
                                        </Box>
                                    </Box>
                                }
                                sx={{
                                    fontSize: '0.7rem',
                                    height: 22,
                                    bgcolor: 'rgba(255,255,255,0.03)',
                                    border: '1px solid',
                                    borderColor: 'divider',
                                }}
                            />
                        ))}
                    </Box>
                )}
            </CardContent>
        </Card>
    );
}

export default SystemResourceMonitor;
