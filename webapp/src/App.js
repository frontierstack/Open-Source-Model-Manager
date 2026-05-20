import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
// Use native WebSocket (W3C-compliant in all modern browsers)
import { useAuthStore } from './stores/useAuthStore';
import { useAppStore } from './stores/useAppStore';
import SystemResourceMonitor from './components/SystemResourceMonitor';
import { logout as performLogout } from './services/auth';
import { ThemeProvider, alpha } from '@mui/material/styles';
import { createAppTheme } from './theme';
import CssBaseline from '@mui/material/CssBaseline';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import IconButton from '@mui/material/IconButton';
import { MenuIcon } from './components/Icons';
import { DeleteIcon } from './components/Icons';
import { EditIcon } from './components/Icons';
import { CloudDownloadIcon } from './components/Icons';
import { RefreshIcon } from './components/Icons';
import { CheckCircleIcon } from './components/Icons';
import { WarningIcon } from './components/Icons';
import { PlayArrowIcon } from './components/Icons';
import { StopIcon } from './components/Icons';
import { SearchIcon } from './components/Icons';
import { SettingsIcon } from './components/Icons';
import { StorageIcon } from './components/Icons';
import { TerminalIcon } from './components/Icons';
import { ExpandMoreIcon } from './components/Icons';
import { ExpandLessIcon } from './components/Icons';
import { SaveIcon } from './components/Icons';
import { ClearIcon } from './components/Icons';
import { MemoryIcon } from './components/Icons';
import { ChatIcon } from './components/Icons';
import { TuneIcon } from './components/Icons';
import { InfoIcon } from './components/Icons';
import { HelpOutlineIcon } from './components/Icons';
import { MenuBookIcon } from './components/Icons';
import { FilterListIcon } from './components/Icons';
import { VpnKeyIcon } from './components/Icons';
import { ContentCopyIcon } from './components/Icons';
import { VisibilityIcon } from './components/Icons';
import { VisibilityOffIcon } from './components/Icons';
import { AddIcon } from './components/Icons';
import { EmailIcon } from './components/Icons';
import { DragIndicatorIcon } from './components/Icons';
import { ArrowBackIcon } from './components/Icons';
import { ArrowForwardIcon } from './components/Icons';
import { ArrowUpwardIcon } from './components/Icons';
import { ArrowDownwardIcon } from './components/Icons';
import { NavigateBeforeIcon } from './components/Icons';
import { NavigateNextIcon } from './components/Icons';
import { AppsIcon } from './components/Icons';
import { CancelIcon } from './components/Icons';
import { RestartAltIcon } from './components/Icons';
import { CodeIcon } from './components/Icons';
import { AutoAwesomeIcon } from './components/Icons';
import { FavoriteIcon } from './components/Icons';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Snackbar from '@mui/material/Snackbar';
// MUI Accordion / AccordionSummary / AccordionDetails imports were
// removed — Docs tab no longer uses chevron-driven accordions.
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActions from '@mui/material/CardActions';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Input from '@mui/material/Input';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Drawer from '@mui/material/Drawer';
import Collapse from '@mui/material/Collapse';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Slider from '@mui/material/Slider';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Autocomplete from '@mui/material/Autocomplete';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import LinearProgress from '@mui/material/LinearProgress';
import Checkbox from '@mui/material/Checkbox';
import { AccountCircleIcon } from './components/Icons';
import { PeopleIcon } from './components/Icons';
import { LogoutIcon } from './components/Icons';
import Menu from '@mui/material/Menu';
import useMediaQuery from '@mui/material/useMediaQuery';
import {
    Search as LucideSearch,
    HardDrive as LucideHardDrive,
    Users as LucideUsers,
    KeyRound as LucideKey,
    BookOpen as LucideBookOpen,
    Terminal as LucideTerminal,
    LayoutGrid as LucideLayoutGrid,
    Bot as LucideBot,
} from 'lucide-react';
import ThemePicker from './components/ThemePicker';
import AppSidebar from './components/AppSidebar';
import LogsPanel from './components/LogsPanel';
import UsersPanel from './components/UsersPanel';
import AppsPanel from './components/AppsPanel';
import MyModelsPanel from './components/MyModelsPanel';
import RunningInstancesPanel from './components/RunningInstancesPanel';
import UserDialog from './components/UserDialog';
import { usePreferencesStore } from './stores/usePreferencesStore';

// Theme is now created dynamically using createAppTheme from ./theme.js

// Helper functions
const extractParameterSize = (filename) => {
    const match = filename.match(/(\d+\.?\d*)[Bb]/);
    return match ? match[1] + 'B' : null;
};

const extractQuantization = (filename) => {
    const match = filename.match(/[IQ]+[_]?(\d+[_]?[KM]?[_]?[SMLXH0]?[SM]?)/i);
    if (match) {
        return match[0].toUpperCase().replace(/_+/g, '_');
    }
    return null;
};

const isSplitFile = (filename) => {
    return /-\d{5}-of-\d{5}\.gguf$/i.test(filename);
};

const getSplitInfo = (filename) => {
    const match = filename.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
    if (match) {
        return { part: parseInt(match[1]), total: parseInt(match[2]) };
    }
    return null;
};

const formatFileSize = (bytes) => {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb < 1) {
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(0)} MB`;
    }
    return `${gb.toFixed(2)} GB`;
};

const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return null;
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mRem = m % 60;
    return mRem ? `${h}h ${mRem}m` : `${h}h`;
};

// Settings tooltips - detailed descriptions for all sglang configuration options
const SETTINGS_TOOLTIPS = {
    maxModelLen: "Maximum number of tokens the model can process at once (passed as --context-length). Larger values allow longer conversations but require more VRAM. Your prompt + response must fit within this limit.",
    cpuOffloadGb: "Amount of model weights (in GB) to offload to CPU RAM. Use when model doesn't fit entirely in GPU VRAM. Some hybrid Mamba+MoE GGUFs (Qwen3.5/3.6-A3B-MTP) hit a causal_conv1d_fwd dtype error under CPU offload — keep at 0 for those.",
    memFractionStatic: "Fraction of GPU memory (0.0-1.0) that sglang is allowed to use for weights + KV cache (--mem-fraction-static). Default 0.88. Higher values squeeze in more concurrent requests but leave less headroom for spikes.",
    tensorParallelSize: "Number of GPUs to shard the model across (--tp). Set to your GPU count to split a large model. The entrypoint clamps this to the number of GPUs the container can actually see, so over-requesting won't hang at NCCL init.",
    maxRunningRequests: "Maximum number of concurrent requests sglang will batch at once (--max-running-requests). Higher values improve throughput but use more KV cache memory. Leave at 256 for general chat; reduce if hitting OOM under load.",
    chunkedPrefillSize: "Chunk size in tokens for prefill (--chunked-prefill-size). 4096 is a balanced default. Set -1 to disable for very small models. Larger chunks improve throughput on long prompts at the cost of latency variance.",
    schedulePolicy: "Request scheduling policy. 'lpm' (longest-prefix-match) pairs with RadixAttention and wins on RAG/multi-turn workloads. 'fcfs' (first-come-first-served) is fine for general chat. 'priority' uses an explicit priority field.",
    kvCacheDtype: "Data type for KV cache (--kv-cache-dtype). 'auto' uses model's native dtype; 'fp8_e5m2' / 'fp8_e4m3' halve KV memory with minimal quality loss on Hopper/Ada+.",
    trustRemoteCode: "Whether to trust remote code from the model repository (--trust-remote-code). Required for some custom HF model architectures (e.g., GLM-4, certain MoE variants).",
    toolCallParser: "Parser sglang uses to structure tool-call text into message.tool_calls (--tool-call-parser). Auto-detected from model name (qwen for Qwen2/3 Instruct, qwen3_coder for Coder variants, llama3, mistral, deepseekv3, kimi_k2, glm45, step3, gpt-oss). Leave empty to disable.",
    reasoningParser: "Parser sglang uses to separate <think> reasoning from the final answer (--reasoning-parser). Auto-detected: qwen3 for Qwen3 thinking, deepseek-r1 for R1, glm45 for GLM-4.5, kimi for Kimi K2. Empty for non-reasoning models.",
    contextShift: "Enable context shifting to automatically truncate old context when the limit is reached. Without this, requests fail when context is full. Recommended for long conversations.",
    disableThinking: "Controls reasoning/thinking mode for models that support it (e.g., Qwen3, Gemma thinking variants). ON = reasoning enabled (model shows its work in <think> blocks). OFF = reasoning disabled (model answers directly, faster).",
    compressMemory: "Enable AIMem memory compression for long conversations. Compresses older messages using deduplication, lossy compression, and relevance ranking to reduce token usage (~48% reduction) while retaining all facts."
};

// Settings tooltips for llama.cpp configuration options
const LLAMACPP_TOOLTIPS = {
    nGpuLayers: "Number of model layers to offload to GPU. -1 = all layers (recommended). Lower values offload less to GPU, useful for large models that don't fit in VRAM.",
    contextSize: "Maximum context window size in tokens. Larger values allow longer conversations but require more memory. Common values: 2048, 4096, 8192, 16384.",
    contextShift: "Enable context shifting to automatically discard old context when the limit is reached. Without this, inference stops when context is full. Recommended for long conversations.",
    compressMemory: "Enable AIMem memory compression for long conversations. Compresses older messages using deduplication, lossy compression, and relevance ranking to reduce token usage (~48% reduction) while retaining all facts.",
    flashAttention: "Enable flash attention for faster inference and lower memory usage. Recommended for most GPUs that support it.",
    cacheTypeK: "Data type for key cache. f16 = full precision, q8_0 = 8-bit quantized (saves memory), q4_0 = 4-bit quantized (maximum memory savings).",
    cacheTypeV: "Data type for value cache. Same options as key cache. Using quantized cache reduces memory but may slightly affect output quality.",
    threads: "Number of CPU threads to use. 0 = auto-detect (uses all available cores). Lower values leave more CPU for other tasks.",
    parallelSlots: "Number of parallel inference slots. Higher values allow more concurrent requests but use more memory.",
    batchSize: "Batch size for prompt processing. Larger values are faster but use more memory. Common values: 512, 1024, 2048.",
    ubatchSize: "Micro-batch size for processing. Should be smaller than batch size. Common values: 256, 512, 1024. Larger values speed up prompt processing for long inputs.",
    swaFull: "Allocate the full sliding-window-attention cache. Required for prompt-cache reuse across turns on SWA/hybrid models like Gemma 3/4 — without it, every turn re-evaluates the entire prompt from scratch. Costs more VRAM proportional to context size; only enable if VRAM headroom allows.",
    specType: "Speculative decoding mode (llama.cpp --spec-type). 'Off' = serial decode (default). 'MTP heads' uses this model's built-in multi-token-prediction heads — DeepSeek-V3/R1, Qwen3-Next-MTP, and Qwen3.5/3.6-MTP all ship them. No separate draft GGUF needed. 'Draft model' is classic speculative decoding using a smaller second GGUF. Both can deliver ~1.5–2× single-stream tok/s on supported models.",
    specDraftNMax: "Max tokens speculatively drafted per step (llama.cpp --spec-draft-n-max). 3 is a balanced default. Higher = more aggressive speculation (helps when acceptance rate is high), lower = less wasted compute when the draft is wrong. Only meaningful when speculative decoding is enabled.",
    specDraftModel: "Path inside /models to the draft GGUF (llama.cpp --spec-draft-model). Only used in 'Draft model' mode. The draft should be small + share the main model's tokenizer (e.g. Qwen2.5-0.5B-Instruct as draft for Qwen3-8B-Instruct). Ignored when 'MTP heads' is selected — those heads live inside the main GGUF.",
    repeatPenalty: "Penalty for repeating tokens (1.0 = no penalty). Higher values (1.1-1.3) reduce repetition. Too high may affect coherence.",
    repeatLastN: "Number of recent tokens to consider for repetition penalty. 64-128 is usually sufficient.",
    presencePenalty: "Penalty for tokens that have appeared at all (0.0-1.0). Encourages the model to talk about new topics.",
    frequencyPenalty: "Penalty based on token frequency (0.0-1.0). Higher values reduce repetition of common phrases.",
    disableThinking: "Controls reasoning/thinking mode for models that support it (e.g., Qwen3, Gemma thinking variants). ON = reasoning enabled (model shows its work in <think> blocks). OFF = reasoning disabled (model answers directly, faster)."
};

// Section Header Component
const SectionHeader = ({ icon, title, subtitle, action }) => (
    <Box sx={{ mb: { xs: 1.5, md: 2 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                {icon && React.cloneElement(icon, { sx: { fontSize: 18, color: 'primary.main' } })}
                <Typography variant="h5" sx={{ color: 'text.primary', fontSize: { xs: '1.15rem', md: '1.5rem' }, lineHeight: 1.2 }}>{title}</Typography>
            </Box>
            {action}
        </Box>
        {subtitle && (
            <Typography variant="caption" sx={{ color: 'text.secondary', ml: icon ? 3.5 : 0, display: 'block' }}>
                {subtitle}
            </Typography>
        )}
    </Box>
);

// Collapsible Section Component
const CollapsibleSection = ({ title, icon, children, defaultExpanded = true }) => {
    const [expanded, setExpanded] = useState(defaultExpanded);
    return (
        <Box sx={{ mb: 2 }}>
            <Box
                onClick={() => setExpanded(!expanded)}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    py: 1,
                    px: 1,
                    borderRadius: 1,
                    '&:hover': { bgcolor: 'var(--bg-tertiary)' }
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    {icon && React.cloneElement(icon, { sx: { fontSize: 16, color: 'text.secondary' } })}
                    <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                        {title}
                    </Typography>
                </Box>
                {expanded ? <ExpandLessIcon sx={{ fontSize: 18, color: 'text.secondary' }} /> : <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} />}
            </Box>
            <Collapse in={expanded}>
                <Box sx={{ pt: 1 }}>{children}</Box>
            </Collapse>
        </Box>
    );
};

// Docs sections — left-rail navigation pattern. The previous accordion
// design had been polished repeatedly without losing its accordion-y
// feel; this commit drops MUI Accordion entirely and shows one section
// at a time, picked from a vertical nav. No chevrons, no expand icons.
const docSectionSx = {
    bgcolor: 'var(--bg-tertiary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 2,
    overflow: 'hidden',
};
const docSectionHeaderSx = {
    display: 'flex',
    alignItems: 'center',
    gap: 1.5,
    px: 2.5,
    py: 2,
    bgcolor: 'var(--bg-elevated)',
    borderBottom: '1px solid var(--border-primary)',
    borderLeft: '3px solid var(--accent-primary)',
};
const docSectionBodySx = {
    px: 2.5,
    py: 2.5,
    color: 'var(--text-primary)',
};
// Left-rail nav — vertical pill list. Active item gets accent border-left
// + accent-tinted bg; inactive items get hover bg + accent border on hover.
const docNavItemSx = (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 1.25,
    width: '100%',
    px: 1.5,
    py: 1,
    borderRadius: 1.5,
    border: '1px solid',
    borderColor: active ? 'var(--accent-muted)' : 'transparent',
    bgcolor: active ? 'var(--accent-muted)' : 'transparent',
    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    fontWeight: active ? 600 : 500,
    transition: 'background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease',
    '&:hover': {
        bgcolor: active ? 'var(--accent-muted)' : 'var(--bg-hover)',
        color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
        borderColor: active ? 'var(--accent-muted)' : 'var(--border-primary)',
    },
});
// No icons in the rail — just labels. The earlier version had a lucide
// icon per row; the user explicitly asked for them gone.
const DOC_SECTIONS = [
    { id: 'quick-start',     label: 'Quick Start'         },
    { id: 'api-builder',     label: 'API Code Builder'    },
    { id: 'pi-setup',        label: 'Pi setup'            },
    { id: 'web-search',      label: 'Web Search & Fetch'  },
    { id: 'sandbox-skills',  label: 'Sandbox Skills'      },
    { id: 'config-flags',    label: 'Configuration Flags' },
    { id: 'api-endpoints',   label: 'API Endpoints'       },
    { id: 'utility-scripts', label: 'Utility Scripts'     },
    { id: 'system-reset',    label: 'System Reset'        },
];

// Compact table styling for docs — uses theme tokens so it reads correctly
// on light themes (the previous rgba(255,255,255,...) literals washed out
// to invisible borders against a white background).
const compactTableSx = {
    '& .MuiTableCell-root': {
        py: 0.75,
        px: 1.5,
        fontSize: '0.8rem',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--border-secondary)',
    },
    '& .MuiTableCell-head': {
        fontWeight: 600,
        color: 'var(--text-secondary)',
        fontSize: '0.7rem',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        bgcolor: 'var(--bg-hover)',
        borderBottom: '1px solid var(--border-primary)',
    },
};

const App = () => {
    // Core state
    const [models, setModels] = useState([]);
    const [instances, setInstances] = useState([]);
    // Crashed/exited containers stay in modelInstances (server-side) for diagnostics,
    // but they shouldn't render as "Running" in the UI — filter them out here.
    const liveInstances = React.useMemo(
        () => instances.filter(i => i.status !== 'stopped' && i.status !== 'oom_killed'),
        [instances]
    );
    const [logs, setLogs] = useState(() => {
        // Load logs from localStorage on mount
        try {
            const saved = localStorage.getItem('modelserver_logs');
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    });
    const [wsConnected, setWsConnected] = useState(false);
    const [loading, setLoading] = useState(false);
    const [logFilter, setLogFilter] = useState('all'); // 'all', 'error', 'warning', 'success', 'info'
    const [logSearch, setLogSearch] = useState('');

    // Live system resource state (driven by WebSocket 'system_stats' events)
    const [systemStats, setSystemStats] = useState(null);
    const [systemStatsHistory, setSystemStatsHistory] = useState([]);

    // Auth state
    const { user } = useAuthStore();
    const [userMenuAnchor, setUserMenuAnchor] = useState(null);

    // App preferences (theme, font, etc.)
    const { preferences } = useAppStore();

    // Dynamic theme based on user preferences
    const theme = useMemo(() => {
        return createAppTheme(
            preferences.theme || 'dark',
            preferences.fontFamily || 'default',
            preferences.fontSize || 'medium',
            preferences.accent || null
        );
    }, [preferences.theme, preferences.accent, preferences.fontFamily, preferences.fontSize]);

    // 'md' (<900px) so phone-landscape (~812px), iPad mini portrait (768px),
    // and any narrow desktop window also flip to mobile-friendly behavior
    // (full-screen dialogs, condensed header). 'sm' alone (<600px) is too
    // narrow — it leaves tablets and split-view layouts in the cramped
    // desktop layout.
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    // UI state
    const [activeTab, setActiveTab] = useState(0);
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [snackbarSeverity, setSnackbarSeverity] = useState('success');

    // HuggingFace search state
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searching, setSearching] = useState(false);
    // repoId -> { totalBytes, weightBytes, loading?, error? }. Populated lazily
    // after a search returns by hydrateRepoSizes() — non-GGUF results have no
    // file picker, so without this the user wouldn't see download size.
    const [repoSizes, setRepoSizes] = useState({});
    const [selectedModelFiles, setSelectedModelFiles] = useState([]);
    const [ggufRepo, setGgufRepo] = useState('');
    const [ggufFile, setGgufFile] = useState('');
    const [fileFilter, setFileFilter] = useState('all'); // 'all', 'single', 'split'
    const [searchSortBy, setSearchSortBy] = useState('downloads'); // 'downloads', 'likes', 'params', 'trending', 'newest'
    const [searchSizeFilter, setSearchSizeFilter] = useState('all'); // 'all', 'small', 'medium', 'large', 'xlarge'
    const [searchFormat, setSearchFormat] = useState('gguf'); // 'gguf', 'safetensors', 'awq', 'gptq', 'fp8', 'nvfp4', 'bnb', 'any'
    // HuggingFace direct-load dialog (sglang loads non-GGUF formats from a repo id)
    const [hfLoadDialog, setHfLoadDialog] = useState({ open: false, repoId: '', format: '' });
    const [hfLoadConfig, setHfLoadConfig] = useState({
        // 16K default: the chat stream attaches the full skill catalog
        // (~7k tokens) plus a runtime-context system prompt, so an 8K
        // context leaves no room for the user message. 16K is the safe
        // minimum for chat use; bump higher for long conversations.
        maxModelLen: 16384,
        memFractionStatic: 0.88,
        tensorParallelSize: 1,
        cpuOffloadGb: 0,
        kvCacheDtype: 'auto',
        trustRemoteCode: true,
        // CUDA graphs are a noticeable throughput win on driver 580+ /
        // Blackwell-open. Flip on per-load if a driver/arch combo emits
        // cudaErrorUnsupportedPtxVersion at warmup.
        enforceEager: false,
        contextShift: true,
        disableThinking: false,
        compressMemory: false,
        toolCallParser: '' // empty = server auto-picks from repo name
    });
    const [hfLoading, setHfLoading] = useState(false);
    // llama.cpp load dialog mirror — clicking Load on a downloaded GGUF model
    // opens this with the model name pre-filled, so config is per-launch
    // (matches the sglang flow). Replaces the old standalone Launch Settings
    // panel that applied a single global config to every load.
    const [llamacppLoadDialog, setLlamacppLoadDialog] = useState({ open: false, modelName: '' });
    const [llamacppLoading, setLlamacppLoading] = useState(false);
    // Cached HF repos previously pulled by sglang (lives in modelserver_hf_cache volume)
    const [hfCacheEntries, setHfCacheEntries] = useState([]);
    const [hfCacheTotalBytes, setHfCacheTotalBytes] = useState(0);
    const [hfCacheLoading, setHfCacheLoading] = useState(false);
    const [searchPage, setSearchPage] = useState(1);
    const ITEMS_PER_PAGE = 24;

    // User management state
    const [users, setUsers] = useState([]);
    const [usersLoading, setUsersLoading] = useState(false);
    const [selectedUser, setSelectedUser] = useState(null);
    const [userDialogOpen, setUserDialogOpen] = useState(false);
    const [userDialogMode, setUserDialogMode] = useState('create'); // 'create', 'edit', 'resetPassword', 'invite'
    const [newUserData, setNewUserData] = useState({ username: '', email: '', password: '', role: 'user' });


    // Model configuration state for sglang
    const [modelConfig, setModelConfig] = useState({
        maxModelLen: 4096,
        cpuOffloadGb: 0,
        memFractionStatic: 0.88,
        tensorParallelSize: 1,
        maxRunningRequests: 256,
        kvCacheDtype: 'auto',
        trustRemoteCode: true,
        enforceEager: false,
        contextShift: true,
        disableThinking: false,
        compressMemory: false
    });

    // Model configuration state for llama.cpp
    const [llamacppConfig, setLlamacppConfig] = useState({
        nGpuLayers: -1,
        contextSize: 4096,
        contextShift: true,
        flashAttention: false,
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        threads: 0,
        parallelSlots: 1,
        batchSize: 2048,
        ubatchSize: 512,
        repeatPenalty: 1.1,
        repeatLastN: 64,
        presencePenalty: 0.0,
        frequencyPenalty: 0.0,
        disableThinking: false,
        compressMemory: false,
        swaFull: false,
        // Speculative decoding (llama.cpp PR #22673, May 2026).
        //   'none'         — single-stream serial decode (default)
        //   'draft-mtp'    — use this model's built-in MTP heads (DeepSeek-V3/R1,
        //                    Qwen3-Next-MTP, Qwen3.5/3.6-MTP). No second model.
        //   'draft-simple' — classic speculation with a separate smaller draft.
        specType: 'none',
        specDraftNMax: 3,
        specDraftModel: ''
    });

    // Optimal settings state
    const [loadingOptimalSettings, setLoadingOptimalSettings] = useState(false);
    const [optimalSettingsNotes, setOptimalSettingsNotes] = useState([]);
    const [selectedModelForOptimal, setSelectedModelForOptimal] = useState(null);

    // API Keys state
    const [apiKeys, setApiKeys] = useState([]);
    // Pi-setup picker: which bearer key to embed in the install one-liner
    const [piSelectedKeyId, setPiSelectedKeyId] = useState('');
    const [piRevealKey, setPiRevealKey] = useState(false);
    const [newKeyName, setNewKeyName] = useState('');
    const [newKeyPermissions, setNewKeyPermissions] = useState(['query', 'models']);
    // Denylist of skills the new key is forbidden from calling. Empty = allow all.
    const [newKeyDisabledSkills, setNewKeyDisabledSkills] = useState([]);
    const [newKeyRateLimitRequests, setNewKeyRateLimitRequests] = useState(60);
    const [newKeyRateLimitTokens, setNewKeyRateLimitTokens] = useState(100000);
    const [noRateLimit, setNoRateLimit] = useState(false);
    const [noTokenLimit, setNoTokenLimit] = useState(false);
    const [bearerOnly, setBearerOnly] = useState(false);
    const [showCreateKeyDialog, setShowCreateKeyDialog] = useState(false);
    const [createdKeyData, setCreatedKeyData] = useState(null);
    const [showSecrets, setShowSecrets] = useState({});
    const [showCreatedSecret, setShowCreatedSecret] = useState(false);
    const [editingKey, setEditingKey] = useState(null);
    const [editKeyName, setEditKeyName] = useState('');
    const [editKeyPermissions, setEditKeyPermissions] = useState([]);
    const [editKeyDisabledSkills, setEditKeyDisabledSkills] = useState([]);
    const [editKeyRateLimitRequests, setEditKeyRateLimitRequests] = useState(60);
    const [editKeyRateLimitTokens, setEditKeyRateLimitTokens] = useState(100000);
    const [editNoRateLimit, setEditNoRateLimit] = useState(false);
    const [editNoTokenLimit, setEditNoTokenLimit] = useState(false);

    // Download management state
    const [activeDownloads, setActiveDownloads] = useState([]);

    // Apps management state
    const [apps, setApps] = useState([]);
    const [selectedApp, setSelectedApp] = useState(null);

    // Agents state
    const [agents, setAgents] = useState([]);
    const [agentDialogOpen, setAgentDialogOpen] = useState(false);
    const [editingAgent, setEditingAgent] = useState(null);
    const [agentFormData, setAgentFormData] = useState({
        name: '',
        description: '',
        modelName: '',
        systemPrompt: '',
        skills: []
    });

    // Skills state
    const [skills, setSkills] = useState([]);
    const [skillDialogOpen, setSkillDialogOpen] = useState(false);
    const [editingSkill, setEditingSkill] = useState(null);
    const [skillFormData, setSkillFormData] = useState({
        name: '',
        description: '',
        type: 'tool',
        parameters: {},
        code: '',
        systemPrompt: ''
    });

    // Markdown Skills state — instructional .md files the LLM consults
    // via the `load_skill` tool. NOT executable.
    const [mdSkills, setMdSkills] = useState([]);
    const [mdSkillDialogOpen, setMdSkillDialogOpen] = useState(false);
    const [editingMdSkill, setEditingMdSkill] = useState(null);
    const [mdSkillFormData, setMdSkillFormData] = useState({
        name: '',
        description: '',
        triggers: '',
        body: '',
    });

    // Tasks state
    const [tasks, setTasks] = useState([]);
    const [taskDialogOpen, setTaskDialogOpen] = useState(false);
    const [taskFormData, setTaskFormData] = useState({
        agentId: '',
        description: '',
        priority: 'medium'
    });

    // Agent sub-tab state
    const [agentSubTab, setAgentSubTab] = useState(0);

    // Tools sub-tab UI state (search/filter)
    const [toolsSearchQuery, setToolsSearchQuery] = useState('');
    const [toolsEnabledFilter, setToolsEnabledFilter] = useState('all'); // all | enabled | disabled
    const [toolsTypeFilter, setToolsTypeFilter] = useState('all'); // 'all' or specific type
    // Tools Library opens collapsed — the catalog is long enough that the
    // tab landed on a wall of cards; collapsing keeps the page scannable
    // and the user opts in when they actually want to browse.
    const [toolsLibraryExpanded, setToolsLibraryExpanded] = useState(false);

    // Skills sub-tab UI state (search/filter)
    const [skillsSearchQuery, setSkillsSearchQuery] = useState('');
    const [skillsEnabledFilter, setSkillsEnabledFilter] = useState('all'); // all | enabled | disabled
    // Skills Library: same collapsed-by-default behavior as Tools — both
    // sub-tabs render long catalogs that smother the page on first visit.
    const [skillsLibraryExpanded, setSkillsLibraryExpanded] = useState(false);

    // System reset state
    const [resetDialogOpen, setResetDialogOpen] = useState(false);
    const [resetConfirmation, setResetConfirmation] = useState('');
    const [resetChecked, setResetChecked] = useState(false);

    // Tab order state
    const [tabOrder, setTabOrder] = useState(() => {
        const defaultOrder = [0, 1, 2, 3, 4, 5, 6, 7];
        try {
            const saved = localStorage.getItem('tabOrder');
            if (saved) {
                let parsed = JSON.parse(saved);
                // Migrate older saved orders that predate a tab being added:
                // append any missing default tab IDs (preserving the user's
                // existing arrangement) instead of discarding their layout.
                // This covers the 7→8 tab bump (Agent tab) and is forward-safe.
                if (Array.isArray(parsed)) {
                    const missing = defaultOrder.filter(id => !parsed.includes(id));
                    if (missing.length) parsed = [...parsed, ...missing];
                    // Drop any stale IDs no longer in the tab set.
                    parsed = parsed.filter(id => defaultOrder.includes(id));
                }
                const hasAllTabs = defaultOrder.every(id => parsed.includes(id));
                if (parsed.length === defaultOrder.length && hasAllTabs) {
                    return parsed;
                }
                // Invalid saved order - clear it
                localStorage.removeItem('tabOrder');
            }
        } catch (e) {
            localStorage.removeItem('tabOrder');
        }
        return defaultOrder;
    });

    // Agent tab — persistent per-agent (Pi/bearer-key) sandbox workspaces.
    const [agentWorkspaces, setAgentWorkspaces] = useState([]);
    const [agentWsLoading, setAgentWsLoading] = useState(false);
    const [agentWsDeleteTarget, setAgentWsDeleteTarget] = useState(null);
    const [agentWsDeleting, setAgentWsDeleting] = useState(false);

    const loadAgentWorkspaces = async () => {
        setAgentWsLoading(true);
        try {
            const res = await fetch('/api/agent-workspaces');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setAgentWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
        } catch (e) {
            setAgentWorkspaces([]);
        } finally {
            setAgentWsLoading(false);
        }
    };

    const confirmDeleteAgentWorkspace = async () => {
        if (!agentWsDeleteTarget) return;
        setAgentWsDeleting(true);
        try {
            const res = await fetch(`/api/agent-workspaces/${encodeURIComponent(agentWsDeleteTarget.bucket)}`, {
                method: 'DELETE',
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || `HTTP ${res.status}`);
            }
            showSnackbar(`Deleted workspace "${agentWsDeleteTarget.label}"`, 'success');
            setAgentWsDeleteTarget(null);
            await loadAgentWorkspaces();
        } catch (e) {
            showSnackbar(`Delete failed: ${e.message}`, 'error');
        } finally {
            setAgentWsDeleting(false);
        }
    };

    // Docs accordion order state
    const [docsAccordionOrder, setDocsAccordionOrder] = useState(() => {
        const saved = localStorage.getItem('docsAccordionOrder');
        return saved ? JSON.parse(saved) : [0, 1, 2, 3, 4, 5];
    });
    // Docs left-rail selection. Single-section disclosure, no MUI Accordion
    // chrome — the previous chevron-driven UI had been polished repeatedly
    // and still felt accordion-y; left rail nav is a fundamentally different
    // affordance.
    const [activeDocSection, setActiveDocSection] = useState(() => {
        const saved = localStorage.getItem('docsActiveSection');
        // api-permissions was folded into api-endpoints — redirect any
        // stale-localStorage users so they don't land on a missing section.
        if (saved === 'api-permissions') return 'api-endpoints';
        return saved || 'quick-start';
    });
    useEffect(() => {
        try { localStorage.setItem('docsActiveSection', activeDocSection); } catch (_) {}
    }, [activeDocSection]);

    // API Builder state
    const [apiBuilderEndpoint, setApiBuilderEndpoint] = useState('/api/chat');
    const [apiBuilderLang, setApiBuilderLang] = useState('curl');
    const [apiBuilderAuthType, setApiBuilderAuthType] = useState('bearer');

    // Refs
    const logsEndRef = useRef(null);
    const logsContainerRef = useRef(null);
    const wsRef = useRef(null);
    const isUserNearBottomRef = useRef(true);
    // Incoming log lines are accumulated here and flushed to React state
    // on a short interval. Without this buffer, a model startup emitting
    // 100+ log lines/sec triggers a full re-render + auto-scroll + localStorage
    // write per line, which visibly "spazzes" the logs pane.
    const logBufferRef = useRef([]);

    // Dynamic base URLs from current host
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port || '3001';
    const baseUrl = `${protocol}//${hostname}:${port}`;

    const showSnackbar = (message, severity) => {
        setSnackbarMessage(message);
        setSnackbarSeverity(severity);
        setSnackbarOpen(true);
    };

    const checkIfNearBottom = () => {
        const container = logsContainerRef.current;
        if (!container) return true;
        const threshold = 100;
        return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    };

    const handleLogsScroll = () => {
        isUserNearBottomRef.current = checkIfNearBottom();
    };

    const scrollToBottom = () => {
        if (isUserNearBottomRef.current) {
            // 'auto' (instant) avoids animation queueing when many log lines
            // arrive in quick succession — 'smooth' fights itself and stutters.
            logsEndRef.current?.scrollIntoView({ behavior: "auto" });
        }
    };

    // Flush the incoming log buffer into state on a fixed interval so we
    // re-render at most ~6 times/sec even when the WebSocket is firehosing
    // lines during model startup.
    useEffect(() => {
        const flushId = setInterval(() => {
            if (logBufferRef.current.length === 0) return;
            const batch = logBufferRef.current;
            logBufferRef.current = [];
            setLogs(prev => [...prev, ...batch]);
        }, 150);
        return () => clearInterval(flushId);
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [logs]);

    // Persist logs to localStorage on a 2s debounce instead of on every
    // state change — JSON.stringify of 500 entries was running on every
    // log arrival and blocking the main thread.
    useEffect(() => {
        const saveId = setTimeout(() => {
            try {
                localStorage.setItem('modelserver_logs', JSON.stringify(logs.slice(-500)));
            } catch (error) {
                console.error('Failed to save logs to localStorage:', error);
            }
        }, 2000);
        return () => clearTimeout(saveId);
    }, [logs]);

    // Reset search page when sort/size filters change
    useEffect(() => {
        setSearchPage(1);
    }, [searchSortBy, searchSizeFilter, searchFormat]);

    // Fetch users when Users tab is selected
    // Note: Using tabOrder here instead of visibleTabOrder since this runs early in component
    // and visibleTabOrder is derived later. The check is still valid because we also check admin role.
    useEffect(() => {
        if (tabOrder[activeTab] === 2 && user?.role === 'admin') {
            fetchUsers();
        }
    }, [activeTab, user?.role, tabOrder]);

    // Refresh agent workspaces whenever the Agent tab is opened.
    useEffect(() => {
        if (tabOrder[activeTab] === 7) {
            loadAgentWorkspaces();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, tabOrder]);

    // Hydrate UI preferences (theme/accent/bubble/density) from the
    // server on mount. The store applies them to <html>/<body> so chat's
    // CSS variables resolve. Runs once; subsequent updates are pushed
    // back to the server by the store itself.
    useEffect(() => {
        usePreferencesStore.getState().hydrate();
    }, []);

    // Initial data fetch and WebSocket setup
    useEffect(() => {
        fetchModels();
        fetchInstances();
        fetchApiKeys();
        fetchDownloads();
        fetchApps();
        fetchHfCache();
        fetchAgents();
        fetchSkills();
        fetchMdSkills();
        fetchTasks();

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = window.location.hostname;
        const wsPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
        const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}`;

        let reconnectTimeout = null;
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 20;
        let intentionalClose = false;

        const connectWs = () => {
            const client = new WebSocket(wsUrl);
            wsRef.current = client;

            client.onopen = () => {
                setWsConnected(true);
                if (reconnectAttempts > 0) {
                    showSnackbar('Reconnected to backend', 'success');
                } else {
                    showSnackbar('Connected to backend', 'success');
                }
                reconnectAttempts = 0;
            };

            client.onmessage = (message) => {
                try {
                    const data = JSON.parse(message.data);
                    if (data.type === 'log') {
                        let msg = data.message.trim();
                        // Strip Docker container timestamps from message content
                        // These appear as "X2026-03-20T21:30:01.179Z text" where X is a stray char
                        let dockerTime = null;
                        const tsClean = msg.match(/^(.{0,2}?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s*/);
                        if (tsClean) {
                            dockerTime = new Date(tsClean[2]);
                            msg = msg.slice(tsClean[0].length);
                        }
                        // Auto-detect level from message content if not provided
                        let level = data.level || 'info';
                        if (!data.level) {
                            const lower = msg.toLowerCase();
                            if (lower.includes('error') || lower.includes('failed') || lower.includes('fatal') || lower.startsWith('error:')) level = 'error';
                            else if (lower.includes('warning') || lower.includes('⚠️') || lower.includes('warn')) level = 'warning';
                            else if (lower.includes('✓') || lower.includes('success') || lower.includes('complete') || lower.includes('ready') || lower.includes('started') || lower.includes('running')) level = 'success';
                        }
                        // Push to the ref-backed buffer; the flush interval
                        // above drains it into React state on a throttle.
                        logBufferRef.current.push({
                            message: msg,
                            level: level,
                            timestamp: dockerTime ? dockerTime.getTime() : Date.now()
                        });
                    } else if (data.type === 'status') {
                        // load_failed carries `error` + remediation; surface it
                        // prominently and prefill the HF load dialog with the
                        // KV-cache-suggested max_model_len so retrying is one
                        // click away.
                        if (data.status === 'load_failed' && data.error) {
                            showSnackbar(data.error, 'error');
                            if (typeof data.suggestedMaxModelLen === 'number') {
                                setHfLoadConfig(c => ({ ...c, maxModelLen: data.suggestedMaxModelLen }));
                            }
                        } else {
                            const msg = data.message || data.error || 'Status update';
                            const severity = data.level === 'error' ? 'error' :
                                             data.level === 'success' ? 'success' :
                                             msg.toLowerCase().includes('error') ? 'error' : 'success';
                            showSnackbar(msg, severity);
                        }
                        fetchModels();
                        fetchInstances();
                        setLoading(false);
                    } else if (data.type === 'download_started') {
                        fetchDownloads();
                        showSnackbar(`Download started: ${data.modelName}`, 'info');
                    } else if (data.type === 'system_stats') {
                        // Push into a bounded ring buffer. The resource panel
                        // reads from this state to draw sparklines; logs stay
                        // untouched.
                        setSystemStats(data);
                        setSystemStatsHistory(prev => {
                            const next = [...prev, data];
                            // Keep last 120 samples (~6 minutes at 3s interval)
                            return next.length > 120 ? next.slice(next.length - 120) : next;
                        });
                    } else if (data.type === 'download_progress') {
                        setActiveDownloads(prev => prev.map(d =>
                            d.downloadId === data.downloadId
                                ? {
                                    ...d,
                                    progress: data.progress ?? d.progress,
                                    overallPct: data.overallPct ?? d.overallPct,
                                    overallDownloaded: data.overallDownloaded ?? d.overallDownloaded,
                                    overallTotal: data.overallTotal ?? d.overallTotal,
                                    fileIndex: data.fileIndex ?? d.fileIndex,
                                    fileTotal: data.fileTotal ?? d.fileTotal,
                                    fileName: data.fileName ?? d.fileName,
                                    filePct: data.filePct ?? d.filePct,
                                    fileDownloaded: data.fileDownloaded ?? d.fileDownloaded,
                                    fileSize: data.fileSize ?? d.fileSize,
                                    speed: data.speed ?? d.speed,
                                    eta: data.eta ?? d.eta
                                }
                                : d
                        ));
                    } else if (data.type === 'download_finished') {
                        fetchDownloads();
                        fetchModels();
                        if (data.success) {
                            showSnackbar(data.message, 'success');
                        } else {
                            showSnackbar(data.message, 'error');
                        }
                    } else if (data.type === 'download_cancelled') {
                        fetchDownloads();
                        showSnackbar(data.message, 'warning');
                    } else if (data.type === 'download_removed') {
                        setActiveDownloads(prev => prev.filter(d => d.downloadId !== data.downloadId));
                    } else if (data.type === 'service_status_changed') {
                        fetchApps();
                    }
                } catch (error) {
                    console.error('Error processing WebSocket message:', error);
                }
            };

            client.onclose = () => {
                setWsConnected(false);
                if (!intentionalClose && reconnectAttempts < maxReconnectAttempts) {
                    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
                    reconnectAttempts++;
                    reconnectTimeout = setTimeout(connectWs, delay);
                }
            };

            client.onerror = () => {
                // onclose will fire after onerror, reconnection handled there
            };
        };

        connectWs();

        return () => {
            intentionalClose = true;
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.close();
            }
        };
    }, []);

    // Data fetching functions
    const fetchModels = () => {
        fetch('/api/models', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setModels(data))
            .catch(error => showSnackbar(`Failed to fetch models: ${error.message}`, 'error'));
    };

    const fetchInstances = async () => {
        try {
            const [llamacppRes, sglangRes] = await Promise.allSettled([
                fetch('/api/llamacpp/instances', { credentials: 'include' }),
                fetch('/api/sglang/instances', { credentials: 'include' }),
            ]);

            const allInstances = [];

            // Parse llama.cpp instances
            if (llamacppRes.status === 'fulfilled' && llamacppRes.value.ok) {
                const llamacppData = await llamacppRes.value.json();
                const llamacppInstances = Array.isArray(llamacppData) ? llamacppData : (llamacppData.instances || []);
                allInstances.push(...llamacppInstances);
            }

            // Parse sglang instances
            if (sglangRes.status === 'fulfilled' && sglangRes.value.ok) {
                const sglangData = await sglangRes.value.json();
                const sglangInstances = Array.isArray(sglangData) ? sglangData : (sglangData.instances || []);
                allInstances.push(...sglangInstances);
            }

            setInstances(allInstances);
        } catch (error) {
            console.error('Error fetching instances:', error);
        }
    };

    const fetchApiKeys = () => {
        fetch('/api/api-keys', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setApiKeys(data))
            .catch(error => console.error('Error fetching API keys:', error));
    };

    const fetchDownloads = () => {
        fetch('/api/downloads', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setActiveDownloads(data))
            .catch(error => console.error('Error fetching downloads:', error));
    };

    const fetchApps = () => {
        fetch('/api/apps', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setApps(data))
            .catch(error => console.error('Error fetching apps:', error));
    };

    const fetchAgents = () => {
        fetch('/api/agents', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setAgents(data))
            .catch(error => console.error('Error fetching agents:', error));
    };

    const fetchSkills = () => {
        fetch('/api/skills', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setSkills(data))
            .catch(error => console.error('Error fetching skills:', error));
    };

    const fetchMdSkills = () => {
        fetch('/api/markdown-skills', { credentials: 'include' })
            .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then(data => setMdSkills(Array.isArray(data) ? data : []))
            .catch(error => console.error('Error fetching markdown skills:', error));
    };

    const openMdSkillEditor = async (skill) => {
        if (!skill) {
            setEditingMdSkill(null);
            setMdSkillFormData({ name: '', description: '', triggers: '', body: '' });
            setMdSkillDialogOpen(true);
            return;
        }
        try {
            const res = await fetch(`/api/markdown-skills/${skill.id}`, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const full = await res.json();
            setEditingMdSkill(full);
            setMdSkillFormData({
                name: full.name || '',
                description: full.description || '',
                triggers: full.triggers || '',
                body: full.body || '',
            });
            setMdSkillDialogOpen(true);
        } catch (e) {
            showSnackbar(`Failed to load skill: ${e.message}`, 'error');
        }
    };

    const handleSaveMdSkill = async () => {
        const payload = {
            name: mdSkillFormData.name,
            description: mdSkillFormData.description,
            triggers: mdSkillFormData.triggers,
            body: mdSkillFormData.body,
        };
        try {
            const isEdit = !!editingMdSkill;
            const url = isEdit
                ? `/api/markdown-skills/${editingMdSkill.id}`
                : '/api/markdown-skills';
            const res = await fetch(url, {
                method: isEdit ? 'PUT' : 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            showSnackbar(isEdit ? 'Skill updated' : 'Skill created', 'success');
            setMdSkillDialogOpen(false);
            setEditingMdSkill(null);
            fetchMdSkills();
        } catch (e) {
            showSnackbar(`Failed to save skill: ${e.message}`, 'error');
        }
    };

    const handleDeleteMdSkill = async (skill) => {
        if (!window.confirm(`Delete skill "${skill.name}"?`)) return;
        try {
            const res = await fetch(`/api/markdown-skills/${skill.id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            showSnackbar('Skill deleted', 'success');
            fetchMdSkills();
        } catch (e) {
            showSnackbar(`Failed to delete skill: ${e.message}`, 'error');
        }
    };

    // Flip a markdown skill's enabled flag via PUT. Disabled skills
    // vanish from the chat model's load_skill catalog, mirroring the
    // Tools on/off toggle behavior.
    const handleToggleMdSkill = async (skill, nextEnabled) => {
        try {
            const res = await fetch(`/api/markdown-skills/${skill.id}`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: nextEnabled }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            showSnackbar(nextEnabled ? 'Skill enabled' : 'Skill disabled', 'success');
            fetchMdSkills();
        } catch (e) {
            showSnackbar(`Failed to update skill: ${e.message}`, 'error');
        }
    };

    const fetchTasks = () => {
        fetch('/api/tasks', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setTasks(data))
            .catch(error => console.error('Error fetching tasks:', error));
    };

    // API Key handlers
    const handleCreateApiKey = () => {
        if (!newKeyName.trim()) {
            showSnackbar('Please provide a name for the API key', 'warning');
            return;
        }

        fetch('/api/api-keys', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: newKeyName,
                permissions: newKeyPermissions,
                // Denylist semantics — empty = all skills allowed.
                disabledSkills: newKeyDisabledSkills || [],
                rateLimitRequests: noRateLimit ? null : newKeyRateLimitRequests,
                rateLimitTokens: noTokenLimit ? null : newKeyRateLimitTokens,
                bearerOnly: bearerOnly
            }),
        })
        .then(res => res.json())
        .then(data => {
            setCreatedKeyData(data);
            setNewKeyName('');
            setNewKeyPermissions(['query', 'models']);
            setNewKeyDisabledSkills([]);
            setNewKeyRateLimitRequests(60);
            setNewKeyRateLimitTokens(100000);
            setNoRateLimit(false);
            setNoTokenLimit(false);
            setBearerOnly(false);
            fetchApiKeys();
            showSnackbar('API key created successfully', 'success');
        })
        .catch(error => showSnackbar(`Failed to create API key: ${error.message}`, 'error'));
    };

    const handleDeleteApiKey = (id, name) => {
        if (!confirm(`Are you sure you want to delete the API key "${name}"?`)) {
            return;
        }

        fetch(`/api/api-keys/${id}`, {
            method: 'DELETE',
        })
        .then(res => res.json())
        .then(() => {
            fetchApiKeys();
            showSnackbar('API key deleted', 'success');
        })
        .catch(error => showSnackbar(`Failed to delete API key: ${error.message}`, 'error'));
    };

    const handleRevokeApiKey = (id, name) => {
        if (!confirm(`Are you sure you want to revoke the API key "${name}"?`)) {
            return;
        }

        fetch(`/api/api-keys/${id}/revoke`, {
            method: 'POST',
        })
        .then(res => res.json())
        .then(() => {
            fetchApiKeys();
            showSnackbar('API key revoked', 'success');
        })
        .catch(error => showSnackbar(`Failed to revoke API key: ${error.message}`, 'error'));
    };

    const handleToggleApiKeyActive = (id, currentActive) => {
        fetch(`/api/api-keys/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !currentActive })
        })
        .then(res => res.json())
        .then(() => {
            fetchApiKeys();
            showSnackbar(`API key ${currentActive ? 'deactivated' : 'activated'}`, 'success');
        })
        .catch(error => showSnackbar(`Failed to update API key: ${error.message}`, 'error'));
    };

    const handleClearApiKeyUsage = (id, name) => {
        fetch(`/api/api-keys/${id}/clear-usage`, {
            method: 'POST',
        })
        .then(res => res.json())
        .then(() => {
            fetchApiKeys();
            showSnackbar(`Token usage cleared for "${name}"`, 'success');
        })
        .catch(error => showSnackbar(`Failed to clear usage: ${error.message}`, 'error'));
    };

    const handleStartEditApiKey = (key) => {
        setEditingKey(key);
        setEditKeyName(key.name);
        setEditKeyPermissions(key.permissions || []);
        setEditKeyDisabledSkills(Array.isArray(key.disabledSkills) ? key.disabledSkills : []);
        setEditKeyRateLimitRequests(key.rateLimitRequests || 60);
        setEditKeyRateLimitTokens(key.rateLimitTokens || 100000);
        setEditNoRateLimit(key.rateLimitRequests === null);
        setEditNoTokenLimit(key.rateLimitTokens === null);
    };

    const handleUpdateApiKey = () => {
        if (!editingKey || !editKeyName.trim()) {
            showSnackbar('Please provide a name for the API key', 'warning');
            return;
        }

        fetch(`/api/api-keys/${editingKey.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: editKeyName,
                permissions: editKeyPermissions,
                // Denylist semantics — empty = all skills allowed.
                disabledSkills: editKeyDisabledSkills || [],
                // Clear any legacy whitelist when the user edits through the
                // new UI; otherwise an old allowedSkills:[non-empty] would keep
                // overriding the new disabledSkills picker.
                allowedSkills: null,
                rateLimitRequests: editNoRateLimit ? null : editKeyRateLimitRequests,
                rateLimitTokens: editNoTokenLimit ? null : editKeyRateLimitTokens
            }),
        })
        .then(res => res.json())
        .then(() => {
            setEditingKey(null);
            fetchApiKeys();
            showSnackbar('API key updated successfully', 'success');
        })
        .catch(error => showSnackbar(`Failed to update API key: ${error.message}`, 'error'));
    };

    const copyToClipboard = (text) => {
        // Check if clipboard API is available (requires secure context)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                showSnackbar('Copied to clipboard', 'success');
            }).catch(() => {
                showSnackbar('Failed to copy', 'error');
            });
        } else {
            // Fallback for non-secure contexts (HTTP)
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-9999px';
            textArea.style.top = '-9999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                showSnackbar('Copied to clipboard', 'success');
            } catch (err) {
                showSnackbar('Failed to copy - please copy manually', 'error');
            }
            document.body.removeChild(textArea);
        }
    };

    // API Builder code generator
    const getApiBuilderCode = () => {
        const endpoint = apiBuilderEndpoint || '/api/chat';
        const lang = apiBuilderLang || 'curl';

        const examples = {
            '/api/chat': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/chat \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Explain quantum computing"
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/chat \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Explain quantum computing"
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/chat',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'message': 'Explain quantum computing'
    },
    verify=False  # For self-signed certificates
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/chat',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'message': 'Explain quantum computing'
    },
    verify=False  # For self-signed certificates
)

result = response.json()
print(result['response'])`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    message = "Explain quantum computing"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/chat" -Method Post -Headers $headers -Body $body
Write-Output $response.response`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/chat', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: 'Explain quantum computing'
  })
})
.then(res => res.json())
.then(data => console.log(data.response))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/chat', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: 'Explain quantum computing'
  })
})
.then(res => res.json())
.then(data => console.log(data.response))
.catch(err => console.error(err));`
            },
            '/api/complete': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/complete \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "The capital of France is"
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/complete \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "The capital of France is"
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/complete',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'prompt': 'The capital of France is'
    },
    verify=False  # For self-signed certificates
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/complete',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'prompt': 'The capital of France is'
    },
    verify=False  # For self-signed certificates
)

result = response.json()
print(result['completion'])`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    prompt = "The capital of France is"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/complete" -Method Post -Headers $headers -Body $body
Write-Output $response.completion`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/complete', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: 'The capital of France is'
  })
})
.then(res => res.json())
.then(data => console.log(data.completion))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/complete', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: 'The capital of France is'
  })
})
.then(res => res.json())
.then(data => console.log(data.completion))
.catch(err => console.error(err));`
            },
            '/api/models': {
                curl: `# Bearer Token Authentication
curl -k -X GET ${baseUrl}/api/models \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/models \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/models',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    },
    verify=False  # For self-signed certificates
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/models',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False  # For self-signed certificates
)

models = response.json()
for model in models:
    print(f"{model['name']}: {model['status']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/models" -Method Get -Headers $headers
$response | ForEach-Object { Write-Output "$($_.name): $($_.status)" }`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/models', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer your_bearer_token'
  }
})
.then(res => res.json())
.then(models => models.forEach(m => console.log(\`\${m.name}: \${m.status}\`)))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/models', {
  method: 'GET',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(models => models.forEach(m => console.log(\`\${m.name}: \${m.status}\`)))
.catch(err => console.error(err));`
            },
            '/api/models/pull': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/models/pull \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "ggufRepo": "TheBloke/Llama-2-7B-GGUF",
    "ggufFile": "llama-2-7b.Q4_K_M.gguf"
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/models/pull \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "ggufRepo": "TheBloke/Llama-2-7B-GGUF",
    "ggufFile": "llama-2-7b.Q4_K_M.gguf"
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/models/pull',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'ggufRepo': 'TheBloke/Llama-2-7B-GGUF',
        'ggufFile': 'llama-2-7b.Q4_K_M.gguf'
    },
    verify=False  # For self-signed certificates
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/models/pull',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'ggufRepo': 'TheBloke/Llama-2-7B-GGUF',
        'ggufFile': 'llama-2-7b.Q4_K_M.gguf'
    },
    verify=False  # For self-signed certificates
)

result = response.json()
print(result['message'])`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    ggufRepo = "TheBloke/Llama-2-7B-GGUF"
    ggufFile = "llama-2-7b.Q4_K_M.gguf"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/models/pull" -Method Post -Headers $headers -Body $body
Write-Output $response.message`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/models/pull', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    ggufRepo: 'TheBloke/Llama-2-7B-GGUF',
    ggufFile: 'llama-2-7b.Q4_K_M.gguf'
  })
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/models/pull', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    ggufRepo: 'TheBloke/Llama-2-7B-GGUF',
    ggufFile: 'llama-2-7b.Q4_K_M.gguf'
  })
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));`
            },
            '/api/models/:name/load': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/models/Llama-2-7B-GGUF/load \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "maxModelLen": 4096,
    "cpuOffloadGb": 0,
    "memFractionStatic": 0.88,
    "tensorParallelSize": 1,
    "maxRunningRequests": 256,
    "compressMemory": true
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/models/Llama-2-7B-GGUF/load \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "maxModelLen": 4096,
    "cpuOffloadGb": 0,
    "memFractionStatic": 0.88,
    "tensorParallelSize": 1,
    "maxRunningRequests": 256,
    "compressMemory": true
  }'

# compressMemory: Enable AIMem memory compression for long conversations
# Compresses older messages using dedup + lossy + relevance gating (~48% token reduction)`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/models/Llama-2-7B-GGUF/load',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'maxModelLen': 4096,
        'cpuOffloadGb': 0,
        'memFractionStatic': 0.88,
        'tensorParallelSize': 1,
        'maxRunningRequests': 256
    },
    verify=False  # For self-signed certificates
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/models/Llama-2-7B-GGUF/load',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'maxModelLen': 4096,
        'cpuOffloadGb': 0,
        'memFractionStatic': 0.88,
        'tensorParallelSize': 1,
        'maxRunningRequests': 256
    },
    verify=False  # For self-signed certificates
)

result = response.json()
print(f"Model loaded on port {result['port']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    maxModelLen = 4096
    cpuOffloadGb = 0
    memFractionStatic = 0.88
    tensorParallelSize = 1
    maxRunningRequests = 256
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/models/Llama-2-7B-GGUF/load" -Method Post -Headers $headers -Body $body
Write-Output "Model loaded on port $($response.port)"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/models/Llama-2-7B-GGUF/load', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    maxModelLen: 4096,
    cpuOffloadGb: 0,
    memFractionStatic: 0.88,
    tensorParallelSize: 1,
    maxRunningRequests: 256
  })
})
.then(res => res.json())
.then(data => console.log(\`Model loaded on port \${data.port}\`))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/models/Llama-2-7B-GGUF/load', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    maxModelLen: 4096,
    cpuOffloadGb: 0,
    memFractionStatic: 0.88,
    tensorParallelSize: 1,
    maxRunningRequests: 256
  })
})
.then(res => res.json())
.then(data => console.log(\`Model loaded on port \${data.port}\`))
.catch(err => console.error(err));`
            },
            '/api/models/:name': {
                curl: `# Bearer Token Authentication
curl -X DELETE ${baseUrl}/api/models/Llama-2-7B-GGUF \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -X DELETE ${baseUrl}/api/models/Llama-2-7B-GGUF \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.delete(
    '${baseUrl}/api/models/Llama-2-7B-GGUF',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    }
)

# OR API Key + Secret Authentication
response = requests.delete(
    '${baseUrl}/api/models/Llama-2-7B-GGUF',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    }
)

result = response.json()
print(result['message'])`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/models/Llama-2-7B-GGUF" -Method Delete -Headers $headers
Write-Output $response.message`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/models/Llama-2-7B-GGUF', {
  method: 'DELETE',
  headers: {
    'Authorization': 'Bearer your_bearer_token'
  }
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/models/Llama-2-7B-GGUF', {
  method: 'DELETE',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));`
            },
            '/api/sglang/instances': {
                curl: `# Bearer Token Authentication
curl -X GET ${baseUrl}/api/sglang/instances \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -X GET ${baseUrl}/api/sglang/instances \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/sglang/instances',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    }
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/sglang/instances',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    }
)

instances = response.json()
for instance in instances:
    print(f"{instance['name']}: {instance['status']} on port {instance['port']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/sglang/instances" -Method Get -Headers $headers
$response | ForEach-Object { Write-Output "$($_.name): $($_.status) on port $($_.port)" }`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/sglang/instances', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer your_bearer_token'
  }
})
.then(res => res.json())
.then(instances => instances.forEach(i => console.log(\`\${i.name}: \${i.status} on port \${i.port}\`)))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/sglang/instances', {
  method: 'GET',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(instances => instances.forEach(i => console.log(\`\${i.name}: \${i.status} on port \${i.port}\`)))
.catch(err => console.error(err));`
            },
            '/api/sglang/instances/:name': {
                curl: `# Bearer Token Authentication
curl -X DELETE ${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -X DELETE ${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.delete(
    '${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    }
)

# OR API Key + Secret Authentication
response = requests.delete(
    '${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    }
)

result = response.json()
print(result['message'])`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF" -Method Delete -Headers $headers
Write-Output $response.message`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF', {
  method: 'DELETE',
  headers: {
    'Authorization': 'Bearer your_bearer_token'
  }
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/sglang/instances/Llama-2-7B-GGUF', {
  method: 'DELETE',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // STREAMING CHAT
            // ============================================================================
            '/api/chat/stream': {
                curl: `# Streaming Chat with Server-Sent Events
# Bearer Token Authentication
curl -k -N -X POST ${baseUrl}/api/chat/stream \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Write a short poem about coding",
    "maxTokens": 500
  }'

# OR API Key + Secret Authentication
curl -k -N -X POST ${baseUrl}/api/chat/stream \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Write a short poem about coding",
    "maxTokens": 500
  }'

# With Map-Reduce Chunking for Large Content
# chunkingStrategy options: "auto" (default), "map-reduce", "truncate", "none"
curl -k -N -X POST ${baseUrl}/api/chat/stream \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [
      {"role": "user", "content": "Analyze this large document..."}
    ],
    "maxTokens": 2000,
    "chunkingStrategy": "map-reduce"
  }'

# SSE Events for Map-Reduce:
# - {"type":"chunking_progress","phase":"chunking","message":"Splitting..."}
# - {"type":"chunking_progress","phase":"map","currentChunk":1,"totalChunks":3}
# - {"type":"chunking_progress","phase":"reduce","message":"Synthesizing..."}
# - {"done":true,"mapReduce":{"enabled":true,"chunkCount":3,"synthesized":true}}
#
# AIMem Compression (when compressMemory enabled on model instance):
# Final event includes: {"aimem":{"compressed":true,"tokensSaved":N,"reductionPct":N}}`,
                python: `import requests
import json

# Streaming Chat - Process tokens as they arrive
def stream_chat(message, bearer_token, chunking_strategy='auto'):
    response = requests.post(
        '${baseUrl}/api/chat/stream',
        headers={
            'Authorization': f'Bearer {bearer_token}',
            'Content-Type': 'application/json'
        },
        json={
            'message': message,
            'maxTokens': 500,
            'chunkingStrategy': chunking_strategy  # 'auto', 'map-reduce', 'truncate', 'none'
        },
        stream=True,
        verify=False
    )

    for line in response.iter_lines():
        if line:
            line = line.decode('utf-8')
            if line.startswith('data: '):
                data = line[6:]  # Remove 'data: ' prefix
                if data == '[DONE]':
                    break
                chunk = json.loads(data)

                # Handle map-reduce progress events
                if chunk.get('type') == 'chunking_progress':
                    phase = chunk.get('phase')
                    msg = chunk.get('message', '')
                    print(f'[{phase}] {msg}')
                    continue

                # Handle map-reduce completion info
                if chunk.get('mapReduce', {}).get('enabled'):
                    mr = chunk['mapReduce']
                    print(f'\\n[Processed {mr["chunkCount"]} chunks, synthesized={mr["synthesized"]}]')

                # Handle content tokens
                delta = chunk.get('choices', [{}])[0].get('delta', {})
                if delta.get('content'):
                    print(delta['content'], end='', flush=True)
    print()  # Final newline

stream_chat('Write a short poem about coding', 'your_bearer_token')`,
                powershell: `# PowerShell doesn't handle SSE natively well
# Use the non-streaming /api/chat endpoint instead
# Or use Python/JavaScript for streaming

$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{
    message = "Write a short poem about coding"
    maxTokens = 500
} | ConvertTo-Json

# Non-streaming alternative
$response = Invoke-RestMethod -Uri "${baseUrl}/api/chat" -Method Post -Headers $headers -Body $body
Write-Output $response.response`,
                javascript: `// Streaming Chat with EventSource-like handling
async function streamChat(message, bearerToken, chunkingStrategy = 'auto') {
  const response = await fetch('${baseUrl}/api/chat/stream', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${bearerToken}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: message,
      maxTokens: 500,
      chunkingStrategy: chunkingStrategy  // 'auto', 'map-reduce', 'truncate', 'none'
    })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);

          // Handle map-reduce progress events
          if (parsed.type === 'chunking_progress') {
            console.log(\`[Map-Reduce] \${parsed.phase}: \${parsed.message || ''}\`);
            continue;
          }

          // Handle map-reduce completion info
          if (parsed.mapReduce?.enabled) {
            const mr = parsed.mapReduce;
            console.log(\`[Processed \${mr.chunkCount} chunks, synthesized=\${mr.synthesized}]\`);
          }

          // Handle content tokens
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            process.stdout.write(content); // Node.js
            // Or: document.body.innerHTML += content; // Browser
            fullResponse += content;
          }
        } catch (e) {}
      }
    }
  }
  console.log('\\nFull response:', fullResponse);
}

streamChat('Write a short poem about coding', 'your_bearer_token');`
            },
            // ============================================================================
            // AUTHENTICATION
            // ============================================================================
            '/api/auth/has-users': {
                curl: `# Check if any users exist (for first admin setup)
curl -k -X GET ${baseUrl}/api/auth/has-users`,
                python: `import requests

response = requests.get(
    '${baseUrl}/api/auth/has-users',
    verify=False
)

result = response.json()
if result['hasUsers']:
    print("Users exist - registration requires pre-registered email")
else:
    print("No users - first registration becomes admin")`,
                powershell: `$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/has-users" -Method Get
if ($response.hasUsers) {
    Write-Output "Users exist - registration requires pre-registered email"
} else {
    Write-Output "No users - first registration becomes admin"
}`,
                javascript: `fetch('${baseUrl}/api/auth/has-users')
.then(res => res.json())
.then(data => {
  if (data.hasUsers) {
    console.log('Users exist - registration requires pre-registered email');
  } else {
    console.log('No users - first registration becomes admin');
  }
})
.catch(err => console.error(err));`
            },
            '/api/auth/register': {
                curl: `# Register a new user account
# First user becomes admin, subsequent users need pre-registered email
curl -k -X POST ${baseUrl}/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "newuser",
    "email": "user@example.com",
    "password": "securepassword123"
  }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/auth/register',
    json={
        'username': 'newuser',
        'email': 'user@example.com',
        'password': 'securepassword123'
    },
    verify=False
)

result = response.json()
if response.status_code == 201:
    print(f"User created: {result['user']['username']}")
    if result.get('isFirstUser'):
        print("This is the admin account!")
else:
    print(f"Error: {result['error']}")`,
                powershell: `$body = @{
    username = "newuser"
    email = "user@example.com"
    password = "securepassword123"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/register" -Method Post -Body $body -ContentType "application/json"
Write-Output "User created: $($response.user.username)"`,
                javascript: `fetch('${baseUrl}/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'newuser',
    email: 'user@example.com',
    password: 'securepassword123'
  })
})
.then(res => res.json())
.then(data => {
  console.log('User created:', data.user?.username);
  if (data.isFirstUser) console.log('This is the admin account!');
})
.catch(err => console.error(err));`
            },
            '/api/auth/login': {
                curl: `# Login and get session cookie
curl -k -c cookies.txt -X POST ${baseUrl}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "youruser",
    "password": "yourpassword"
  }'`,
                python: `import requests

session = requests.Session()
response = session.post(
    '${baseUrl}/api/auth/login',
    json={
        'username': 'youruser',
        'password': 'yourpassword'
    },
    verify=False
)

if response.status_code == 200:
    print("Login successful!")
    # Session cookies are stored in session object
    # Use session for subsequent requests
    models = session.get('${baseUrl}/api/models', verify=False)
    print(models.json())`,
                powershell: `$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

$body = @{
    username = "youruser"
    password = "yourpassword"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/login" -Method Post -Body $body -ContentType "application/json" -WebSession $session
Write-Output "Login successful!"`,
                javascript: `fetch('${baseUrl}/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',  // Important for session cookies
  body: JSON.stringify({
    username: 'youruser',
    password: 'yourpassword'
  })
})
.then(res => res.json())
.then(data => console.log('Login successful:', data.user?.username))
.catch(err => console.error(err));`
            },
            '/api/auth/reset-password': {
                curl: `# Self-service password reset (requires username, email, current password)
curl -k -X POST ${baseUrl}/api/auth/reset-password \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "youruser",
    "email": "your@email.com",
    "currentPassword": "oldpassword",
    "newPassword": "newpassword123"
  }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/auth/reset-password',
    json={
        'username': 'youruser',
        'email': 'your@email.com',
        'currentPassword': 'oldpassword',
        'newPassword': 'newpassword123'
    },
    verify=False
)

if response.status_code == 200:
    print("Password reset successful!")
else:
    print(f"Error: {response.json()['error']}")`,
                powershell: `$body = @{
    username = "youruser"
    email = "your@email.com"
    currentPassword = "oldpassword"
    newPassword = "newpassword123"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/reset-password" -Method Post -Body $body -ContentType "application/json"
Write-Output "Password reset successful!"`,
                javascript: `fetch('${baseUrl}/api/auth/reset-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'youruser',
    email: 'your@email.com',
    currentPassword: 'oldpassword',
    newPassword: 'newpassword123'
  })
})
.then(res => res.json())
.then(data => console.log(data.success ? 'Password reset!' : data.error))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // USER MANAGEMENT (Admin Only)
            // ============================================================================
            '/api/users/invite': {
                curl: `# Invite user by email (admin only) - creates pending account
# Bearer Token or Session Authentication required
curl -k -X POST ${baseUrl}/api/users/invite \\
  -H "Authorization: Bearer your_admin_token" \\
  -H "Content-Type: application/json" \\
  -d '{ "email": "newuser@example.com" }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/users/invite',
    headers={'Authorization': 'Bearer your_admin_token'},
    json={'email': 'newuser@example.com'},
    verify=False
)

result = response.json()
if response.status_code == 201:
    print(f"Invitation sent to {result['user']['email']}")
else:
    print(f"Error: {result['error']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_admin_token"
}
$body = @{ email = "newuser@example.com" } | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/users/invite" -Method Post -Headers $headers -Body $body -ContentType "application/json"
Write-Output "Invitation sent to $($response.user.email)"`,
                javascript: `fetch('${baseUrl}/api/users/invite', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_admin_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ email: 'newuser@example.com' })
})
.then(res => res.json())
.then(data => console.log('Invitation sent:', data.user?.email))
.catch(err => console.error(err));`
            },
            '/api/users/:id/disable': {
                curl: `# Disable user account (admin only)
curl -k -X PUT ${baseUrl}/api/users/USER_ID_HERE/disable \\
  -H "Authorization: Bearer your_admin_token"`,
                python: `import requests

user_id = "USER_ID_HERE"
response = requests.put(
    f'${baseUrl}/api/users/{user_id}/disable',
    headers={'Authorization': 'Bearer your_admin_token'},
    verify=False
)

result = response.json()
if result.get('success'):
    print(f"User {result['user']['username']} disabled")
else:
    print(f"Error: {result['error']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_admin_token"
}
$userId = "USER_ID_HERE"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/users/$userId/disable" -Method Put -Headers $headers
Write-Output "User $($response.user.username) disabled"`,
                javascript: `const userId = 'USER_ID_HERE';
fetch(\`${baseUrl}/api/users/\${userId}/disable\`, {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer your_admin_token' }
})
.then(res => res.json())
.then(data => console.log('User disabled:', data.user?.username))
.catch(err => console.error(err));`
            },
            '/api/users/:id/enable': {
                curl: `# Enable user account (admin only)
curl -k -X PUT ${baseUrl}/api/users/USER_ID_HERE/enable \\
  -H "Authorization: Bearer your_admin_token"`,
                python: `import requests

user_id = "USER_ID_HERE"
response = requests.put(
    f'${baseUrl}/api/users/{user_id}/enable',
    headers={'Authorization': 'Bearer your_admin_token'},
    verify=False
)

result = response.json()
if result.get('success'):
    print(f"User {result['user']['username']} enabled")
else:
    print(f"Error: {result['error']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_admin_token"
}
$userId = "USER_ID_HERE"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/users/$userId/enable" -Method Put -Headers $headers
Write-Output "User $($response.user.username) enabled"`,
                javascript: `const userId = 'USER_ID_HERE';
fetch(\`${baseUrl}/api/users/\${userId}/enable\`, {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer your_admin_token' }
})
.then(res => res.json())
.then(data => console.log('User enabled:', data.user?.username))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // WEB SEARCH
            // ============================================================================
            '/api/search': {
                curl: `# Bearer Token Authentication
curl -k -G "${baseUrl}/api/search" \\
  -H "Authorization: Bearer your_bearer_token" \\
  --data-urlencode "q=latest AI news" \\
  --data-urlencode "limit=10" \\
  --data-urlencode "fetchContent=true" \\
  --data-urlencode "contentLimit=3"

# OR API Key + Secret Authentication
curl -k -G "${baseUrl}/api/search" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  --data-urlencode "q=latest AI news" \\
  --data-urlencode "limit=10"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/search',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    },
    params={
        'q': 'latest AI news',
        'limit': 10,
        'fetchContent': 'true',
        'contentLimit': 3
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/search',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    params={
        'q': 'latest AI news',
        'limit': 10
    },
    verify=False
)

results = response.json()
print(f"Found {results['count']} results")
for r in results['results']:
    print(f"- {r['title']}: {r['url']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$params = @{
    q = "latest AI news"
    limit = 10
    fetchContent = "true"
    contentLimit = 3
}

$query = ($params.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join "&"
$response = Invoke-RestMethod -Uri "${baseUrl}/api/search?$query" -Headers $headers
Write-Output "Found $($response.count) results"
$response.results | ForEach-Object { Write-Output "- $($_.title): $($_.url)" }`,
                javascript: `// Bearer Token Authentication
const params = new URLSearchParams({
  q: 'latest AI news',
  limit: 10,
  fetchContent: true,
  contentLimit: 3
});

fetch(\`${baseUrl}/api/search?\${params}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => {
  console.log(\`Found \${data.count} results\`);
  data.results.forEach(r => console.log(\`- \${r.title}: \${r.url}\`));
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch(\`${baseUrl}/api/search?\${params}\`, {
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(data => {
  console.log(\`Found \${data.count} results\`);
  data.results.forEach(r => console.log(\`- \${r.title}: \${r.url}\`));
})
.catch(err => console.error(err));`
            },
            // ============================================================================
            // URL FETCH (Chat Feature)
            // ============================================================================
            '/api/url/fetch': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/url/fetch \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "urls": ["https://example.com/article", "https://example.org/page"],
    "maxLength": 4000,
    "timeout": 15000
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/url/fetch \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "urls": ["https://example.com/article", "https://example.org/page"],
    "maxLength": 4000,
    "timeout": 15000
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/url/fetch',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'urls': ['https://example.com/article', 'https://example.org/page'],
        'maxLength': 4000,
        'timeout': 15000
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/url/fetch',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'urls': ['https://example.com/article', 'https://example.org/page'],
        'maxLength': 4000,
        'timeout': 15000
    },
    verify=False
)

data = response.json()
for result in data['results']:
    if result['success']:
        print(f"Title: {result['title']}")
        print(f"URL: {result['url']}")
        print(f"Content: {result['content'][:200]}...")
        print(f"Source: {result['source']}")
    else:
        print(f"Failed: {result['url']} - {result['error']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    urls = @("https://example.com/article", "https://example.org/page")
    maxLength = 4000
    timeout = 15000
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/url/fetch" -Method Post -Headers $headers -Body $body
foreach ($result in $response.results) {
    if ($result.success) {
        Write-Output "Title: $($result.title)"
        Write-Output "Content: $($result.content.Substring(0, 200))..."
    } else {
        Write-Output "Failed: $($result.url) - $($result.error)"
    }
}`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/url/fetch', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    urls: ['https://example.com/article', 'https://example.org/page'],
    maxLength: 4000,
    timeout: 15000
  })
})
.then(res => res.json())
.then(data => {
  data.results.forEach(result => {
    if (result.success) {
      console.log(\`Title: \${result.title}\`);
      console.log(\`Content: \${result.content.slice(0, 200)}...\`);
      console.log(\`Source: \${result.source}\`);
    } else {
      console.log(\`Failed: \${result.url} - \${result.error}\`);
    }
  });
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/url/fetch', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    urls: ['https://example.com/article', 'https://example.org/page'],
    maxLength: 4000,
    timeout: 15000
  })
})
.then(res => res.json())
.then(data => {
  data.results.forEach(result => {
    if (result.success) {
      console.log(\`Title: \${result.title}\`);
      console.log(\`Content: \${result.content.slice(0, 200)}...\`);
      console.log(\`Source: \${result.source}\`);
    } else {
      console.log(\`Failed: \${result.url} - \${result.error}\`);
    }
  });
})
.catch(err => console.error(err));`
            },
            // ============================================================================
            // PLAYWRIGHT WEB SCRAPING
            // ============================================================================
            '/api/playwright/fetch': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/playwright/fetch \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com",
    "waitForJS": true,
    "maxLength": 8000,
    "includeLinks": true
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/playwright/fetch \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com",
    "waitForJS": true,
    "maxLength": 8000
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/playwright/fetch',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'url': 'https://example.com',
        'waitForJS': True,
        'maxLength': 8000,
        'includeLinks': True
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/playwright/fetch',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'url': 'https://example.com',
        'waitForJS': True,
        'maxLength': 8000
    },
    verify=False
)

result = response.json()
print(f"Title: {result['title']}")
print(f"Content: {result['content'][:500]}...")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    url = "https://example.com"
    waitForJS = $true
    maxLength = 8000
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/playwright/fetch" -Method Post -Headers $headers -Body $body
Write-Output "Title: $($response.title)"
Write-Output "Content: $($response.content.Substring(0, 500))..."`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/playwright/fetch', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: 'https://example.com',
    waitForJS: true,
    maxLength: 8000,
    includeLinks: true
  })
})
.then(res => res.json())
.then(data => {
  console.log('Title:', data.title);
  console.log('Content:', data.content?.substring(0, 500));
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/playwright/fetch', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: 'https://example.com',
    waitForJS: true,
    maxLength: 8000
  })
})
.then(res => res.json())
.then(data => {
  console.log('Title:', data.title);
  console.log('Content:', data.content?.substring(0, 500));
})
.catch(err => console.error(err));`
            },
            '/api/playwright/interact': {
                curl: `# Bearer Token Authentication
curl -k -X POST ${baseUrl}/api/playwright/interact \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com/login",
    "actions": [
      {"type": "type", "selector": "#username", "text": "user"},
      {"type": "click", "selector": "#submit"}
    ],
    "maxLength": 8000
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/playwright/interact \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com/login",
    "actions": [
      {"type": "type", "selector": "#username", "text": "user"},
      {"type": "click", "selector": "#submit"}
    ]
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/playwright/interact',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'url': 'https://example.com/login',
        'actions': [
            {'type': 'type', 'selector': '#username', 'text': 'user'},
            {'type': 'click', 'selector': '#submit'}
        ],
        'maxLength': 8000
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/playwright/interact',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'url': 'https://example.com/login',
        'actions': [
            {'type': 'type', 'selector': '#username', 'text': 'user'},
            {'type': 'click', 'selector': '#submit'}
        ]
    },
    verify=False
)

result = response.json()
print(f"Final URL: {result['url']}")
print(f"Content after interaction: {result['content'][:500]}...")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
    "Content-Type" = "application/json"
}

$body = @{
    url = "https://example.com/login"
    actions = @(
        @{type = "type"; selector = "#username"; text = "user"},
        @{type = "click"; selector = "#submit"}
    )
} | ConvertTo-Json -Depth 3

$response = Invoke-RestMethod -Uri "${baseUrl}/api/playwright/interact" -Method Post -Headers $headers -Body $body
Write-Output "Final URL: $($response.url)"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/playwright/interact', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: 'https://example.com/login',
    actions: [
      {type: 'type', selector: '#username', text: 'user'},
      {type: 'click', selector: '#submit'}
    ],
    maxLength: 8000
  })
})
.then(res => res.json())
.then(data => console.log('Final URL:', data.url))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/playwright/interact', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: 'https://example.com/login',
    actions: [
      {type: 'type', selector: '#username', text: 'user'},
      {type: 'click', selector: '#submit'}
    ]
  })
})
.then(res => res.json())
.then(data => console.log('Final URL:', data.url))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // SYSTEM ENDPOINTS
            // ============================================================================
            '/api/system/resources': {
                curl: `# Bearer Token Authentication
curl -k -X GET ${baseUrl}/api/system/resources \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/system/resources \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/system/resources',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/system/resources',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

resources = response.json()
print(f"CPU: {resources['cpu']['model']} ({resources['cpu']['cores']} cores)")
print(f"RAM: {resources['memory']['total'] / 1024**3:.1f} GB")`,
                powershell: `# Bearer Token Authentication
$headers = @{ "Authorization" = "Bearer your_bearer_token" }

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/system/resources" -Headers $headers
Write-Output "CPU: $($response.cpu.model) ($($response.cpu.cores) cores)"
Write-Output "RAM: $([math]::Round($response.memory.total / 1GB, 1)) GB"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/system/resources', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => {
  console.log(\`CPU: \${data.cpu.model} (\${data.cpu.cores} cores)\`);
  console.log(\`RAM: \${(data.memory.total / 1024**3).toFixed(1)} GB\`);
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/system/resources', {
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(data => {
  console.log(\`CPU: \${data.cpu.model} (\${data.cpu.cores} cores)\`);
  console.log(\`RAM: \${(data.memory.total / 1024**3).toFixed(1)} GB\`);
})
.catch(err => console.error(err));`
            },
            '/api/system/optimal-settings': {
                curl: `# Calculate optimal launch settings for a model
curl -k -X POST ${baseUrl}/api/system/optimal-settings \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "modelName": "Llama-2-7B-GGUF",
    "modelSize": 4000000000,
    "quantization": "Q4_K_M"
  }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/system/optimal-settings',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'modelName': 'Llama-2-7B-GGUF',
        'modelSize': 4000000000,
        'quantization': 'Q4_K_M'
    },
    verify=False
)

settings = response.json()
print(f"Recommended settings:")
print(f"  GPU Layers: {settings['nGpuLayers']}")
print(f"  Context Size: {settings['contextSize']}")
print(f"  Flash Attention: {settings['flashAttention']}")
print(f"  Parallel Slots: {settings['parallelSlots']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{
    modelName = "Llama-2-7B-GGUF"
    modelSize = 4000000000
    quantization = "Q4_K_M"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/system/optimal-settings" -Method Post -Headers $headers -Body $body
Write-Output "Recommended GPU Layers: $($response.nGpuLayers)"
Write-Output "Context Size: $($response.contextSize)"`,
                javascript: `fetch('${baseUrl}/api/system/optimal-settings', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    modelName: 'Llama-2-7B-GGUF',
    modelSize: 4000000000,
    quantization: 'Q4_K_M'
  })
})
.then(res => res.json())
.then(settings => {
  console.log('Recommended settings:', settings);
})
.catch(err => console.error(err));`
            },
            // ============================================================================
            // LLAMA.CPP INSTANCES
            // ============================================================================
            '/api/llamacpp/instances': {
                curl: `# List running llama.cpp instances
curl -k -X GET ${baseUrl}/api/llamacpp/instances \\
  -H "Authorization: Bearer your_bearer_token"`,
                python: `import requests

response = requests.get(
    '${baseUrl}/api/llamacpp/instances',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

instances = response.json()
for instance in instances:
    print(f"{instance['name']}: {instance['status']} on port {instance['port']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/llamacpp/instances" -Headers $headers
$response | ForEach-Object { Write-Output "$($_.name): $($_.status) on port $($_.port)" }`,
                javascript: `fetch('${baseUrl}/api/llamacpp/instances', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(instances => {
  instances.forEach(i => console.log(\`\${i.name}: \${i.status} on port \${i.port}\`));
})
.catch(err => console.error(err));`
            },
            '/api/llamacpp/instances/:name': {
                curl: `# Stop a llama.cpp instance
curl -k -X DELETE ${baseUrl}/api/llamacpp/instances/Llama-2-7B-GGUF \\
  -H "Authorization: Bearer your_bearer_token"`,
                python: `import requests

response = requests.delete(
    '${baseUrl}/api/llamacpp/instances/Llama-2-7B-GGUF',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

print(response.json()['message'])`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/llamacpp/instances/Llama-2-7B-GGUF" -Method Delete -Headers $headers
Write-Output $response.message`,
                javascript: `fetch('${baseUrl}/api/llamacpp/instances/Llama-2-7B-GGUF', {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // AGENTS
            // ============================================================================
            '/api/agents': {
                curl: `# List all agents
curl -k -X GET ${baseUrl}/api/agents \\
  -H "Authorization: Bearer your_bearer_token"

# Create a new agent
curl -k -X POST ${baseUrl}/api/agents \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Code Assistant",
    "description": "Helps with coding tasks",
    "skills": ["create_file", "read_file", "update_file"],
    "systemPrompt": "You are a helpful coding assistant."
  }'`,
                python: `import requests

# List agents
response = requests.get(
    '${baseUrl}/api/agents',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)
agents = response.json()
for agent in agents:
    print(f"- {agent['name']}: {agent['description']}")

# Create agent
response = requests.post(
    '${baseUrl}/api/agents',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'name': 'Code Assistant',
        'description': 'Helps with coding tasks',
        'skills': ['create_file', 'read_file', 'update_file'],
        'systemPrompt': 'You are a helpful coding assistant.'
    },
    verify=False
)
print(f"Created agent: {response.json()['name']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# List agents
$agents = Invoke-RestMethod -Uri "${baseUrl}/api/agents" -Headers $headers
$agents | ForEach-Object { Write-Output "- $($_.name): $($_.description)" }

# Create agent
$body = @{
    name = "Code Assistant"
    description = "Helps with coding tasks"
    skills = @("create_file", "read_file", "update_file")
    systemPrompt = "You are a helpful coding assistant."
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/agents" -Method Post -Headers $headers -Body $body
Write-Output "Created agent: $($response.name)"`,
                javascript: `// List agents
fetch('${baseUrl}/api/agents', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(agents => agents.forEach(a => console.log(\`- \${a.name}: \${a.description}\`)));

// Create agent
fetch('${baseUrl}/api/agents', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Code Assistant',
    description: 'Helps with coding tasks',
    skills: ['create_file', 'read_file', 'update_file'],
    systemPrompt: 'You are a helpful coding assistant.'
  })
})
.then(res => res.json())
.then(agent => console.log('Created agent:', agent.name));`
            },
            // ============================================================================
            // SKILLS
            // ============================================================================
            '/api/skills': {
                curl: `# List all available skills
curl -k -X GET ${baseUrl}/api/skills \\
  -H "Authorization: Bearer your_bearer_token"

# Execute a skill
curl -k -X POST ${baseUrl}/api/skills/read_file/execute \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "filePath": "/path/to/file.txt"
  }'`,
                python: `import requests

# List skills
response = requests.get(
    '${baseUrl}/api/skills',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)
skills = response.json()
print(f"Available skills: {len(skills)}")
for skill in skills[:10]:  # First 10
    print(f"  - {skill['name']}: {skill['description']}")

# Execute a skill
response = requests.post(
    '${baseUrl}/api/skills/read_file/execute',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'filePath': '/path/to/file.txt'
    },
    verify=False
)
print(response.json())`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# List skills
$skills = Invoke-RestMethod -Uri "${baseUrl}/api/skills" -Headers $headers
Write-Output "Available skills: $($skills.Count)"
$skills | Select-Object -First 10 | ForEach-Object { Write-Output "  - $($_.name): $($_.description)" }

# Execute skill
$body = @{ filePath = "/path/to/file.txt" } | ConvertTo-Json
$response = Invoke-RestMethod -Uri "${baseUrl}/api/skills/read_file/execute" -Method Post -Headers $headers -Body $body
Write-Output $response`,
                javascript: `// List skills
fetch('${baseUrl}/api/skills', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(skills => {
  console.log(\`Available skills: \${skills.length}\`);
  skills.slice(0, 10).forEach(s => console.log(\`  - \${s.name}: \${s.description}\`));
});

// Execute skill
fetch('${baseUrl}/api/skills/read_file/execute', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ filePath: '/path/to/file.txt' })
})
.then(res => res.json())
.then(result => console.log('Skill result:', result));`
            },
            // ============================================================================
            // TASKS
            // ============================================================================
            '/api/tasks': {
                curl: `# List all tasks
curl -k -X GET ${baseUrl}/api/tasks \\
  -H "Authorization: Bearer your_bearer_token"

# Create a new task
curl -k -X POST ${baseUrl}/api/tasks \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Review code changes",
    "description": "Review PR #123 for security issues",
    "agentId": "agent-id-here",
    "priority": "high"
  }'`,
                python: `import requests

# List tasks
response = requests.get(
    '${baseUrl}/api/tasks',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)
tasks = response.json()
for task in tasks:
    print(f"- [{task['status']}] {task['title']}")

# Create task
response = requests.post(
    '${baseUrl}/api/tasks',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'title': 'Review code changes',
        'description': 'Review PR #123 for security issues',
        'priority': 'high'
    },
    verify=False
)
print(f"Created task: {response.json()['id']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

# List tasks
$tasks = Invoke-RestMethod -Uri "${baseUrl}/api/tasks" -Headers $headers
$tasks | ForEach-Object { Write-Output "- [$($_.status)] $($_.title)" }

# Create task
$body = @{
    title = "Review code changes"
    description = "Review PR #123 for security issues"
    priority = "high"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/tasks" -Method Post -Headers $headers -Body $body
Write-Output "Created task: $($response.id)"`,
                javascript: `// List tasks
fetch('${baseUrl}/api/tasks', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(tasks => tasks.forEach(t => console.log(\`- [\${t.status}] \${t.title}\`)));

// Create task
fetch('${baseUrl}/api/tasks', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    title: 'Review code changes',
    description: 'Review PR #123 for security issues',
    priority: 'high'
  })
})
.then(res => res.json())
.then(task => console.log('Created task:', task.id));`
            },
            // ============================================================================
            // FILE OPERATIONS (Agent API)
            // ============================================================================
            '/api/agent/file/read': {
                curl: `# Read a file
curl -k -X POST ${baseUrl}/api/agent/file/read \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "path": "/path/to/file.txt"
  }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/agent/file/read',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={'path': '/path/to/file.txt'},
    verify=False
)

result = response.json()
if result.get('success'):
    print(result['content'])
else:
    print(f"Error: {result['error']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{ path = "/path/to/file.txt" } | ConvertTo-Json
$response = Invoke-RestMethod -Uri "${baseUrl}/api/agent/file/read" -Method Post -Headers $headers -Body $body
Write-Output $response.content`,
                javascript: `fetch('${baseUrl}/api/agent/file/read', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ path: '/path/to/file.txt' })
})
.then(res => res.json())
.then(data => {
  if (data.success) console.log(data.content);
  else console.error(data.error);
});`
            },
            '/api/agent/file/write': {
                curl: `# Write to a file
curl -k -X POST ${baseUrl}/api/agent/file/write \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "path": "/path/to/file.txt",
    "content": "Hello, World!\\nThis is line 2."
  }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/agent/file/write',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'path': '/path/to/file.txt',
        'content': 'Hello, World!\\nThis is line 2.'
    },
    verify=False
)

result = response.json()
print('Success!' if result.get('success') else f"Error: {result['error']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{
    path = "/path/to/file.txt"
    content = "Hello, World!\`nThis is line 2."
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/agent/file/write" -Method Post -Headers $headers -Body $body
Write-Output "File written successfully"`,
                javascript: `fetch('${baseUrl}/api/agent/file/write', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    path: '/path/to/file.txt',
    content: 'Hello, World!\\nThis is line 2.'
  })
})
.then(res => res.json())
.then(data => console.log(data.success ? 'Success!' : data.error));`
            },
            '/api/agent/file/list': {
                curl: `# List directory contents
curl -k -X POST ${baseUrl}/api/agent/file/list \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "path": "/path/to/directory"
  }'`,
                python: `import requests

response = requests.post(
    '${baseUrl}/api/agent/file/list',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={'path': '/path/to/directory'},
    verify=False
)

result = response.json()
if result.get('success'):
    for item in result['files']:
        type_icon = '📁' if item['isDirectory'] else '📄'
        print(f"{type_icon} {item['name']} ({item['size']} bytes)")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{ path = "/path/to/directory" } | ConvertTo-Json
$response = Invoke-RestMethod -Uri "${baseUrl}/api/agent/file/list" -Method Post -Headers $headers -Body $body
$response.files | ForEach-Object { Write-Output "$($_.name) ($($_.size) bytes)" }`,
                javascript: `fetch('${baseUrl}/api/agent/file/list', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ path: '/path/to/directory' })
})
.then(res => res.json())
.then(data => {
  data.files?.forEach(f => {
    const icon = f.isDirectory ? '📁' : '📄';
    console.log(\`\${icon} \${f.name} (\${f.size} bytes)\`);
  });
});`
            },
            // ============================================================================
            // API KEYS
            // ============================================================================
            '/api/api-keys': {
                curl: `# List all API keys (admin only)
curl -k -X GET ${baseUrl}/api/api-keys \\
  -H "Authorization: Bearer your_admin_token"

# Create a new API key
curl -k -X POST ${baseUrl}/api/api-keys \\
  -H "Authorization: Bearer your_admin_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Production API Key",
    "permissions": ["query", "models"],
    "rateLimit": {
      "requestsPerHour": 1000,
      "tokensPerDay": 100000
    }
  }'`,
                python: `import requests

# List API keys
response = requests.get(
    '${baseUrl}/api/api-keys',
    headers={'Authorization': 'Bearer your_admin_token'},
    verify=False
)
keys = response.json()
for key in keys:
    print(f"- {key['name']}: {key['permissions']}")

# Create API key
response = requests.post(
    '${baseUrl}/api/api-keys',
    headers={
        'Authorization': 'Bearer your_admin_token',
        'Content-Type': 'application/json'
    },
    json={
        'name': 'Production API Key',
        'permissions': ['query', 'models'],
        'rateLimit': {
            'requestsPerHour': 1000,
            'tokensPerDay': 100000
        }
    },
    verify=False
)
key_data = response.json()
print(f"API Key: {key_data['key']}")
print(f"Secret: {key_data['secret']}")
print("Save these - the secret won't be shown again!")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_admin_token"
    "Content-Type" = "application/json"
}

# List keys
$keys = Invoke-RestMethod -Uri "${baseUrl}/api/api-keys" -Headers $headers
$keys | ForEach-Object { Write-Output "- $($_.name): $($_.permissions -join ', ')" }

# Create key
$body = @{
    name = "Production API Key"
    permissions = @("query", "models")
    rateLimit = @{
        requestsPerHour = 1000
        tokensPerDay = 100000
    }
} | ConvertTo-Json -Depth 3

$response = Invoke-RestMethod -Uri "${baseUrl}/api/api-keys" -Method Post -Headers $headers -Body $body
Write-Output "API Key: $($response.key)"
Write-Output "Secret: $($response.secret)"`,
                javascript: `// List API keys
fetch('${baseUrl}/api/api-keys', {
  headers: { 'Authorization': 'Bearer your_admin_token' }
})
.then(res => res.json())
.then(keys => keys.forEach(k => console.log(\`- \${k.name}: \${k.permissions.join(', ')}\`)));

// Create API key
fetch('${baseUrl}/api/api-keys', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_admin_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Production API Key',
    permissions: ['query', 'models'],
    rateLimit: {
      requestsPerHour: 1000,
      tokensPerDay: 100000
    }
  })
})
.then(res => res.json())
.then(data => {
  console.log('API Key:', data.key);
  console.log('Secret:', data.secret);
  console.log('Save these - the secret will not be shown again!');
});`
            },
            // ============================================================================
            // HUGGINGFACE SEARCH
            // ============================================================================
            '/api/huggingface/search': {
                curl: `# Search HuggingFace for GGUF models
curl -k -G "${baseUrl}/api/huggingface/search" \\
  -H "Authorization: Bearer your_bearer_token" \\
  --data-urlencode "q=llama 7b gguf" \\
  --data-urlencode "limit=10"`,
                python: `import requests

response = requests.get(
    '${baseUrl}/api/huggingface/search',
    headers={'Authorization': 'Bearer your_bearer_token'},
    params={
        'q': 'llama 7b gguf',
        'limit': 10
    },
    verify=False
)

results = response.json()
for model in results:
    print(f"- {model['id']}: {model['downloads']} downloads")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$query = [uri]::EscapeDataString("llama 7b gguf")
$response = Invoke-RestMethod -Uri "${baseUrl}/api/huggingface/search?q=$query&limit=10" -Headers $headers
$response | ForEach-Object { Write-Output "- $($_.id): $($_.downloads) downloads" }`,
                javascript: `const params = new URLSearchParams({
  q: 'llama 7b gguf',
  limit: 10
});

fetch(\`${baseUrl}/api/huggingface/search?\${params}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(models => models.forEach(m => console.log(\`- \${m.id}: \${m.downloads} downloads\`)));`
            },
            // ============================================================================
            // APPS MANAGEMENT
            // ============================================================================
            '/api/apps': {
                curl: `# List all apps and their status
curl -k -X GET ${baseUrl}/api/apps \\
  -H "Authorization: Bearer your_bearer_token"`,
                python: `import requests

# List apps
response = requests.get(
    '${baseUrl}/api/apps',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)
apps = response.json()
for app in apps:
    print(f"- {app['name']}: {app.get('status', {}).get('status', 'unknown')}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

# List apps
$apps = Invoke-RestMethod -Uri "${baseUrl}/api/apps" -Headers $headers
$apps | ForEach-Object { Write-Output "- $($_.name): $($_.status.status)" }`,
                javascript: `// List apps
fetch('${baseUrl}/api/apps', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(apps => apps.forEach(a => console.log(\`- \${a.name}: \${a.status?.status || 'unknown'}\`)));`
            },
            // ============================================================================
            // CHAT UPLOAD
            // ============================================================================
            '/api/chat/upload': {
                curl: `# Upload a file for chat (images, PDFs, text files)
curl -k -X POST ${baseUrl}/api/chat/upload \\
  -H "Authorization: Bearer your_bearer_token" \\
  -F "file=@/path/to/document.pdf"

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/chat/upload \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -F "file=@/path/to/image.png"`,
                python: `import requests

# Bearer Token Authentication
with open('/path/to/document.pdf', 'rb') as f:
    response = requests.post(
        '${baseUrl}/api/chat/upload',
        headers={'Authorization': 'Bearer your_bearer_token'},
        files={'file': f},
        verify=False
    )

# OR API Key + Secret Authentication
with open('/path/to/image.png', 'rb') as f:
    response = requests.post(
        '${baseUrl}/api/chat/upload',
        headers={
            'X-API-Key': 'your_api_key',
            'X-API-Secret': 'your_api_secret'
        },
        files={'file': f},
        verify=False
    )

result = response.json()
print(f"Uploaded: {result['filename']}, Type: {result['type']}")
# PDFs and spreadsheets also return an attachmentId — used to fetch
# the raw bytes (PDF) or structured sheets (xlsx) on demand via
# GET /api/attachments/:id and /api/attachments/:id/meta.
if result.get('attachmentId'):
    print(f"attachmentId: {result['attachmentId']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

# Upload file
$filePath = "C:\\path\\to\\document.pdf"
$fileBytes = [System.IO.File]::ReadAllBytes($filePath)
$fileName = [System.IO.Path]::GetFileName($filePath)

$boundary = [System.Guid]::NewGuid().ToString()
$contentType = "multipart/form-data; boundary=$boundary"

$body = @"
--$boundary
Content-Disposition: form-data; name="file"; filename="$fileName"
Content-Type: application/octet-stream

$([System.Text.Encoding]::UTF8.GetString($fileBytes))
--$boundary--
"@

$response = Invoke-RestMethod -Uri "${baseUrl}/api/chat/upload" -Method Post -Headers $headers -ContentType $contentType -Body $body
Write-Output "Uploaded: $($response.filename)"
# PDFs and spreadsheets include an attachmentId for fetching bytes/meta later.
if ($response.attachmentId) { Write-Output "attachmentId: $($response.attachmentId)" }`,
                javascript: `// Bearer Token Authentication
const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('${baseUrl}/api/chat/upload', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' },
  body: formData
})
.then(res => res.json())
.then(data => {
  console.log('Uploaded:', data.filename, 'Type:', data.type);
  // PDFs and spreadsheets include an attachmentId — fetch bytes/meta with
  // GET /api/attachments/:id and /api/attachments/:id/meta.
  if (data.attachmentId) console.log('attachmentId:', data.attachmentId);
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/chat/upload', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  },
  body: formData
})
.then(res => res.json())
.then(data => console.log('Uploaded:', data.filename))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // ATTACHMENT STORE
            // ============================================================================
            // PDFs and structured spreadsheet rows uploaded via /api/chat/upload
            // are kept in a per-user attachment store at
            // /models/.modelserver/attachments/<userId>/<aid>/. The upload response
            // returns an `attachmentId`; these endpoints fetch the bytes (PDF) or
            // structured metadata (xlsx sheets[]) on demand. Owner-scoped — no
            // cross-user access. Wiped when the parent conversation is deleted,
            // plus a 14-day orphan sweep at boot + every 12h.
            '/api/attachments/:id': {
                curl: `# Fetch raw attachment bytes (PDF, etc.) — Content-Type comes from saved metadata.
curl -k -X GET ${baseUrl}/api/attachments/abcd1234567890abcdef1234567890ab \\
  -H "Authorization: Bearer your_bearer_token" \\
  -o downloaded.pdf

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/attachments/abcd1234567890abcdef1234567890ab \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -o downloaded.pdf`,
                python: `import requests

attachment_id = "abcd1234567890abcdef1234567890ab"  # 32-hex-char id from /api/chat/upload

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/attachments/{attachment_id}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/attachments/{attachment_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

if response.ok:
    with open('downloaded.pdf', 'wb') as f:
        f.write(response.content)
    print(f"Saved {len(response.content)} bytes")
else:
    print(f"Error: {response.status_code} {response.text}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$attachmentId = "abcd1234567890abcdef1234567890ab"
Invoke-WebRequest -Uri "${baseUrl}/api/attachments/$attachmentId" -Headers $headers -OutFile "downloaded.pdf"
Write-Output "Saved downloaded.pdf"`,
                javascript: `// Bearer Token Authentication
const attachmentId = 'abcd1234567890abcdef1234567890ab'; // from /api/chat/upload

fetch(\`${baseUrl}/api/attachments/\${attachmentId}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' },
})
.then(res => res.blob())
.then(blob => {
  // For inline rendering (e.g. <embed> or pdfjs), turn the blob into an
  // object URL.
  const url = URL.createObjectURL(blob);
  console.log('Object URL:', url, 'Size:', blob.size);
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch(\`${baseUrl}/api/attachments/\${attachmentId}\`, {
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  },
})
.then(res => res.blob())
.then(blob => console.log('size:', blob.size))
.catch(err => console.error(err));`
            },
            '/api/attachments/:id/meta': {
                curl: `# Fetch attachment metadata (filename, mimeType, byteSize, etc.).
# For spreadsheet uploads this also includes structured sheets[] data:
#   { name, rowCount, truncated, rows: [[...], ...] }
curl -k -X GET ${baseUrl}/api/attachments/abcd1234567890abcdef1234567890ab/meta \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/attachments/abcd1234567890abcdef1234567890ab/meta \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

attachment_id = "abcd1234567890abcdef1234567890ab"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/attachments/{attachment_id}/meta',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/attachments/{attachment_id}/meta',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

meta = response.json()
print(f"Filename: {meta.get('filename')}")
print(f"Type: {meta.get('type')} ({meta.get('mimeType')})")
print(f"Size: {meta.get('byteSize')} bytes")
# Spreadsheet uploads include the parsed rows
if meta.get('sheets'):
    for s in meta['sheets']:
        print(f"  Sheet '{s['name']}': {s['rowCount']} rows")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$attachmentId = "abcd1234567890abcdef1234567890ab"
$meta = Invoke-RestMethod -Uri "${baseUrl}/api/attachments/$attachmentId/meta" -Headers $headers
Write-Output "Filename: $($meta.filename)"
Write-Output "Size: $($meta.byteSize) bytes"
if ($meta.sheets) { $meta.sheets | ForEach-Object { Write-Output "Sheet '$($_.name)': $($_.rowCount) rows" } }`,
                javascript: `// Bearer Token Authentication
const attachmentId = 'abcd1234567890abcdef1234567890ab';

fetch(\`${baseUrl}/api/attachments/\${attachmentId}/meta\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' },
})
.then(res => res.json())
.then(meta => {
  console.log('Filename:', meta.filename);
  console.log('Type:', meta.type, '(' + meta.mimeType + ')');
  console.log('Size:', meta.byteSize, 'bytes');
  // Spreadsheet uploads include parsed rows for inline rendering.
  if (meta.sheets) {
    meta.sheets.forEach(s => console.log(\`Sheet '\${s.name}': \${s.rowCount} rows\`));
  }
})
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch(\`${baseUrl}/api/attachments/\${attachmentId}/meta\`, {
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  },
})
.then(res => res.json())
.then(meta => console.log(meta))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // CHAT CONTINUATION
            // ============================================================================
            '/api/chat/continuation/:conversationId': {
                curl: `# Get continuation queue for a conversation (chunked content)
curl -k -X GET ${baseUrl}/api/chat/continuation/conv_abc123 \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/chat/continuation/conv_abc123 \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/chat/continuation/{conversation_id}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/chat/continuation/{conversation_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

result = response.json()
if result.get('hasContinuation'):
    print(f"Remaining: {result['remainingTokens']} tokens")
    print(f"Chunk {result['processedChunks']}/{result['totalChunks']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv_abc123"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/chat/continuation/$conversationId" -Headers $headers
if ($response.hasContinuation) {
    Write-Output "Remaining: $($response.remainingTokens) tokens"
    Write-Output "Chunk $($response.processedChunks)/$($response.totalChunks)"
}`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/chat/continuation/\${conversationId}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => {
  if (data.hasContinuation) {
    console.log('Remaining:', data.remainingTokens, 'tokens');
    console.log(\`Chunk \${data.processedChunks}/\${data.totalChunks}\`);
  }
})
.catch(err => console.error(err));`
            },
            // ============================================================================
            // AUTH - LOGOUT
            // ============================================================================
            '/api/auth/logout': {
                curl: `# Logout current user
curl -k -X POST ${baseUrl}/api/auth/logout \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/auth/logout \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/auth/logout',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/auth/logout',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("Logged out successfully" if response.ok else "Logout failed")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/logout" -Method Post -Headers $headers
Write-Output "Logged out successfully"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/auth/logout', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('Logged out successfully'))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/auth/logout', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(() => console.log('Logged out'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // AUTH - GET CURRENT USER
            // ============================================================================
            '/api/auth/me': {
                curl: `# Get current authenticated user info
curl -k -X GET ${baseUrl}/api/auth/me \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/auth/me \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/auth/me',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/auth/me',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

user = response.json().get('user')
print(f"User: {user['username']}, Role: {user['role']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/me" -Headers $headers
Write-Output "User: $($response.user.username), Role: $($response.user.role)"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/auth/me', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => console.log('User:', data.user.username, 'Role:', data.user.role))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/auth/me', {
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(data => console.log('User:', data.user))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // AUTH - CHANGE PASSWORD
            // ============================================================================
            '/api/auth/password': {
                curl: `# Change current user's password
curl -k -X PUT ${baseUrl}/api/auth/password \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "currentPassword": "oldPassword123",
    "newPassword": "newSecurePassword456"
  }'

# OR API Key + Secret Authentication
curl -k -X PUT ${baseUrl}/api/auth/password \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "currentPassword": "oldPassword123",
    "newPassword": "newSecurePassword456"
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.put(
    '${baseUrl}/api/auth/password',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'currentPassword': 'oldPassword123',
        'newPassword': 'newSecurePassword456'
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.put(
    '${baseUrl}/api/auth/password',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'currentPassword': 'oldPassword123',
        'newPassword': 'newSecurePassword456'
    },
    verify=False
)

print("Password changed" if response.ok else f"Error: {response.json()}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{
    currentPassword = "oldPassword123"
    newPassword = "newSecurePassword456"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/auth/password" -Method Put -Headers $headers -Body $body
Write-Output "Password changed successfully"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/auth/password', {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    currentPassword: 'oldPassword123',
    newPassword: 'newSecurePassword456'
  })
})
.then(res => res.json())
.then(() => console.log('Password changed successfully'))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/auth/password', {
  method: 'PUT',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    currentPassword: 'oldPassword123',
    newPassword: 'newSecurePassword456'
  })
})
.then(() => console.log('Password changed'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // MODEL CONFIGS
            // ============================================================================
            '/api/model-configs/:modelName': {
                curl: `# Get model configuration
curl -k -X GET "${baseUrl}/api/model-configs/llama-7b" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/model-configs/llama-7b" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/model-configs/{model_name}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/model-configs/{model_name}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

config = response.json()
print(f"Context Size: {config.get('contextSize')}")
print(f"GPU Layers: {config.get('gpuLayers')}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$modelName = "llama-7b"

$config = Invoke-RestMethod -Uri "${baseUrl}/api/model-configs/$modelName" -Headers $headers
Write-Output "Context Size: $($config.contextSize)"
Write-Output "GPU Layers: $($config.gpuLayers)"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/model-configs/\${modelName}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(config => {
  console.log('Context Size:', config.contextSize);
  console.log('GPU Layers:', config.gpuLayers);
})
.catch(err => console.error(err));`
            },
            '/api/model-configs/:modelName/update': {
                curl: `# Update model configuration
curl -k -X PUT "${baseUrl}/api/model-configs/llama-7b" \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contextSize": 8192,
    "gpuLayers": 35,
    "temperature": 0.7
  }'

# OR API Key + Secret Authentication
curl -k -X PUT "${baseUrl}/api/model-configs/llama-7b" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contextSize": 8192,
    "gpuLayers": 35
  }'`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.put(
    f'${baseUrl}/api/model-configs/{model_name}',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'contextSize': 8192,
        'gpuLayers': 35,
        'temperature': 0.7
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.put(
    f'${baseUrl}/api/model-configs/{model_name}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'contextSize': 8192,
        'gpuLayers': 35
    },
    verify=False
)

print("Config updated" if response.ok else f"Error: {response.json()}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}
$modelName = "llama-7b"

$body = @{
    contextSize = 8192
    gpuLayers = 35
    temperature = 0.7
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/model-configs/$modelName" -Method Put -Headers $headers -Body $body
Write-Output "Config updated successfully"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/model-configs/\${modelName}\`, {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    contextSize: 8192,
    gpuLayers: 35,
    temperature: 0.7
  })
})
.then(res => res.json())
.then(() => console.log('Config updated'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // HUGGINGFACE FILES
            // ============================================================================
            '/api/huggingface/files/:owner/:repo': {
                curl: `# List files in a HuggingFace repository
curl -k -X GET "${baseUrl}/api/huggingface/files/TheBloke/Llama-2-7B-GGUF" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/huggingface/files/TheBloke/Llama-2-7B-GGUF" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

owner = "TheBloke"
repo = "Llama-2-7B-GGUF"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/huggingface/files/{owner}/{repo}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/huggingface/files/{owner}/{repo}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

files = response.json()
for f in files:
    print(f"- {f['path']}: {f.get('size', 0) / 1e9:.2f} GB")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$owner = "TheBloke"
$repo = "Llama-2-7B-GGUF"

$files = Invoke-RestMethod -Uri "${baseUrl}/api/huggingface/files/$owner/$repo" -Headers $headers
$files | ForEach-Object { Write-Output "- $($_.path): $([math]::Round($_.size / 1GB, 2)) GB" }`,
                javascript: `const owner = 'TheBloke';
const repo = 'Llama-2-7B-GGUF';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/huggingface/files/\${owner}/\${repo}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(files => files.forEach(f =>
  console.log(\`- \${f.path}: \${(f.size / 1e9).toFixed(2)} GB\`)
))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // DOWNLOADS
            // ============================================================================
            '/api/downloads': {
                curl: `# List active downloads
curl -k -X GET ${baseUrl}/api/downloads \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/downloads \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/downloads',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/downloads',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

downloads = response.json()
for d in downloads:
    print(f"- {d['filename']}: {d['progress']}% ({d['status']})")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$downloads = Invoke-RestMethod -Uri "${baseUrl}/api/downloads" -Headers $headers
$downloads | ForEach-Object {
    Write-Output "- $($_.filename): $($_.progress)% ($($_.status))"
}`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/downloads', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(downloads => downloads.forEach(d =>
  console.log(\`- \${d.filename}: \${d.progress}% (\${d.status})\`)
))
.catch(err => console.error(err));`
            },
            '/api/downloads/:downloadId': {
                curl: `# Cancel a download
curl -k -X DELETE "${baseUrl}/api/downloads/dl_abc123" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X DELETE "${baseUrl}/api/downloads/dl_abc123" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

download_id = "dl_abc123"

# Bearer Token Authentication
response = requests.delete(
    f'${baseUrl}/api/downloads/{download_id}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.delete(
    f'${baseUrl}/api/downloads/{download_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("Download cancelled" if response.ok else f"Error: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$downloadId = "dl_abc123"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/downloads/$downloadId" -Method Delete -Headers $headers
Write-Output "Download cancelled"`,
                javascript: `const downloadId = 'dl_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/downloads/\${downloadId}\`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('Download cancelled'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // SGLANG SLOTS
            // ============================================================================
            '/api/sglang/instances/:name/slots': {
                curl: `# Get KV cache slots for a sglang instance
curl -k -X GET "${baseUrl}/api/sglang/instances/llama-7b/slots" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/sglang/instances/llama-7b/slots" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/sglang/instances/{model_name}/slots',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/sglang/instances/{model_name}/slots',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

slots = response.json()
print(f"Used: {slots.get('used')}, Total: {slots.get('total')}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$modelName = "llama-7b"

$slots = Invoke-RestMethod -Uri "${baseUrl}/api/sglang/instances/$modelName/slots" -Headers $headers
Write-Output "Used: $($slots.used), Total: $($slots.total)"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/sglang/instances/\${modelName}/slots\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(slots => console.log('Used:', slots.used, 'Total:', slots.total))
.catch(err => console.error(err));`
            },
            '/api/sglang/instances/:name/slots/clear': {
                curl: `# Clear KV cache for a sglang instance
curl -k -X POST "${baseUrl}/api/sglang/instances/llama-7b/slots/clear" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X POST "${baseUrl}/api/sglang/instances/llama-7b/slots/clear" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.post(
    f'${baseUrl}/api/sglang/instances/{model_name}/slots/clear',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    f'${baseUrl}/api/sglang/instances/{model_name}/slots/clear',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("KV cache cleared" if response.ok else f"Error: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$modelName = "llama-7b"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/sglang/instances/$modelName/slots/clear" -Method Post -Headers $headers
Write-Output "KV cache cleared"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/sglang/instances/\${modelName}/slots/clear\`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('KV cache cleared'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // SYSTEM PROMPTS
            // ============================================================================
            '/api/system-prompts': {
                curl: `# List all system prompts
curl -k -X GET ${baseUrl}/api/system-prompts \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/system-prompts \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/system-prompts',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/system-prompts',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

prompts = response.json()
for model, prompt in prompts.items():
    print(f"- {model}: {prompt[:50]}...")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$prompts = Invoke-RestMethod -Uri "${baseUrl}/api/system-prompts" -Headers $headers
$prompts.PSObject.Properties | ForEach-Object {
    Write-Output "- $($_.Name): $($_.Value.Substring(0, [Math]::Min(50, $_.Value.Length)))..."
}`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/system-prompts', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(prompts => {
  Object.entries(prompts).forEach(([model, prompt]) =>
    console.log(\`- \${model}: \${prompt.substring(0, 50)}...\`)
  );
})
.catch(err => console.error(err));`
            },
            '/api/system-prompts/:modelName': {
                curl: `# Get system prompt for a specific model
curl -k -X GET "${baseUrl}/api/system-prompts/llama-7b" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/system-prompts/llama-7b" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/system-prompts/{model_name}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/system-prompts/{model_name}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

result = response.json()
print(f"System Prompt: {result.get('systemPrompt')}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$modelName = "llama-7b"

$result = Invoke-RestMethod -Uri "${baseUrl}/api/system-prompts/$modelName" -Headers $headers
Write-Output "System Prompt: $($result.systemPrompt)"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/system-prompts/\${modelName}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(result => console.log('System Prompt:', result.systemPrompt))
.catch(err => console.error(err));`
            },
            '/api/system-prompts/:modelName/update': {
                curl: `# Update system prompt for a model
curl -k -X PUT "${baseUrl}/api/system-prompts/llama-7b" \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "systemPrompt": "You are a helpful AI assistant. Be concise and accurate."
  }'

# OR API Key + Secret Authentication
curl -k -X PUT "${baseUrl}/api/system-prompts/llama-7b" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "systemPrompt": "You are a helpful AI assistant."
  }'`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.put(
    f'${baseUrl}/api/system-prompts/{model_name}',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'systemPrompt': 'You are a helpful AI assistant. Be concise and accurate.'
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.put(
    f'${baseUrl}/api/system-prompts/{model_name}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'systemPrompt': 'You are a helpful AI assistant.'
    },
    verify=False
)

print("System prompt updated" if response.ok else f"Error: {response.json()}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}
$modelName = "llama-7b"

$body = @{
    systemPrompt = "You are a helpful AI assistant. Be concise and accurate."
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/system-prompts/$modelName" -Method Put -Headers $headers -Body $body
Write-Output "System prompt updated"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/system-prompts/\${modelName}\`, {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    systemPrompt: 'You are a helpful AI assistant. Be concise and accurate.'
  })
})
.then(res => res.json())
.then(() => console.log('System prompt updated'))
.catch(err => console.error(err));`
            },
            '/api/system-prompts/:modelName/delete': {
                curl: `# Delete system prompt for a model
curl -k -X DELETE "${baseUrl}/api/system-prompts/llama-7b" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X DELETE "${baseUrl}/api/system-prompts/llama-7b" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.delete(
    f'${baseUrl}/api/system-prompts/{model_name}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.delete(
    f'${baseUrl}/api/system-prompts/{model_name}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("System prompt deleted" if response.ok else f"Error: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$modelName = "llama-7b"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/system-prompts/$modelName" -Method Delete -Headers $headers
Write-Output "System prompt deleted"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/system-prompts/\${modelName}\`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('System prompt deleted'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // SYSTEM RESET
            // ============================================================================
            '/api/system/reset': {
                curl: `# Reset system (Admin only) - stops all instances, clears caches
curl -k -X POST ${baseUrl}/api/system/reset \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "stopInstances": true,
    "clearCache": true
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/system/reset \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "stopInstances": true,
    "clearCache": true
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/system/reset',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'stopInstances': True,
        'clearCache': True
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/system/reset',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'stopInstances': True,
        'clearCache': True
    },
    verify=False
)

print("System reset complete" if response.ok else f"Error: {response.json()}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{
    stopInstances = $true
    clearCache = $true
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/system/reset" -Method Post -Headers $headers -Body $body
Write-Output "System reset complete"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/system/reset', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    stopInstances: true,
    clearCache: true
  })
})
.then(res => res.json())
.then(() => console.log('System reset complete'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // PLAYWRIGHT STATUS
            // ============================================================================
            '/api/playwright/status': {
                curl: `# Get Playwright browser status
curl -k -X GET ${baseUrl}/api/playwright/status \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/playwright/status \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/playwright/status',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/playwright/status',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

status = response.json()
print(f"Browser: {status.get('browser')}, Active: {status.get('active')}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$status = Invoke-RestMethod -Uri "${baseUrl}/api/playwright/status" -Headers $headers
Write-Output "Browser: $($status.browser), Active: $($status.active)"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/playwright/status', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(status => console.log('Browser:', status.browser, 'Active:', status.active))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // CONVERSATIONS
            // ============================================================================
            '/api/conversations': {
                curl: `# List all conversations
curl -k -X GET ${baseUrl}/api/conversations \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/conversations \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/conversations',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/conversations',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

conversations = response.json()
for conv in conversations:
    print(f"- {conv['id']}: {conv.get('title', 'Untitled')} ({len(conv.get('messages', []))} messages)")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversations = Invoke-RestMethod -Uri "${baseUrl}/api/conversations" -Headers $headers
$conversations | ForEach-Object {
    Write-Output "- $($_.id): $($_.title) ($($_.messages.Count) messages)"
}`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/conversations', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(convs => convs.forEach(c =>
  console.log(\`- \${c.id}: \${c.title || 'Untitled'} (\${c.messages?.length || 0} messages)\`)
))
.catch(err => console.error(err));`
            },
            '/api/conversations/create': {
                curl: `# Create a new conversation
curl -k -X POST ${baseUrl}/api/conversations \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "New Conversation",
    "model": "llama-7b"
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/conversations \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "New Conversation",
    "model": "llama-7b"
  }'`,
                python: `import requests

# Bearer Token Authentication
response = requests.post(
    '${baseUrl}/api/conversations',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'title': 'New Conversation',
        'model': 'llama-7b'
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    '${baseUrl}/api/conversations',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'title': 'New Conversation',
        'model': 'llama-7b'
    },
    verify=False
)

conv = response.json()
print(f"Created conversation: {conv['id']}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}

$body = @{
    title = "New Conversation"
    model = "llama-7b"
} | ConvertTo-Json

$conv = Invoke-RestMethod -Uri "${baseUrl}/api/conversations" -Method Post -Headers $headers -Body $body
Write-Output "Created conversation: $($conv.id)"`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/conversations', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    title: 'New Conversation',
    model: 'llama-7b'
  })
})
.then(res => res.json())
.then(conv => console.log('Created conversation:', conv.id))
.catch(err => console.error(err));`
            },
            '/api/conversations/:id': {
                curl: `# Get a specific conversation
curl -k -X GET "${baseUrl}/api/conversations/conv_abc123" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/conversations/conv_abc123" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/conversations/{conversation_id}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/conversations/{conversation_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

conv = response.json()
print(f"Title: {conv.get('title')}")
print(f"Messages: {len(conv.get('messages', []))}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv_abc123"

$conv = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId" -Headers $headers
Write-Output "Title: $($conv.title)"
Write-Output "Messages: $($conv.messages.Count)"`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(conv => {
  console.log('Title:', conv.title);
  console.log('Messages:', conv.messages?.length || 0);
})
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/update': {
                curl: `# Update a conversation
curl -k -X PUT "${baseUrl}/api/conversations/conv_abc123" \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Updated Title"
  }'

# OR API Key + Secret Authentication
curl -k -X PUT "${baseUrl}/api/conversations/conv_abc123" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Updated Title"
  }'`,
                python: `import requests

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.put(
    f'${baseUrl}/api/conversations/{conversation_id}',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'title': 'Updated Title'
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.put(
    f'${baseUrl}/api/conversations/{conversation_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'title': 'Updated Title'
    },
    verify=False
)

print("Conversation updated" if response.ok else f"Error: {response.json()}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}
$conversationId = "conv_abc123"

$body = @{ title = "Updated Title" } | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId" -Method Put -Headers $headers -Body $body
Write-Output "Conversation updated"`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}\`, {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ title: 'Updated Title' })
})
.then(res => res.json())
.then(() => console.log('Conversation updated'))
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/delete': {
                curl: `# Delete a conversation
curl -k -X DELETE "${baseUrl}/api/conversations/conv_abc123" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X DELETE "${baseUrl}/api/conversations/conv_abc123" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("Conversation deleted" if response.ok else f"Error: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv_abc123"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId" -Method Delete -Headers $headers
Write-Output "Conversation deleted"`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}\`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('Conversation deleted'))
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/messages': {
                curl: `# Add a message to a conversation
curl -k -X POST "${baseUrl}/api/conversations/conv_abc123/messages" \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "role": "user",
    "content": "Hello, how are you?"
  }'

# OR API Key + Secret Authentication
curl -k -X POST "${baseUrl}/api/conversations/conv_abc123/messages" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "role": "user",
    "content": "Hello, how are you?"
  }'`,
                python: `import requests

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.post(
    f'${baseUrl}/api/conversations/{conversation_id}/messages',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'role': 'user',
        'content': 'Hello, how are you?'
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    f'${baseUrl}/api/conversations/{conversation_id}/messages',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'role': 'user',
        'content': 'Hello, how are you?'
    },
    verify=False
)

print("Message added" if response.ok else f"Error: {response.json()}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}
$conversationId = "conv_abc123"

$body = @{
    role = "user"
    content = "Hello, how are you?"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/messages" -Method Post -Headers $headers -Body $body
Write-Output "Message added"`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/messages\`, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    role: 'user',
    content: 'Hello, how are you?'
  })
})
.then(res => res.json())
.then(() => console.log('Message added'))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // CONVERSATION MEMORIES
            // ============================================================================
            '/api/conversations/:id/memories': {
                curl: `# List all memories for a conversation
curl -k -X GET "${baseUrl}/api/conversations/conv-abc123/memories" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/conversations/conv-abc123/memories" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# Response:
# {
#   "conversationId": "conv-abc123",
#   "cursor": 0,
#   "count": 2,
#   "memories": [
#     { "id": "mem-xyz789", "text": "The webapp listens on port 3001.",
#       "keywords": ["webapp", "port"], "tokens": 9,
#       "sourceRole": "assistant", "sourceTurnId": "turn-1",
#       "ts": 1712345678000, "score": 0.87 }
#   ]
# }`,
                python: `import requests

conversation_id = "conv-abc123"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/conversations/{conversation_id}/memories',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/conversations/{conversation_id}/memories',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

data = response.json()
print(f"Memories ({data['count']}) for {data['conversationId']}:")
for mem in data['memories']:
    print(f"- [{mem['id']}] {mem['text']}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv-abc123"

$data = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/memories" -Headers $headers
Write-Output "Memories ($($data.count)) for $($data.conversationId):"
$data.memories | ForEach-Object {
    Write-Output "- [$($_.id)] $($_.text)"
}`,
                javascript: `const conversationId = 'conv-abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/memories\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => {
  console.log(\`Memories (\${data.count}) for \${data.conversationId}:\`);
  data.memories.forEach(m => console.log(\`- [\${m.id}] \${m.text}\`));
})
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/memories/clear': {
                curl: `# Clear all memories for a conversation
curl -k -X DELETE "${baseUrl}/api/conversations/conv-abc123/memories" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X DELETE "${baseUrl}/api/conversations/conv-abc123/memories" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# Response: { "success": true }`,
                python: `import requests

conversation_id = "conv-abc123"

# Bearer Token Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}/memories',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}/memories',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("Memories cleared" if response.ok else f"Error: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv-abc123"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/memories" -Method Delete -Headers $headers
Write-Output "Memories cleared"`,
                javascript: `const conversationId = 'conv-abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/memories\`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('Memories cleared'))
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/memories/:memId': {
                curl: `# Delete a single memory
curl -k -X DELETE "${baseUrl}/api/conversations/conv-abc123/memories/mem-xyz789" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X DELETE "${baseUrl}/api/conversations/conv-abc123/memories/mem-xyz789" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# Response: { "success": true }
# 404 if memory not found`,
                python: `import requests

conversation_id = "conv-abc123"
memory_id = "mem-xyz789"

# Bearer Token Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}/memories/{memory_id}',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}/memories/{memory_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print("Memory deleted" if response.ok else f"Error: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv-abc123"
$memoryId = "mem-xyz789"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/memories/$memoryId" -Method Delete -Headers $headers
Write-Output "Memory deleted"`,
                javascript: `const conversationId = 'conv-abc123';
const memoryId = 'mem-xyz789';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/memories/\${memoryId}\`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(() => console.log('Memory deleted'))
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/memories/:memId/update': {
                curl: `# Edit a memory's text
curl -k -X PUT "${baseUrl}/api/conversations/conv-abc123/memories/mem-xyz789" \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "The webapp listens on port 3001."
  }'

# OR API Key + Secret Authentication
curl -k -X PUT "${baseUrl}/api/conversations/conv-abc123/memories/mem-xyz789" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "The webapp listens on port 3001."
  }'

# Response:
# {
#   "success": true,
#   "memory": {
#     "id": "mem-xyz789",
#     "text": "The webapp listens on port 3001.",
#     "keywords": ["webapp", "port"],
#     "tokens": 9,
#     "sourceRole": "assistant",
#     "sourceTurnId": "turn-1",
#     "ts": 1712345678000,
#     "editedAt": 1712999999000
#   }
# }`,
                python: `import requests

conversation_id = "conv-abc123"
memory_id = "mem-xyz789"

# Bearer Token Authentication
response = requests.put(
    f'${baseUrl}/api/conversations/{conversation_id}/memories/{memory_id}',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={
        'text': 'The webapp listens on port 3001.'
    },
    verify=False
)

# OR API Key + Secret Authentication
response = requests.put(
    f'${baseUrl}/api/conversations/{conversation_id}/memories/{memory_id}',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret',
        'Content-Type': 'application/json'
    },
    json={
        'text': 'The webapp listens on port 3001.'
    },
    verify=False
)

result = response.json()
if result.get('success'):
    print(f"Updated memory: {result['memory']['text']}")
else:
    print(f"Error: {result}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
    "Content-Type" = "application/json"
}
$conversationId = "conv-abc123"
$memoryId = "mem-xyz789"

$body = @{
    text = "The webapp listens on port 3001."
} | ConvertTo-Json

$result = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/memories/$memoryId" -Method Put -Headers $headers -Body $body
Write-Output "Updated memory: $($result.memory.text)"`,
                javascript: `const conversationId = 'conv-abc123';
const memoryId = 'mem-xyz789';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/memories/\${memoryId}\`, {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ text: 'The webapp listens on port 3001.' })
})
.then(res => res.json())
.then(result => console.log('Updated memory:', result.memory.text))
.catch(err => console.error(err));`
            },
            // ============================================================================
            // STREAMING STATUS & CONTROL
            // ============================================================================
            '/api/conversations/:id/streaming': {
                curl: `# Check if a conversation has an active background stream
curl -k -X GET "${baseUrl}/api/conversations/conv_abc123/streaming" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/conversations/conv_abc123/streaming" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# Response when streaming:
# { "streaming": true, "content": "partial response...", "reasoning": "",
#   "startTime": 1712345678000, "model": "llama-7b", "clientConnected": false }

# Response when not streaming:
# { "streaming": false }`,
                python: `import requests
import time

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/conversations/{conversation_id}/streaming',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/conversations/{conversation_id}/streaming',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

data = response.json()
if data['streaming']:
    print(f"Active stream: {len(data['content'])} chars, model: {data['model']}")
    print(f"Client connected: {data['clientConnected']}")
    print(f"Elapsed: {(time.time() * 1000 - data['startTime']) / 1000:.1f}s")
else:
    print("No active stream")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv_abc123"

$status = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/streaming" -Headers $headers
if ($status.streaming) {
    Write-Output "Active stream: $($status.content.Length) chars, model: $($status.model)"
    Write-Output "Client connected: $($status.clientConnected)"
} else {
    Write-Output "No active stream"
}`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/streaming\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => {
  if (data.streaming) {
    console.log(\`Active stream: \${data.content.length} chars, model: \${data.model}\`);
    console.log(\`Client connected: \${data.clientConnected}\`);
  } else {
    console.log('No active stream');
  }
})
.catch(err => console.error(err));`
            },
            '/api/conversations/:id/streaming/cancel': {
                curl: `# Cancel an active background stream and save partial response
curl -k -X DELETE "${baseUrl}/api/conversations/conv_abc123/streaming" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X DELETE "${baseUrl}/api/conversations/conv_abc123/streaming" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# Response: { "cancelled": true, "hadContent": true }
# If no active stream: { "cancelled": false, "reason": "No active stream found" }`,
                python: `import requests

conversation_id = "conv_abc123"

# Bearer Token Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}/streaming',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.delete(
    f'${baseUrl}/api/conversations/{conversation_id}/streaming',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

result = response.json()
if result.get('cancelled'):
    print(f"Stream cancelled (had content: {result['hadContent']})")
    if result['hadContent']:
        print("Partial response was saved to the conversation")
else:
    print(f"Not cancelled: {result.get('reason', 'unknown')}")`,
                powershell: `$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$conversationId = "conv_abc123"

$result = Invoke-RestMethod -Uri "${baseUrl}/api/conversations/$conversationId/streaming" -Method Delete -Headers $headers
if ($result.cancelled) {
    Write-Output "Stream cancelled (had content: $($result.hadContent))"
} else {
    Write-Output "Not cancelled: $($result.reason)"
}`,
                javascript: `const conversationId = 'conv_abc123';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/conversations/\${conversationId}/streaming\`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(result => {
  if (result.cancelled) {
    console.log(\`Stream cancelled (had content: \${result.hadContent})\`);
    if (result.hadContent) {
      console.log('Partial response was saved to the conversation');
    }
  } else {
    console.log(\`Not cancelled: \${result.reason}\`);
  }
})
.catch(err => console.error(err));`
            },
            // ============================================================================
            // APPS - START/STOP/RESTART
            // ============================================================================
            '/api/apps/:name/start': {
                curl: `# Start an app
curl -k -X POST "${baseUrl}/api/apps/my-app/start" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X POST "${baseUrl}/api/apps/my-app/start" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

app_name = "my-app"

# Bearer Token Authentication
response = requests.post(
    f'${baseUrl}/api/apps/{app_name}/start',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    f'${baseUrl}/api/apps/{app_name}/start',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print(f"App started: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$appName = "my-app"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/apps/$appName/start" -Method Post -Headers $headers
Write-Output "App started: $($response | ConvertTo-Json)"`,
                javascript: `const appName = 'my-app';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/apps/\${appName}/start\`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => console.log('App started:', data))
.catch(err => console.error(err));`
            },
            '/api/apps/:name/stop': {
                curl: `# Stop an app
curl -k -X POST "${baseUrl}/api/apps/my-app/stop" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X POST "${baseUrl}/api/apps/my-app/stop" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

app_name = "my-app"

# Bearer Token Authentication
response = requests.post(
    f'${baseUrl}/api/apps/{app_name}/stop',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    f'${baseUrl}/api/apps/{app_name}/stop',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print(f"App stopped: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$appName = "my-app"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/apps/$appName/stop" -Method Post -Headers $headers
Write-Output "App stopped"`,
                javascript: `const appName = 'my-app';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/apps/\${appName}/stop\`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => console.log('App stopped:', data))
.catch(err => console.error(err));`
            },
            '/api/apps/:name/restart': {
                curl: `# Restart an app
curl -k -X POST "${baseUrl}/api/apps/my-app/restart" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X POST "${baseUrl}/api/apps/my-app/restart" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

app_name = "my-app"

# Bearer Token Authentication
response = requests.post(
    f'${baseUrl}/api/apps/{app_name}/restart',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    f'${baseUrl}/api/apps/{app_name}/restart',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

print(f"App restarted: {response.json()}")`,
                powershell: `# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
}

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$appName = "my-app"

$response = Invoke-RestMethod -Uri "${baseUrl}/api/apps/$appName/restart" -Method Post -Headers $headers
Write-Output "App restarted"`,
                javascript: `const appName = 'my-app';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/apps/\${appName}/restart\`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => console.log('App restarted:', data))
.catch(err => console.error(err));`
            },
            '/api/model-configs': {
                curl: `# Bearer Token Authentication
curl -k -X GET ${baseUrl}/api/model-configs \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET ${baseUrl}/api/model-configs \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/model-configs',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/model-configs',
    headers={
        'X-API-Key': 'your_api_key',
        'X-API-Secret': 'your_api_secret'
    },
    verify=False
)

configs = response.json()  # { modelName: { contextSize, temperature, ... }, ... }
for name, cfg in configs.items():
    print(name, cfg)`,
                powershell: `# Bearer Token Authentication
$headers = @{ "Authorization" = "Bearer your_bearer_token" }

# OR API Key + Secret Authentication
$headers = @{
    "X-API-Key" = "your_api_key"
    "X-API-Secret" = "your_api_secret"
}

$response = Invoke-RestMethod -Uri "${baseUrl}/api/model-configs" -Method Get -Headers $headers
$response | ConvertTo-Json`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/model-configs', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(configs => console.log(configs))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/model-configs', {
  method: 'GET',
  headers: {
    'X-API-Key': 'your_api_key',
    'X-API-Secret': 'your_api_secret'
  }
})
.then(res => res.json())
.then(configs => console.log(configs))
.catch(err => console.error(err));`
            },
            '/api/pi/install': {
                curl: `# Bash-pipeable installer. Self-corrects: MITM TLS, missing/old Node
# (NodeSource → nvm fallback), missing Pi, missing curl, broken sudo.
# Idempotent.

# Auth required — bearer-mode API key (Authorization: Bearer …).
export MODELSERVER_API_KEY="your_bearer_key"
curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \\
  ${baseUrl}/api/pi/install | bash`,
                python: `import os, subprocess, requests

H = {'Authorization': 'Bearer ' + os.environ['MODELSERVER_API_KEY']}
script = requests.get(f'${baseUrl}/api/pi/install', headers=H, verify=False).text

# Run the installer. The script is idempotent.
env = {**os.environ, 'MODELSERVER_API_KEY': os.environ['MODELSERVER_API_KEY']}
subprocess.run(['bash', '-c', script], check=True, env=env)`,
                powershell: `# Pi's installer is bash-only. From PowerShell, hand off to WSL:
$env:MODELSERVER_API_KEY = "your_bearer_key"
$script = Invoke-RestMethod -Uri "${baseUrl}/api/pi/install" \`
  -Headers @{ Authorization = "Bearer $env:MODELSERVER_API_KEY" } \`
  -SkipCertificateCheck
$script | wsl bash -c "MODELSERVER_API_KEY=$env:MODELSERVER_API_KEY bash"`,
                javascript: `// Fetch the script, then exec via Node's child_process.
import { execSync } from 'node:child_process';
const r = await fetch('${baseUrl}/api/pi/install', {
  headers: { Authorization: 'Bearer ' + process.env.MODELSERVER_API_KEY }
});
const script = await r.text();
execSync(script, { stdio: 'inherit', shell: '/bin/bash', env: process.env });`
            },
            '/api/pi/extension/modelserver.ts': {
                curl: `# Raw TypeScript source for the bundled Pi extension that registers this
# server as an OpenAI-compatible provider and proxies the skill catalog.
# Auth required.
curl -sk -H "Authorization: Bearer your_bearer_key" \\
  ${baseUrl}/api/pi/extension/modelserver.ts \\
  -o ~/.pi/agent/extensions/modelserver/modelserver.ts`,
                python: `import requests, os
H = {'Authorization': 'Bearer ' + os.environ['MODELSERVER_API_KEY']}
src = requests.get(f'${baseUrl}/api/pi/extension/modelserver.ts', headers=H, verify=False).text
print(src[:400])`,
                powershell: `$h = @{ Authorization = "Bearer $env:MODELSERVER_API_KEY" }
Invoke-WebRequest -Uri "${baseUrl}/api/pi/extension/modelserver.ts" -Headers $h \`
  -SkipCertificateCheck -OutFile "$HOME\\.pi\\agent\\extensions\\modelserver\\modelserver.ts"`,
                javascript: `const r = await fetch('${baseUrl}/api/pi/extension/modelserver.ts', {
  headers: { Authorization: 'Bearer ' + process.env.MODELSERVER_API_KEY }
});
const src = await r.text();
console.log(src.slice(0, 400));`
            },
            '/api/pi/extension/package.json': {
                curl: `# Manifest for the bundled Pi extension (declares the typebox dep that
# Pi's npm install --omit=dev will pull in).
curl -sk -H "Authorization: Bearer your_bearer_key" \\
  ${baseUrl}/api/pi/extension/package.json`,
                python: `import requests, os
H = {'Authorization': 'Bearer ' + os.environ['MODELSERVER_API_KEY']}
print(requests.get(f'${baseUrl}/api/pi/extension/package.json', headers=H, verify=False).json())`,
                powershell: `$h = @{ Authorization = "Bearer $env:MODELSERVER_API_KEY" }
Invoke-RestMethod -Uri "${baseUrl}/api/pi/extension/package.json" -Headers $h -SkipCertificateCheck | ConvertTo-Json`,
                javascript: `const pkg = await fetch('${baseUrl}/api/pi/extension/package.json', {
  headers: { Authorization: 'Bearer ' + process.env.MODELSERVER_API_KEY }
}).then(r => r.json());
console.log(pkg.name, pkg.version);`
            },
            '/api/agent-permissions': {
                curl: `# GET — fetch the current global agent file-operation permissions.
curl -sk ${baseUrl}/api/agent-permissions \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# PUT — update the permissions (any field omitted keeps its previous value).
curl -sk -X PUT ${baseUrl}/api/agent-permissions \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "allowFileRead": true,
    "allowFileWrite": false,
    "allowFileDelete": false,
    "allowToolExecution": true,
    "allowModelAccess": true,
    "allowCollaboration": true
  }'`,
                python: `import requests
H = {'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'}
# GET
print(requests.get(f'${baseUrl}/api/agent-permissions', headers=H, verify=False).json())
# PUT
print(requests.put(f'${baseUrl}/api/agent-permissions', headers={**H, 'Content-Type': 'application/json'},
                   json={'allowFileWrite': False, 'allowFileDelete': False}, verify=False).json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/agent-permissions" -Headers $h
Invoke-RestMethod -Uri "${baseUrl}/api/agent-permissions" -Method Put -Headers $h \`
  -ContentType 'application/json' \`
  -Body (@{ allowFileWrite = $false; allowFileDelete = $false } | ConvertTo-Json)`,
                javascript: `const h = { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' };
fetch('${baseUrl}/api/agent-permissions', { headers: h }).then(r => r.json()).then(console.log);
fetch('${baseUrl}/api/agent-permissions', {
  method: 'PUT',
  headers: { ...h, 'Content-Type': 'application/json' },
  body: JSON.stringify({ allowFileWrite: false, allowFileDelete: false })
}).then(r => r.json()).then(console.log);`
            },
            '/api/agent/file/delete': {
                curl: `# Deletes a file. Requires \`agents\` permission AND global allowFileDelete.
curl -sk -X POST ${baseUrl}/api/agent/file/delete \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{ "filePath": "/models/.modelserver/agents/sandbox/temp.txt" }'`,
                python: `import requests
H = {'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret', 'Content-Type': 'application/json'}
r = requests.post(f'${baseUrl}/api/agent/file/delete', headers=H,
                  json={'filePath': '/models/.modelserver/agents/sandbox/temp.txt'}, verify=False)
print(r.json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/agent/file/delete" -Method Post -Headers $h \`
  -ContentType 'application/json' -Body (@{ filePath = '/models/.modelserver/agents/sandbox/temp.txt' } | ConvertTo-Json)`,
                javascript: `fetch('${baseUrl}/api/agent/file/delete', {
  method: 'POST',
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ filePath: '/models/.modelserver/agents/sandbox/temp.txt' })
}).then(r => r.json()).then(console.log);`
            },
            '/api/agent/file/move': {
                curl: `# Moves or renames a file. Requires \`agents\` permission.
curl -sk -X POST ${baseUrl}/api/agent/file/move \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sourcePath": "/models/.modelserver/agents/sandbox/old.txt",
    "destPath":   "/models/.modelserver/agents/sandbox/new.txt"
  }'`,
                python: `import requests
H = {'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret', 'Content-Type': 'application/json'}
r = requests.post(f'${baseUrl}/api/agent/file/move', headers=H,
                  json={'sourcePath': 'sandbox/old.txt', 'destPath': 'sandbox/new.txt'}, verify=False)
print(r.json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
$body = @{ sourcePath = 'sandbox/old.txt'; destPath = 'sandbox/new.txt' } | ConvertTo-Json
Invoke-RestMethod -Uri "${baseUrl}/api/agent/file/move" -Method Post -Headers $h -ContentType 'application/json' -Body $body`,
                javascript: `fetch('${baseUrl}/api/agent/file/move', {
  method: 'POST',
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ sourcePath: 'sandbox/old.txt', destPath: 'sandbox/new.txt' })
}).then(r => r.json()).then(console.log);`
            },
            '/api/agents/skills/available': {
                curl: `# Lists every enabled skill (without source code) — used by agents to discover capabilities.
curl -sk ${baseUrl}/api/agents/skills/available \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests
r = requests.get(f'${baseUrl}/api/agents/skills/available',
                 headers={'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'}, verify=False)
for s in r.json(): print(s['name'], '-', s['description'])`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
(Invoke-RestMethod -Uri "${baseUrl}/api/agents/skills/available" -Headers $h) |
  ForEach-Object { "$($_.name) - $($_.description)" }`,
                javascript: `fetch('${baseUrl}/api/agents/skills/available', {
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' }
}).then(r => r.json()).then(skills => skills.forEach(s => console.log(s.name, '-', s.description)));`
            },
            '/api/agents/skills/discover': {
                curl: `# Filter the catalog by type or free-text query (matches name + description).
curl -sk "${baseUrl}/api/agents/skills/discover?type=python&query=file" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests
r = requests.get(f'${baseUrl}/api/agents/skills/discover',
                 params={'type': 'python', 'query': 'file'},
                 headers={'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'}, verify=False)
print(r.json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/agents/skills/discover?type=python&query=file" -Headers $h`,
                javascript: `const u = new URL('${baseUrl}/api/agents/skills/discover');
u.searchParams.set('type', 'python');
u.searchParams.set('query', 'file');
fetch(u, { headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' } })
  .then(r => r.json()).then(console.log);`
            },
            '/api/agents/skills/recommend': {
                curl: `# Keyword-rank skills against a free-text task description.
curl -sk -X POST ${baseUrl}/api/agents/skills/recommend \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{ "taskDescription": "summarize a pdf and email me the result" }'`,
                python: `import requests
r = requests.post(f'${baseUrl}/api/agents/skills/recommend',
                  headers={'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret',
                           'Content-Type': 'application/json'},
                  json={'taskDescription': 'summarize a pdf and email me the result'}, verify=False)
print(r.json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/agents/skills/recommend" -Method Post -Headers $h \`
  -ContentType 'application/json' \`
  -Body (@{ taskDescription = 'summarize a pdf and email me the result' } | ConvertTo-Json)`,
                javascript: `fetch('${baseUrl}/api/agents/skills/recommend', {
  method: 'POST',
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ taskDescription: 'summarize a pdf and email me the result' })
}).then(r => r.json()).then(console.log);`
            },
            '/api/markdown-skills': {
                curl: `# GET — list markdown "how-to" skills the chat model can load via load_skill.
curl -sk ${baseUrl}/api/markdown-skills \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"

# POST — create a new markdown skill.
curl -sk -X POST ${baseUrl}/api/markdown-skills \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "research-github-repo",
    "description": "Step-by-step guide to research a GitHub repository.",
    "triggers": ["github", "repo research"],
    "body": "# Steps\\n1. Fetch README\\n2. ...",
    "enabled": true
  }'`,
                python: `import requests
H = {'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'}
print(requests.get(f'${baseUrl}/api/markdown-skills', headers=H, verify=False).json())
print(requests.post(f'${baseUrl}/api/markdown-skills',
    headers={**H, 'Content-Type': 'application/json'},
    json={'name': 'research-github-repo',
          'description': 'Step-by-step guide to research a GitHub repository.',
          'triggers': ['github', 'repo research'],
          'body': '# Steps\\n1. Fetch README\\n2. ...',
          'enabled': True}, verify=False).json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/markdown-skills" -Headers $h
Invoke-RestMethod -Uri "${baseUrl}/api/markdown-skills" -Method Post -Headers $h \`
  -ContentType 'application/json' \`
  -Body (@{ name='research-github-repo'; description='Guide.'; triggers=@('github'); body='# Steps'; enabled=$true } | ConvertTo-Json)`,
                javascript: `const h = { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' };
fetch('${baseUrl}/api/markdown-skills', { headers: h }).then(r => r.json()).then(console.log);
fetch('${baseUrl}/api/markdown-skills', {
  method: 'POST',
  headers: { ...h, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'research-github-repo',
    description: 'Step-by-step guide to research a GitHub repository.',
    triggers: ['github', 'repo research'],
    body: '# Steps\\n1. Fetch README\\n2. ...',
    enabled: true
  })
}).then(r => r.json()).then(console.log);`
            },
            '/api/markdown-skills/:id': {
                curl: `# GET, PUT, and DELETE a single markdown skill by id.
curl -sk ${baseUrl}/api/markdown-skills/SKILL_ID \\
  -H "X-API-Key: your_api_key" -H "X-API-Secret: your_api_secret"

curl -sk -X PUT ${baseUrl}/api/markdown-skills/SKILL_ID \\
  -H "X-API-Key: your_api_key" -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{ "enabled": false }'

curl -sk -X DELETE ${baseUrl}/api/markdown-skills/SKILL_ID \\
  -H "X-API-Key: your_api_key" -H "X-API-Secret: your_api_secret"`,
                python: `import requests
H = {'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'}
sid = 'SKILL_ID'
print(requests.get(f'${baseUrl}/api/markdown-skills/{sid}', headers=H, verify=False).json())
print(requests.put(f'${baseUrl}/api/markdown-skills/{sid}',
    headers={**H, 'Content-Type': 'application/json'},
    json={'enabled': False}, verify=False).json())
print(requests.delete(f'${baseUrl}/api/markdown-skills/{sid}', headers=H, verify=False).json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
$sid = 'SKILL_ID'
Invoke-RestMethod -Uri "${baseUrl}/api/markdown-skills/$sid" -Headers $h
Invoke-RestMethod -Uri "${baseUrl}/api/markdown-skills/$sid" -Method Put -Headers $h \`
  -ContentType 'application/json' -Body (@{ enabled = $false } | ConvertTo-Json)
Invoke-RestMethod -Uri "${baseUrl}/api/markdown-skills/$sid" -Method Delete -Headers $h`,
                javascript: `const h = { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' };
const id = 'SKILL_ID';
fetch(\`${baseUrl}/api/markdown-skills/\${id}\`, { headers: h }).then(r => r.json()).then(console.log);
fetch(\`${baseUrl}/api/markdown-skills/\${id}\`, {
  method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: false })
}).then(r => r.json()).then(console.log);
fetch(\`${baseUrl}/api/markdown-skills/\${id}\`, { method: 'DELETE', headers: h })
  .then(r => r.json()).then(console.log);`
            },
            '/api/sandbox/run-code': {
                curl: `# Run a Python snippet in a sandboxed container (no network, 30s default, 256m RAM).
# Files saved to /artifacts/ become downloadable via /api/tool-artifacts/:runId/:filename.
curl -sk -X POST ${baseUrl}/api/sandbox/run-code \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "language": "python",
    "code": "import statistics\\nprint(statistics.mean([1,2,3,4,5]))",
    "timeoutMs": 30000
  }'`,
                python: `import requests
r = requests.post(f'${baseUrl}/api/sandbox/run-code',
    headers={'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret',
             'Content-Type': 'application/json'},
    json={'language': 'python',
          'code': 'import statistics\\nprint(statistics.mean([1,2,3,4,5]))',
          'timeoutMs': 30000},
    verify=False)
res = r.json()
print('stdout:', res.get('stdout')); print('artifacts:', res.get('artifacts'))`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
$body = @{ language='python'; code="print(2+2)"; timeoutMs=30000 } | ConvertTo-Json
$r = Invoke-RestMethod -Uri "${baseUrl}/api/sandbox/run-code" -Method Post -Headers $h \`
       -ContentType 'application/json' -Body $body
$r.stdout`,
                javascript: `fetch('${baseUrl}/api/sandbox/run-code', {
  method: 'POST',
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    language: 'python',
    code: 'import statistics\\nprint(statistics.mean([1,2,3,4,5]))',
    timeoutMs: 30000
  })
}).then(r => r.json()).then(({ stdout, artifacts }) => console.log({ stdout, artifacts }));`
            },
            '/api/tool-artifacts/:runId/:filename': {
                curl: `# Download a file produced by a sandboxed tool/skill run.
# runId is the crypto-random hex id returned in the tool result; filename is path-validated.
curl -sk ${baseUrl}/api/tool-artifacts/RUN_ID_HEX/frame.png \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -o frame.png`,
                python: `import requests
runId = 'RUN_ID_HEX'; name = 'frame.png'
r = requests.get(f'${baseUrl}/api/tool-artifacts/{runId}/{name}',
                 headers={'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'},
                 verify=False)
open(name, 'wb').write(r.content)`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-WebRequest -Uri "${baseUrl}/api/tool-artifacts/RUN_ID_HEX/frame.png" -Headers $h -OutFile frame.png`,
                javascript: `const runId = 'RUN_ID_HEX', name = 'frame.png';
fetch(\`${baseUrl}/api/tool-artifacts/\${runId}/\${name}\`, {
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' }
}).then(r => r.blob()).then(b => console.log('size:', b.size));`
            },
            '/api/system/tools-catalog': {
                curl: `# Lists every tool the chat model sees (native tools + per-user enabled skills).
curl -sk ${baseUrl}/api/system/tools-catalog \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests
r = requests.get(f'${baseUrl}/api/system/tools-catalog',
                 headers={'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'},
                 verify=False)
print(r.json())  # { count, staticCount, tools: [...] }`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/system/tools-catalog" -Headers $h | Format-List`,
                javascript: `fetch('${baseUrl}/api/system/tools-catalog', {
  headers: { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' }
}).then(r => r.json()).then(console.log);`
            },
            '/api/system/egress-proxy': {
                curl: `# Admin-only: stats for the sandbox network egress allowlist.
curl -sk ${baseUrl}/api/system/egress-proxy \\
  -H "X-API-Key: your_admin_api_key" \\
  -H "X-API-Secret: your_admin_api_secret"`,
                python: `import requests
r = requests.get(f'${baseUrl}/api/system/egress-proxy',
                 headers={'X-API-Key': 'your_admin_api_key', 'X-API-Secret': 'your_admin_api_secret'},
                 verify=False)
print(r.json())  # grant counts, rejection reasons, listening state`,
                powershell: `$h = @{ 'X-API-Key' = 'your_admin_api_key'; 'X-API-Secret' = 'your_admin_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/system/egress-proxy" -Headers $h`,
                javascript: `fetch('${baseUrl}/api/system/egress-proxy', {
  headers: { 'X-API-Key': 'your_admin_api_key', 'X-API-Secret': 'your_admin_api_secret' }
}).then(r => r.json()).then(console.log);`
            },
            '/api/docs': {
                curl: `# Look up reference docs from DevDocs.io. Requires \`query\` permission.
# Without ?query, returns the index for the library.
curl -sk "${baseUrl}/api/docs?library=python" \\
  -H "X-API-Key: your_api_key" -H "X-API-Secret: your_api_secret"

# With ?query, returns matching entries.
curl -sk "${baseUrl}/api/docs?library=javascript&query=Array.prototype.map" \\
  -H "X-API-Key: your_api_key" -H "X-API-Secret: your_api_secret"`,
                python: `import requests
H = {'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret'}
print(requests.get(f'${baseUrl}/api/docs',
                   params={'library': 'python'}, headers=H, verify=False).json())
print(requests.get(f'${baseUrl}/api/docs',
                   params={'library': 'javascript', 'query': 'Array.prototype.map'},
                   headers=H, verify=False).json())`,
                powershell: `$h = @{ 'X-API-Key' = 'your_api_key'; 'X-API-Secret' = 'your_api_secret' }
Invoke-RestMethod -Uri "${baseUrl}/api/docs?library=python" -Headers $h
Invoke-RestMethod -Uri "${baseUrl}/api/docs?library=javascript&query=Array.prototype.map" -Headers $h`,
                javascript: `const h = { 'X-API-Key': 'your_api_key', 'X-API-Secret': 'your_api_secret' };
fetch(\`${baseUrl}/api/docs?library=python\`, { headers: h }).then(r => r.json()).then(console.log);
fetch(\`${baseUrl}/api/docs?library=javascript&query=Array.prototype.map\`, { headers: h })
  .then(r => r.json()).then(console.log);`
            },
            '/v1/chat/completions': {
                curl: `# OpenAI-compatible passthrough — forwards to the first running model instance.
# Honors client-supplied tools, tool_choice, stream. Server does NOT inject its
# own tool catalog or run the tool loop on this path (use /api/chat/stream for that).
# Requires the API key to have the \`query\` permission.
curl -sk -X POST ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "any",  // ignored — server picks the first running instance
    "messages": [{ "role": "user", "content": "Hello!" }],
    "stream": false
  }'

# Also reachable: /v1/models, /v1/completions, /v1/embeddings — anything the
# underlying sglang/llama.cpp instance exposes.
curl -sk ${baseUrl}/v1/models \\
  -H "Authorization: Bearer your_bearer_token"`,
                python: `from openai import OpenAI
# The OpenAI SDK works directly against the proxy.
client = OpenAI(
    base_url='${baseUrl}/v1',
    api_key='your_bearer_token',  # passed as Authorization: Bearer
    default_headers={},
)
resp = client.chat.completions.create(
    model='any',  # ignored by the proxy
    messages=[{'role': 'user', 'content': 'Hello!'}],
)
print(resp.choices[0].message.content)`,
                powershell: `$h = @{ 'Authorization' = 'Bearer your_bearer_token'; 'Content-Type' = 'application/json' }
$body = @{
  model    = 'any'
  messages = @(@{ role = 'user'; content = 'Hello!' })
  stream   = $false
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "${baseUrl}/v1/chat/completions" -Method Post -Headers $h -ContentType 'application/json' -Body $body`,
                javascript: `// Drop-in OpenAI SDK usage.
const res = await fetch('${baseUrl}/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'any',  // ignored — server picks the first running instance
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: false
  })
});
console.log(await res.json());`
            }
        };

        const code = examples[endpoint]?.[lang] || `// No specific example available for ${endpoint}
// Follow the pattern shown in similar endpoints with the appropriate HTTP method`;

        // Filter code based on selected auth type
        if (code && apiBuilderAuthType) {
            const lines = code.split('\n');
            const filteredLines = [];
            let skipUntilNextSection = false;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lowerLine = line.toLowerCase();

                // Detect auth section markers
                const isBearerMarker = lowerLine.includes('bearer token') && (lowerLine.includes('#') || lowerLine.includes('//'));
                const isApiKeyMarker = (lowerLine.includes('api key') || lowerLine.includes('apikey')) &&
                                       (lowerLine.includes('# or') || lowerLine.includes('// or'));

                if (apiBuilderAuthType === 'bearer') {
                    // Skip API Key sections (marked with "# OR API Key" or "// OR API Key")
                    if (isApiKeyMarker) {
                        skipUntilNextSection = true;
                        continue;
                    }
                    // Stop skipping when we hit a blank line followed by actual code (not headers)
                    if (skipUntilNextSection) {
                        if (line.trim() === '' && i + 1 < lines.length) {
                            const nextLine = lines[i + 1].toLowerCase().trim();
                            const isHeaderLine = nextLine.startsWith('"') || nextLine.startsWith("'") ||
                                                nextLine === '}' || nextLine.startsWith('$headers');
                            if (!isHeaderLine && nextLine !== '') {
                                skipUntilNextSection = false;
                            }
                        }
                        continue;
                    }
                    // Remove "# Bearer Token Authentication" comment since it's the only option now
                    if (isBearerMarker) {
                        continue;
                    }
                    filteredLines.push(line);
                } else {
                    // apikey auth - Skip Bearer sections and show API Key sections
                    if (isBearerMarker && !lowerLine.includes('or')) {
                        skipUntilNextSection = true;
                        continue;
                    }
                    if (isApiKeyMarker) {
                        skipUntilNextSection = false;
                        continue; // Skip the "# OR API Key" marker line itself
                    }
                    if (skipUntilNextSection) {
                        // Stop skipping when we hit actual code after headers
                        if (line.trim() === '' && i + 1 < lines.length) {
                            const nextLine = lines[i + 1].toLowerCase().trim();
                            const isHeaderLine = nextLine.startsWith('"') || nextLine.startsWith("'") ||
                                                nextLine === '}' || nextLine.startsWith('$headers') ||
                                                nextLine.startsWith('headers') || nextLine.startsWith('{');
                            if (!isHeaderLine && nextLine !== '' && !nextLine.includes('api key') && !nextLine.includes('bearer')) {
                                skipUntilNextSection = false;
                            }
                        }
                        continue;
                    }
                    filteredLines.push(line);
                }
            }

            // Clean up leading/trailing blank lines
            let result = filteredLines.join('\n');
            result = result.replace(/^\n+/, '').replace(/\n+$/, '');

            // Post-processing pass: replace any remaining Bearer auth with API Key auth
            // This handles endpoints that only have Bearer auth (no "# OR API Key" section)
            if (apiBuilderAuthType === 'apikey') {
                // PowerShell: "Authorization" = "Bearer ..." → X-API-Key + X-API-Secret
                result = result.replace(
                    /^(\s*)"Authorization"\s*=\s*"Bearer\s+[^"]*"/gm,
                    '$1"X-API-Key" = "your_api_key"\n$1"X-API-Secret" = "your_api_secret"'
                );
                // Python/JS single quotes: 'Authorization': 'Bearer ...' → X-API-Key + X-API-Secret
                result = result.replace(
                    /^(\s*)'Authorization':\s*'Bearer\s+[^']*',?/gm,
                    "$1'X-API-Key': 'your_api_key',\n$1'X-API-Secret': 'your_api_secret',"
                );
                // Python/JS double quotes: "Authorization": "Bearer ..." (in fetch headers)
                result = result.replace(
                    /^(\s*)"Authorization":\s*"Bearer\s+[^"]*",?/gm,
                    '$1"X-API-Key": "your_api_key",\n$1"X-API-Secret": "your_api_secret",'
                );
                // curl: -H "Authorization: Bearer ..." → -H "X-API-Key: ..." + -H "X-API-Secret: ..."
                result = result.replace(
                    /^(\s*)-H\s*"Authorization:\s*Bearer\s+[^"]*"\s*\\?/gm,
                    '$1-H "X-API-Key: your_api_key" \\\n$1-H "X-API-Secret: your_api_secret" \\'
                );
                // Remove leftover "# Bearer Token Authentication" comments
                result = result.replace(/^[ \t]*#\s*Bearer Token Authentication\s*\n?/gm, '');
                result = result.replace(/^[ \t]*\/\/\s*Bearer Token Authentication\s*\n?/gm, '');
            }

            // PowerShell: Add SSL certificate bypass for self-signed certs
            if (apiBuilderLang === 'powershell') {
                result = '# Bypass SSL certificate validation (self-signed certs)\n[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }\n\n' + result;
                result = result + '\n\n# Restore default SSL certificate validation\n[System.Net.ServicePointManager]::ServerCertificateValidationCallback = $null';
            }

            return result;
        }

        return code;
    };

    // Tab reordering handlers with drag and drop
    const [draggedTab, setDraggedTab] = useState(null);

    // Admin-only tab IDs (API Keys = 3, Apps = 6)
    const adminOnlyTabIds = [3, 6];

    const handleDragStart = (e, index) => {
        setDraggedTab(index);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e, index) => {
        e.preventDefault();
        if (draggedTab === null || draggedTab === index) return;

        // For non-admin users, we need to work with visibleTabOrder indices
        // but update the full tabOrder state
        const currentVisibleOrder = user?.role === 'admin'
            ? tabOrder
            : tabOrder.filter(tabId => !adminOnlyTabIds.includes(tabId));

        const draggedTabId = currentVisibleOrder[draggedTab];
        const targetTabId = currentVisibleOrder[index];

        // Find positions in the full tabOrder
        const draggedFullIndex = tabOrder.indexOf(draggedTabId);
        const targetFullIndex = tabOrder.indexOf(targetTabId);

        const newOrder = [...tabOrder];
        newOrder.splice(draggedFullIndex, 1);
        newOrder.splice(targetFullIndex, 0, draggedTabId);

        setTabOrder(newOrder);
        setDraggedTab(index);
        localStorage.setItem('tabOrder', JSON.stringify(newOrder));
    };

    const handleDragEnd = () => {
        setDraggedTab(null);
    };

    const handleTabChange = (event, newValue) => {
        setActiveTab(newValue);
    };

    // Docs accordion reordering handlers
    const handleDocsAccordionMove = (currentIndex, direction) => {
        const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (newIndex < 0 || newIndex >= docsAccordionOrder.length) return;

        const newOrder = [...docsAccordionOrder];
        const temp = newOrder[currentIndex];
        newOrder[currentIndex] = newOrder[newIndex];
        newOrder[newIndex] = temp;

        setDocsAccordionOrder(newOrder);
        localStorage.setItem('docsAccordionOrder', JSON.stringify(newOrder));
    };

    // Tab definitions — sidebar icons via lucide-react for a sleeker
    // monoline aesthetic (chat:3002 already uses lucide). MUI Material
    // Icons feel out of place in a Tailwind/CSS-var design system.
    const tabDefinitions = [
        { id: 0, icon: <LucideSearch size={18} strokeWidth={1.75} />,    label: 'Discover' },
        { id: 1, icon: <LucideHardDrive size={18} strokeWidth={1.75} />, label: 'My Models' },
        { id: 2, icon: <LucideUsers size={18} strokeWidth={1.75} />,     label: 'Users' },
        { id: 3, icon: <LucideKey size={18} strokeWidth={1.75} />,       label: 'API Keys', adminOnly: true },
        { id: 4, icon: <LucideBookOpen size={18} strokeWidth={1.75} />,  label: 'Docs' },
        { id: 5, icon: <LucideTerminal size={18} strokeWidth={1.75} />,  label: 'Logs' },
        { id: 6, icon: <LucideLayoutGrid size={18} strokeWidth={1.75} />, label: 'Apps', adminOnly: true },
        { id: 7, icon: <LucideBot size={18} strokeWidth={1.75} />,        label: 'Agent' }
    ];

    // Filter tabs based on user role - hide admin-only tabs for non-admin users
    const isAdmin = user?.role === 'admin';
    const visibleTabOrder = isAdmin
        ? tabOrder
        : tabOrder.filter(tabId => !tabDefinitions.find(t => t.id === tabId)?.adminOnly);

    // Size filter ranges (in billions)
    const SIZE_FILTERS = {
        all: { min: null, max: null, label: 'All Sizes' },
        small: { min: 0, max: 3.5, label: '≤3B' },
        medium: { min: 3.5, max: 14, label: '7B-13B' },
        large: { min: 14, max: 40, label: '14B-40B' },
        xlarge: { min: 40, max: null, label: '40B+' }
    };

    // HuggingFace handlers
    const handleSearch = () => {
        setSearching(true);
        setSearchPage(1); // Reset to first page on new search

        // Build query params
        const params = new URLSearchParams();
        if (searchQuery.trim()) {
            params.append('query', searchQuery);
        }
        params.append('sortBy', searchSortBy);
        params.append('format', searchFormat);

        // Add size filter if not 'all'
        const sizeFilter = SIZE_FILTERS[searchSizeFilter];
        if (sizeFilter.min !== null) {
            params.append('minSize', sizeFilter.min);
        }
        if (sizeFilter.max !== null) {
            params.append('maxSize', sizeFilter.max);
        }

        fetch(`/api/huggingface/search?${params.toString()}`, {
        })
            .then(res => res.json())
            .then(data => {
                setSearchResults(data);
                setSearching(false);
                setRepoSizes({});
                // Non-GGUF formats have no per-file picker — hydrate repo
                // size in the background so the user can see how big the
                // download will be before clicking Load.
                const targets = (data || []).filter(m => m.format && m.format !== 'gguf');
                if (targets.length > 0) hydrateRepoSizes(targets.map(m => m.id));
            })
            .catch(error => {
                showSnackbar(`Search failed: ${error.message}`, 'error');
                setSearching(false);
            });
    };

    // Fetch repo size for each id with a small concurrency cap so we don't
    // open 100 sockets to huggingface.co when a search returns 100 results.
    const hydrateRepoSizes = async (repoIds) => {
        const CONCURRENCY = 6;
        const queue = [...repoIds];
        setRepoSizes(prev => {
            const next = { ...prev };
            for (const id of repoIds) if (!next[id]) next[id] = { loading: true };
            return next;
        });
        const worker = async () => {
            while (queue.length > 0) {
                const id = queue.shift();
                if (!id) return;
                try {
                    const res = await fetch(`/api/huggingface/repo-size/${id}`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    setRepoSizes(prev => ({
                        ...prev,
                        [id]: { totalBytes: data.totalBytes, weightBytes: data.weightBytes }
                    }));
                } catch (err) {
                    setRepoSizes(prev => ({ ...prev, [id]: { error: err.message } }));
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    };

    const handleSelectModel = (modelId, modelFormat) => {
        // Non-GGUF formats (safetensors / AWQ / GPTQ / FP8 / NVFP4 / BnB)
        // are loaded by sglang directly from the HF repo id — there's no
        // single-file pull step. Open a dedicated load dialog so the user
        // can set max-model-len / GPU mem / tensor-parallel before launch.
        if (modelFormat && modelFormat !== 'gguf' && modelFormat !== 'unknown') {
            // Prefill tensorParallelSize with the detected GPU count so sglang
            // fans across every GPU by default. Falls back to whatever the
            // dialog already had if /api/system/resources is unreachable.
            fetch('/api/system/resources').then(r => r.json()).then(d => {
                const gpus = d?.gpu?.count || d?.gpus?.length || 1;
                setHfLoadConfig(c => ({ ...c, tensorParallelSize: gpus }));
            }).catch(() => {});
            setHfLoadDialog({ open: true, repoId: modelId, format: modelFormat });
            return;
        }
        const [owner, repo] = modelId.split('/');
        fetch(`/api/huggingface/files/${owner}/${repo}`, {
        })
            .then(res => res.json())
            .then(files => {
                if (files.length > 0) {
                    setGgufRepo(modelId);
                    setSelectedModelFiles(files);
                    showSnackbar(`Found ${files.length} GGUF files`, 'success');
                } else {
                    showSnackbar('No GGUF files found in this repository', 'warning');
                }
            })
            .catch(error => showSnackbar(`Failed to fetch files: ${error.message}`, 'error'));
    };

    const handleLoadHf = () => {
        const { repoId, format } = hfLoadDialog;
        if (!repoId) return;
        setHfLoading(true);
        fetch('/api/models/load-hf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoId,
                format,
                maxModelLen: Number(hfLoadConfig.maxModelLen) || 4096,
                memFractionStatic: Number(hfLoadConfig.memFractionStatic) || 0.88,
                tensorParallelSize: Number(hfLoadConfig.tensorParallelSize) || 1,
                cpuOffloadGb: Number(hfLoadConfig.cpuOffloadGb) || 0,
                kvCacheDtype: hfLoadConfig.kvCacheDtype || 'auto',
                trustRemoteCode: !!hfLoadConfig.trustRemoteCode,
                enforceEager: !!hfLoadConfig.enforceEager,
                contextShift: !!hfLoadConfig.contextShift,
                disableThinking: !!hfLoadConfig.disableThinking,
                compressMemory: !!hfLoadConfig.compressMemory,
                toolCallParser: hfLoadConfig.toolCallParser || undefined
            })
        })
        .then(async res => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            return body;
        })
        .then(data => {
            showSnackbar(`sglang starting "${repoId}" on port ${data.port} — first launch will download weights`, 'success');
            setHfLoadDialog({ open: false, repoId: '', format: '' });
            fetchInstances();
        })
        .catch(err => showSnackbar(`Load failed: ${err.message}`, 'error'))
        .finally(() => setHfLoading(false));
    };

    const fetchHfCache = () => {
        setHfCacheLoading(true);
        fetch('/api/models/hf-cache')
            .then(res => res.json())
            .then(data => {
                setHfCacheEntries(data.entries || []);
                setHfCacheTotalBytes(data.totalBytes || 0);
            })
            .catch(() => { /* silent — endpoint may be unavailable on first load */ })
            .finally(() => setHfCacheLoading(false));
    };

    const handleDeleteHfCache = (entry) => {
        if (!window.confirm(`Delete cached HF model "${entry.repoId}" (${formatBytes(entry.sizeBytes)})?\n\nNext load will re-download.`)) return;
        fetch(`/api/models/hf-cache/${encodeURIComponent(entry.dirName)}`, { method: 'DELETE' })
            .then(async r => {
                const body = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
                showSnackbar(`Deleted "${entry.repoId}" from HF cache`, 'success');
                fetchHfCache();
            })
            .catch(err => showSnackbar(`Delete failed: ${err.message}`, 'error'));
    };

    const handleReloadHfCache = (entry) => {
        setHfLoadDialog({ open: true, repoId: entry.repoId, format: 'cached' });
    };

    const formatBytes = (n) => {
        if (!n || n < 0) return '—';
        const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        let i = 0; let v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
    };

    const handleSelectGGUFFile = (filename) => {
        setGgufFile(filename);
    };

    const handlePullModel = () => {
        if (!ggufRepo || !ggufFile) {
            showSnackbar('Please provide both repository and file name', 'warning');
            return;
        }
        setLoading(true);
        fetch('/api/models/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ggufRepo, ggufFile }),
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => { throw new Error(err.error || 'Failed to start download'); });
            }
            return response.json();
        })
        .then(data => {
            showSnackbar(data.message, 'success');
            setLoading(false); // Reset loading immediately after download starts
        })
        .catch(error => {
            showSnackbar(error.message, 'error');
            setLoading(false);
        });
    };

    // Model instance handlers
    const handleLoadModel = (modelName) => {
        // Local /models/<name> directories are always GGUF (the only path
        // that produces them is the HF GGUF pull flow), so they always go
        // to llama.cpp. Non-GGUF models use the Load-via-sglang dialog from
        // the search results — this opens the matching llama.cpp dialog.
        setLlamacppLoadDialog({ open: true, modelName });
    };

    const handleLoadLlamacppFromDialog = () => {
        const modelName = llamacppLoadDialog.modelName;
        if (!modelName) return;
        setLlamacppLoading(true);
        const config = { backend: 'llamacpp', ...llamacppConfig };

        fetch(`/api/models/${encodeURIComponent(modelName)}/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => { throw new Error(err.error || 'Failed to load model'); });
            }
            return response.json();
        })
        .then(data => {
            showSnackbar(`Instance running on port ${data.port} (${data.backend})`, 'success');
            fetchModels();
            fetchInstances();
            setLlamacppLoadDialog({ open: false, modelName: '' });
        })
        .catch(error => showSnackbar(error.message, 'error'))
        .finally(() => setLlamacppLoading(false));
    };

    // Fetch optimal settings based on hardware and model size
    const fetchOptimalSettings = async (model) => {
        if (!model || !model.fileSize) {
            showSnackbar('Model file size information not available', 'warning');
            return;
        }

        setLoadingOptimalSettings(true);
        setSelectedModelForOptimal(model.name);
        setOptimalSettingsNotes([]);

        try {
            const response = await fetch('/api/system/optimal-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modelFileSize: model.fileSize,
                    modelName: model.name,
                    backend: 'llamacpp'
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to get optimal settings');
            }

            const data = await response.json();

            setLlamacppConfig(prev => ({
                ...prev,
                nGpuLayers: data.settings.nGpuLayers,
                contextSize: data.settings.contextSize,
                flashAttention: data.settings.flashAttention,
                cacheTypeK: data.settings.cacheTypeK,
                cacheTypeV: data.settings.cacheTypeV,
                threads: data.settings.threads,
                parallelSlots: data.settings.parallelSlots,
                batchSize: data.settings.batchSize,
                ubatchSize: data.settings.ubatchSize,
                repeatPenalty: data.settings.repeatPenalty,
                repeatLastN: data.settings.repeatLastN,
                presencePenalty: data.settings.presencePenalty,
                frequencyPenalty: data.settings.frequencyPenalty,
                swaFull: data.settings.swaFull === true
            }));

            setOptimalSettingsNotes(data.notes || []);

            const hardwareInfo = data.hardware.gpuFreeGB
                ? `${data.hardware.gpuCount} GPU(s) · ${data.hardware.gpuFreeGB}/${data.hardware.gpuMemoryGB}GB free, ${data.hardware.cpuCores} CPU cores`
                : `${data.hardware.gpuCount} GPU(s) with ${data.hardware.gpuMemoryGB}GB VRAM, ${data.hardware.cpuCores} CPU cores`;
            showSnackbar(`Optimal settings applied for ${model.name} (${hardwareInfo})`, 'success');
        } catch (error) {
            showSnackbar(error.message, 'error');
        } finally {
            setLoadingOptimalSettings(false);
        }
    };

    const handleStopInstance = (modelName, backend = 'llamacpp') => {
        showSnackbar(`Stopping ${modelName}...`, 'info');
        // HF-repo instance keys contain '/' (e.g. owner/name), which would split
        // the URL into too many segments and fall through to a 404 — encode it.
        const encodedName = encodeURIComponent(modelName);
        const endpoint = backend === 'sglang'
            ? `/api/sglang/instances/${encodedName}`
            : `/api/llamacpp/instances/${encodedName}`;
        fetch(endpoint, {
            method: 'DELETE',
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => { throw new Error(err.error || 'Failed to stop instance'); });
            }
            return response.json();
        })
        .then(data => {
            showSnackbar(data.message, 'success');
            fetchModels();
            fetchInstances();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleDeleteModel = (modelName) => {
        if (!window.confirm(`Delete ${modelName}? This will also stop any running instance.`)) return;
        showSnackbar(`Deleting ${modelName}...`, 'info');
        fetch(`/api/models/${modelName}`, {
            method: 'DELETE',
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => { throw new Error(err.error || 'Failed to delete model'); });
            }
            return response.json();
        })
        .then(data => {
            showSnackbar(data.message, 'success');
            fetchModels();
            fetchInstances();
            if (selectedModelForPrompt === modelName) {
                setSelectedModelForPrompt('');
                setCurrentSystemPrompt('');
            }
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    // Download handlers
    const handleCancelDownload = (downloadId) => {
        fetch(`/api/downloads/${downloadId}`, {
            method: 'DELETE',
        })
        .then(response => response.json())
        .then(data => {
            showSnackbar(data.message, 'info');
            fetchDownloads();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    // Apps management handlers
    const handleAppStart = (appName) => {
        showSnackbar(`Starting ${appName}...`, 'info');
        fetch(`/api/apps/${appName}/start`, {
            method: 'POST',
        })
        .then(response => response.json())
        .then(data => {
            showSnackbar(data.message, 'success');
            fetchApps();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleAppStop = (appName) => {
        showSnackbar(`Stopping ${appName}...`, 'info');
        fetch(`/api/apps/${appName}/stop`, {
            method: 'POST',
        })
        .then(response => response.json())
        .then(data => {
            showSnackbar(data.message, 'success');
            fetchApps();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleAppRestart = (appName) => {
        showSnackbar(`Restarting ${appName}...`, 'info');
        fetch(`/api/apps/${appName}/restart`, {
            method: 'POST',
        })
        .then(response => response.json())
        .then(data => {
            showSnackbar(data.message, 'success');
            fetchApps();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    // Agent handlers
    const handleCreateAgent = () => {
        if (!agentFormData.name) {
            showSnackbar('Agent name is required', 'warning');
            return;
        }

        fetch('/api/agents', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(agentFormData)
        })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    showSnackbar(data.error, 'error');
                } else {
                    showSnackbar('Agent created successfully', 'success');
                    setAgentDialogOpen(false);
                    setAgentFormData({ name: '', description: '', modelName: '', systemPrompt: '', skills: [] });
                    fetchAgents();
                }
            })
            .catch(error => showSnackbar('Failed to create agent', 'error'));
    };

    const handleUpdateAgent = () => {
        if (!editingAgent) return;

        fetch(`/api/agents/${editingAgent.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(agentFormData)
        })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    showSnackbar(data.error, 'error');
                } else {
                    showSnackbar('Agent updated successfully', 'success');
                    setAgentDialogOpen(false);
                    setEditingAgent(null);
                    setAgentFormData({ name: '', description: '', modelName: '', systemPrompt: '', skills: [] });
                    fetchAgents();
                }
            })
            .catch(error => showSnackbar('Failed to update agent', 'error'));
    };

    const handleDeleteAgent = (agentId) => {
        if (!window.confirm('Are you sure you want to delete this agent?')) return;

        fetch(`/api/agents/${agentId}`, {
            method: 'DELETE',
        })
            .then(res => res.json())
            .then(data => {
                showSnackbar(data.message || 'Agent deleted successfully', 'success');
                fetchAgents();
                fetchTasks(); // Refresh tasks as they may be deleted
            })
            .catch(error => showSnackbar('Failed to delete agent', 'error'));
    };

    const handleRegenerateAgentKey = (agentId) => {
        if (!window.confirm('Are you sure you want to regenerate the API key? The old key will stop working.')) return;

        fetch(`/api/agents/${agentId}/regenerate-key`, {
            method: 'POST',
        })
            .then(res => res.json())
            .then(data => {
                showSnackbar('API key regenerated successfully', 'success');
                fetchAgents();
            })
            .catch(error => showSnackbar('Failed to regenerate API key', 'error'));
    };

    // Skill handlers
    const handleCreateSkill = () => {
        if (!skillFormData.name || !skillFormData.type) {
            showSnackbar('Skill name and type are required', 'warning');
            return;
        }

        fetch('/api/skills', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(skillFormData)
        })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    showSnackbar(data.error, 'error');
                } else {
                    showSnackbar('Skill created successfully', 'success');
                    setSkillDialogOpen(false);
                    setSkillFormData({ name: '', description: '', type: 'tool', parameters: {}, code: '', systemPrompt: '' });
                    fetchSkills();
                }
            })
            .catch(error => showSnackbar('Failed to create skill', 'error'));
    };

    const handleUpdateSkill = () => {
        if (!editingSkill) return;

        fetch(`/api/skills/${editingSkill.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(skillFormData)
        })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    showSnackbar(data.error, 'error');
                } else {
                    showSnackbar('Skill updated successfully', 'success');
                    setSkillDialogOpen(false);
                    setEditingSkill(null);
                    setSkillFormData({ name: '', description: '', type: 'tool', parameters: {}, code: '', systemPrompt: '' });
                    fetchSkills();
                }
            })
            .catch(error => showSnackbar('Failed to update skill', 'error'));
    };

    const handleDeleteSkill = (skillId) => {
        if (!window.confirm('Are you sure you want to delete this skill?')) return;

        fetch(`/api/skills/${skillId}`, {
            method: 'DELETE',
        })
            .then(res => res.json())
            .then(data => {
                showSnackbar(data.message || 'Skill deleted successfully', 'success');
                fetchSkills();
            })
            .catch(error => showSnackbar('Failed to delete skill', 'error'));
    };

    // Task handlers
    const handleCreateTask = () => {
        if (!taskFormData.agentId || !taskFormData.description) {
            showSnackbar('Agent and description are required', 'warning');
            return;
        }

        fetch('/api/tasks', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(taskFormData)
        })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    showSnackbar(data.error, 'error');
                } else {
                    showSnackbar('Task created successfully', 'success');
                    setTaskDialogOpen(false);
                    setTaskFormData({ agentId: '', description: '', priority: 'medium' });
                    fetchTasks();
                }
            })
            .catch(error => showSnackbar('Failed to create task', 'error'));
    };

    const handleUpdateTaskStatus = (taskId, newStatus) => {
        fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: newStatus })
        })
            .then(res => res.json())
            .then(data => {
                showSnackbar('Task status updated', 'success');
                fetchTasks();
            })
            .catch(error => showSnackbar('Failed to update task', 'error'));
    };

    const handleDeleteTask = (taskId) => {
        if (!window.confirm('Are you sure you want to delete this task?')) return;

        fetch(`/api/tasks/${taskId}`, {
            method: 'DELETE',
        })
            .then(res => res.json())
            .then(data => {
                showSnackbar(data.message || 'Task deleted successfully', 'success');
                fetchTasks();
            })
            .catch(error => showSnackbar('Failed to delete task', 'error'));
    };

    // User menu handlers
    const handleUserMenuOpen = (event) => {
        setUserMenuAnchor(event.currentTarget);
    };

    const handleUserMenuClose = () => {
        setUserMenuAnchor(null);
    };

    const handleLogout = async () => {
        handleUserMenuClose();
        await performLogout();
    };

    // System reset handlers
    const handleSystemReset = () => {
        if (!resetChecked || resetConfirmation !== 'RESET') {
            showSnackbar('Please confirm by checking the box and typing "RESET"', 'error');
            return;
        }

        showSnackbar('Initiating system reset...', 'warning');
        fetch('/api/system/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: resetConfirmation })
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => { throw new Error(err.error || 'Reset failed'); });
            }
            return response.json();
        })
        .then(data => {
            showSnackbar(data.message, 'success');
            setResetDialogOpen(false);
            setResetConfirmation('');
            setResetChecked(false);
            fetchModels();
            fetchInstances();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    // User management handlers
    const fetchUsers = () => {
        if (user?.role !== 'admin') return;
        setUsersLoading(true);
        fetch('/api/users')
            .then(response => {
                if (!response.ok) throw new Error('Failed to fetch users');
                return response.json();
            })
            .then(data => {
                setUsers(data);
                setUsersLoading(false);
            })
            .catch(error => {
                console.error('Fetch users error:', error);
                setUsersLoading(false);
            });
    };

    const handleOpenUserDialog = (mode, userData = null) => {
        setUserDialogMode(mode);
        if (mode === 'create') {
            setNewUserData({ username: '', email: '', password: '', role: 'user' });
        } else if (mode === 'edit' && userData) {
            setSelectedUser(userData);
            setNewUserData({ username: userData.username, email: userData.email, role: userData.role, password: '' });
        } else if (mode === 'resetPassword' && userData) {
            setSelectedUser(userData);
            setNewUserData({ ...newUserData, password: '' });
        }
        setUserDialogOpen(true);
    };

    const handleCloseUserDialog = () => {
        setUserDialogOpen(false);
        setSelectedUser(null);
        setNewUserData({ username: '', email: '', password: '', role: 'user' });
    };

    const handleCreateUser = () => {
        fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newUserData),
        })
        .then(response => {
            if (!response.ok) return response.json().then(err => { throw new Error(err.error); });
            return response.json();
        })
        .then(() => {
            showSnackbar('User created successfully', 'success');
            handleCloseUserDialog();
            fetchUsers();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleUpdateUser = () => {
        const updates = { email: newUserData.email, role: newUserData.role };
        fetch(`/api/users/${selectedUser.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        })
        .then(response => {
            if (!response.ok) return response.json().then(err => { throw new Error(err.error); });
            return response.json();
        })
        .then(() => {
            showSnackbar('User updated successfully', 'success');
            handleCloseUserDialog();
            fetchUsers();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleInviteUser = () => {
        fetch('/api/users/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email: newUserData.email, role: newUserData.role }),
        })
        .then(response => {
            if (!response.ok) return response.json().then(err => { throw new Error(err.error); });
            return response.json();
        })
        .then((data) => {
            showSnackbar(data.message || 'User invited successfully', 'success');
            handleCloseUserDialog();
            fetchUsers();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleToggleUserStatus = (userId, disabled) => {
        fetch(`/api/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled }),
        })
        .then(response => {
            if (!response.ok) return response.json().then(err => { throw new Error(err.error); });
            return response.json();
        })
        .then(() => {
            showSnackbar(`User ${disabled ? 'disabled' : 'enabled'} successfully`, 'success');
            fetchUsers();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleDeleteUser = (userId) => {
        if (!confirm('Are you sure you want to delete this user?')) return;
        fetch(`/api/users/${userId}`, { method: 'DELETE' })
        .then(response => {
            if (!response.ok) return response.json().then(err => { throw new Error(err.error); });
            return response.json();
        })
        .then(() => {
            showSnackbar('User deleted successfully', 'success');
            fetchUsers();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleResetPassword = () => {
        fetch(`/api/users/${selectedUser.username}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword: newUserData.password }),
        })
        .then(response => {
            if (!response.ok) return response.json().then(err => { throw new Error(err.error); });
            return response.json();
        })
        .then(() => {
            showSnackbar('Password reset successfully', 'success');
            handleCloseUserDialog();
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
                {/* Phase 1b sidebar (Tailwind, desktop only). Mobile uses
                    the existing slide-in Drawer below. The sidebar reads
                    from the same activeTab state the Drawer uses, so
                    selecting in either path moves both in lock-step. */}
                <AppSidebar
                    tabs={tabDefinitions}
                    visibleOrder={visibleTabOrder}
                    activeIndex={activeTab}
                    onSelectIndex={(idx) => setActiveTab(idx)}
                />

                {/* Main Content */}
                <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    {/* Header */}
                    <Box sx={{
                        px: { xs: 1.5, md: 3 },
                        py: { xs: 1.5, md: 3 },
                        minHeight: '72px',
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        bgcolor: 'background.paper',
                    }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
                                <IconButton
                                    aria-label="open navigation"
                                    onClick={() => setMobileNavOpen(true)}
                                    sx={{ display: { xs: 'inline-flex', md: 'none' }, mr: 0.5 }}
                                    size="small"
                                >
                                    <MenuIcon />
                                </IconButton>
                                <Typography variant="h1" sx={{
                                    background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                                    WebkitBackgroundClip: 'text',
                                    WebkitTextFillColor: 'transparent',
                                    fontSize: { xs: '1.05rem', md: 'inherit' },
                                    whiteSpace: { xs: 'nowrap', md: 'normal' },
                                    overflow: { xs: 'hidden', md: 'visible' },
                                    textOverflow: { xs: 'ellipsis', md: 'clip' },
                                    minWidth: 0,
                                }}>
                                    {/* On mobile show the active tab name (more useful nav context
                                        than the static product title); on desktop the product title
                                        sits above the tab strip as before. */}
                                    <Box component="span" sx={{ display: { xs: 'inline', md: 'none' } }}>
                                        {tabDefinitions.find(t => t.id === visibleTabOrder[activeTab])?.label || ''}
                                    </Box>
                                    {/* Desktop slot: show the active tab's label so the header is
                                        contextual, not a static brand string. The brand "Model
                                        Server" lives in the sidebar; repeating it here was
                                        redundant. */}
                                    <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
                                        {tabDefinitions.find(t => t.id === visibleTabOrder[activeTab])?.label || ''}
                                    </Box>
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}>
                                {/* Tailwind-based theme picker. Reads/writes
                                    /api/me/preferences and applies the same
                                    CSS variables chat:3002 uses, so theme
                                    choice syncs across both apps. */}
                                <ThemePicker />
                                {/* Header chips: keep typography + icon sizing
                                    in lockstep with ThemePicker (h-8, text-xs,
                                    12-14px icons) so the row reads as a single
                                    set instead of mixed sizes. */}
                                <Chip
                                    icon={wsConnected ? <CheckCircleIcon sx={{ fontSize: 14 }} /> : <WarningIcon sx={{ fontSize: 14 }} />}
                                    label={wsConnected ? "Connected" : "Disconnected"}
                                    size="medium"
                                    color={wsConnected ? "success" : "error"}
                                    variant="outlined"
                                    sx={{ height: 32, fontSize: '0.75rem', display: { xs: 'none', md: 'inline-flex' }, '& .MuiChip-icon': { ml: 0.5 } }}
                                />
                                {liveInstances.length > 0 && (
                                    <Chip
                                        icon={<MemoryIcon sx={{ fontSize: 14 }} />}
                                        label={`${liveInstances.length} Active`}
                                        size="medium"
                                        color="secondary"
                                        variant="outlined"
                                        sx={{ height: 32, fontSize: '0.75rem', display: { xs: 'none', md: 'inline-flex' }, '& .MuiChip-icon': { ml: 0.5 } }}
                                    />
                                )}
                                <Chip
                                    icon={<AccountCircleIcon sx={{ fontSize: 14, color: 'text.primary' }} />}
                                    label={user?.username || 'User'}
                                    size="medium"
                                    variant="outlined"
                                    onClick={handleUserMenuOpen}
                                    sx={{
                                        height: 32,
                                        fontSize: '0.75rem',
                                        borderColor: 'divider',
                                        color: 'text.primary',
                                        '& .MuiChip-icon': { ml: 0.5 },
                                        cursor: 'pointer',
                                        '&:hover': { bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08) }
                                    }}
                                />
                            </Box>
                        </Box>

                        {/* Tabs (legacy desktop strip — replaced by AppSidebar
                            in Phase 1b. Kept in tree for now so reorder
                            handlers stay wired; rendered hidden. Drop in a
                            later phase once sidebar drag-reorder lands.) */}
                        <Box sx={{ display: 'none', alignItems: 'center', gap: 1, mt: 2 }}>
                            <Tabs
                                value={activeTab}
                                onChange={handleTabChange}
                                variant="scrollable"
                                scrollButtons="auto"
                                allowScrollButtonsMobile
                                sx={{ flex: 1, minWidth: 0 }}
                            >
                                {visibleTabOrder.map((tabId, index) => {
                                    const tab = tabDefinitions.find(t => t.id === tabId);
                                    return (
                                        <Tab
                                            key={tabId}
                                            draggable
                                            onDragStart={(e) => handleDragStart(e, index)}
                                            onDragOver={(e) => handleDragOver(e, index)}
                                            onDragEnd={handleDragEnd}
                                            icon={<DragIndicatorIcon sx={{ fontSize: 14, opacity: 0.5, cursor: 'grab' }} />}
                                            iconPosition="start"
                                            label={
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                    {tab.icon}
                                                    <Typography variant="body2">{tab.label}</Typography>
                                                </Box>
                                            }
                                            sx={{
                                                cursor: draggedTab === index ? 'grabbing' : 'pointer',
                                                opacity: draggedTab === index ? 0.5 : 1,
                                                transition: 'opacity 0.2s'
                                            }}
                                        />
                                    );
                                })}
                            </Tabs>
                        </Box>
                    </Box>

                    {/* Mobile navigation drawer — slides in from the left when
                        the hamburger button is tapped. Lists the same tabs as
                        the desktop tab strip, in vertical form with icon +
                        label, for thumb-friendly navigation. Drag-reorder is
                        intentionally not exposed here; that's a desktop power
                        feature. */}
                    <Drawer
                        anchor="left"
                        open={mobileNavOpen}
                        onClose={() => setMobileNavOpen(false)}
                        sx={{ display: { xs: 'block', md: 'none' } }}
                        PaperProps={{ sx: { width: 280, bgcolor: 'background.paper' } }}
                    >
                        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
                            <Typography variant="h6" sx={{
                                background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                                WebkitBackgroundClip: 'text',
                                WebkitTextFillColor: 'transparent',
                                fontWeight: 700,
                                fontSize: '1rem',
                            }}>
                                Model Server
                            </Typography>
                        </Box>
                        <List sx={{ pt: 1 }}>
                            {visibleTabOrder.map((tabId, index) => {
                                const tab = tabDefinitions.find(t => t.id === tabId);
                                if (!tab) return null;
                                const selected = activeTab === index;
                                return (
                                    <ListItemButton
                                        key={tabId}
                                        selected={selected}
                                        onClick={() => {
                                            setActiveTab(index);
                                            setMobileNavOpen(false);
                                        }}
                                        sx={{
                                            mx: 1, mb: 0.5, borderRadius: 1,
                                            '&.Mui-selected': {
                                                bgcolor: 'rgba(99, 102, 241, 0.18)',
                                                '&:hover': { bgcolor: 'rgba(99, 102, 241, 0.24)' },
                                            },
                                        }}
                                    >
                                        <ListItemIcon sx={{ minWidth: 36, color: selected ? 'secondary.main' : 'text.secondary' }}>
                                            {tab.icon}
                                        </ListItemIcon>
                                        <ListItemText
                                            primary={tab.label}
                                            primaryTypographyProps={{
                                                fontWeight: selected ? 600 : 500,
                                                color: selected ? 'text.primary' : 'text.secondary',
                                            }}
                                        />
                                    </ListItemButton>
                                );
                            })}
                        </List>
                        <Divider sx={{ mt: 1 }} />
                        <Box sx={{ p: 2 }}>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                                Signed in as
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {user?.username || 'User'}
                            </Typography>
                            <Box sx={{ mt: 1, display: 'flex', gap: 1, alignItems: 'center' }}>
                                <Chip
                                    icon={wsConnected ? <CheckCircleIcon sx={{ fontSize: 16 }} /> : <WarningIcon sx={{ fontSize: 16 }} />}
                                    label={wsConnected ? 'Connected' : 'Disconnected'}
                                    size="small"
                                    color={wsConnected ? 'success' : 'error'}
                                    variant="outlined"
                                />
                                {liveInstances.length > 0 && (
                                    <Chip
                                        icon={<MemoryIcon sx={{ fontSize: 16 }} />}
                                        label={`${liveInstances.length} active`}
                                        size="small"
                                        color="secondary"
                                        variant="outlined"
                                    />
                                )}
                            </Box>
                        </Box>
                    </Drawer>

                    {/* Tab Panels */}
                    <Box sx={{ flex: 1, overflow: 'auto', p: { xs: 1.5, md: 3 }, minWidth: 0 }}>
                        {/* Discover Tab */}
                        {visibleTabOrder[activeTab] === 0 && (
                            <Grid container spacing={3}>
                                {/* Search Section */}
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <SectionHeader
                                                icon={<SearchIcon />}
                                                title="Discover Models"
                                                subtitle="Search and download GGUF models from HuggingFace"
                                            />
                                            {/* Search input */}
                                            <Box sx={{ display: 'flex', gap: 1.5, mt: 2, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
                                                <TextField
                                                    fullWidth
                                                    placeholder="Search models... (e.g., llama, mistral, qwen, deepseek)"
                                                    value={searchQuery}
                                                    onChange={(e) => setSearchQuery(e.target.value)}
                                                    onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                                                    size="small"
                                                    sx={{
                                                        '& .MuiOutlinedInput-root': {
                                                            borderRadius: 2,
                                                            bgcolor: 'var(--bg-hover)',
                                                        },
                                                    }}
                                                    InputProps={{
                                                        startAdornment: (
                                                            <InputAdornment position="start">
                                                                <SearchIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                                                            </InputAdornment>
                                                        ),
                                                    }}
                                                />
                                                <Button
                                                    variant="contained"
                                                    onClick={handleSearch}
                                                    disabled={searching}
                                                    sx={{ minWidth: { xs: 'auto', sm: 100 }, width: { xs: '100%', sm: 'auto' }, borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
                                                >
                                                    {searching ? <CircularProgress size={20} /> : 'Search'}
                                                </Button>
                                            </Box>

                                            {/* Sort pills */}
                                            <Box sx={{ display: 'flex', gap: 0.75, mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                                                <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>Sort</Typography>
                                                {[
                                                    { value: 'downloads', label: 'Downloads' },
                                                    { value: 'trending', label: 'Trending' },
                                                    { value: 'likes', label: 'Likes' },
                                                    { value: 'newest', label: 'Newest' },
                                                    { value: 'params', label: 'Size \u2193' },
                                                    { value: 'params_asc', label: 'Size \u2191' },
                                                ].map(opt => (
                                                    <Chip
                                                        key={opt.value}
                                                        label={opt.label}
                                                        size="small"
                                                        onClick={() => setSearchSortBy(opt.value)}
                                                        sx={{
                                                            height: 26, fontSize: '0.72rem', cursor: 'pointer', fontWeight: 500,
                                                            bgcolor: searchSortBy === opt.value ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
                                                            border: '1px solid',
                                                            borderColor: searchSortBy === opt.value ? 'var(--border-focus)' : 'transparent',
                                                            color: searchSortBy === opt.value ? 'var(--accent-primary)' : 'text.secondary',
                                                            '&:hover': { bgcolor: searchSortBy === opt.value ? 'var(--accent-muted)' : 'var(--bg-hover)' },
                                                        }}
                                                    />
                                                ))}

                                                <Box sx={{ width: 1, height: 16, borderLeft: '1px solid', borderColor: 'divider', mx: 0.5 }} />

                                                <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>Size</Typography>
                                                {[
                                                    { value: 'all', label: 'All' },
                                                    { value: 'small', label: '\u22643B' },
                                                    { value: 'medium', label: '7-13B' },
                                                    { value: 'large', label: '14-40B' },
                                                    { value: 'xlarge', label: '40B+' },
                                                ].map(opt => (
                                                    <Chip
                                                        key={opt.value}
                                                        label={opt.label}
                                                        size="small"
                                                        onClick={() => setSearchSizeFilter(opt.value)}
                                                        sx={{
                                                            height: 26, fontSize: '0.72rem', cursor: 'pointer', fontWeight: 500,
                                                            bgcolor: searchSizeFilter === opt.value ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
                                                            border: '1px solid',
                                                            borderColor: searchSizeFilter === opt.value ? 'var(--border-focus)' : 'transparent',
                                                            color: searchSizeFilter === opt.value ? 'var(--accent-primary)' : 'text.secondary',
                                                            '&:hover': { bgcolor: searchSizeFilter === opt.value ? 'var(--accent-muted)' : 'var(--bg-hover)' },
                                                        }}
                                                    />
                                                ))}

                                                <Box sx={{ width: 1, height: 16, borderLeft: '1px solid', borderColor: 'divider', mx: 0.5 }} />

                                                <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>Format</Typography>
                                                {[
                                                    { value: 'gguf', label: 'GGUF', hint: 'llama.cpp + sglang (experimental)' },
                                                    { value: 'safetensors', label: 'safetensors', hint: 'sglang full precision' },
                                                    { value: 'awq', label: 'AWQ', hint: 'sglang 4-bit, NVIDIA-optimized' },
                                                    { value: 'gptq', label: 'GPTQ', hint: 'sglang 4-bit, Marlin kernels' },
                                                    { value: 'fp8', label: 'FP8', hint: 'sglang Hopper/Ada/Blackwell' },
                                                    { value: 'nvfp4', label: 'NVFP4', hint: 'sglang Blackwell only' },
                                                    { value: 'bnb', label: 'BnB', hint: 'sglang bitsandbytes' },
                                                    { value: 'any', label: 'Any', hint: 'No format filter' },
                                                ].map(opt => (
                                                    <Tooltip key={opt.value} title={opt.hint} arrow>
                                                        <Chip
                                                            label={opt.label}
                                                            size="small"
                                                            onClick={() => setSearchFormat(opt.value)}
                                                            sx={{
                                                                height: 26, fontSize: '0.72rem', cursor: 'pointer', fontWeight: 500,
                                                                bgcolor: searchFormat === opt.value ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
                                                                border: '1px solid',
                                                                borderColor: searchFormat === opt.value ? 'var(--border-focus)' : 'transparent',
                                                                color: searchFormat === opt.value ? 'var(--accent-primary)' : 'text.secondary',
                                                                '&:hover': { bgcolor: searchFormat === opt.value ? 'var(--accent-muted)' : 'var(--bg-hover)' },
                                                            }}
                                                        />
                                                    </Tooltip>
                                                ))}
                                            </Box>

                                            {/* Search Results */}
                                            {searchResults.length > 0 && (() => {
                                                const totalPages = Math.ceil(searchResults.length / ITEMS_PER_PAGE);
                                                const startIndex = (searchPage - 1) * ITEMS_PER_PAGE;
                                                const endIndex = startIndex + ITEMS_PER_PAGE;
                                                const paginatedResults = searchResults.slice(startIndex, endIndex);

                                                // Helper to detect model type tags from model name and HuggingFace tags
                                                const getModelTypeTags = (modelId, tags = []) => {
                                                    const name = modelId.toLowerCase();
                                                    const tagSet = new Set(tags?.map(t => t.toLowerCase()) || []);
                                                    const typeTags = [];

                                                    // Thinking/Reasoning models
                                                    if (name.includes('qwq') || name.includes('deepseek-r1') || name.includes('o1') ||
                                                        name.includes('o3') || name.includes('reasoning') || name.includes('think') ||
                                                        tagSet.has('reasoning') || tagSet.has('thinking')) {
                                                        typeTags.push({ label: 'Thinking', color: 'rgba(251,191,36,0.3)', textColor: '#fbbf24' });
                                                    }

                                                    // Coding models
                                                    if (name.includes('code') || name.includes('coder') || name.includes('starcoder') ||
                                                        name.includes('codellama') || name.includes('deepseek-coder') || name.includes('qwen2.5-coder') ||
                                                        tagSet.has('code') || tagSet.has('coding')) {
                                                        typeTags.push({ label: 'Code', color: 'rgba(34,197,94,0.3)', textColor: '#22c55e' });
                                                    }

                                                    // Chat/Instruct models
                                                    if (name.includes('instruct') || name.includes('chat') || name.includes('-it') ||
                                                        tagSet.has('chat') || tagSet.has('conversational')) {
                                                        typeTags.push({ label: 'Chat', color: 'rgba(59,130,246,0.3)', textColor: '#3b82f6' });
                                                    }

                                                    // Vision/Multimodal models
                                                    if (name.includes('vision') || name.includes('vl') || name.includes('llava') ||
                                                        name.includes('multimodal') || name.includes('minicpm-v') ||
                                                        tagSet.has('vision') || tagSet.has('image-text-to-text')) {
                                                        typeTags.push({ label: 'Vision', color: 'rgba(168,85,247,0.3)', textColor: '#a855f7' });
                                                    }

                                                    // Math models
                                                    if (name.includes('math') || name.includes('mathstral') || tagSet.has('math')) {
                                                        typeTags.push({ label: 'Math', color: 'rgba(239,68,68,0.3)', textColor: '#ef4444' });
                                                    }

                                                    // Embedding models
                                                    if (name.includes('embed') || tagSet.has('embeddings') || tagSet.has('feature-extraction')) {
                                                        typeTags.push({ label: 'Embed', color: 'var(--border-focus)', textColor: '#6366f1' });
                                                    }

                                                    return typeTags;
                                                };

                                                return (
                                                <Box sx={{ mt: 3 }}>
                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                                                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                                            Showing {startIndex + 1}-{Math.min(endIndex, searchResults.length)} of {searchResults.length} models
                                                            {searchSortBy === 'params' && ' (sorted by size)'}
                                                            {searchSizeFilter !== 'all' && ` • ${SIZE_FILTERS[searchSizeFilter].label}`}
                                                        </Typography>
                                                        {totalPages > 1 && (
                                                            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                                                Page {searchPage} of {totalPages}
                                                            </Typography>
                                                        )}
                                                    </Box>
                                                    <Grid container spacing={2}>
                                                        {paginatedResults.map(model => {
                                                            // Use paramSize from API if available, otherwise extract from name
                                                            const paramSize = model.paramSize
                                                                ? (model.paramSize >= 1 ? `${model.paramSize}B` : `${(model.paramSize * 1000).toFixed(0)}M`)
                                                                : extractParameterSize(model.id);
                                                            const formatNumber = (num) => {
                                                                if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
                                                                if (num >= 1000) return `${(num / 1000).toFixed(0)}k`;
                                                                return num;
                                                            };
                                                            const typeTags = getModelTypeTags(model.id, model.tags);
                                                            return (
                                                                <Grid item xs={12} sm={6} md={4} key={model.id}>
                                                                    <Card
                                                                        variant="outlined"
                                                                        sx={{
                                                                            cursor: 'pointer',
                                                                            position: 'relative',
                                                                            transition: 'transform 0.2s, box-shadow 0.2s',
                                                                            borderColor: 'var(--border-primary)',
                                                                            '&::before': {
                                                                                content: '""',
                                                                                position: 'absolute',
                                                                                inset: -1,
                                                                                borderRadius: 'inherit',
                                                                                padding: '1px',
                                                                                background: 'linear-gradient(135deg, rgba(99,102,241,0) 0%, rgba(99,102,241,0) 100%)',
                                                                                WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                                                                                WebkitMaskComposite: 'xor',
                                                                                maskComposite: 'exclude',
                                                                                transition: 'background 0.3s',
                                                                                pointerEvents: 'none',
                                                                            },
                                                                            '&:hover': {
                                                                                transform: 'translateY(-2px)',
                                                                                boxShadow: '0 4px 20px var(--accent-muted)',
                                                                                borderColor: 'transparent',
                                                                                '&::before': {
                                                                                    background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 50%, var(--accent-primary) 100%)',
                                                                                },
                                                                            },
                                                                        }}
                                                                        onClick={() => handleSelectModel(model.id, model.format)}
                                                                    >
                                                                        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                                                            {/* Header row: name + param size */}
                                                                            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
                                                                                <Typography sx={{
                                                                                    fontWeight: 600,
                                                                                    whiteSpace: 'nowrap',
                                                                                    overflow: 'hidden',
                                                                                    textOverflow: 'ellipsis',
                                                                                    fontSize: '0.92rem',
                                                                                    lineHeight: 1.3,
                                                                                }}>
                                                                                    {model.id.split('/')[1]}
                                                                                </Typography>
                                                                                {paramSize && (
                                                                                    <Chip label={paramSize} size="small" sx={{
                                                                                        height: 22, fontWeight: 700, fontSize: '0.72rem', flexShrink: 0,
                                                                                        bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: 'none',
                                                                                    }} />
                                                                                )}
                                                                            </Box>
                                                                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1, fontSize: '0.7rem' }}>
                                                                                {model.id.split('/')[0]}
                                                                            </Typography>
                                                                            {/* Format + Type Tags */}
                                                                            {(() => {
                                                                                const FORMAT_STYLES = {
                                                                                    gguf:                 { label: 'GGUF',     color: 'rgba(20,184,166,0.3)',  textColor: '#14b8a6', tip: 'llama.cpp + sglang (experimental)' },
                                                                                    safetensors:          { label: 'safetensors', color: 'var(--border-focus)', textColor: '#818cf8', tip: 'sglang full-precision' },
                                                                                    awq:                  { label: 'AWQ',      color: 'rgba(34,197,94,0.3)',   textColor: '#22c55e', tip: 'sglang 4-bit, NVIDIA-optimized' },
                                                                                    gptq:                 { label: 'GPTQ',     color: 'rgba(234,179,8,0.3)',   textColor: '#eab308', tip: 'sglang 4-bit (Marlin kernels)' },
                                                                                    fp8:                  { label: 'FP8',      color: 'rgba(244,114,182,0.3)', textColor: '#f472b6', tip: 'sglang Hopper/Ada/Blackwell' },
                                                                                    nvfp4:                { label: 'NVFP4',    color: 'rgba(217,70,239,0.3)',  textColor: '#d946ef', tip: 'sglang Blackwell-only' },
                                                                                    bnb:                  { label: 'BnB',      color: 'rgba(245,158,11,0.3)',  textColor: '#f59e0b', tip: 'sglang bitsandbytes' },
                                                                                    'compressed-tensors': { label: 'comp-tensors', color: 'rgba(129,140,248,0.3)', textColor: '#a5b4fc', tip: 'sglang compressed-tensors' },
                                                                                };
                                                                                const fmt = FORMAT_STYLES[model.format];
                                                                                const hasFormat = !!fmt;
                                                                                const hasTypeTags = typeTags.length > 0;
                                                                                const sizeEntry = repoSizes[model.id];
                                                                                const showSize = model.format && model.format !== 'gguf';
                                                                                if (!hasFormat && !hasTypeTags && !showSize) return null;
                                                                                return (
                                                                                    <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
                                                                                        {hasFormat && (
                                                                                            <Tooltip title={fmt.tip} arrow>
                                                                                                <Chip
                                                                                                    label={fmt.label}
                                                                                                    size="small"
                                                                                                    sx={{
                                                                                                        height: 18,
                                                                                                        fontSize: '0.62rem',
                                                                                                        bgcolor: fmt.color,
                                                                                                        color: fmt.textColor,
                                                                                                        fontWeight: 700,
                                                                                                        letterSpacing: 0.3,
                                                                                                    }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {showSize && sizeEntry && typeof sizeEntry.totalBytes === 'number' && (() => {
                                                                                            // Estimate runtime VRAM at 8K context: weights + KV cache.
                                                                                            // The +2 GB activation overhead reflects sglang's CUDA workspace,
                                                                                            // NCCL buffers, and forward-pass scratch — empirical, not exact,
                                                                                            // but better than ignoring it. Without this people see "9 GB
                                                                                            // weights" and assume it'll fit on a 16 GB card; in practice
                                                                                            // KV cache often doubles the footprint at non-trivial context.
                                                                                            const ACTIVATION_OVERHEAD = 2 * 1024 * 1024 * 1024;
                                                                                            const weights = sizeEntry.weightBytes || sizeEntry.totalBytes;
                                                                                            const kvPerTok = sizeEntry.kvBytesPerToken;
                                                                                            const kvAt8k = kvPerTok ? kvPerTok * 8192 : null;
                                                                                            const kvAt32k = kvPerTok ? kvPerTok * 32768 : null;
                                                                                            const runtimeAt8k = kvAt8k !== null ? weights + kvAt8k + ACTIVATION_OVERHEAD : null;
                                                                                            const tipLines = [`Repo total: ${formatBytes(sizeEntry.totalBytes)}`];
                                                                                            if (sizeEntry.weightBytes) tipLines.push(`Weights: ${formatBytes(sizeEntry.weightBytes)}`);
                                                                                            if (kvAt8k !== null) tipLines.push(`KV cache @ 8K ctx: ${formatBytes(kvAt8k)}`);
                                                                                            if (kvAt32k !== null) tipLines.push(`KV cache @ 32K ctx: ${formatBytes(kvAt32k)}`);
                                                                                            if (runtimeAt8k !== null) tipLines.push(`Estimated VRAM @ 8K: ~${formatBytes(runtimeAt8k)} (weights + KV + ~2 GB activations)`);
                                                                                            return (
                                                                                                <>
                                                                                                    <Tooltip title={tipLines.join(' · ')} arrow>
                                                                                                        <Chip
                                                                                                            label={formatBytes(sizeEntry.totalBytes)}
                                                                                                            size="small"
                                                                                                            sx={{
                                                                                                                height: 18,
                                                                                                                fontSize: '0.62rem',
                                                                                                                bgcolor: 'var(--border-primary)',
                                                                                                                color: 'text.primary',
                                                                                                                fontWeight: 700,
                                                                                                                letterSpacing: 0.3,
                                                                                                            }}
                                                                                                        />
                                                                                                    </Tooltip>
                                                                                                    {runtimeAt8k !== null && (
                                                                                                        <Tooltip
                                                                                                            title={`Estimated runtime VRAM @ 8K context: ~${formatBytes(runtimeAt8k)}. Scales linearly with max_model_len — at 32K you'd add ${formatBytes(kvAt32k - kvAt8k)} more KV cache.`}
                                                                                                            arrow
                                                                                                        >
                                                                                                            <Chip
                                                                                                                label={`~${formatBytes(runtimeAt8k)} VRAM`}
                                                                                                                size="small"
                                                                                                                sx={{
                                                                                                                    height: 18,
                                                                                                                    fontSize: '0.62rem',
                                                                                                                    bgcolor: 'rgba(244,114,182,0.12)',
                                                                                                                    color: '#f472b6',
                                                                                                                    fontWeight: 700,
                                                                                                                    letterSpacing: 0.3,
                                                                                                                }}
                                                                                                            />
                                                                                                        </Tooltip>
                                                                                                    )}
                                                                                                </>
                                                                                            );
                                                                                        })()}
                                                                                        {showSize && sizeEntry && sizeEntry.loading && (
                                                                                            <Chip
                                                                                                label="…"
                                                                                                size="small"
                                                                                                sx={{
                                                                                                    height: 18,
                                                                                                    fontSize: '0.62rem',
                                                                                                    bgcolor: 'var(--bg-tertiary)',
                                                                                                    color: 'text.secondary',
                                                                                                    letterSpacing: 0.3,
                                                                                                }}
                                                                                            />
                                                                                        )}
                                                                                        {typeTags.map((tag, idx) => (
                                                                                            <Chip
                                                                                                key={idx}
                                                                                                label={tag.label}
                                                                                                size="small"
                                                                                                sx={{
                                                                                                    height: 18,
                                                                                                    fontSize: '0.62rem',
                                                                                                    bgcolor: tag.color,
                                                                                                    color: tag.textColor,
                                                                                                    fontWeight: 600,
                                                                                                    letterSpacing: 0.3,
                                                                                                }}
                                                                                            />
                                                                                        ))}
                                                                                    </Box>
                                                                                );
                                                                            })()}
                                                                            {/* Stats row */}
                                                                            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', color: 'text.secondary', fontSize: '0.7rem' }}>
                                                                                <Tooltip title="Downloads" arrow>
                                                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                                                                                        <CloudDownloadIcon sx={{ fontSize: 13, opacity: 0.7 }} />
                                                                                        <span>{formatNumber(model.downloads)}</span>
                                                                                    </Box>
                                                                                </Tooltip>
                                                                                {model.likes > 0 && (
                                                                                    <Tooltip title="Likes" arrow>
                                                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                                                                                            <FavoriteIcon sx={{ fontSize: 12, opacity: 0.7 }} />
                                                                                            <span>{formatNumber(model.likes)}</span>
                                                                                        </Box>
                                                                                    </Tooltip>
                                                                                )}
                                                                                {model.contextLength && (
                                                                                    <Tooltip title={model.contextEstimated ? "Estimated context" : "Context window"} arrow>
                                                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, ml: 'auto',
                                                                                            ...(model.contextEstimated && { opacity: 0.6, fontStyle: 'italic' })
                                                                                        }}>
                                                                                            <MemoryIcon sx={{ fontSize: 12, opacity: 0.7 }} />
                                                                                            <span>{model.contextLength >= 1048576 ? `${(model.contextLength / 1048576).toFixed(0)}M` :
                                                                                                   model.contextLength >= 1024 ? `${Math.round(model.contextLength / 1024)}K` :
                                                                                                   model.contextLength} ctx</span>
                                                                                        </Box>
                                                                                    </Tooltip>
                                                                                )}
                                                                            </Box>
                                                                        </CardContent>
                                                                    </Card>
                                                                </Grid>
                                                            );
                                                        })}
                                                    </Grid>
                                                    {/* Pagination Controls */}
                                                    {totalPages > 1 && (
                                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2, mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                                                            <Button
                                                                variant="outlined"
                                                                size="small"
                                                                disabled={searchPage === 1}
                                                                onClick={() => setSearchPage(p => Math.max(1, p - 1))}
                                                                startIcon={<NavigateBeforeIcon />}
                                                            >
                                                                Previous
                                                            </Button>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                {/* Page number buttons */}
                                                                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                                                    let pageNum;
                                                                    if (totalPages <= 5) {
                                                                        pageNum = i + 1;
                                                                    } else if (searchPage <= 3) {
                                                                        pageNum = i + 1;
                                                                    } else if (searchPage >= totalPages - 2) {
                                                                        pageNum = totalPages - 4 + i;
                                                                    } else {
                                                                        pageNum = searchPage - 2 + i;
                                                                    }
                                                                    return (
                                                                        <Button
                                                                            key={pageNum}
                                                                            variant={pageNum === searchPage ? 'contained' : 'outlined'}
                                                                            size="small"
                                                                            onClick={() => setSearchPage(pageNum)}
                                                                            sx={{ minWidth: 36, px: 1 }}
                                                                        >
                                                                            {pageNum}
                                                                        </Button>
                                                                    );
                                                                })}
                                                            </Box>
                                                            <Button
                                                                variant="outlined"
                                                                size="small"
                                                                disabled={searchPage === totalPages}
                                                                onClick={() => setSearchPage(p => Math.min(totalPages, p + 1))}
                                                                endIcon={<NavigateNextIcon />}
                                                            >
                                                                Next
                                                            </Button>
                                                        </Box>
                                                    )}
                                                </Box>
                                                );
                                            })()}
                                        </CardContent>
                                    </Card>
                                </Grid>

                                {/* Quantization side panel (Drawer) */}
                                <Drawer
                                    anchor="right"
                                    open={selectedModelFiles.length > 0}
                                    onClose={() => { setSelectedModelFiles([]); setGgufRepo(''); setGgufFile(''); setFileFilter('all'); }}
                                    PaperProps={{ sx: { width: 380, bgcolor: 'background.paper', backgroundImage: 'none' } }}
                                >
                                    {selectedModelFiles.length > 0 && (() => {
                                        // Collect unique quantization types for filter
                                        const allQuants = [...new Set(selectedModelFiles.map(f => extractQuantization(f.rfilename)).filter(Boolean))];
                                        // Active quant filter (empty = show all)
                                        const activeQuantFilter = fileFilter.startsWith('q:') ? fileFilter.slice(2) : null;

                                        const filteredFiles = selectedModelFiles.filter(file => {
                                            // Type filter
                                            if (fileFilter === 'single' && isSplitFile(file.rfilename)) return false;
                                            if (fileFilter === 'split' && !isSplitFile(file.rfilename)) return false;
                                            // Quant filter
                                            if (activeQuantFilter) {
                                                const q = extractQuantization(file.rfilename);
                                                if (q !== activeQuantFilter) return false;
                                            }
                                            return true;
                                        });

                                        return (
                                        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                            {/* Header */}
                                            <Box sx={{ p: 2.5, pb: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
                                                    <Typography sx={{ fontWeight: 700, fontSize: '1.1rem' }}>Select Quantization</Typography>
                                                    <IconButton size="small" onClick={() => { setSelectedModelFiles([]); setGgufRepo(''); setGgufFile(''); setFileFilter('all'); }}>
                                                        <ClearIcon sx={{ fontSize: 20 }} />
                                                    </IconButton>
                                                </Box>
                                                <Typography sx={{ color: 'text.secondary', fontSize: '0.82rem', wordBreak: 'break-all', lineHeight: 1.4 }}>
                                                    {ggufRepo}
                                                </Typography>

                                                {/* Type filters */}
                                                <Box sx={{ display: 'flex', gap: 0.75, mt: 2, flexWrap: 'wrap' }}>
                                                    {[
                                                        { value: 'all', label: 'All' },
                                                        { value: 'single', label: 'Single' },
                                                        { value: 'split', label: 'Split' },
                                                    ].map(opt => (
                                                        <Chip key={opt.value} label={opt.label} size="small"
                                                            onClick={() => setFileFilter(opt.value)}
                                                            sx={{
                                                                height: 28, fontSize: '0.8rem', cursor: 'pointer', fontWeight: 500,
                                                                bgcolor: fileFilter === opt.value ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
                                                                border: '1px solid',
                                                                borderColor: fileFilter === opt.value ? 'var(--border-focus)' : 'transparent',
                                                                color: fileFilter === opt.value ? 'var(--accent-primary)' : 'text.secondary',
                                                                '&:hover': { bgcolor: 'var(--bg-hover)' },
                                                            }}
                                                        />
                                                    ))}
                                                </Box>

                                                {/* Quantization type filters */}
                                                {allQuants.length > 1 && (
                                                    <Box sx={{ display: 'flex', gap: 0.5, mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                                                        <Typography sx={{ color: 'text.secondary', fontSize: '0.75rem', mr: 0.5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Quant</Typography>
                                                        {allQuants.sort().map(q => (
                                                            <Chip key={q} label={q} size="small"
                                                                onClick={() => setFileFilter(activeQuantFilter === q ? 'all' : `q:${q}`)}
                                                                sx={{
                                                                    height: 26, fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600,
                                                                    fontFamily: '"Fira Code", monospace',
                                                                    bgcolor: activeQuantFilter === q ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
                                                                    border: '1px solid',
                                                                    borderColor: activeQuantFilter === q ? 'var(--border-focus)' : 'transparent',
                                                                    color: activeQuantFilter === q ? 'var(--accent-primary)' : 'text.secondary',
                                                                    '&:hover': { bgcolor: 'var(--bg-hover)' },
                                                                }}
                                                            />
                                                        ))}
                                                    </Box>
                                                )}
                                            </Box>

                                            {/* File list — compact rows */}
                                            <Box sx={{ flex: 1, overflow: 'auto', px: 1, py: 0.5 }}>
                                                {filteredFiles.map(file => {
                                                    const quant = extractQuantization(file.rfilename);
                                                    const isSelected = ggufFile === file.rfilename;
                                                    const isSplit = isSplitFile(file.rfilename);
                                                    const splitInfo = getSplitInfo(file.rfilename);
                                                    // For files with no detected quantization, show a short filename instead
                                                    const displayLabel = quant || file.rfilename.replace(/\.gguf$/i, '').split('/').pop().slice(-20);
                                                    return (
                                                        <Box
                                                            key={file.rfilename}
                                                            onClick={() => handleSelectGGUFFile(file.rfilename)}
                                                            sx={{
                                                                display: 'flex', alignItems: 'center', gap: 1.5,
                                                                px: 1.5, py: 1.25, mx: 0.5, my: 0.25,
                                                                borderRadius: 1.5, cursor: 'pointer',
                                                                borderLeft: '3px solid',
                                                                borderLeftColor: isSelected ? 'primary.main' : 'transparent',
                                                                bgcolor: isSelected ? 'var(--bg-hover)' : 'transparent',
                                                                transition: 'all 0.15s',
                                                                '&:hover': {
                                                                    bgcolor: isSelected ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                                                                },
                                                            }}
                                                        >
                                                            {/* Quant label */}
                                                            <Typography sx={{
                                                                fontFamily: quant ? '"Fira Code", monospace' : 'inherit',
                                                                fontWeight: 700, fontSize: '0.88rem',
                                                                color: isSelected ? 'primary.main' : 'text.primary',
                                                                minWidth: 80,
                                                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                            }}>
                                                                {displayLabel}
                                                            </Typography>
                                                            {/* Split badge */}
                                                            {isSplit && (
                                                                <Typography sx={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600, minWidth: 30 }}>
                                                                    {splitInfo?.part}/{splitInfo?.total}
                                                                </Typography>
                                                            )}
                                                            {/* Size — pushed right */}
                                                            {file.size > 0 && (
                                                                <Typography sx={{
                                                                    ml: 'auto', fontSize: '0.85rem', fontWeight: 500,
                                                                    color: 'text.secondary', fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                                                                }}>
                                                                    {formatFileSize(file.size)}
                                                                </Typography>
                                                            )}
                                                            {/* Check */}
                                                            {isSelected && <CheckCircleIcon sx={{ fontSize: 18, color: 'primary.main', flexShrink: 0 }} />}
                                                        </Box>
                                                    );
                                                })}
                                                {filteredFiles.length === 0 && (
                                                    <Typography sx={{ textAlign: 'center', color: 'text.secondary', fontSize: '0.88rem', py: 4 }}>
                                                        No files match current filters
                                                    </Typography>
                                                )}
                                            </Box>

                                            {/* Download button — pinned at bottom */}
                                            <Box sx={{ p: 2.5, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                                                {ggufFile ? (
                                                    <>
                                                        <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', display: 'block', mb: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                            {ggufFile}
                                                        </Typography>
                                                        <Button
                                                            variant="contained"
                                                            startIcon={loading ? <CircularProgress size={18} /> : <CloudDownloadIcon />}
                                                            onClick={handlePullModel}
                                                            disabled={loading}
                                                            fullWidth
                                                            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600, fontSize: '0.9rem', py: 1.25 }}
                                                        >
                                                            {loading ? 'Downloading...' : 'Download'}
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <Typography sx={{ textAlign: 'center', color: 'text.secondary', fontSize: '0.88rem' }}>
                                                        Select a file to download
                                                    </Typography>
                                                )}
                                            </Box>
                                        </Box>
                                        );
                                    })()}
                                </Drawer>

                                {/* Active Downloads */}
                                {activeDownloads.length > 0 && (
                                    <Grid item xs={12}>
                                        <Card>
                                            <CardContent>
                                                <SectionHeader
                                                    icon={<CloudDownloadIcon />}
                                                    title="Active Downloads"
                                                    subtitle={`${activeDownloads.length} download${activeDownloads.length > 1 ? 's' : ''} in progress`}
                                                />
                                                <Box sx={{ mt: 2 }}>
                                                    {activeDownloads.map(download => {
                                                        const pct = download.progress || 0;
                                                        const hasTotals = download.overallTotal > 0;
                                                        const hasSplit = (download.fileTotal || 0) > 1;
                                                        const speedLabel = download.speed
                                                            ? `${formatFileSize(download.speed)}/s`
                                                            : null;
                                                        const etaLabel = download.eta
                                                            ? formatDuration(download.eta)
                                                            : null;
                                                        const sizeLabel = hasTotals
                                                            ? `${formatFileSize(download.overallDownloaded)} / ${formatFileSize(download.overallTotal)}`
                                                            : null;
                                                        const indeterminate = download.status === 'downloading' && !hasTotals && pct === 0;
                                                        return (
                                                        <Box key={download.downloadId} sx={{ mb: 2, p: 2, bgcolor: 'rgba(99, 102, 241, 0.05)', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                                                                <Box sx={{ flex: 1, overflow: 'hidden' }}>
                                                                    <Typography variant="body1" sx={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                                        {download.modelName || download.ggufRepo}
                                                                    </Typography>
                                                                    <Typography variant="caption" color="text.secondary">
                                                                        {download.ggufFile}
                                                                    </Typography>
                                                                </Box>
                                                                {download.status === 'downloading' && (
                                                                    <IconButton
                                                                        size="small"
                                                                        onClick={() => handleCancelDownload(download.downloadId)}
                                                                        sx={{ ml: 1 }}
                                                                    >
                                                                        <CancelIcon />
                                                                    </IconButton>
                                                                )}
                                                            </Box>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <LinearProgress
                                                                    variant={indeterminate ? 'indeterminate' : 'determinate'}
                                                                    value={pct}
                                                                    sx={{ flex: 1, height: 8, borderRadius: 4 }}
                                                                />
                                                                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                                    {pct}%
                                                                </Typography>
                                                            </Box>
                                                            <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                                                                <Chip
                                                                    label={download.status}
                                                                    size="small"
                                                                    color={download.status === 'downloading' ? 'primary' : download.status === 'completed' ? 'success' : 'warning'}
                                                                />
                                                                {hasSplit && (
                                                                    <Chip
                                                                        label={`Part ${download.fileIndex || 0}/${download.fileTotal}`}
                                                                        size="small"
                                                                        variant="outlined"
                                                                        color="info"
                                                                    />
                                                                )}
                                                                {sizeLabel && (
                                                                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                                        {sizeLabel}
                                                                    </Typography>
                                                                )}
                                                                {speedLabel && download.status === 'downloading' && (
                                                                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                                        ↓ {speedLabel}
                                                                    </Typography>
                                                                )}
                                                                {etaLabel && download.status === 'downloading' && (
                                                                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                                        ETA {etaLabel}
                                                                    </Typography>
                                                                )}
                                                            </Box>
                                                        </Box>
                                                        );
                                                    })}
                                                </Box>
                                            </CardContent>
                                        </Card>
                                    </Grid>
                                )}
                            </Grid>
                        )}

                        {/* My Models Tab */}
                        {visibleTabOrder[activeTab] === 1 && (
                            <MyModelsPanel instancesLoaded={liveInstances.length}>
                            <Grid container spacing={3}>
                                {/* Running Instances — Phase 7 Tailwind port */}
                                {liveInstances.length > 0 && (
                                    <Grid item xs={12}>
                                        <RunningInstancesPanel
                                            instances={liveInstances}
                                            onStop={handleStopInstance}
                                        />
                                    </Grid>
                                )}
                                {/* Legacy inline Running Instances JSX kept guarded
                                    `false` for one cycle for A/B during verification.
                                    Drop on follow-up. */}
                                {false && liveInstances.length > 0 && (
                                    <Grid item xs={12}>
                                        <Card sx={{ borderColor: 'success.dark', borderWidth: 1 }}>
                                            <CardContent>
                                                <SectionHeader
                                                    icon={<MemoryIcon />}
                                                    title="Running Instances"
                                                    subtitle={`${liveInstances.length} model${liveInstances.length > 1 ? 's' : ''} currently loaded`}
                                                />
                                                <Grid container spacing={2} sx={{ mt: 1 }}>
                                                    {liveInstances.map(instance => (
                                                        <Grid item xs={12} sm={6} md={4} key={instance.name}>
                                                            <Card variant="outlined" sx={{
                                                                bgcolor: 'rgba(34, 197, 94, 0.05)',
                                                                borderColor: 'success.dark',
                                                            }}>
                                                                <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                                                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                                                                        <Box sx={{ flex: 1 }}>
                                                                            <Typography variant="h6" sx={{ mb: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                                                {instance.name}
                                                                            </Typography>
                                                                            <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
                                                                                <Chip
                                                                                    label={`Port ${instance.port}`}
                                                                                    size="small"
                                                                                    color="success"
                                                                                />
                                                                                <Tooltip title={`Backend: ${instance.backend === 'llamacpp' ? 'llama.cpp' : 'sglang'}`}>
                                                                                    <Chip
                                                                                        label={instance.backend === 'llamacpp' ? 'llama.cpp' : 'sglang'}
                                                                                        size="small"
                                                                                        sx={{
                                                                                            bgcolor: 'rgba(255, 255, 255, 0.1)',
                                                                                            color: '#ffffff',
                                                                                            fontWeight: 600,
                                                                                            border: '1px solid rgba(255, 255, 255, 0.2)'
                                                                                        }}
                                                                                    />
                                                                                </Tooltip>
                                                                                <Tooltip title="Context size">
                                                                                    <Chip
                                                                                        label={`${instance.backend === 'llamacpp' ? instance.config?.contextSize || 4096 : instance.config?.maxModelLen || 4096} ctx`}
                                                                                        size="small"
                                                                                        variant="outlined"
                                                                                    />
                                                                                </Tooltip>
                                                                                {instance.backend === 'sglang' && instance.config?.cpuOffloadGb > 0 && (
                                                                                    <Tooltip title="CPU offload enabled">
                                                                                        <Chip
                                                                                            label={`CPU: ${instance.config?.cpuOffloadGb}GB`}
                                                                                            size="small"
                                                                                            color="info"
                                                                                            variant="outlined"
                                                                                        />
                                                                                    </Tooltip>
                                                                                )}
                                                                            </Box>
                                                                            <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
                                                                                {instance.backend === 'sglang' ? (
                                                                                    <>
                                                                                        <Tooltip title="GPU memory utilization">
                                                                                            <Chip
                                                                                                label={`GPU: ${Math.round((instance.config?.memFractionStatic || 0.88) * 100)}%`}
                                                                                                size="small"
                                                                                                variant="outlined"
                                                                                                sx={{ fontSize: '0.7rem' }}
                                                                                            />
                                                                                        </Tooltip>
                                                                                        <Tooltip title="Tensor parallel size (GPUs)">
                                                                                            <Chip
                                                                                                label={`TP: ${instance.config?.tensorParallelSize || 1}`}
                                                                                                size="small"
                                                                                                variant="outlined"
                                                                                                sx={{ fontSize: '0.7rem' }}
                                                                                            />
                                                                                        </Tooltip>
                                                                                        <Tooltip title="Max concurrent sequences">
                                                                                            <Chip
                                                                                                label={`Seqs: ${instance.config?.maxRunningRequests || 256}`}
                                                                                                size="small"
                                                                                                variant="outlined"
                                                                                                sx={{ fontSize: '0.7rem' }}
                                                                                            />
                                                                                        </Tooltip>
                                                                                        {instance.config?.kvCacheDtype && instance.config?.kvCacheDtype !== 'auto' && (
                                                                                            <Tooltip title="KV cache data type">
                                                                                                <Chip
                                                                                                    label={`KV: ${instance.config?.kvCacheDtype}`}
                                                                                                    size="small"
                                                                                                    color="warning"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.enforceEager && (
                                                                                            <Tooltip title="CUDA graphs disabled">
                                                                                                <Chip
                                                                                                    label="Eager"
                                                                                                    size="small"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.contextShift && (
                                                                                            <Tooltip title="Context shifting enabled">
                                                                                                <Chip
                                                                                                    label="CtxShift"
                                                                                                    size="small"
                                                                                                    color="success"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.compressMemory && (
                                                                                            <Tooltip title="AIMem memory compression enabled">
                                                                                                <Chip
                                                                                                    label="AIMem"
                                                                                                    size="small"
                                                                                                    color="secondary"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                    </>
                                                                                ) : (
                                                                                    <>
                                                                                        <Tooltip title="GPU layers (-1 = all)">
                                                                                            <Chip
                                                                                                label={`Layers: ${instance.config?.nGpuLayers === -1 ? 'All' : instance.config?.nGpuLayers || 'All'}`}
                                                                                                size="small"
                                                                                                variant="outlined"
                                                                                                sx={{ fontSize: '0.7rem' }}
                                                                                            />
                                                                                        </Tooltip>
                                                                                        <Tooltip title="Parallel slots">
                                                                                            <Chip
                                                                                                label={`Slots: ${instance.config?.parallelSlots || 1}`}
                                                                                                size="small"
                                                                                                variant="outlined"
                                                                                                sx={{ fontSize: '0.7rem' }}
                                                                                            />
                                                                                        </Tooltip>
                                                                                        {instance.config?.threads > 0 && (
                                                                                            <Tooltip title="CPU threads">
                                                                                                <Chip
                                                                                                    label={`Threads: ${instance.config?.threads}`}
                                                                                                    size="small"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.batchSize && instance.config?.batchSize !== 2048 && (
                                                                                            <Tooltip title="Batch size">
                                                                                                <Chip
                                                                                                    label={`Batch: ${instance.config?.batchSize}`}
                                                                                                    size="small"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {(instance.config?.cacheTypeK && instance.config?.cacheTypeK !== 'f16') && (
                                                                                            <Tooltip title="KV cache quantization">
                                                                                                <Chip
                                                                                                    label={`Cache: ${instance.config?.cacheTypeK}`}
                                                                                                    size="small"
                                                                                                    color="warning"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.flashAttention && (
                                                                                            <Tooltip title="Flash attention enabled">
                                                                                                <Chip
                                                                                                    label="Flash"
                                                                                                    size="small"
                                                                                                    color="info"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.swaFull && (
                                                                                            <Tooltip title="Full SWA cache — prompt cache reuses across turns">
                                                                                                <Chip
                                                                                                    label="SWA-Full"
                                                                                                    size="small"
                                                                                                    color="success"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.contextShift && (
                                                                                            <Tooltip title="Context shifting enabled">
                                                                                                <Chip
                                                                                                    label="CtxShift"
                                                                                                    size="small"
                                                                                                    color="success"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {instance.config?.compressMemory && (
                                                                                            <Tooltip title="AIMem memory compression enabled">
                                                                                                <Chip
                                                                                                    label="AIMem"
                                                                                                    size="small"
                                                                                                    color="secondary"
                                                                                                    variant="outlined"
                                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                                />
                                                                                            </Tooltip>
                                                                                        )}
                                                                                        {/* Always show the reasoning state so it's unambiguous at a glance. */}
                                                                                        <Tooltip title={instance.config?.disableThinking ? 'Reasoning disabled — model will not emit <think> blocks' : 'Reasoning enabled — model may use <think> blocks for chain-of-thought'}>
                                                                                            <Chip
                                                                                                label={instance.config?.disableThinking ? 'Reasoning: Off' : 'Reasoning: On'}
                                                                                                size="small"
                                                                                                color={instance.config?.disableThinking ? 'default' : 'success'}
                                                                                                variant="outlined"
                                                                                                sx={{ fontSize: '0.7rem' }}
                                                                                            />
                                                                                        </Tooltip>
                                                                                    </>
                                                                                )}
                                                                            </Box>
                                                                        </Box>
                                                                        <Tooltip title="Stop Instance">
                                                                            <IconButton
                                                                                size="small"
                                                                                onClick={() => handleStopInstance(instance.name, instance.backend)}
                                                                                sx={{ color: 'error.main' }}
                                                                            >
                                                                                <StopIcon />
                                                                            </IconButton>
                                                                        </Tooltip>
                                                                    </Box>
                                                                </CardContent>
                                                            </Card>
                                                        </Grid>
                                                    ))}
                                                </Grid>
                                            </CardContent>
                                        </Card>
                                    </Grid>
                                )}

                                {/* Cached HuggingFace Models (sglang HF-repo loads) */}
                                {hfCacheEntries.length > 0 && (
                                    <Grid item xs={12}>
                                        <Card>
                                            <CardContent>
                                                <SectionHeader
                                                    icon={<CloudDownloadIcon />}
                                                    title="Cached sglang Models (HuggingFace cache)"
                                                    subtitle={`${hfCacheEntries.length} repo${hfCacheEntries.length > 1 ? 's' : ''} · ${formatBytes(hfCacheTotalBytes)} total — reloads use this cache (no re-download)`}
                                                    action={
                                                        <Tooltip title="Refresh cache list">
                                                            <IconButton size="small" onClick={fetchHfCache} disabled={hfCacheLoading}>
                                                                <RefreshIcon />
                                                            </IconButton>
                                                        </Tooltip>
                                                    }
                                                />
                                                <Grid container spacing={2} sx={{ mt: 1 }}>
                                                    {hfCacheEntries.map(entry => (
                                                        <Grid item xs={12} sm={6} md={4} key={entry.dirName}>
                                                            <Card variant="outlined" sx={{
                                                                bgcolor: entry.loaded ? 'rgba(34,197,94,0.05)' : 'var(--bg-hover)',
                                                                borderColor: entry.loaded ? 'success.dark' : 'var(--border-focus)'
                                                            }}>
                                                                <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                                                    {/* Header row mirrors GGUF Available Models card:
                                                                        name + Load/Delete IconButtons on the right. */}
                                                                    <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 0.75 }}>
                                                                        <Typography sx={{ flex: 1, fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all', mr: 1 }}>
                                                                            {entry.repoId}
                                                                        </Typography>
                                                                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                                                                            {!entry.loaded && (
                                                                                <Tooltip title="Load Model">
                                                                                    <IconButton
                                                                                        size="small"
                                                                                        onClick={() => handleReloadHfCache(entry)}
                                                                                        sx={{ color: 'primary.main' }}
                                                                                    >
                                                                                        <PlayArrowIcon fontSize="small" />
                                                                                    </IconButton>
                                                                                </Tooltip>
                                                                            )}
                                                                            <Tooltip title={entry.loaded ? 'Stop instance first' : 'Delete from cache (frees disk; next load re-downloads)'}>
                                                                                <span>
                                                                                    <IconButton
                                                                                        size="small"
                                                                                        disabled={entry.loaded}
                                                                                        onClick={() => handleDeleteHfCache(entry)}
                                                                                        sx={{ color: 'error.main' }}
                                                                                    >
                                                                                        <DeleteIcon fontSize="small" />
                                                                                    </IconButton>
                                                                                </span>
                                                                            </Tooltip>
                                                                        </Box>
                                                                    </Box>
                                                                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                                                                        <Chip label={formatBytes(entry.sizeBytes)} size="small" sx={{ height: 20, fontSize: '0.7rem' }} />
                                                                        {entry.loaded && (
                                                                            <Chip label="Loaded" size="small" color="success" sx={{ height: 20, fontSize: '0.7rem' }} />
                                                                        )}
                                                                        {entry.lastModified > 0 && (
                                                                            <Typography variant="caption" sx={{ color: 'text.secondary', ml: 'auto' }}>
                                                                                {new Date(entry.lastModified).toLocaleDateString()}
                                                                            </Typography>
                                                                        )}
                                                                    </Box>
                                                                </CardContent>
                                                            </Card>
                                                        </Grid>
                                                    ))}
                                                </Grid>
                                            </CardContent>
                                        </Card>
                                    </Grid>
                                )}

                                {/* Available Models */}
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <SectionHeader
                                                icon={<StorageIcon />}
                                                title="Available Models"
                                                subtitle={models.length > 0 ? `${models.length} model${models.length > 1 ? 's' : ''} downloaded` : 'No models downloaded yet'}
                                            />
                                            {models.length === 0 ? (
                                                <Box sx={{ textAlign: 'center', py: 6 }}>
                                                    <StorageIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
                                                    <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>
                                                        No models downloaded yet
                                                    </Typography>
                                                    <Button
                                                        variant="outlined"
                                                        onClick={() => setActiveTab(0)}
                                                    >
                                                        Browse Models
                                                    </Button>
                                                </Box>
                                            ) : (
                                                <Grid container spacing={2} sx={{ mt: 1 }}>
                                                    {models.map((model) => {
                                                        const paramSize = extractParameterSize(model.name);
                                                        const isRunning = model.loadedIn === 'sglang' || model.loadedIn === 'llamacpp';
                                                        const isLoading = model.status.includes('Starting') || model.status.includes('Loading');
                                                        return (
                                                            <Grid item xs={12} sm={6} md={4} key={model.name}>
                                                                <Card variant="outlined" sx={{
                                                                    transition: 'all 0.15s',
                                                                    '&:hover': {
                                                                        borderColor: 'primary.main',
                                                                    },
                                                                }}>
                                                                    <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                                                        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                                                                            <Typography variant="h6" sx={{
                                                                                flex: 1,
                                                                                whiteSpace: 'nowrap',
                                                                                overflow: 'hidden',
                                                                                textOverflow: 'ellipsis',
                                                                                mr: 1
                                                                            }}>
                                                                                {model.name}
                                                                            </Typography>
                                                                            <Box sx={{ display: 'flex', gap: 0.5 }}>
                                                                                {!isRunning && !isLoading && (
                                                                                    <Tooltip title="Load Model">
                                                                                        <IconButton
                                                                                            size="small"
                                                                                            onClick={() => handleLoadModel(model.name)}
                                                                                            sx={{ color: 'primary.main' }}
                                                                                        >
                                                                                            <PlayArrowIcon fontSize="small" />
                                                                                        </IconButton>
                                                                                    </Tooltip>
                                                                                )}
                                                                                <Tooltip title="Delete Model">
                                                                                    <IconButton
                                                                                        size="small"
                                                                                        onClick={() => handleDeleteModel(model.name)}
                                                                                        sx={{ color: 'error.main' }}
                                                                                    >
                                                                                        <DeleteIcon fontSize="small" />
                                                                                    </IconButton>
                                                                                </Tooltip>
                                                                            </Box>
                                                                        </Box>
                                                                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                                                                            {paramSize && (
                                                                                <Chip label={paramSize} size="small" color="secondary" />
                                                                            )}
                                                                            {model.quantization && (
                                                                                <Chip
                                                                                    label={model.quantization}
                                                                                    size="small"
                                                                                    color="primary"
                                                                                    variant="outlined"
                                                                                />
                                                                            )}
                                                                            {model.isThinkingModel && (
                                                                                <Tooltip title="Extended reasoning model with chain-of-thought capabilities. May include thinking tokens in responses.">
                                                                                    <Chip
                                                                                        icon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
                                                                                        label="Thinking"
                                                                                        size="small"
                                                                                        color="warning"
                                                                                    />
                                                                                </Tooltip>
                                                                            )}
                                                                            <Chip
                                                                                label={model.status}
                                                                                size="small"
                                                                                color={
                                                                                    isRunning ? 'success' :
                                                                                    isLoading ? 'info' :
                                                                                    model.status.includes('Slow') ? 'warning' :
                                                                                    'default'
                                                                                }
                                                                                variant={isRunning ? 'filled' : 'outlined'}
                                                                            />
                                                                            {model.port && (
                                                                                <Chip
                                                                                    label={`Port ${model.port}`}
                                                                                    size="small"
                                                                                    variant="outlined"
                                                                                />
                                                                            )}
                                                                        </Box>
                                                                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', fontSize: '0.75rem', color: 'text.secondary' }}>
                                                                            {model.fileSize && (
                                                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                    <StorageIcon sx={{ fontSize: 14 }} />
                                                                                    <Typography variant="caption">{(model.fileSize / 1024 / 1024 / 1024).toFixed(2)} GB</Typography>
                                                                                </Box>
                                                                            )}
                                                                            {model.contextSize && (
                                                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                    <MemoryIcon sx={{ fontSize: 14 }} />
                                                                                    <Typography variant="caption">
                                                                                        {model.contextSize >= 1048576 ? `${(model.contextSize / 1048576).toFixed(0)}M` :
                                                                                         model.contextSize >= 1024 ? `${(model.contextSize / 1024).toFixed(0)}K` :
                                                                                         model.contextSize} ctx
                                                                                    </Typography>
                                                                                </Box>
                                                                            )}
                                                                        </Box>
                                                                    </CardContent>
                                                                </Card>
                                                            </Grid>
                                                        );
                                                    })}
                                                </Grid>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Grid>

                            </Grid>
                            </MyModelsPanel>
                        )}

                        {/* Users Tab */}
                        {visibleTabOrder[activeTab] === 2 && (
                            <UsersPanel
                                users={users}
                                user={user}
                                usersLoading={usersLoading}
                                isAdmin={user?.role === 'admin'}
                                isMobile={isMobile}
                                onInvite={() => {
                                    setUserDialogMode('invite');
                                    setNewUserData({ username: '', email: '', password: '', role: 'user' });
                                    setUserDialogOpen(true);
                                }}
                                onEdit={(u) => handleOpenUserDialog('edit', u)}
                                onResetPassword={(u) => handleOpenUserDialog('resetPassword', u)}
                                onDelete={(id) => handleDeleteUser(id)}
                                onToggleStatus={(id, nextDisabled) => handleToggleUserStatus(id, nextDisabled)}
                            />
                        )}
                        {/* Legacy inline Users JSX retained one cycle for A/B */}
                        {false && visibleTabOrder[activeTab] === 2 && (
                            <Grid container spacing={3}>
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, gap: 1 }}>
                                                <SectionHeader
                                                    icon={<PeopleIcon />}
                                                    title="User Management"
                                                    subtitle="Manage user accounts and permissions"
                                                />
                                                {user?.role === 'admin' && (
                                                    <Button
                                                        variant="outlined"
                                                        size={isMobile ? 'small' : 'medium'}
                                                        startIcon={<EmailIcon />}
                                                        onClick={() => {
                                                            setUserDialogMode('invite');
                                                            setNewUserData({ username: '', email: '', password: '', role: 'user' });
                                                            setUserDialogOpen(true);
                                                        }}
                                                        sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                                                    >
                                                        {isMobile ? 'Invite' : 'Invite User'}
                                                    </Button>
                                                )}
                                            </Box>

                                            {user?.role !== 'admin' ? (
                                                <Box sx={{ textAlign: 'center', py: 8 }}>
                                                    <PeopleIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
                                                    <Typography variant="body1" sx={{ color: 'text.secondary' }}>
                                                        Admin access required to manage users
                                                    </Typography>
                                                </Box>
                                            ) : usersLoading ? (
                                                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                                                    <CircularProgress />
                                                </Box>
                                            ) : users.length === 0 ? (
                                                <Box sx={{ textAlign: 'center', py: 4 }}>
                                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                                        No users found
                                                    </Typography>
                                                </Box>
                                            ) : (
                                                <TableContainer>
                                                    <Table>
                                                        <TableHead>
                                                            <TableRow>
                                                                <TableCell>Username</TableCell>
                                                                <TableCell>Email</TableCell>
                                                                <TableCell>Role</TableCell>
                                                                <TableCell>Status</TableCell>
                                                                <TableCell>Last Login</TableCell>
                                                                <TableCell align="right">Actions</TableCell>
                                                            </TableRow>
                                                        </TableHead>
                                                        <TableBody>
                                                            {users.map((u) => (
                                                                <TableRow key={u.id} sx={{ opacity: u.disabled ? 0.6 : 1 }}>
                                                                    <TableCell>
                                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                            <AccountCircleIcon sx={{ color: u.disabled ? 'text.disabled' : 'text.secondary' }} />
                                                                            {u.username}
                                                                            {u.id === user?.id && (
                                                                                <Chip label="You" size="small" color="primary" sx={{ height: 20, fontSize: '0.7rem' }} />
                                                                            )}
                                                                        </Box>
                                                                    </TableCell>
                                                                    <TableCell>{u.email}</TableCell>
                                                                    <TableCell>
                                                                        <Chip
                                                                            label={u.role}
                                                                            size="small"
                                                                            color={u.role === 'admin' ? 'secondary' : 'default'}
                                                                            sx={{ textTransform: 'capitalize' }}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        <Chip
                                                                            label={u.disabled ? 'Disabled' : 'Active'}
                                                                            size="small"
                                                                            color={u.disabled ? 'error' : 'success'}
                                                                            sx={{ minWidth: 70 }}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        {u.lastLoginAt ? (
                                                                            <Tooltip title={new Date(u.lastLoginAt).toLocaleString()}>
                                                                                <Typography variant="body2" sx={{ fontSize: '0.85rem' }}>
                                                                                    {new Date(u.lastLoginAt).toLocaleDateString()}
                                                                                </Typography>
                                                                            </Tooltip>
                                                                        ) : (
                                                                            <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>
                                                                                Never
                                                                            </Typography>
                                                                        )}
                                                                    </TableCell>
                                                                    <TableCell align="right">
                                                                        {u.id !== user?.id && (
                                                                            <Tooltip title={u.disabled ? 'Enable Account' : 'Disable Account'}>
                                                                                <Switch
                                                                                    size="small"
                                                                                    checked={!u.disabled}
                                                                                    onChange={() => handleToggleUserStatus(u.id, !u.disabled)}
                                                                                    color="success"
                                                                                />
                                                                            </Tooltip>
                                                                        )}
                                                                        <Tooltip title="Edit">
                                                                            <IconButton
                                                                                size="small"
                                                                                onClick={() => handleOpenUserDialog('edit', u)}
                                                                            >
                                                                                <EditIcon fontSize="small" />
                                                                            </IconButton>
                                                                        </Tooltip>
                                                                        <Tooltip title="Reset Password">
                                                                            <IconButton
                                                                                size="small"
                                                                                onClick={() => handleOpenUserDialog('resetPassword', u)}
                                                                            >
                                                                                <VpnKeyIcon fontSize="small" />
                                                                            </IconButton>
                                                                        </Tooltip>
                                                                        {u.id !== user?.id && (
                                                                            <Tooltip title="Delete">
                                                                                <IconButton
                                                                                    size="small"
                                                                                    color="error"
                                                                                    onClick={() => handleDeleteUser(u.id)}
                                                                                >
                                                                                    <DeleteIcon fontSize="small" />
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                        )}
                                                                    </TableCell>
                                                                </TableRow>
                                                            ))}
                                                        </TableBody>
                                                    </Table>
                                                </TableContainer>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Grid>
                            </Grid>
                        )}

                        {/* User Dialog — Tailwind Modal port */}
                        <UserDialog
                            open={userDialogOpen}
                            mode={userDialogMode}
                            selectedUser={selectedUser}
                            formData={newUserData}
                            setFormData={setNewUserData}
                            onClose={handleCloseUserDialog}
                            onCreate={handleCreateUser}
                            onUpdate={handleUpdateUser}
                            onInvite={handleInviteUser}
                            onResetPassword={handleResetPassword}
                        />

                        {/* API Keys Tab (Admin Only) */}
                        {visibleTabOrder[activeTab] === 3 && isAdmin && (
                            <Grid container spacing={3}>
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, gap: 1 }}>
                                                <SectionHeader
                                                    icon={<VpnKeyIcon />}
                                                    title="API Key Management"
                                                    subtitle="Create and manage API keys for programmatic access"
                                                />
                                                <Button
                                                    variant="contained"
                                                    size={isMobile ? 'small' : 'medium'}
                                                    startIcon={<AddIcon />}
                                                    onClick={() => setShowCreateKeyDialog(!showCreateKeyDialog)}
                                                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                                                >
                                                    {isMobile ? 'Create' : 'Create API Key'}
                                                </Button>
                                            </Box>

                                            {/* Create Key Form */}
                                            <Collapse in={showCreateKeyDialog}>
                                                <Card variant="outlined" sx={{ mb: 3, p: 2, bgcolor: 'background.default' }}>
                                                    <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
                                                        New API Key
                                                    </Typography>
                                                    <Grid container spacing={2}>
                                                        <Grid item xs={12} md={6}>
                                                            <TextField
                                                                fullWidth
                                                                size="small"
                                                                label="Key Name"
                                                                value={newKeyName}
                                                                onChange={(e) => setNewKeyName(e.target.value)}
                                                                placeholder="My API Key"
                                                            />
                                                        </Grid>
                                                        <Grid item xs={12} md={6}>
                                                            <FormControl fullWidth size="small">
                                                                <InputLabel>Permissions</InputLabel>
                                                                <Select
                                                                    multiple
                                                                    value={newKeyPermissions}
                                                                    onChange={(e) => setNewKeyPermissions(e.target.value)}
                                                                    label="Permissions"
                                                                >
                                                                    <MenuItem value="query">Query Models</MenuItem>
                                                                    <MenuItem value="query_web">Query Web</MenuItem>
                                                                    <MenuItem value="agents">Manage Agents</MenuItem>
                                                                    <MenuItem value="skills">Manage Tools</MenuItem>
                                                                    <MenuItem value="models">Manage Models</MenuItem>
                                                                    <MenuItem value="instances">Manage Instances</MenuItem>
                                                                    <MenuItem value="admin">Admin Access</MenuItem>
                                                                </Select>
                                                            </FormControl>
                                                        </Grid>
                                                        <Grid item xs={12}>
                                                            <FormControlLabel
                                                                control={
                                                                    <Switch
                                                                        size="small"
                                                                        checked={bearerOnly}
                                                                        onChange={(e) => setBearerOnly(e.target.checked)}
                                                                    />
                                                                }
                                                                label="Bearer Token Only (no secret required)"
                                                            />
                                                            <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}>
                                                                Bearer tokens can be used with "Authorization: Bearer &lt;token&gt;" header without requiring a secret.
                                                            </Typography>
                                                        </Grid>
                                                        <Grid item xs={12}>
                                                            <Autocomplete
                                                                multiple
                                                                size="small"
                                                                options={skills.map(s => s.name).filter(Boolean)}
                                                                value={newKeyDisabledSkills}
                                                                onChange={(e, v) => setNewKeyDisabledSkills(v)}
                                                                renderTags={(value, getTagProps) =>
                                                                    value.map((option, index) => (
                                                                        <Chip variant="outlined" color="warning" label={option} size="small" {...getTagProps({ index })} key={option} />
                                                                    ))
                                                                }
                                                                renderInput={(params) => (
                                                                    <TextField
                                                                        {...params}
                                                                        size="small"
                                                                        label="Disabled Skills"
                                                                        placeholder="Block specific tools (optional)"
                                                                        helperText="By default the key can call every enabled skill. Pick one or more here to BLOCK them for this key (e.g. disable file-write skills for a read-only Pi key)."
                                                                    />
                                                                )}
                                                            />
                                                        </Grid>
                                                        <Grid item xs={12} md={6}>
                                                            <Box>
                                                                <FormControlLabel
                                                                    control={
                                                                        <Switch
                                                                            size="small"
                                                                            checked={noRateLimit}
                                                                            onChange={(e) => setNoRateLimit(e.target.checked)}
                                                                        />
                                                                    }
                                                                    label="No Rate Limit"
                                                                />
                                                                {!noRateLimit && (
                                                                    <TextField
                                                                        fullWidth
                                                                        size="small"
                                                                        type="number"
                                                                        label="Rate Limit (req/min)"
                                                                        value={newKeyRateLimitRequests}
                                                                        onChange={(e) => setNewKeyRateLimitRequests(parseInt(e.target.value))}
                                                                        sx={{ mt: 1 }}
                                                                    />
                                                                )}
                                                            </Box>
                                                        </Grid>
                                                        <Grid item xs={12} md={6}>
                                                            <Box>
                                                                <FormControlLabel
                                                                    control={
                                                                        <Switch
                                                                            size="small"
                                                                            checked={noTokenLimit}
                                                                            onChange={(e) => setNoTokenLimit(e.target.checked)}
                                                                        />
                                                                    }
                                                                    label="No Token Limit"
                                                                />
                                                                {!noTokenLimit && (
                                                                    <TextField
                                                                        fullWidth
                                                                        size="small"
                                                                        type="number"
                                                                        label="Token Limit (tokens/day)"
                                                                        value={newKeyRateLimitTokens}
                                                                        onChange={(e) => setNewKeyRateLimitTokens(parseInt(e.target.value))}
                                                                        sx={{ mt: 1 }}
                                                                    />
                                                                )}
                                                            </Box>
                                                        </Grid>
                                                        <Grid item xs={12}>
                                                            <Box sx={{ display: 'flex', gap: 1 }}>
                                                                <Button
                                                                    variant="contained"
                                                                    onClick={handleCreateApiKey}
                                                                    startIcon={<SaveIcon />}
                                                                >
                                                                    Create Key
                                                                </Button>
                                                                <Button
                                                                    variant="outlined"
                                                                    onClick={() => setShowCreateKeyDialog(false)}
                                                                >
                                                                    Cancel
                                                                </Button>
                                                            </Box>
                                                        </Grid>
                                                    </Grid>
                                                </Card>
                                            </Collapse>

                                            {/* Created Key Display */}
                                            {createdKeyData && (
                                                <Alert severity="success" sx={{ mb: 3 }} onClose={() => { setCreatedKeyData(null); setShowCreatedSecret(false); }}>
                                                    <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                                                        {createdKeyData.bearerOnly ? 'Bearer Token Created Successfully!' : 'API Key Created Successfully!'}
                                                    </Typography>
                                                    <Typography variant="body2" sx={{ mb: 1 }}>
                                                        {createdKeyData.bearerOnly
                                                            ? 'Save this Bearer token securely. Use it in the Authorization header: Bearer <token>'
                                                            : 'Save these credentials securely. The secret will not be shown again.'}
                                                    </Typography>
                                                    <Box sx={{ fontFamily: 'monospace', fontSize: '0.75rem', bgcolor: 'rgba(0,0,0,0.2)', p: 1, borderRadius: 1, mb: 1 }}>
                                                        <Box sx={{ mb: createdKeyData.bearerOnly ? 0 : 0.5 }}>
                                                            <strong>{createdKeyData.bearerOnly ? 'Bearer Token:' : 'API Key:'}</strong> {createdKeyData.key}
                                                            <IconButton size="small" onClick={() => copyToClipboard(createdKeyData.key)}>
                                                                <ContentCopyIcon sx={{ fontSize: 14 }} />
                                                            </IconButton>
                                                        </Box>
                                                        {!createdKeyData.bearerOnly && (
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <strong>Secret:</strong>
                                                                {showCreatedSecret ? createdKeyData.secret : '•'.repeat(48)}
                                                                <IconButton size="small" onClick={() => setShowCreatedSecret(!showCreatedSecret)}>
                                                                    {showCreatedSecret ? <VisibilityOffIcon sx={{ fontSize: 14 }} /> : <VisibilityIcon sx={{ fontSize: 14 }} />}
                                                                </IconButton>
                                                                {showCreatedSecret && (
                                                                    <IconButton size="small" onClick={() => copyToClipboard(createdKeyData.secret)}>
                                                                        <ContentCopyIcon sx={{ fontSize: 14 }} />
                                                                    </IconButton>
                                                                )}
                                                            </Box>
                                                        )}
                                                    </Box>
                                                </Alert>
                                            )}

                                            {/* Edit Key Dialog */}
                                            {editingKey && (
                                                <Card variant="outlined" sx={{ mb: 3, p: 2, bgcolor: 'rgba(99, 102, 241, 0.05)', border: '1px solid var(--border-focus)' }}>
                                                    <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600, color: 'primary.main' }}>
                                                        Edit API Key: {editingKey.name}
                                                    </Typography>
                                                    <Grid container spacing={2}>
                                                        <Grid item xs={12} md={6}>
                                                            <TextField
                                                                fullWidth
                                                                size="small"
                                                                label="Key Name"
                                                                value={editKeyName}
                                                                onChange={(e) => setEditKeyName(e.target.value)}
                                                                placeholder="My API Key"
                                                            />
                                                        </Grid>
                                                        <Grid item xs={12} md={6}>
                                                            <FormControl fullWidth size="small">
                                                                <InputLabel>Permissions</InputLabel>
                                                                <Select
                                                                    multiple
                                                                    value={editKeyPermissions}
                                                                    onChange={(e) => setEditKeyPermissions(e.target.value)}
                                                                    label="Permissions"
                                                                >
                                                                    <MenuItem value="query">Query Models</MenuItem>
                                                                    <MenuItem value="query_web">Query Web</MenuItem>
                                                                    <MenuItem value="agents">Manage Agents</MenuItem>
                                                                    <MenuItem value="skills">Manage Tools</MenuItem>
                                                                    <MenuItem value="models">Manage Models</MenuItem>
                                                                    <MenuItem value="instances">Manage Instances</MenuItem>
                                                                    <MenuItem value="admin">Admin Access</MenuItem>
                                                                </Select>
                                                            </FormControl>
                                                        </Grid>
                                                        <Grid item xs={12}>
                                                            <Autocomplete
                                                                multiple
                                                                size="small"
                                                                options={skills.map(s => s.name).filter(Boolean)}
                                                                value={editKeyDisabledSkills}
                                                                onChange={(e, v) => setEditKeyDisabledSkills(v)}
                                                                renderTags={(value, getTagProps) =>
                                                                    value.map((option, index) => (
                                                                        <Chip variant="outlined" color="warning" label={option} size="small" {...getTagProps({ index })} key={option} />
                                                                    ))
                                                                }
                                                                renderInput={(params) => (
                                                                    <TextField
                                                                        {...params}
                                                                        size="small"
                                                                        label="Disabled Skills"
                                                                        placeholder="Block specific tools (optional)"
                                                                        helperText="By default the key can call every enabled skill. Pick one or more here to BLOCK them for this key."
                                                                    />
                                                                )}
                                                            />
                                                        </Grid>
                                                        <Grid item xs={12} md={6}>
                                                            <Box>
                                                                <FormControlLabel
                                                                    control={
                                                                        <Switch
                                                                            size="small"
                                                                            checked={editNoRateLimit}
                                                                            onChange={(e) => setEditNoRateLimit(e.target.checked)}
                                                                        />
                                                                    }
                                                                    label="No Rate Limit"
                                                                />
                                                                {!editNoRateLimit && (
                                                                    <TextField
                                                                        fullWidth
                                                                        size="small"
                                                                        type="number"
                                                                        label="Rate Limit (req/min)"
                                                                        value={editKeyRateLimitRequests}
                                                                        onChange={(e) => setEditKeyRateLimitRequests(parseInt(e.target.value))}
                                                                        sx={{ mt: 1 }}
                                                                    />
                                                                )}
                                                            </Box>
                                                        </Grid>
                                                        <Grid item xs={12} md={6}>
                                                            <Box>
                                                                <FormControlLabel
                                                                    control={
                                                                        <Switch
                                                                            size="small"
                                                                            checked={editNoTokenLimit}
                                                                            onChange={(e) => setEditNoTokenLimit(e.target.checked)}
                                                                        />
                                                                    }
                                                                    label="No Token Limit"
                                                                />
                                                                {!editNoTokenLimit && (
                                                                    <TextField
                                                                        fullWidth
                                                                        size="small"
                                                                        type="number"
                                                                        label="Token Limit (tokens/day)"
                                                                        value={editKeyRateLimitTokens}
                                                                        onChange={(e) => setEditKeyRateLimitTokens(parseInt(e.target.value))}
                                                                        sx={{ mt: 1 }}
                                                                    />
                                                                )}
                                                            </Box>
                                                        </Grid>
                                                        <Grid item xs={12}>
                                                            <Box sx={{ display: 'flex', gap: 1 }}>
                                                                <Button
                                                                    variant="contained"
                                                                    onClick={handleUpdateApiKey}
                                                                    startIcon={<SaveIcon />}
                                                                >
                                                                    Update Key
                                                                </Button>
                                                                <Button
                                                                    variant="outlined"
                                                                    onClick={() => setEditingKey(null)}
                                                                >
                                                                    Cancel
                                                                </Button>
                                                            </Box>
                                                        </Grid>
                                                    </Grid>
                                                </Card>
                                            )}

                                            {/* API Keys List */}
                                            {apiKeys.length === 0 ? (
                                                <Box sx={{ textAlign: 'center', py: 4 }}>
                                                    <VpnKeyIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
                                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                                        No API keys created yet. Create one to get started.
                                                    </Typography>
                                                </Box>
                                            ) : (
                                                <TableContainer>
                                                    <Table size="small">
                                                        <TableHead>
                                                            <TableRow>
                                                                <TableCell>Name</TableCell>
                                                                <TableCell>API Key</TableCell>
                                                                <TableCell>API Secret</TableCell>
                                                                <TableCell>Permissions</TableCell>
                                                                <TableCell>Rate Limits</TableCell>
                                                                <TableCell>Status</TableCell>
                                                                <TableCell>Token Usage</TableCell>
                                                                <TableCell>Created</TableCell>
                                                                <TableCell>Actions</TableCell>
                                                            </TableRow>
                                                        </TableHead>
                                                        <TableBody>
                                                            {apiKeys.map((key) => (
                                                                <TableRow key={key.id}>
                                                                    <TableCell>{key.name}</TableCell>
                                                                    <TableCell>
                                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontFamily: 'monospace', fontSize: '0.7rem' }}>
                                                                            {showSecrets[key.id] ? key.key : `${key.key?.substring(0, 12)}...`}
                                                                            <Tooltip title={showSecrets[key.id] ? "Hide" : "Show"}>
                                                                                <IconButton size="small" onClick={() => setShowSecrets(prev => ({ ...prev, [key.id]: !prev[key.id] }))}>
                                                                                    {showSecrets[key.id] ? <VisibilityOffIcon sx={{ fontSize: 12 }} /> : <VisibilityIcon sx={{ fontSize: 12 }} />}
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                            <Tooltip title="Copy">
                                                                                <IconButton size="small" onClick={() => copyToClipboard(key.key)}>
                                                                                    <ContentCopyIcon sx={{ fontSize: 12 }} />
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                        </Box>
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        {key.bearerOnly ? (
                                                                            <Chip label="Bearer Only" size="small" color="info" sx={{ fontSize: '0.65rem', height: 20 }} />
                                                                        ) : (
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontFamily: 'monospace', fontSize: '0.7rem' }}>
                                                                                {showSecrets[`${key.id}-secret`] ? (key.secret || '(Not stored)') : '•'.repeat(16)}
                                                                                <Tooltip title={showSecrets[`${key.id}-secret`] ? "Hide" : "Show"}>
                                                                                    <IconButton size="small" onClick={() => setShowSecrets(prev => ({ ...prev, [`${key.id}-secret`]: !prev[`${key.id}-secret`] }))}>
                                                                                        {showSecrets[`${key.id}-secret`] ? <VisibilityOffIcon sx={{ fontSize: 12 }} /> : <VisibilityIcon sx={{ fontSize: 12 }} />}
                                                                                    </IconButton>
                                                                                </Tooltip>
                                                                                {key.secret && (
                                                                                    <Tooltip title="Copy">
                                                                                        <IconButton size="small" onClick={() => copyToClipboard(key.secret)}>
                                                                                            <ContentCopyIcon sx={{ fontSize: 12 }} />
                                                                                        </IconButton>
                                                                                    </Tooltip>
                                                                                )}
                                                                            </Box>
                                                                        )}
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                                                                            {key.permissions?.map(p => (
                                                                                <Chip key={p} label={p} size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
                                                                            ))}
                                                                        </Box>
                                                                    </TableCell>
                                                                    <TableCell sx={{ fontSize: '0.75rem' }}>
                                                                        {key.rateLimitRequests ? `${key.rateLimitRequests}/min` : 'No Limit'}
                                                                        <br />
                                                                        {key.rateLimitTokens ? `${(key.rateLimitTokens / 1000).toFixed(0)}k/day` : 'No Limit'}
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        <Chip
                                                                            label={key.active ? (key.stats?.isActive ? 'Active' : 'Idle') : 'Revoked'}
                                                                            size="small"
                                                                            color={key.active ? (key.stats?.isActive ? 'success' : 'default') : 'error'}
                                                                            sx={{ fontSize: '0.7rem', height: 20 }}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell sx={{ fontSize: '0.75rem' }}>
                                                                        {key.rateLimitTokens ? (
                                                                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                                                                                <Box>
                                                                                    {key.stats?.dailyTokens?.toLocaleString() || 0} / {(key.rateLimitTokens / 1000).toFixed(0)}k
                                                                                </Box>
                                                                                <Box sx={{ width: '100%', bgcolor: 'var(--bg-hover)', borderRadius: 1, height: 4, overflow: 'hidden' }}>
                                                                                    <Box sx={{
                                                                                        width: `${Math.min(100, key.stats?.tokenUsagePercentage || 0)}%`,
                                                                                        height: '100%',
                                                                                        bgcolor: (key.stats?.tokenUsagePercentage || 0) > 90 ? 'error.main' :
                                                                                                 (key.stats?.tokenUsagePercentage || 0) > 70 ? 'warning.main' : 'success.main',
                                                                                        transition: 'width 0.3s ease'
                                                                                    }} />
                                                                                </Box>
                                                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                                                                    {key.stats?.tokenUsagePercentage || 0}%
                                                                                </Typography>
                                                                            </Box>
                                                                        ) : (
                                                                            <Box sx={{ color: 'text.secondary' }}>
                                                                                {key.stats?.dailyTokens?.toLocaleString() || 0}
                                                                                <br />
                                                                                <Typography variant="caption">No Limit</Typography>
                                                                            </Box>
                                                                        )}
                                                                    </TableCell>
                                                                    <TableCell sx={{ fontSize: '0.75rem' }}>
                                                                        {new Date(key.createdAt).toLocaleDateString()}
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                                                                            <Tooltip title="Edit">
                                                                                <IconButton
                                                                                    size="small"
                                                                                    onClick={() => handleStartEditApiKey(key)}
                                                                                    color="primary"
                                                                                >
                                                                                    <EditIcon sx={{ fontSize: 16 }} />
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                            <Tooltip title={key.active ? "Revoke" : "Activate"}>
                                                                                <IconButton
                                                                                    size="small"
                                                                                    onClick={() => handleToggleApiKeyActive(key.id, key.active)}
                                                                                >
                                                                                    {key.active ? <StopIcon sx={{ fontSize: 16 }} /> : <PlayArrowIcon sx={{ fontSize: 16 }} />}
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                            <Tooltip title="Clear Token Usage">
                                                                                <IconButton
                                                                                    size="small"
                                                                                    onClick={() => handleClearApiKeyUsage(key.id, key.name)}
                                                                                    color="warning"
                                                                                >
                                                                                    <RestartAltIcon sx={{ fontSize: 16 }} />
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                            <Tooltip title="Delete">
                                                                                <IconButton
                                                                                    size="small"
                                                                                    onClick={() => handleDeleteApiKey(key.id, key.name)}
                                                                                    color="error"
                                                                                >
                                                                                    <DeleteIcon sx={{ fontSize: 16 }} />
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                        </Box>
                                                                    </TableCell>
                                                                </TableRow>
                                                            ))}
                                                        </TableBody>
                                                    </Table>
                                                </TableContainer>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Grid>
                            </Grid>
                        )}

                        {/* Docs Tab */}
                        {visibleTabOrder[activeTab] === 4 && (
                            <div className="flex flex-col gap-4">
                                {/* Tailwind page header in the same vocabulary
                                    as the other rebuilt panels (Logs, Users,
                                    Apps, My Models). The accordions below
                                    inherit theme via Phase 3 MUI overrides. */}
                                <div
                                    className="flex items-center gap-3 rounded-xl border px-4 py-3"
                                    style={{
                                        backgroundColor: 'var(--surface-primary)',
                                        borderColor: 'var(--border-primary)',
                                    }}
                                >
                                    <span
                                        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
                                        style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                                    >
                                        <LucideBookOpen size={20} strokeWidth={1.75} />
                                    </span>
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                            Documentation &amp; API Reference
                                        </div>
                                        <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                            Complete guide to getting started, API usage, and configuration
                                        </div>
                                    </div>
                                </div>
                            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2.5, alignItems: 'flex-start' }}>
                                {/* Left rail — section list. Sticky on desktop so the
                                    nav stays visible while the user reads a section. */}
                                <Box
                                    component="nav"
                                    aria-label="Documentation sections"
                                    sx={{
                                        width: { xs: '100%', md: 220 },
                                        flexShrink: 0,
                                        position: { xs: 'static', md: 'sticky' },
                                        top: { xs: 'auto', md: 16 },
                                        bgcolor: 'var(--bg-tertiary)',
                                        border: '1px solid var(--border-primary)',
                                        borderRadius: 2,
                                        p: 1,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 0.25,
                                    }}
                                >
                                    {DOC_SECTIONS.map((s) => {
                                        const active = activeDocSection === s.id;
                                        return (
                                            <Box
                                                key={s.id}
                                                component="button"
                                                type="button"
                                                onClick={() => setActiveDocSection(s.id)}
                                                sx={docNavItemSx(active)}
                                            >
                                                <span>{s.label}</span>
                                            </Box>
                                        );
                                    })}
                                </Box>

                                {/* Section pane — only the active section renders
                                    below; everything else is unmounted. */}
                                <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                                {/* Quick Start Guide */}
                                {activeDocSection === 'quick-start' && (
                                <Box sx={docSectionSx}>
                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Quick Start</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Get up and running in 3 steps</Typography>
                                            </Box>
                                        </Box>

                                    </Box>
                                    <Box sx={docSectionBodySx}>
                                        {/* Condensed 3-step flow */}
                                        <Grid container spacing={2}>
                                            <Grid item xs={12} md={4}>
                                                <Box sx={{ p: 2, bgcolor: 'var(--accent-muted)', borderRadius: 2, height: '100%', border: '1px solid var(--accent-muted)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                                                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'var(--accent-primary)', color: 'var(--accent-ink, #fff)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 }}>1</Box>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Load Model</Typography>
                                                    </Box>
                                                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                        <strong style={{ color: 'var(--text-primary)' }}>Discover</strong> → Download → <strong style={{ color: 'var(--text-primary)' }}>My Models</strong> → Load
                                                    </Typography>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={4}>
                                                <Box sx={{ p: 2, bgcolor: 'var(--accent-muted)', borderRadius: 2, height: '100%', border: '1px solid var(--accent-muted)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                                                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'var(--accent-primary)', color: 'var(--accent-ink, #fff)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 }}>2</Box>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Choose Interface</Typography>
                                                    </Box>
                                                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                        <strong style={{ color: 'var(--text-primary)' }}>AI Chat</strong> for web • <strong style={{ color: 'var(--text-primary)' }}>Pi</strong> for terminal • <strong style={{ color: 'var(--text-primary)' }}>API</strong> for code
                                                    </Typography>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={4}>
                                                <Box sx={{ p: 2, bgcolor: 'rgba(34, 197, 94, 0.08)', borderRadius: 2, height: '100%', border: '1px solid rgba(34, 197, 94, 0.15)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                                                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'var(--accent-primary)', color: 'var(--accent-ink, #fff)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 }}>3</Box>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Create API Key</Typography>
                                                    </Box>
                                                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                        <strong style={{ color: 'var(--text-primary)' }}>API Keys</strong> tab → Create → Copy credentials
                                                    </Typography>
                                                </Box>
                                            </Grid>
                                        </Grid>

                                        {/* Interface quick reference */}
                                        <Box sx={{ mt: 2.5, p: 2, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                            <TableContainer>
                                                <Table size="small" sx={compactTableSx}>
                                                    <TableHead>
                                                        <TableRow>
                                                            <TableCell sx={{ width: 100 }}>Interface</TableCell>
                                                            <TableCell>Setup / URL</TableCell>
                                                            <TableCell sx={{ width: 180 }}>Best For</TableCell>
                                                        </TableRow>
                                                    </TableHead>
                                                    <TableBody>
                                                        <TableRow>
                                                            <TableCell sx={{ fontWeight: 600, color: 'var(--accent-primary)' }}>AI Chat</TableCell>
                                                            <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>https://localhost:3002</TableCell>
                                                            <TableCell sx={{ color: 'var(--text-secondary)' }}>Web chat interface with streaming</TableCell>
                                                        </TableRow>
                                                        <TableRow>
                                                            <TableCell sx={{ fontWeight: 600, color: 'var(--accent-primary)' }}>Pi</TableCell>
                                                            <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>npm install -g @earendil-works/pi-coding-agent</TableCell>
                                                            <TableCell sx={{ color: 'var(--text-secondary)' }}>Terminal, automation (see Pi section below)</TableCell>
                                                        </TableRow>
                                                        <TableRow>
                                                            <TableCell sx={{ fontWeight: 600, color: 'var(--success)' }}>Direct API</TableCell>
                                                            <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{baseUrl}/api/chat</TableCell>
                                                            <TableCell sx={{ color: 'var(--text-secondary)' }}>Integrations</TableCell>
                                                        </TableRow>
                                                    </TableBody>
                                                </Table>
                                            </TableContainer>
                                        </Box>

                                    </Box>
                                </Box>
                                )}

                                {/* API Builder */}
                                {activeDocSection === 'api-builder' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>API Code Builder</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Generate code snippets for any endpoint</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        <Box sx={{ p: 2, bgcolor: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)', borderRadius: 2 }}>
                                            <Grid container spacing={2}>
                                                <Grid item xs={12} md={6}>
                                                    <FormControl fullWidth size="small">
                                                        <InputLabel>Endpoint</InputLabel>
                                                        <Select
                                                            value={apiBuilderEndpoint || '/api/chat'}
                                                            onChange={(e) => setApiBuilderEndpoint(e.target.value)}
                                                            label="Endpoint"
                                                        >
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Chat & Completion ───</MenuItem>
                                                            <MenuItem value="/api/chat">POST /api/chat - Simple Chat</MenuItem>
                                                            <MenuItem value="/api/chat/stream">POST /api/chat/stream - Streaming Chat (SSE)</MenuItem>
                                                            <MenuItem value="/api/chat/upload">POST /api/chat/upload - Upload File for Chat</MenuItem>
                                                            <MenuItem value="/api/attachments/:id">GET /api/attachments/:id - Fetch Attachment Bytes</MenuItem>
                                                            <MenuItem value="/api/attachments/:id/meta">GET /api/attachments/:id/meta - Fetch Attachment Metadata</MenuItem>
                                                            <MenuItem value="/api/complete">POST /api/complete - Text Completion</MenuItem>
                                                            <MenuItem value="/api/chat/continuation/:conversationId">GET /api/chat/continuation/:id - Get Continuation Queue</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Authentication ───</MenuItem>
                                                            <MenuItem value="/api/auth/has-users">GET /api/auth/has-users - Check If Users Exist</MenuItem>
                                                            <MenuItem value="/api/auth/register">POST /api/auth/register - Register User</MenuItem>
                                                            <MenuItem value="/api/auth/login">POST /api/auth/login - Login</MenuItem>
                                                            <MenuItem value="/api/auth/logout">POST /api/auth/logout - Logout</MenuItem>
                                                            <MenuItem value="/api/auth/me">GET /api/auth/me - Get Current User</MenuItem>
                                                            <MenuItem value="/api/auth/password">PUT /api/auth/password - Change Password</MenuItem>
                                                            <MenuItem value="/api/auth/reset-password">POST /api/auth/reset-password - Reset Password (Self-Service)</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Models ───</MenuItem>
                                                            <MenuItem value="/api/models">GET /api/models - List Models</MenuItem>
                                                            <MenuItem value="/api/models/pull">POST /api/models/pull - Download Model</MenuItem>
                                                            <MenuItem value="/api/models/:name/load">POST /api/models/:modelName/load - Load Model</MenuItem>
                                                            <MenuItem value="/api/models/:name">DELETE /api/models/:modelName - Delete Model</MenuItem>
                                                            <MenuItem value="/api/model-configs">GET /api/model-configs - List All Model Configs</MenuItem>
                                                            <MenuItem value="/api/model-configs/:modelName">GET /api/model-configs/:name - Get Model Config</MenuItem>
                                                            <MenuItem value="/api/model-configs/:modelName/update">PUT /api/model-configs/:name - Update Model Config</MenuItem>
                                                            <MenuItem value="/api/huggingface/search">GET /api/huggingface/search - Search HuggingFace</MenuItem>
                                                            <MenuItem value="/api/huggingface/files/:owner/:repo">GET /api/huggingface/files/:owner/:repo - List HuggingFace Files</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Downloads ───</MenuItem>
                                                            <MenuItem value="/api/downloads">GET /api/downloads - List Active Downloads</MenuItem>
                                                            <MenuItem value="/api/downloads/:downloadId">DELETE /api/downloads/:id - Cancel Download</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Instances ───</MenuItem>
                                                            <MenuItem value="/api/sglang/instances">GET /api/sglang/instances - List sglang Instances</MenuItem>
                                                            <MenuItem value="/api/sglang/instances/:name">DELETE /api/sglang/instances/:modelName - Stop sglang Instance</MenuItem>
                                                            <MenuItem value="/api/sglang/instances/:name/slots">GET /api/sglang/instances/:modelName/slots - Get KV Cache Slots</MenuItem>
                                                            <MenuItem value="/api/sglang/instances/:name/slots/clear">POST /api/sglang/instances/:name/slots/clear - Clear KV Cache</MenuItem>
                                                            <MenuItem value="/api/llamacpp/instances">GET /api/llamacpp/instances - List llama.cpp Instances</MenuItem>
                                                            <MenuItem value="/api/llamacpp/instances/:name">DELETE /api/llamacpp/instances/:modelName - Stop llama.cpp Instance</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── System Prompts ───</MenuItem>
                                                            <MenuItem value="/api/system-prompts">GET /api/system-prompts - List System Prompts</MenuItem>
                                                            <MenuItem value="/api/system-prompts/:modelName">GET /api/system-prompts/:name - Get System Prompt</MenuItem>
                                                            <MenuItem value="/api/system-prompts/:modelName/update">PUT /api/system-prompts/:name - Update System Prompt</MenuItem>
                                                            <MenuItem value="/api/system-prompts/:modelName/delete">DELETE /api/system-prompts/:name - Delete System Prompt</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── System ───</MenuItem>
                                                            <MenuItem value="/api/system/resources">GET /api/system/resources - System Hardware Info</MenuItem>
                                                            <MenuItem value="/api/system/optimal-settings">POST /api/system/optimal-settings - Calculate Settings</MenuItem>
                                                            <MenuItem value="/api/system/reset">POST /api/system/reset - System Reset (Admin)</MenuItem>
                                                            <MenuItem value="/api/system/tools-catalog">GET /api/system/tools-catalog - Native Tools Catalog</MenuItem>
                                                            <MenuItem value="/api/system/egress-proxy">GET /api/system/egress-proxy - Egress Proxy Stats (Admin)</MenuItem>
                                                            <MenuItem value="/api/sandbox/run-code">POST /api/sandbox/run-code - Sandboxed Python Eval</MenuItem>
                                                            <MenuItem value="/api/tool-artifacts/:runId/:filename">GET /api/tool-artifacts/:runId/:filename - Download Tool Artifact</MenuItem>
                                                            <MenuItem value="/api/docs">GET /api/docs - DevDocs Reference Lookup</MenuItem>
                                                            <MenuItem value="/v1/chat/completions">POST /v1/* - OpenAI-Compatible Passthrough</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Search & Web Scraping ───</MenuItem>
                                                            <MenuItem value="/api/search">GET /api/search - Web Search</MenuItem>
                                                            <MenuItem value="/api/url/fetch">POST /api/url/fetch - Fetch URLs (Chat Feature)</MenuItem>
                                                            <MenuItem value="/api/playwright/fetch">POST /api/playwright/fetch - Fetch Webpage (Playwright)</MenuItem>
                                                            <MenuItem value="/api/playwright/interact">POST /api/playwright/interact - Interact with Page</MenuItem>
                                                            <MenuItem value="/api/playwright/status">GET /api/playwright/status - Playwright Status</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Conversations ───</MenuItem>
                                                            <MenuItem value="/api/conversations">GET /api/conversations - List Conversations</MenuItem>
                                                            <MenuItem value="/api/conversations/create">POST /api/conversations - Create Conversation</MenuItem>
                                                            <MenuItem value="/api/conversations/:id">GET /api/conversations/:id - Get Conversation</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/update">PUT /api/conversations/:id - Update Conversation</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/delete">DELETE /api/conversations/:id - Delete Conversation</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/messages">POST /api/conversations/:id/messages - Add Message</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/memories">GET /api/conversations/:id/memories - List Memories</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/memories/clear">DELETE /api/conversations/:id/memories - Clear Memories</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/memories/:memId">DELETE /api/conversations/:id/memories/:memId - Delete Memory</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/memories/:memId/update">PUT /api/conversations/:id/memories/:memId - Edit Memory</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/streaming">GET /api/conversations/:id/streaming - Streaming Status</MenuItem>
                                                            <MenuItem value="/api/conversations/:id/streaming/cancel">DELETE /api/conversations/:id/streaming - Cancel Stream</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Apps Management ───</MenuItem>
                                                            <MenuItem value="/api/apps">GET /api/apps - List Apps</MenuItem>
                                                            <MenuItem value="/api/apps/:name/start">POST /api/apps/:name/start - Start App</MenuItem>
                                                            <MenuItem value="/api/apps/:name/stop">POST /api/apps/:name/stop - Stop App</MenuItem>
                                                            <MenuItem value="/api/apps/:name/restart">POST /api/apps/:name/restart - Restart App</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Agents ───</MenuItem>
                                                            <MenuItem value="/api/agents">GET /api/agents - List Agents</MenuItem>
                                                            <MenuItem value="/api/agents/create">POST /api/agents - Create Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id">GET /api/agents/:id - Get Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id/update">PUT /api/agents/:id - Update Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id/delete">DELETE /api/agents/:id - Delete Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id/regenerate-key">POST /api/agents/:id/regenerate-key - Regenerate Agent Key</MenuItem>
                                                            <MenuItem value="/api/agent-permissions">GET/PUT /api/agent-permissions - Manage Agent Permissions</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Skills ───</MenuItem>
                                                            <MenuItem value="/api/skills">GET /api/skills - List Skills</MenuItem>
                                                            <MenuItem value="/api/skills/create">POST /api/skills - Create Skill</MenuItem>
                                                            <MenuItem value="/api/skills/:id">GET /api/skills/:id - Get Skill</MenuItem>
                                                            <MenuItem value="/api/skills/:id/update">PUT /api/skills/:id - Update Skill</MenuItem>
                                                            <MenuItem value="/api/skills/:id/delete">DELETE /api/skills/:id - Delete Skill</MenuItem>
                                                            <MenuItem value="/api/skills/:skillName/execute">POST /api/skills/:skillName/execute - Execute Skill</MenuItem>
                                                            <MenuItem value="/api/agents/skills/available">GET /api/agents/skills/available - Available Skills</MenuItem>
                                                            <MenuItem value="/api/agents/skills/discover">GET /api/agents/skills/discover - Discover Skills</MenuItem>
                                                            <MenuItem value="/api/agents/skills/recommend">POST /api/agents/skills/recommend - Recommend Skills</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Markdown Skills ───</MenuItem>
                                                            <MenuItem value="/api/markdown-skills">GET /api/markdown-skills - List Markdown Skills</MenuItem>
                                                            <MenuItem value="/api/markdown-skills/create">POST /api/markdown-skills - Create Markdown Skill</MenuItem>
                                                            <MenuItem value="/api/markdown-skills/:id">GET /api/markdown-skills/:id - Get Markdown Skill</MenuItem>
                                                            <MenuItem value="/api/markdown-skills/:id/update">PUT /api/markdown-skills/:id - Update Markdown Skill</MenuItem>
                                                            <MenuItem value="/api/markdown-skills/:id/delete">DELETE /api/markdown-skills/:id - Delete Markdown Skill</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Tasks ───</MenuItem>
                                                            <MenuItem value="/api/tasks">GET /api/tasks - List Tasks</MenuItem>
                                                            <MenuItem value="/api/tasks/create">POST /api/tasks - Create Task</MenuItem>
                                                            <MenuItem value="/api/tasks/:id">GET /api/tasks/:id - Get Task</MenuItem>
                                                            <MenuItem value="/api/tasks/:id/update">PUT /api/tasks/:id - Update Task</MenuItem>
                                                            <MenuItem value="/api/tasks/:id/delete">DELETE /api/tasks/:id - Delete Task</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── File Operations ───</MenuItem>
                                                            <MenuItem value="/api/agent/file/read">POST /api/agent/file/read - Read File</MenuItem>
                                                            <MenuItem value="/api/agent/file/write">POST /api/agent/file/write - Write File</MenuItem>
                                                            <MenuItem value="/api/agent/file/delete">POST /api/agent/file/delete - Delete File</MenuItem>
                                                            <MenuItem value="/api/agent/file/list">POST /api/agent/file/list - List Directory</MenuItem>
                                                            <MenuItem value="/api/agent/file/move">POST /api/agent/file/move - Move/Rename File</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── User Management (Admin) ───</MenuItem>
                                                            <MenuItem value="/api/users">GET /api/users - List Users</MenuItem>
                                                            <MenuItem value="/api/users/create">POST /api/users - Create User</MenuItem>
                                                            <MenuItem value="/api/users/invite">POST /api/users/invite - Invite User by Email</MenuItem>
                                                            <MenuItem value="/api/users/:id">PUT /api/users/:id - Update User</MenuItem>
                                                            <MenuItem value="/api/users/:id/disable">PUT /api/users/:id/disable - Disable User</MenuItem>
                                                            <MenuItem value="/api/users/:id/enable">PUT /api/users/:id/enable - Enable User</MenuItem>
                                                            <MenuItem value="/api/users/:id/delete">DELETE /api/users/:id - Delete User</MenuItem>
                                                            <MenuItem value="/api/users/:username/reset-password">POST /api/users/:username/reset-password - Admin Reset Password</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── API Keys (Admin) ───</MenuItem>
                                                            <MenuItem value="/api/api-keys">GET /api/api-keys - List API Keys</MenuItem>
                                                            <MenuItem value="/api/api-keys/create">POST /api/api-keys - Create API Key</MenuItem>
                                                            <MenuItem value="/api/api-keys/:id">PUT /api/api-keys/:id - Update API Key</MenuItem>
                                                            <MenuItem value="/api/api-keys/:id/revoke">POST /api/api-keys/:id/revoke - Revoke API Key</MenuItem>
                                                            <MenuItem value="/api/api-keys/:id/delete">DELETE /api/api-keys/:id - Delete API Key</MenuItem>
                                                            <MenuItem value="/api/api-keys/:id/clear-usage">POST /api/api-keys/:id/clear-usage - Clear Usage Stats</MenuItem>
                                                            <MenuItem value="/api/api-keys/:id/stats">GET /api/api-keys/:id/stats - Get Key Stats</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Pi (Terminal Agent) ───</MenuItem>
                                                            <MenuItem value="/api/pi/install">GET /api/pi/install - Pi auto-installer (curl | bash)</MenuItem>
                                                            <MenuItem value="/api/pi/extension/modelserver.ts">GET /api/pi/extension/modelserver.ts - Pi extension source</MenuItem>
                                                            <MenuItem value="/api/pi/extension/package.json">GET /api/pi/extension/package.json - Pi extension manifest</MenuItem>
                                                        </Select>
                                                    </FormControl>
                                                </Grid>
                                                <Grid item xs={12} md={4}>
                                                    <FormControl fullWidth size="small">
                                                        <InputLabel>Language</InputLabel>
                                                        <Select
                                                            value={apiBuilderLang || 'curl'}
                                                            onChange={(e) => setApiBuilderLang(e.target.value)}
                                                            label="Language"
                                                        >
                                                            <MenuItem value="curl">cURL</MenuItem>
                                                            <MenuItem value="python">Python</MenuItem>
                                                            <MenuItem value="powershell">PowerShell</MenuItem>
                                                            <MenuItem value="javascript">JavaScript (fetch)</MenuItem>
                                                        </Select>
                                                    </FormControl>
                                                </Grid>
                                                <Grid item xs={12} md={2}>
                                                    <FormControl fullWidth size="small">
                                                        <InputLabel>Auth Type</InputLabel>
                                                        <Select
                                                            value={apiBuilderAuthType}
                                                            onChange={(e) => setApiBuilderAuthType(e.target.value)}
                                                            label="Auth Type"
                                                        >
                                                            <MenuItem value="bearer">Bearer Token</MenuItem>
                                                            <MenuItem value="apikey">API Key + Secret</MenuItem>
                                                        </Select>
                                                    </FormControl>
                                                </Grid>
                                            </Grid>
                                            <Box sx={{
                                                mt: 2,
                                                bgcolor: 'var(--bg-primary)',
                                                border: '1px solid var(--border-primary)',
                                                p: 2,
                                                borderRadius: 1,
                                                position: 'relative',
                                            }}>
                                                <IconButton
                                                    size="small"
                                                    sx={{
                                                        position: 'absolute', top: 8, right: 8,
                                                        color: 'var(--text-tertiary)',
                                                        '&:hover': {
                                                            color: 'var(--accent-primary)',
                                                            bgcolor: 'var(--bg-hover)',
                                                        },
                                                    }}
                                                    onClick={() => copyToClipboard(getApiBuilderCode())}
                                                >
                                                    <ContentCopyIcon sx={{ fontSize: 16 }} />
                                                </IconButton>
                                                <pre style={{
                                                    margin: 0,
                                                    color: 'var(--accent-primary)',
                                                    fontSize: '0.75rem',
                                                    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
                                                    overflow: 'auto',
                                                    paddingRight: 40,
                                                }}>
                                                    {getApiBuilderCode()}
                                                </pre>
                                            </Box>
                                        </Box>


                                    </Box>

                                </Box>

                                )}


                                {/* Pi setup */}
                                {activeDocSection === 'pi-setup' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Pi setup</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Install Pi (pi.dev) and connect it to this server</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, p: 1.5, bgcolor: 'var(--accent-muted)', borderRadius: 2, border: '1px solid var(--accent-muted)' }}>
                                            <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                <strong style={{ color: 'var(--text-primary)' }}>Pi</strong> is a third-party minimal coding harness (<a href="https://pi.dev" target="_blank" rel="noopener" style={{ color: 'var(--accent-secondary)' }}>pi.dev</a>) for the terminal. The bundled extension below registers this server as an OpenAI-compatible provider and exposes every enabled skill as a Pi tool.
                                            </Typography>
                                        </Box>

                                        {(() => {
                                            const bearerKeys = (apiKeys || []).filter(k => k && k.bearerOnly && k.active !== false);
                                            const selectedKey = bearerKeys.find(k => k.id === piSelectedKeyId) || null;
                                            const keyForCmd = selectedKey ? selectedKey.key : '<your-bearer-key>';
                                            const keyDisplay = selectedKey
                                                ? (piRevealKey ? selectedKey.key : `${selectedKey.key.slice(0, 8)}…${selectedKey.key.slice(-4)}`)
                                                : '<your-bearer-key>';
                                            const cmdReveal = `export MODELSERVER_API_KEY="${keyDisplay}"\ncurl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \\\n  ${baseUrl}/api/pi/install | bash`;
                                            const cmdFull = `export MODELSERVER_API_KEY="${keyForCmd}"\ncurl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \\\n  ${baseUrl}/api/pi/install | bash`;
                                            const missingAgents = selectedKey && !(selectedKey.permissions || []).includes('agents');
                                            return (
                                                <>
                                                    <Box sx={{ mb: 2, p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>1. Pick a bearer-mode API key</Typography>
                                                        {bearerKeys.length === 0 ? (
                                                            <Box sx={{ p: 1.25, bgcolor: 'rgba(251, 191, 36, 0.08)', borderRadius: 1, border: '1px solid rgba(251,191,36,0.2)' }}>
                                                                <Typography sx={{ fontSize: '0.78rem', color: 'var(--warning)', mb: 0.5 }}>
                                                                    No bearer-mode keys yet.
                                                                </Typography>
                                                                <Typography sx={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                                    Open the <strong style={{ color: 'var(--text-primary)' }}>API Keys</strong> tab → create a key with the <code>Bearer Only</code> flag and the <code>agents</code> permission (Pi sends <code>Authorization: Bearer &lt;key&gt;</code>; standard key+secret pairs won&apos;t dispatch).
                                                                </Typography>
                                                            </Box>
                                                        ) : (
                                                            <>
                                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                    <FormControl size="small" sx={{ flex: 1 }}>
                                                                        <InputLabel sx={{ fontSize: '0.8rem' }}>Bearer key</InputLabel>
                                                                        <Select
                                                                            value={piSelectedKeyId}
                                                                            label="Bearer key"
                                                                            onChange={(e) => setPiSelectedKeyId(e.target.value)}
                                                                            sx={{ fontSize: '0.8rem' }}
                                                                            MenuProps={{ PaperProps: { sx: { maxHeight: 300 } } }}
                                                                        >
                                                                            <MenuItem value=""><em>— select —</em></MenuItem>
                                                                            {bearerKeys.map(k => (
                                                                                <MenuItem key={k.id} value={k.id} sx={{ fontSize: '0.8rem' }}>
                                                                                    {k.name}
                                                                                    {!(k.permissions || []).includes('agents') && (
                                                                                        <Chip label="no agents perm" size="small" sx={{ ml: 1, height: 18, fontSize: '0.6rem', bgcolor: 'rgba(251,191,36,0.2)', color: 'var(--warning)' }} />
                                                                                    )}
                                                                                </MenuItem>
                                                                            ))}
                                                                        </Select>
                                                                    </FormControl>
                                                                    {selectedKey && (
                                                                        <Tooltip title={piRevealKey ? 'Hide key' : 'Reveal key'}>
                                                                            <IconButton size="small" onClick={() => setPiRevealKey(v => !v)}>
                                                                                {piRevealKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                                                                            </IconButton>
                                                                        </Tooltip>
                                                                    )}
                                                                </Box>
                                                                {missingAgents && (
                                                                    <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'var(--warning)' }}>
                                                                        ⚠ This key lacks the <code>agents</code> permission. Pi will register the model provider but <code>/api/skills</code> will return 403 — the skill catalog won&apos;t load. Edit the key (API Keys tab) to add it.
                                                                    </Typography>
                                                                )}
                                                            </>
                                                        )}
                                                    </Box>

                                                    <Box sx={{ mb: 2, p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                                                            <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>2. One-liner install (curl | bash)</Typography>
                                                            {selectedKey && (
                                                                <Tooltip title="Copy full command (with cleartext key)">
                                                                    <IconButton size="small" onClick={() => copyToClipboard(cmdFull)}>
                                                                        <ContentCopyIcon sx={{ fontSize: 14 }} />
                                                                    </IconButton>
                                                                </Tooltip>
                                                            )}
                                                        </Box>
                                                        <Box sx={{ bgcolor: 'rgba(0,0,0,0.4)', p: 1.5, borderRadius: 1, fontFamily: 'monospace', fontSize: '0.72rem', whiteSpace: 'pre-wrap' }}>
                                                            <span>{cmdReveal}</span>
                                                        </Box>
                                                        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'var(--text-secondary)' }}>
                                                            {selectedKey
                                                                ? <>The copy button grabs the full command with the cleartext key. The key is masked in the displayed snippet by default — click <VisibilityIcon sx={{ fontSize: 12, verticalAlign: 'middle' }} /> above to reveal.</>
                                                                : <>Pick a key above and the command auto-populates. Or replace <code>&lt;your-bearer-key&gt;</code> by hand.</>}
                                                        </Typography>
                                                        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'var(--text-secondary)' }}>
                                                            One script handles every common failure: corporate MITM proxies (writes <code>~/.curlrc</code>, sets <code>NODE_TLS_REJECT_UNAUTHORIZED=0</code>, <code>npm strict-ssl=false</code>), missing or too-old Node (installs Node 22 LTS via NodeSource, falls back to nvm), missing Pi, missing curl, broken sudo, root vs non-root. Idempotent — safe to re-run.
                                                        </Typography>
                                                    </Box>
                                                </>
                                            );
                                        })()}

                                        <Box sx={{ mb: 2, p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                            <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>3. Run</Typography>
                                            <Box sx={{ bgcolor: 'rgba(0,0,0,0.4)', p: 1.5, borderRadius: 1, fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                                <span>{`pi  # picks up MODELSERVER_BASE_URL + MODELSERVER_API_KEY automatically`}</span>
                                            </Box>
                                        </Box>

                                        <Box sx={{ mb: 2, p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                            <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>What gets registered</Typography>
                                            <Table size="small" sx={compactTableSx}>
                                                <TableBody>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>provider</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}><code>modelserver</code> — populated from <code>/v1/models</code>; pick any loaded model from Pi&apos;s model picker</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>tools</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>One per enabled skill — <code>web_search</code>, <code>fetch_url</code>, <code>grep_code</code>, <code>outline_file</code>, <code>replace_lines</code>, file ops, OCR, PDF, and the rest of the 120+ catalog</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>auth</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Bearer key reused for both <code>/v1/*</code> chat completions and <code>/api/skills/:name/execute</code></TableCell></TableRow>
                                                </TableBody>
                                            </Table>
                                        </Box>

                                        <Box sx={{ p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                            <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Manual install</Typography>
                                            <Typography variant="caption" sx={{ display: 'block', color: 'var(--text-secondary)', mb: 1 }}>
                                                Don&apos;t want to pipe to bash? Fetch the files directly and edit <code>~/.pi/agent/settings.json</code> by hand:
                                            </Typography>
                                            <Box sx={{ bgcolor: 'rgba(0,0,0,0.4)', p: 1.5, borderRadius: 1, fontFamily: 'monospace', fontSize: '0.7rem', whiteSpace: 'pre-wrap' }}>
                                                <span>{`# Auto-installer (raw bash; what /api/pi/install serves)
${baseUrl}/api/pi/extension/install.sh

# Individual extension files (auth required on all of these)
${baseUrl}/api/pi/extension/modelserver.ts
${baseUrl}/api/pi/extension/package.json
${baseUrl}/api/pi/extension/README.md`}</span>
                                            </Box>
                                        </Box>


                                    </Box>

                                </Box>

                                )}


                                {/* Web Search & URL Fetch */}
                                {activeDocSection === 'web-search' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Web Search &amp; URL Fetch</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Native chat tools for browsing the open web and pulling URL content</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>

                                        {/* Intro callout — the model decides; no UI toggle. */}
                                        <Box sx={{ p: 1.5, mb: 2, bgcolor: 'var(--accent-muted)', borderRadius: 1.5, border: '1px solid var(--accent-muted)' }}>
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                                                <CheckCircleIcon sx={{ fontSize: 18, color: 'var(--accent-primary)' }} />
                                                <Typography sx={{ fontSize: '0.85rem', fontWeight: 600 }}>Native tools, no UI toggle</Typography>
                                            </Box>
                                            <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                The chat model invokes <code>web_search</code> and <code>fetch_url</code> as OpenAI-style function calls when a query warrants it. Each call streams in as a chip showing the tool name, arguments, and result. There is no globe / link button to enable; the model decides per turn.
                                            </Typography>
                                        </Box>

                                        <Grid container spacing={2}>

                                            {/* ====================== Web Search ====================== */}
                                            <Grid item xs={12} lg={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'var(--accent-muted)', borderRadius: 2, border: '1px solid var(--accent-muted)', height: '100%' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                        <Chip label="web_search" size="small" sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600, fontFamily: 'monospace' }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Open-web search with content extraction</Typography>
                                                    </Box>

                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>Behavior</Typography>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.7rem' }, mb: 1.5 }}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', width: 130, whiteSpace: 'nowrap' }}>results</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Up to 5 per call</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>content / page</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Up to 12,000 chars extracted</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>query rewrite</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}><code>extractSearchQuery()</code> trims long prompts to key entities (domains, IPs, hashes, CVEs) + intent keywords</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>citations</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Tool description instructs the model to cite sources and quote actual data</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>

                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>Fallback chain</Typography>
                                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
                                                        <Chip label="DuckDuckGo" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                        <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>→</Typography>
                                                        <Chip label="Scrapling (StealthyFetcher)" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'rgba(34,197,94,0.15)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.25)' }} />
                                                        <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>→</Typography>
                                                        <Chip label="Brave Search" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'rgba(251,191,36,0.15)', color: 'var(--warning)', border: '1px solid rgba(251,191,36,0.25)' }} />
                                                        <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>→</Typography>
                                                        <Chip label="Playwright" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'rgba(239,68,68,0.12)', color: 'var(--error)', border: '1px solid rgba(239,68,68,0.22)' }} />
                                                    </Box>
                                                    <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                                                        Earlier providers serve when reachable; later ones engage only on empty / error / blocked results.
                                                    </Typography>
                                                </Box>
                                            </Grid>

                                            {/* ====================== URL Fetch ====================== */}
                                            <Grid item xs={12} lg={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'var(--accent-muted)', borderRadius: 2, border: '1px solid var(--accent-muted)', height: '100%' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                        <Chip label="fetch_url" size="small" sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600, fontFamily: 'monospace' }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Backed by <code>POST /api/url/fetch</code> (<code>query</code> scope)</Typography>
                                                    </Box>

                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>Behavior</Typography>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.7rem' }, mb: 1.5 }}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', width: 130, whiteSpace: 'nowrap' }}>urls / call</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Up to 3 URLs per invocation</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>maxLength (files)</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>50,000 chars default</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>maxLength (HTML)</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>12,000 chars default</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>timeout</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>30,000 ms default</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>file detection</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PDF, DOCX, XLSX/XLS, plus text/code (<code>.txt .csv .json .xml .md .py .js</code>, …) by extension</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>pdf pipeline</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}><code>pdf-parse</code> + <code>repairPdfUrls()</code> rejoins URLs broken across lines</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>

                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>Fallback chain</Typography>
                                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
                                                        <Chip label="Direct download" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                        <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>→</Typography>
                                                        <Chip label="Scrapling" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'rgba(34,197,94,0.15)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.25)' }} />
                                                        <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>→</Typography>
                                                        <Chip label="Playwright" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'rgba(251,191,36,0.15)', color: 'var(--warning)', border: '1px solid rgba(251,191,36,0.25)' }} />
                                                        <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>→</Typography>
                                                        <Chip label="axios" size="small" sx={{ height: 22, fontSize: '0.68rem', bgcolor: 'rgba(239,68,68,0.12)', color: 'var(--error)', border: '1px solid rgba(239,68,68,0.22)' }} />
                                                    </Box>
                                                    <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                                                        Known file extensions skip the browser path entirely and go straight to direct download.
                                                    </Typography>
                                                </Box>
                                            </Grid>

                                            {/* ====================== Under the hood ====================== */}
                                            <Grid item xs={12}>
                                                <Box sx={{ p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>Under the hood — extractors &amp; helpers</Typography>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.72rem' } }}>
                                                        <TableBody>
                                                            <TableRow>
                                                                <TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', width: 200, whiteSpace: 'nowrap' }}>Scrapling StealthyFetcher</TableCell>
                                                                <TableCell sx={{ color: 'var(--text-secondary)' }}>Playwright-based anti-bot fetcher invoked via <code>execFile</code> (safe URL passing). Timeout in milliseconds. Retries with a longer timeout when initial content is &lt; 500 chars.</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>extract_main_content()</TableCell>
                                                                <TableCell sx={{ color: 'var(--text-secondary)' }}>Strips nav / header / footer / sidebar; prefers article-body selectors (<code>.post-body</code>, <code>.articlebody</code>, <code>[itemprop="articleBody"]</code>, <code>.story-body</code>), then generic containers, then tables, then full text.</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>smartTruncate()</TableCell>
                                                                <TableCell sx={{ color: 'var(--text-secondary)' }}>Keeps the first 30% + last 70% of long content — critical for data pages (e.g. EIA gas prices) where the most recent data sits at the bottom.</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>repairPdfUrls()</TableCell>
                                                                <TableCell sx={{ color: 'var(--text-secondary)' }}>Post-processes <code>pdf-parse</code> output to rejoin URLs that the PDF text layer split across line breaks. Applied at every PDF extraction point (chat upload, URL fetch, email attachments).</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>Playwright XHR interception</TableCell>
                                                                <TableCell sx={{ color: 'var(--text-secondary)' }}>Captures XHR / fetch JSON during page load. <code>networkidle</code> 8 s + scroll trigger for lazy-loading SPAs. Falls back to <code>innerText</code> and shadow-DOM traversal when structured extraction &lt; 300 chars.</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>flattenJsonToText()</TableCell>
                                                                <TableCell sx={{ color: 'var(--text-secondary)' }}>Collapses large homogeneous result sets from intercepted JSON (e.g. 94 scan engines all "undetected") into summary lines so the model isn't drowned in repetitive structure.</TableCell>
                                                            </TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>

                                        </Grid>


                                    </Box>

                                </Box>

                                )}


                                {/* Sandbox Skills & Artifacts */}
                                {activeDocSection === 'sandbox-skills' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Sandbox Skills &amp; Artifacts</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Workspace-scoped Python skills, artifact downloads, optional GPU image generation</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, p: 1.5, bgcolor: 'rgba(34, 197, 94, 0.1)', borderRadius: 2, border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                                            <CheckCircleIcon sx={{ fontSize: 18, color: 'var(--success)' }} />
                                            <Typography sx={{ fontSize: '0.85rem' }}>The skills below run inside the sandbox container with a per-conversation <code>/workspace</code> mount. Anything they write to <code>/workspace/artifacts/</code> is auto-promoted by <code>sandboxRunner.runPythonSkill</code> to a downloadable chip on the tool result (mtime-filtered so prior-turn files don't re-surface).</Typography>
                                        </Box>

                                        {/* Sandbox skill catalog */}
                                        <Box sx={{ p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                            <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sandbox-Executed Skills (model-invoked)</Typography>
                                            <Table size="small" sx={compactTableSx}>
                                                <TableBody>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>make_downloadable</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>Copy any file in <code>/workspace</code> into <code>/workspace/artifacts/</code> so the chat UI surfaces it as a download chip. Params: <code>sourcePath</code>, <code>filename</code>. Use after <code>run_python</code>/<code>create_file</code> when the user asks to download.</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>transform_image</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>Pillow-backed image transforms. Params: <code>sourcePath</code>, <code>operation</code> (resize | crop | thumbnail | rotate | convert | grayscale), plus op-specific <code>width</code> / <code>height</code> / <code>x</code> / <code>y</code> / <code>angle</code> / <code>maxWidth</code> / <code>maxHeight</code> / <code>format</code> / <code>quality</code> / <code>outputName</code>. Output written to <code>/workspace/artifacts/</code>.</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>read_xlsx</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>openpyxl reader — returns <code>{`{ headers, rows, sheetNames, rowCount, truncated }`}</code> with rows as dicts keyed by header. Params: <code>path</code>, <code>sheet</code> (name or 0-based index), <code>maxRows</code> (default 1000), <code>header</code> (default <code>true</code>), <code>formulas</code> (raw formula text vs cached values; default <code>false</code>). Counterpart to <code>create_xlsx</code>.</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>query_sqlite</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>Run SQL against a workspace SQLite DB. Params: <code>path</code>, <code>query</code>, <code>params</code> (bind list for <code>?</code> placeholders), <code>maxRows</code> (default 500), <code>readonly</code> (default <code>true</code> — opens with <code>mode=ro</code> URI; pass <code>false</code> to mutate). Returns <code>{`{ columns, rows, rowCount, truncated, affectedRows }`}</code> with rows as dicts.</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>transcribe_audio</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>faster-whisper transcription. Bundled <code>small.en</code> model (CPU, int8) under <code>/opt/whisper-models/</code>. Params: <code>path</code>, <code>model</code> (default <code>small.en</code>), <code>language</code>, <code>wordTimestamps</code>, <code>beamSize</code> (default 5). Returns <code>{`{ text, segments, language, durationSec }`}</code>. ~10-20s for a 1-min clip; ~30-60s for a 5-min song.</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>create_pdf</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>Render a PDF from a strict markdown subset (headings, GFM tables, bullet/numbered lists). Params: <code>filename</code>, optional <code>title</code>, and <strong>either</strong> <code>content</code> (markdown body inline) <strong>or</strong> <code>contentFile</code> (path to a <code>/workspace</code> markdown file — use this for long documents to bypass the tool-arg token cap). Artifacts are staged to <code>/workspace/artifacts/</code> automatically and surface as a download chip — do not call <code>make_downloadable</code> afterwards.</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)', whiteSpace: 'nowrap' }}>create_docx</TableCell>
                                                        <TableCell sx={{ color: 'var(--text-secondary)' }}>Render an editable Word <code>.docx</code> (paragraphs separated by blank lines; <code># </code> / <code>## </code> lines map to Heading 1 / Heading 2). Params: <code>filename</code>, optional <code>title</code>, and <strong>either</strong> <code>content</code> inline <strong>or</strong> <code>contentFile</code> (a <code>/workspace</code> markdown file — preferred when the body exceeds ~5000 chars). Surfaces as a download chip on return.</TableCell>
                                                    </TableRow>
                                                </TableBody>
                                            </Table>
                                            <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'var(--text-secondary)' }}>
                                                Defined in <code>webapp/default-skills.json</code>. All run with <code>sandbox: true</code> and <code>network: "none"</code>; most also mount <code>/workspace</code> (<code>workspace: true</code>), except <code>create_pdf</code> / <code>create_docx</code> which stage straight to <code>/workspace/artifacts/</code>.
                                            </Typography>
                                        </Box>

                                        {/* Auto-download surface */}
                                        <Box sx={{ mt: 2, p: 1.5, bgcolor: 'var(--bg-tertiary)', borderRadius: 2 }}>
                                            <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>How auto-downloads work</Typography>
                                            <Box sx={{ fontSize: '0.8rem' }}>
                                                <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.8rem' }}>Any file a sandbox skill writes to <code>/workspace/artifacts/</code> during a run is picked up automatically. The runner attaches an <code>_artifacts</code> array to the tool result and the chat UI renders one download chip per file.</Typography>
                                                <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.8rem' }}>Files are <strong>mtime-filtered</strong> — only files modified during the current skill invocation are surfaced, so previous-turn artifacts won't re-appear. If a user asks to download a file from an earlier turn, call <code>make_downloadable</code> again (it touches the mtime so the file re-qualifies).</Typography>
                                                <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>Filenames are sanitized: anything outside <code>[A-Za-z0-9._-]</code> becomes <code>_</code>, length is capped at 120 chars, and leading dots are stripped. Bytes are streamed via <code>GET /api/tool-artifacts/:runId/:filename</code>.</Typography>
                                            </Box>
                                        </Box>



                                    </Box>

                                </Box>

                                )}


                                {/* Configuration Flags */}
                                {activeDocSection === 'config-flags' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Configuration Flags</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>llama.cpp and sglang backend settings</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        <Grid container spacing={2}>
                                            {/* llama.cpp Settings */}
                                            <Grid item xs={12} lg={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'var(--accent-muted)', borderRadius: 2, border: '1px solid var(--accent-muted)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                        <Chip label="llama.cpp" size="small" sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Maxwell 5.2+</Typography>
                                                    </Box>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.7rem' } }}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', width: 110 }}>nGpuLayers</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>-1</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GPU layers (-1=all)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>contextSize</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>4096</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Context window size</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>flashAttention</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>false</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Flash attention (faster)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>cacheTypeK/V</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>f16</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>KV cache (f16/q8_0/q4_0)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>threads</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>0</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>CPU threads (0=auto)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>parallelSlots</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>1</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Concurrent requests</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>batchSize</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>2048</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Prompt batch size</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>ubatchSize</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>512</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Micro-batch size</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>repeatPenalty</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>1.1</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Repetition penalty</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>repeatLastN</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>64</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Repetition penalty window</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>presencePenalty</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>0.0</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Presence penalty</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>frequencyPenalty</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>0.0</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Frequency penalty</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>ctxCheckpoints</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>2</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Context checkpoint count</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>contextShift</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>true</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Recycle context window when full</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>compressMemory</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>false</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>AIMem conversation compression</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>disableThinking</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>false</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Skip reasoning mode</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>swaFull</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>false</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--swa-full (skip per-turn SWA re-eval)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>specType</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>none</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--spec-type (none / draft-mtp / draft-simple)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>specDraftNMax</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>3</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--spec-draft-n-max (1–16)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>specDraftModel</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>""</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--spec-draft-model PATH (only when draft-simple)</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>

                                            {/* sglang Settings */}
                                            <Grid item xs={12} lg={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'var(--accent-muted)', borderRadius: 2, border: '1px solid var(--accent-muted)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                        <Chip label="sglang" size="small" sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Turing 7.5+ / driver R570+</Typography>
                                                    </Box>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.7rem' } }}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)', width: 150 }}>maxModelLen</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>4096</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--context-length</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>cpuOffloadGb</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>0</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>CPU offload (GB)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>memFractionStatic</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>0.88</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--mem-fraction-static (replaces vLLM gpuMemoryUtilization)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>tensorParallelSize</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>1</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--tp (auto-clamped to visible GPUs)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>maxRunningRequests</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>256</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--max-running-requests</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>chunkedPrefillSize</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>4096</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--chunked-prefill-size (-1 to disable)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>schedulePolicy</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>lpm</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--schedule-policy (pairs with RadixAttention)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>kvCacheDtype</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>auto</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>auto / fp8_e5m2 / fp8_e4m3</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>toolCallParser</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>auto</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>qwen / qwen3_coder / llama3 / llama4 / mistral / deepseekv3 / deepseekv31 / deepseekv32 / kimi_k2 / glm / glm45 / gpt-oss / step3</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>reasoningParser</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>auto</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>qwen3 / deepseek-r1 / glm45 / kimi</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>trustRemoteCode</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>true</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>--trust-remote-code</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>contextShift</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>true</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Recycle context window when full</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>compressMemory</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>false</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>AIMem conversation compression</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>disableThinking</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>false</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Skip reasoning mode</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>
                                        </Grid>


                                    </Box>

                                </Box>

                                )}


                                {/* API Endpoints (also subsumes API Permissions —
                                    the scope legend now sits at the top of the body). */}
                                {activeDocSection === 'api-endpoints' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>API Endpoints</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Permission scopes and endpoint reference</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        {/* Permission scope legend — what each scope grants on an
                                            API key. The endpoint table below is grouped by the
                                            same scopes, so the legend reads as a key. */}
                                        {(() => {
                                            const accentScope = {
                                                chip: { bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)' },
                                                row:  { bgcolor: 'var(--accent-muted)', border: '1px solid var(--accent-muted)' },
                                            };
                                            const successScope = {
                                                chip: { bgcolor: 'rgba(34,197,94,0.18)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.30)' },
                                                row:  { bgcolor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)' },
                                            };
                                            const errorScope = {
                                                chip: { bgcolor: 'rgba(239,68,68,0.18)', color: 'var(--error)', border: '1px solid rgba(239,68,68,0.30)' },
                                                row:  { bgcolor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' },
                                            };
                                            const SCOPES = [
                                                { label: 'query',     desc: 'Chat, completions, web search, Playwright', style: accentScope  },
                                                { label: 'models',    desc: 'List, download, load/unload, configs',      style: accentScope  },
                                                { label: 'instances', desc: 'List, stop, slots, clear KV cache',         style: successScope },
                                                { label: 'agents',    desc: 'Agents, tools, tasks, file ops',            style: accentScope  },
                                                { label: 'admin',     desc: 'API keys, backend, system, apps',           style: errorScope   },
                                            ];
                                            return (
                                                <Box sx={{ mb: 2 }}>
                                                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)', mb: 1 }}>
                                                        Permission scopes
                                                    </Typography>
                                                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1 }}>
                                                        {SCOPES.map((s) => (
                                                            <Box
                                                                key={s.label}
                                                                sx={{
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: 1,
                                                                    px: 1.25,
                                                                    py: 0.75,
                                                                    borderRadius: 1.5,
                                                                    ...s.style.row,
                                                                }}
                                                            >
                                                                <Chip
                                                                    label={s.label}
                                                                    size="small"
                                                                    sx={{ height: 20, fontSize: '0.65rem', fontWeight: 600, ...s.style.chip }}
                                                                />
                                                                <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                                                    {s.desc}
                                                                </Typography>
                                                            </Box>
                                                        ))}
                                                    </Box>
                                                    <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                                                        <WarningIcon sx={{ fontSize: 14, color: 'var(--warning)' }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                                            Auth endpoints use session auth only.
                                                        </Typography>
                                                    </Box>
                                                </Box>
                                            );
                                        })()}
                                        <Box sx={{ bgcolor: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                                        <TableContainer>
                                            <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.75, px: 1.5, fontSize: '0.75rem' } }}>
                                                <TableBody>
                                                    {/* Query Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'var(--accent-muted)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="query" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Query Endpoints</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/chat</TableCell><TableCell sx={{ color: 'var(--text-secondary)', width: 50 }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Chat with streaming support</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/chat/stream</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>SSE streaming chat</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/chat/upload</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Upload files for chat (returns attachmentId for PDFs / xlsx)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/attachments/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Fetch raw attachment bytes (PDF, etc.)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/attachments/:id/meta</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Fetch attachment metadata (xlsx sheets[], etc.)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/complete</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Text completion</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/conversations</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create conversations</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/conversations/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage conversation</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/conversations/:id/messages</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Append a message</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/conversations/:id/streaming</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Background-stream status / cancel</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/conversations/:id/memories</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Per-conversation memory entries</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/conversations/:id/memories/:memId</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Edit / delete a single memory</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/chat/continuation/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Chunked-content queue status</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/search</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Web search with content fetch</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/url/fetch</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Fetch URLs for chat context</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/playwright/fetch</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Stealth browser fetch</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/playwright/interact</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Page interaction</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/playwright/status</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Browser status</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/docs</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>DevDocs reference lookup</TableCell></TableRow>

                                                    {/* Models Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'var(--accent-muted)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="models" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Model Management</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List all models</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models/pull</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Download from HuggingFace</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models/:name/load</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Start model instance</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models/load-hf</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Load HuggingFace repo directly into sglang</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models/:name</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>DELETE</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Delete model</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models/hf-cache</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List HuggingFace cache contents (sglang downloads)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/models/hf-cache/:dirName</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>DELETE</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Delete a cached HF repo</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/model-configs</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List all model configs</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/model-configs/:name</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Get/update model config</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/huggingface/search</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Search HF models (format filter: gguf/safetensors/awq/gptq/fp8/nvfp4/bnb/any)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/huggingface/files/:owner/:repo</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List repo files</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/huggingface/repo-size/:owner/:repo</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Total size of an HF repo (pre-download size check)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/downloads</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List active downloads</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/downloads/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>DELETE</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Cancel download</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/system/resources</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Hardware info</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/system/optimal-settings</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Calculate optimal settings</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/system/tools-catalog</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List native tools the chat model can invoke</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/system/egress-proxy</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Egress-proxy status / sandbox info</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/sandbox/run-code</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Execute code in the sandboxed runner</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/tool-artifacts/:runId/:filename</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Download artifacts produced by a tool run</TableCell></TableRow>

                                                    {/* Instances Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="instances" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.18)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.30)', fontWeight: 600 }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Instance Management</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/sglang/instances</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List sglang instances</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/sglang/instances/:name</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>DELETE</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Stop sglang instance</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/sglang/instances/:name/slots</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Get KV cache slots</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/sglang/instances/:name/slots/clear</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Clear KV cache</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/llamacpp/instances</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List llama.cpp instances</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/llamacpp/instances/:name</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>DELETE</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Stop llama.cpp instance</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/system-prompts</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List system prompts</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>/api/system-prompts/:name</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage system prompt</TableCell></TableRow>

                                                    {/* Agents Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'var(--accent-muted)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="agents" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)', border: '1px solid var(--accent-muted)', fontWeight: 600 }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Agent System</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agents</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create agents</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agents/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage agent</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agents/:id/regenerate-key</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Regenerate agent key</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agent-permissions</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage permissions</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/skills</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create skills</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/skills/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage skill</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/skills/:skillName/execute</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Execute skill</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/markdown-skills</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create markdown skills</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/markdown-skills/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage markdown skill</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agents/skills/available</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List skills available to an agent</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agents/skills/discover</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Discover skills</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agents/skills/recommend</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Recommend skills for a task</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/tasks</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create tasks</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/tasks/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Manage task</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agent/file/read</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Read file</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agent/file/write</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Write file</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agent/file/delete</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Delete file</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agent/file/list</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List directory</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>/api/agent/file/move</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Move/rename file</TableCell></TableRow>

                                                    {/* Admin Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(239, 68, 68, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="admin" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'rgba(239,68,68,0.18)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.30)', fontWeight: 600 }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Administration</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/has-users</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Check if users exist</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/register</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Register user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/login</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Login</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/logout</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Logout</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/me</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Get current user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/me/preferences</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/PUT</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Per-user preferences (theme, fonts, layout; scoped per app via ?app=webapp|chat)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/password</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PUT</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Change password (session auth only)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/auth/reset-password</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Self-service password reset</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/users</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create users</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/users/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Update/delete user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/users/:id/disable</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PUT</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Disable user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/users/:id/enable</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PUT</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Enable user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/users/:username/reset-password</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Admin resets a user&apos;s password</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/users/invite</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Generate user invite link</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/api-keys</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET/POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List/create API keys</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/api-keys/:id</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>PUT/DEL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Update/delete key</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/api-keys/:id/revoke</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Revoke API key</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/api-keys/:id/stats</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Get key stats</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/api-keys/:id/clear-usage</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Reset usage counters</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/apps</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>List apps</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/apps/:name/start</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Start app</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/apps/:name/stop</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Stop app</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/apps/:name/restart</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Restart app</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>/api/system/reset</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Reset system</TableCell></TableRow>

                                                    {/* OpenAI Compatible */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(251, 191, 36, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="OpenAI" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.3)' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Instance Ports (8001+)</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--warning)' }}>/v1/chat/completions</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>OpenAI-compatible chat (proxied to first running instance)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--warning)' }}>/v1/completions</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>POST</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>OpenAI-compatible text completion</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--warning)' }}>/v1/models</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>OpenAI-compatible model list (used by Pi extension)</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--warning)' }}>/v1/*</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>ALL</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Catch-all proxy: any other sglang/llama.cpp endpoint forwards verbatim</TableCell></TableRow>

                                                    {/* Pi Terminal Agent */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(168, 85, 247, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="Pi" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'var(--border-focus)', color: 'var(--text-primary)' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Pi Terminal Agent (bearer-only auth)</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>/api/pi/install</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Bash auto-installer (curl | bash). Self-corrects MITM TLS, missing/old Node, missing Pi.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>/api/pi/extension/:file</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>GET</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Serves modelserver.ts, package.json, README.md, install.sh</TableCell></TableRow>

                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                        </Box>


                                    </Box>

                                </Box>

                                )}


                                {/* Utility Scripts */}
                                {activeDocSection === 'utility-scripts' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Utility Scripts</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Management scripts and custom patches</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        {/* Management Scripts */}
                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>
                                            Management Scripts
                                        </Typography>
                                        <Typography sx={{ fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1.5 }}>
                                            Shell scripts for service lifecycle management. Run from project root directory.
                                        </Typography>
                                        <TableContainer component={Paper} variant="outlined" sx={{ mb: 2.5 }}>
                                            <Table size="small" sx={compactTableSx}>
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell sx={{ fontWeight: 600, width: '25%' }}>Script</TableCell>
                                                        <TableCell sx={{ fontWeight: 600 }}>Description</TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--success)' }}>./start.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Start all services (webapp and model backends).</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>./stop.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Stop all services and cleanup running model instances.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>./build.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Build Docker images with parallel builds, auto-resume, and state tracking.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--warning)' }}>./reload.sh [service]</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Rebuild and restart services without data loss. Options: webapp, all</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>./update.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Quick rebuild of webapp only (for code updates).</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--error)' }}>./reset.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Full system reset. Removes all data except downloaded models. Options: --force (skip confirmation), --rebuild (rebuild Docker images), --full (also delete models)</TableCell></TableRow>
                                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>./wsl-setup.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>WSL Native-Docker bootstrap: installs Docker + NVIDIA Container Toolkit inside WSL2 (run once on Windows hosts before ./build.sh).</TableCell></TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>

                                        {/* Internal Scripts */}
                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'var(--accent-primary)' }}>
                                            Internal Scripts
                                        </Typography>
                                        <Typography sx={{ fontSize: '0.75rem', color: 'var(--text-secondary)', mb: 1.5 }}>
                                            Scripts in the <code style={{ background: 'var(--border-hover)', padding: '2px 6px', borderRadius: '4px' }}>scripts/</code> folder for specific tasks.
                                        </Typography>
                                        <TableContainer component={Paper} variant="outlined" sx={{ mb: 2.5 }}>
                                            <Table size="small" sx={compactTableSx}>
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell sx={{ fontWeight: 600, width: '35%' }}>Script</TableCell>
                                                        <TableCell sx={{ fontWeight: 600 }}>Description</TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>scripts/manage-users.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Interactive user account management: list users, create admin, reset passwords, delete accounts.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>scripts/download_model.py</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Python script for downloading GGUF models from HuggingFace (used internally by webapp).</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>scripts/download_model.sh</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>Shell wrapper for downloading models (delegates to the Python script).</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'var(--accent-primary)' }}>scripts/migrate-to-multiuser.js</TableCell><TableCell sx={{ color: 'var(--text-secondary)' }}>One-time migration: convert single-user data layout to per-user.</TableCell></TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>

                                        {/* Build Options */}
                                        <Box sx={{ p: 1.5, bgcolor: 'var(--accent-muted)', borderRadius: 1.5, border: '1px solid var(--accent-muted)' }}>
                                            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, mb: 0.5, color: 'var(--accent-primary)' }}>Build Script Options</Typography>
                                            <Typography sx={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                                                ./build.sh --no-cache    # Force rebuild without Docker cache<br/>
                                                ./build.sh --no-parallel # Sequential builds (for low RAM)<br/>
                                                ./build.sh --no-resume   # Clear build state, start fresh<br/>
                                                ./build.sh --retry 3     # Set retry attempts (default: 2)
                                            </Typography>
                                        </Box>


                                    </Box>

                                </Box>

                                )}


                                {/* System Reset */}
                                {activeDocSection === 'system-reset' && (

                                <Box sx={docSectionSx}>

                                    <Box sx={docSectionHeaderSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>System Reset</Typography>
                                                <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Delete models and clean up resources</Typography>
                                            </Box>
                                        </Box>


                                    </Box>

                                    <Box sx={docSectionBodySx}>
                                        <Box sx={{ p: 2, bgcolor: 'rgba(239, 68, 68, 0.08)', borderRadius: 2, border: '1px solid rgba(239, 68, 68, 0.2)', mb: 2 }}>
                                            <Typography sx={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                Stops all instances and cleans up Docker resources. By default downloaded models, API keys, and configuration are preserved. The shell equivalent <code style={{ fontSize: '0.7rem' }}>./reset.sh --full</code> additionally wipes downloaded models for a true factory reset.
                                            </Typography>
                                        </Box>
                                        <Button
                                            variant="outlined"
                                            color="error"
                                            onClick={() => setResetDialogOpen(true)}
                                            fullWidth
                                            size="small"
                                        >
                                            Reset System
                                        </Button>


                                    </Box>

                                </Box>

                                )}

                                </Box>
                            </Box>
                            </div>
                        )}

                        {/* Logs Tab — Phase 2 Tailwind rewrite. Component lives at
                            src/components/LogsPanel.jsx; data + refs flow through
                            from App's existing state. */}
                        {visibleTabOrder[activeTab] === 5 && (
                            <LogsPanel
                                logs={logs}
                                setLogs={setLogs}
                                logFilter={logFilter}
                                setLogFilter={setLogFilter}
                                logSearch={logSearch}
                                setLogSearch={setLogSearch}
                                logsContainerRef={logsContainerRef}
                                logsEndRef={logsEndRef}
                                handleLogsScroll={handleLogsScroll}
                                isMobile={isMobile}
                                systemStats={systemStats}
                                systemStatsHistory={systemStatsHistory}
                            />
                        )}

                        {/* Legacy inline Logs JSX retained briefly during Phase 2
                            verification — guarded `false` so React skips it.
                            Drop on Phase 2 follow-up after a few sessions. */}
                        {false && visibleTabOrder[activeTab] === 5 && (() => {
                            const logCounts = { all: logs.length, error: 0, warning: 0, success: 0, info: 0 };
                            logs.forEach(l => { const lv = (typeof l === 'string' ? 'info' : l.level) || 'info'; if (logCounts[lv] !== undefined) logCounts[lv]++; });
                            const filteredLogs = logs.filter(log => {
                                const message = typeof log === 'string' ? log : log.message;
                                const level = typeof log === 'string' ? 'info' : log.level;
                                if (logFilter !== 'all' && level !== logFilter) return false;
                                if (logSearch && !message.toLowerCase().includes(logSearch.toLowerCase())) return false;
                                return true;
                            });
                            return (
                            <Box sx={{
                                display: 'flex', flexDirection: 'column', gap: 2,
                                // Desktop: fixed-height column, Process Logs flex-fills above the
                                // system monitor. Mobile: let the page scroll — clamping to 100vh
                                // squeezed the flex:1 Process Logs card to ~0px because the
                                // SystemResourceMonitor takes its natural height and wins the
                                // remaining space first.
                                height: { xs: 'auto', md: 'calc(100vh - 200px)' },
                                minHeight: { xs: 0, md: 500 },
                            }}>
                            <Card sx={{
                                display: 'flex', flexDirection: 'column',
                                flex: { xs: 'none', md: 1 },
                                // Mobile: cap the card height so the inner log Paper's
                                // flex:1 resolves to a finite size and scrolls internally
                                // instead of letting the card grow forever with each log
                                // line. Without an explicit height the card has no
                                // upper bound and the Paper's overflow:auto never engages.
                                height: { xs: 480, md: 'auto' },
                                minHeight: { xs: 480, md: 0 },
                                overflow: 'hidden',
                            }}>
                                <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 2 }}>
                                    {/* Header */}
                                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <TerminalIcon sx={{ fontSize: 22, color: 'primary.main' }} />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '1rem' }}>Process Logs</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Real-time system, model, and operation logs</Typography>
                                            </Box>
                                        </Box>
                                        {isMobile ? (
                                            <IconButton size="small" onClick={() => setLogs([])} aria-label="Clear logs" sx={{ border: '1px solid', borderColor: 'divider' }}>
                                                <ClearIcon fontSize="small" />
                                            </IconButton>
                                        ) : (
                                            <Button size="small" variant="outlined" onClick={() => setLogs([])} startIcon={<ClearIcon />}>Clear</Button>
                                        )}
                                    </Box>

                                    {/* Filter bar */}
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
                                        {/* Level filter chips */}
                                        {[
                                            { key: 'all', label: `All (${logCounts.all})`, color: 'default' },
                                            { key: 'error', label: `Errors (${logCounts.error})`, color: '#ef4444' },
                                            { key: 'warning', label: `Warnings (${logCounts.warning})`, color: '#f59e0b' },
                                            { key: 'success', label: `Success (${logCounts.success})`, color: '#22c55e' },
                                            { key: 'info', label: `Info (${logCounts.info})`, color: '#a1a1aa' },
                                        ].map(f => (
                                            <Chip
                                                key={f.key}
                                                label={f.label}
                                                size="small"
                                                onClick={() => setLogFilter(f.key)}
                                                sx={{
                                                    fontSize: '0.7rem', height: 24, cursor: 'pointer',
                                                    bgcolor: logFilter === f.key ? (f.color === 'default' ? 'var(--accent-muted)' : `${f.color}22`) : 'var(--bg-tertiary)',
                                                    border: logFilter === f.key ? `1px solid ${f.color === 'default' ? 'var(--border-focus)' : f.color + '66'}` : '1px solid transparent',
                                                    color: logFilter === f.key ? (f.color === 'default' ? 'primary.main' : f.color) : 'text.secondary',
                                                    '&:hover': { bgcolor: f.color === 'default' ? 'rgba(99,102,241,0.1)' : `${f.color}15` }
                                                }}
                                            />
                                        ))}
                                        {/* Search input */}
                                        <Box sx={{ ml: { xs: 0, sm: 'auto' }, mt: { xs: 0.5, sm: 0 }, width: { xs: '100%', sm: 'auto' }, display: 'flex', alignItems: 'center', bgcolor: 'rgba(255,255,255,0.04)', borderRadius: 1, px: 1, py: 0.25, border: '1px solid', borderColor: 'divider', minWidth: { xs: 0, sm: 180 } }}>
                                            <SearchIcon sx={{ fontSize: 14, color: 'text.secondary', mr: 0.5 }} />
                                            <input
                                                type="text"
                                                placeholder="Search logs..."
                                                value={logSearch}
                                                onChange={(e) => setLogSearch(e.target.value)}
                                                style={{ background: 'transparent', border: 'none', outline: 'none', color: 'inherit', fontSize: '0.75rem', fontFamily: '"Fira Code", monospace', width: '100%' }}
                                            />
                                            {logSearch && (
                                                <IconButton size="small" onClick={() => setLogSearch('')} sx={{ p: 0.25 }}>
                                                    <ClearIcon sx={{ fontSize: 12 }} />
                                                </IconButton>
                                            )}
                                        </Box>
                                    </Box>

                                    {/* Showing count */}
                                    {(logFilter !== 'all' || logSearch) && (
                                        <Typography variant="caption" sx={{ color: 'text.secondary', mb: 0.5, fontSize: '0.7rem' }}>
                                            Showing {filteredLogs.length} of {logs.length} entries
                                        </Typography>
                                    )}

                                    {/* Log display */}
                                    <Paper
                                        ref={logsContainerRef}
                                        onScroll={handleLogsScroll}
                                        sx={{
                                            flex: 1,
                                            px: 0,
                                            py: 0.5,
                                            overflow: 'auto',
                                            bgcolor: '#0a0a0f',
                                            borderRadius: 1.5,
                                            border: '1px solid rgba(255,255,255,0.08)',
                                        }}
                                    >
                                        {filteredLogs.length === 0 ? (
                                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 120 }}>
                                                <Typography sx={{ fontFamily: '"Fira Code", monospace', fontSize: '0.8rem', color: 'rgba(255,255,255,0.25)' }}>
                                                    {logs.length === 0 ? '● Waiting for activity...' : 'No matching log entries'}
                                                </Typography>
                                            </Box>
                                        ) : (
                                            filteredLogs.map((log, index) => {
                                                let message = typeof log === 'string' ? log : log.message;
                                                const level = typeof log === 'string' ? 'info' : (log.level || 'info');

                                                // Extract Docker container timestamps from message and clean them
                                                // Patterns: "2026-03-20T21:30:01.179Z" or stray chars before timestamps
                                                let extractedTime = null;
                                                const dockerTsMatch = message.match(/^(.{0,2}?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s*/);
                                                if (dockerTsMatch) {
                                                    extractedTime = new Date(dockerTsMatch[2]);
                                                    // Remove the timestamp (and any stray leading char) from message
                                                    message = (dockerTsMatch[1] && /\w/.test(dockerTsMatch[1]) ? '' : '') + message.slice(dockerTsMatch[0].length);
                                                }
                                                // Also clean timestamps that appear after [ModelName] prefix
                                                message = message.replace(/^(\[[^\]]+\])\s*.?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/g, '$1 ');
                                                // Clean stray single characters that precede Docker timestamps mid-line
                                                message = message.replace(/.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s*/g, ' ');

                                                const timestamp = log.timestamp ? new Date(log.timestamp) : extractedTime;
                                                const timeStr = timestamp && !isNaN(timestamp.getTime())
                                                    ? timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                                                    : '';
                                                const levelConfig = {
                                                    error:   { color: '#ef4444', bg: 'rgba(239,68,68,0.06)', icon: '✗', border: 'rgba(239,68,68,0.15)' },
                                                    warning: { color: '#f59e0b', bg: 'rgba(245,158,11,0.04)', icon: '▲', border: 'rgba(245,158,11,0.1)' },
                                                    success: { color: '#22c55e', bg: 'rgba(34,197,94,0.04)', icon: '✓', border: 'rgba(34,197,94,0.1)' },
                                                    info:    { color: '#6b7280', bg: 'transparent', icon: '│', border: 'transparent' },
                                                }[level] || { color: '#6b7280', bg: 'transparent', icon: '│', border: 'transparent' };

                                                // Detect special message types for enhanced formatting
                                                const isStepMsg = /^Step \d+\/\d+:/i.test(message);
                                                const isSeparator = /^={3,}/.test(message);
                                                const baseTextColor = level === 'error' ? '#f87171' :
                                                                      level === 'success' ? '#4ade80' :
                                                                      level === 'warning' ? '#fbbf24' :
                                                                      'rgba(255,255,255,0.65)';

                                                // Format message with inline highlights
                                                const formatMessage = (msg) => {
                                                    const parts = [];
                                                    let remaining = msg;
                                                    let key = 0;

                                                    // Process message patterns sequentially
                                                    while (remaining.length > 0) {
                                                        // [ModelName] brackets → cyan badge
                                                        let match = remaining.match(/^\[([^\]]+)\]/);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.08)', padding: '0 4px', borderRadius: 3, fontSize: '0.72rem' }}>[{match[1]}]</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Step N/M: → indigo badge
                                                        match = remaining.match(/^(Step \d+\/\d+:)/i);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#a5b4fc', backgroundColor: 'var(--accent-muted)', padding: '1px 6px', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600 }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Percentages → amber highlight
                                                        match = remaining.match(/^(\d+(?:\.\d+)?%)/);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#fbbf24', fontWeight: 600 }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // File sizes (e.g., 2.3 GB, 512 MB, 1024 K)
                                                        match = remaining.match(/^(\d+(?:\.\d+)?\s*(?:GB|MB|KB|K|B|TB))\b/i);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#c084fc' }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Paths (/path/to/something or C:\path)
                                                        match = remaining.match(/^((?:\/[\w.\-]+){2,}(?:\/[\w.\-]*)?)/);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#93c5fd', fontSize: '0.73rem' }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Port numbers (port NNNN or :NNNN)
                                                        match = remaining.match(/^((?:port\s+)\d{2,5}|:\d{2,5})\b/i);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#34d399' }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Keywords: Creating, Stopping, Deleting, Starting, Syncing, Removing
                                                        match = remaining.match(/^(Creating|Stopping|Deleting|Starting|Syncing|Removing|Restarting|Switching|Checking|Loading|Verifying|Downloading)\b/);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#e2e8f0', fontWeight: 600 }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Error/Warning/ERROR prefix
                                                        match = remaining.match(/^(ERROR|Error|WARNING|Warning|WARN)(:?\s*)/i);
                                                        if (match) {
                                                            const isErr = match[1].toLowerCase().startsWith('err');
                                                            parts.push(<span key={key++} style={{ color: isErr ? '#f87171' : '#fbbf24', fontWeight: 700, fontSize: '0.72rem', backgroundColor: isErr ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)', padding: '0 4px', borderRadius: 2 }}>{match[1]}</span>);
                                                            if (match[2]) parts.push(<span key={key++}>{match[2]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Container names (llamacpp-*, sglang-*)
                                                        match = remaining.match(/^((?:llamacpp|sglang)-[\w\-]+)/);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#22d3ee', fontSize: '0.73rem' }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // "API key" phrases
                                                        match = remaining.match(/^(API key)\b/i);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: '#c084fc', fontWeight: 500 }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // === SEPARATORS ===
                                                        match = remaining.match(/^(={3,}[^=]*={3,})/);
                                                        if (match) {
                                                            parts.push(<span key={key++} style={{ color: 'rgba(255,255,255,0.35)', letterSpacing: '1px' }}>{match[1]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                            continue;
                                                        }
                                                        // Default: consume next character or word
                                                        match = remaining.match(/^[^\[%\/\\(=ES CWADLRV]*./);
                                                        if (match) {
                                                            parts.push(<span key={key++}>{match[0]}</span>);
                                                            remaining = remaining.slice(match[0].length);
                                                        } else {
                                                            parts.push(<span key={key++}>{remaining[0]}</span>);
                                                            remaining = remaining.slice(1);
                                                        }
                                                    }
                                                    return parts;
                                                };

                                                return (
                                                    <Box
                                                        key={index}
                                                        sx={{
                                                            display: 'flex',
                                                            alignItems: 'flex-start',
                                                            gap: 0,
                                                            px: 1.5,
                                                            py: isStepMsg ? 0.6 : isSeparator ? 0.8 : 0.35,
                                                            mt: isStepMsg ? 0.5 : 0,
                                                            bgcolor: isStepMsg ? 'rgba(99,102,241,0.04)' : isSeparator ? 'rgba(255,255,255,0.02)' : levelConfig.bg,
                                                            borderLeft: `2px solid ${isStepMsg ? 'var(--border-focus)' : levelConfig.border}`,
                                                            borderTop: isStepMsg ? '1px solid rgba(255,255,255,0.04)' : 'none',
                                                            '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' },
                                                            transition: 'background-color 0.15s',
                                                        }}
                                                    >
                                                        {/* Timestamp + Level icon: "22:39:48 │" */}
                                                        <Typography component="span" sx={{
                                                            fontFamily: '"Fira Code", monospace',
                                                            fontSize: '0.68rem',
                                                            color: 'rgba(255,255,255,0.18)',
                                                            mr: 1,
                                                            mt: '2px',
                                                            flexShrink: 0,
                                                            userSelect: 'none',
                                                            whiteSpace: 'pre',
                                                        }}>
                                                            {timeStr ? `${timeStr} ` : '         '}<span style={{ color: levelConfig.color, fontSize: '0.72rem' }}>{levelConfig.icon}</span>
                                                        </Typography>
                                                        {/* Formatted Message */}
                                                        <Box sx={{
                                                            fontFamily: '"Fira Code", monospace',
                                                            fontSize: '0.78rem',
                                                            color: baseTextColor,
                                                            lineHeight: 1.55,
                                                            wordBreak: 'break-word',
                                                            flex: 1,
                                                            '& span': { whiteSpace: 'pre-wrap' },
                                                        }}>
                                                            {formatMessage(message)}
                                                        </Box>
                                                    </Box>
                                                );
                                            })
                                        )}
                                        <div ref={logsEndRef} />
                                    </Paper>
                                </CardContent>
                            </Card>
                            <SystemResourceMonitor
                                current={systemStats}
                                history={systemStatsHistory}
                            />
                            </Box>
                            );
                        })()}

                        {/* Agent Tab — persistent Pi/agent workspaces */}
                        {visibleTabOrder[activeTab] === 7 && (
                            <Box sx={{ p: 3 }}>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, gap: 2, flexWrap: 'wrap' }}>
                                    <Box>
                                        <Typography variant="h5" sx={{ fontWeight: 600, mb: 0.5 }}>Agent Workspaces</Typography>
                                        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 700 }}>
                                            Persistent sandbox workspaces for Pi (pi.dev) agents and API keys. Each bearer key
                                            keeps one workspace that survives across turns, so an agent can build files step by
                                            step (assemble a report, then render it to PDF). Deleting a workspace permanently
                                            wipes everything that agent has stored there.
                                        </Typography>
                                    </Box>
                                    <Button variant="outlined" size="small" onClick={loadAgentWorkspaces} disabled={agentWsLoading}>
                                        {agentWsLoading ? 'Refreshing…' : 'Refresh'}
                                    </Button>
                                </Box>

                                {agentWsLoading && agentWorkspaces.length === 0 ? (
                                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
                                ) : agentWorkspaces.length === 0 ? (
                                    <Card variant="outlined"><CardContent>
                                        <Typography variant="body2" color="text.secondary">
                                            No agent workspaces yet. They're created automatically the first time a Pi agent (or
                                            any bearer-key client) runs a file-writing skill such as <code>create_file</code> or
                                            <code> create_pdf</code>.
                                        </Typography>
                                    </CardContent></Card>
                                ) : (
                                    <TableContainer component={Paper} variant="outlined">
                                        <Table size="small">
                                            <TableHead>
                                                <TableRow>
                                                    <TableCell>Workspace</TableCell>
                                                    <TableCell>Type</TableCell>
                                                    <TableCell align="right">Files</TableCell>
                                                    <TableCell align="right">Size</TableCell>
                                                    <TableCell>Last used</TableCell>
                                                    <TableCell align="right">Actions</TableCell>
                                                </TableRow>
                                            </TableHead>
                                            <TableBody>
                                                {agentWorkspaces.map(w => (
                                                    <TableRow key={w.bucket} hover>
                                                        <TableCell>
                                                            <Typography variant="body2" sx={{ fontWeight: 500 }}>{w.label}</Typography>
                                                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{w.bucket}</Typography>
                                                            {w.type === 'agent' && w.keyActive === false && (
                                                                <Chip label="key removed" size="small" color="warning" sx={{ ml: 1, height: 18 }} />
                                                            )}
                                                        </TableCell>
                                                        <TableCell>
                                                            <Chip
                                                                size="small"
                                                                label={w.type}
                                                                color={w.type === 'agent' ? 'primary' : w.type === 'global' ? 'info' : 'default'}
                                                                variant={w.type === 'agent' ? 'filled' : 'outlined'}
                                                            />
                                                        </TableCell>
                                                        <TableCell align="right">{w.fileCount}</TableCell>
                                                        <TableCell align="right">{formatBytes(w.sizeBytes)}</TableCell>
                                                        <TableCell>
                                                            <Typography variant="caption" color="text.secondary">
                                                                {w.mtimeMs ? new Date(w.mtimeMs).toLocaleString() : '—'}
                                                            </Typography>
                                                        </TableCell>
                                                        <TableCell align="right">
                                                            <Tooltip title="Delete workspace">
                                                                <span>
                                                                    <IconButton size="small" color="error" onClick={() => setAgentWsDeleteTarget(w)}>
                                                                        <DeleteIcon fontSize="small" />
                                                                    </IconButton>
                                                                </span>
                                                            </Tooltip>
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                )}

                                <Dialog open={!!agentWsDeleteTarget} onClose={() => !agentWsDeleting && setAgentWsDeleteTarget(null)}>
                                    <DialogTitle>Delete agent workspace?</DialogTitle>
                                    <DialogContent>
                                        <Typography variant="body2">
                                            This permanently deletes <strong>{agentWsDeleteTarget?.label}</strong>
                                            {agentWsDeleteTarget ? ` (${agentWsDeleteTarget.fileCount} files, ${formatBytes(agentWsDeleteTarget.sizeBytes)})` : ''} and
                                            everything the agent stored in it. This cannot be undone.
                                        </Typography>
                                    </DialogContent>
                                    <DialogActions>
                                        <Button onClick={() => setAgentWsDeleteTarget(null)} disabled={agentWsDeleting}>Cancel</Button>
                                        <Button onClick={confirmDeleteAgentWorkspace} color="error" variant="contained" disabled={agentWsDeleting}>
                                            {agentWsDeleting ? 'Deleting…' : 'Delete'}
                                        </Button>
                                    </DialogActions>
                                </Dialog>
                            </Box>
                        )}

                        {/* Apps Tab (Admin Only) */}
                        {visibleTabOrder[activeTab] === 6 && isAdmin && (
                            <AppsPanel
                                apps={apps}
                                onStart={handleAppStart}
                                onStop={handleAppStop}
                                onRestart={handleAppRestart}
                            >
                                {/* Integrated open-model-agents block stays
                                    MUI for now (Tools/Skills sub-tabs are
                                    heavy forms; deferred). Renders inside
                                    AppsPanel via {children}. */}
                                <Grid container spacing={3} sx={{ mt: 0 }}>
                                    {apps.filter(app => app.integrated && app.name === 'open-model-agents').map(app => (
                                        <Grid item xs={12} key={app.name}>
                                            <Card>
                                                <CardContent>
                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                                                        <Box>
                                                            <Typography variant="h6">{app.displayName}</Typography>
                                                            <Typography variant="body2" color="text.secondary">
                                                                {app.description}
                                                            </Typography>
                                                        </Box>
                                                        <Chip label="Integrated" size="small" color="success" />
                                                    </Box>

                                                    <Tabs value={agentSubTab} onChange={(e, v) => setAgentSubTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
                                                        <Tab label="Tools" />
                                                        <Tab label="Skills" />
                                                    </Tabs>

                                                    {/* Tools Sub-Tab */}
                                                    {agentSubTab === 0 && (() => {
                                                        const toolTypes = Array.from(new Set(skills.map(s => s.type).filter(Boolean)));
                                                        const q = toolsSearchQuery.trim().toLowerCase();
                                                        const filteredTools = skills.filter(skill => {
                                                            if (toolsEnabledFilter === 'enabled' && skill.enabled === false) return false;
                                                            if (toolsEnabledFilter === 'disabled' && skill.enabled !== false) return false;
                                                            if (toolsTypeFilter !== 'all' && skill.type !== toolsTypeFilter) return false;
                                                            if (q) {
                                                                const name = (skill.name || '').toLowerCase();
                                                                const desc = (skill.description || '').toLowerCase();
                                                                if (!name.includes(q) && !desc.includes(q)) return false;
                                                            }
                                                            return true;
                                                        });
                                                        return (
                                                        <Box>
                                                            <Box
                                                                onClick={() => setToolsLibraryExpanded(v => !v)}
                                                                role="button"
                                                                tabIndex={0}
                                                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setToolsLibraryExpanded(v => !v); } }}
                                                                sx={{
                                                                    display: 'flex',
                                                                    justifyContent: 'space-between',
                                                                    mb: toolsLibraryExpanded ? 2 : 0,
                                                                    alignItems: 'center',
                                                                    gap: 2,
                                                                    flexWrap: 'wrap',
                                                                    cursor: 'pointer',
                                                                    p: 1.25,
                                                                    borderRadius: 1.5,
                                                                    border: '1px solid var(--border-primary)',
                                                                    bgcolor: 'var(--bg-tertiary)',
                                                                    transition: 'background-color 0.15s, border-color 0.15s',
                                                                    '&:hover': { bgcolor: 'var(--bg-hover)', borderColor: 'var(--border-hover)' },
                                                                }}
                                                            >
                                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flex: 1, minWidth: 0 }}>
                                                                    <ExpandMoreIcon
                                                                        sx={{
                                                                            fontSize: 20,
                                                                            color: 'var(--text-tertiary)',
                                                                            transform: toolsLibraryExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                                                                            transition: 'transform 0.18s ease',
                                                                        }}
                                                                    />
                                                                    <Box>
                                                                        <Typography variant="subtitle1" sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                                                            Tools Library
                                                                        </Typography>
                                                                        <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>
                                                                            {skills.length} tool{skills.length === 1 ? '' : 's'}
                                                                            {toolsLibraryExpanded ? ` · showing ${filteredTools.length}` : ''}
                                                                        </Typography>
                                                                    </Box>
                                                                </Box>
                                                                <Button
                                                                    variant="contained"
                                                                    size="small"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setEditingSkill(null);
                                                                        setSkillFormData({ name: '', description: '', type: 'tool', parameters: {}, code: '', systemPrompt: '' });
                                                                        setSkillDialogOpen(true);
                                                                    }}
                                                                >
                                                                    Create Tool
                                                                </Button>
                                                            </Box>

                                                            <Collapse in={toolsLibraryExpanded} timeout="auto" unmountOnExit>
                                                            <Box sx={{ pt: 1 }}>
                                                            {skills.length === 0 ? (
                                                                <Alert severity="info">No tools created yet. Click "Create Tool" to get started.</Alert>
                                                            ) : (
                                                                <>
                                                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
                                                                        <TextField
                                                                            fullWidth
                                                                            size="small"
                                                                            placeholder="Search tools by name or description"
                                                                            value={toolsSearchQuery}
                                                                            onChange={(e) => setToolsSearchQuery(e.target.value)}
                                                                            InputProps={{
                                                                                startAdornment: (
                                                                                    <InputAdornment position="start">
                                                                                        <SearchIcon fontSize="small" />
                                                                                    </InputAdornment>
                                                                                ),
                                                                                endAdornment: toolsSearchQuery ? (
                                                                                    <InputAdornment position="end">
                                                                                        <IconButton size="small" onClick={() => setToolsSearchQuery('')}>
                                                                                            <ClearIcon fontSize="small" />
                                                                                        </IconButton>
                                                                                    </InputAdornment>
                                                                                ) : null
                                                                            }}
                                                                        />
                                                                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                                                                            <ToggleButtonGroup
                                                                                value={toolsEnabledFilter}
                                                                                exclusive
                                                                                size="small"
                                                                                onChange={(e, v) => { if (v !== null) setToolsEnabledFilter(v); }}
                                                                            >
                                                                                <ToggleButton value="all">All</ToggleButton>
                                                                                <ToggleButton value="enabled">Enabled</ToggleButton>
                                                                                <ToggleButton value="disabled">Disabled</ToggleButton>
                                                                            </ToggleButtonGroup>
                                                                            {toolTypes.length > 0 && (
                                                                                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', ml: { xs: 0, sm: 1 } }}>
                                                                                    <Chip
                                                                                        label="all types"
                                                                                        size="small"
                                                                                        clickable
                                                                                        color={toolsTypeFilter === 'all' ? 'primary' : 'default'}
                                                                                        variant={toolsTypeFilter === 'all' ? 'filled' : 'outlined'}
                                                                                        onClick={() => setToolsTypeFilter('all')}
                                                                                    />
                                                                                    {toolTypes.map(t => (
                                                                                        <Chip
                                                                                            key={t}
                                                                                            label={t}
                                                                                            size="small"
                                                                                            clickable
                                                                                            color={toolsTypeFilter === t ? 'primary' : 'default'}
                                                                                            variant={toolsTypeFilter === t ? 'filled' : 'outlined'}
                                                                                            onClick={() => setToolsTypeFilter(t)}
                                                                                        />
                                                                                    ))}
                                                                                </Box>
                                                                            )}
                                                                        </Box>
                                                                    </Box>

                                                                    {filteredTools.length === 0 ? (
                                                                        <Alert severity="info">No tools match the current filters.</Alert>
                                                                    ) : (
                                                                        <Box sx={{ maxHeight: 600, overflow: 'auto', pr: 0.5 }}>
                                                                            <Grid container spacing={1.5}>
                                                                                {filteredTools.map(skill => {
                                                                                    const isEnabled = skill.enabled !== false;
                                                                                    return (
                                                                                    <Grid item xs={12} md={6} key={skill.id}>
                                                                                        <Card variant="outlined" sx={{ opacity: isEnabled ? 1 : 0.62 }}>
                                                                                            <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                                                                                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', mb: 0.5, gap: 1 }}>
                                                                                                    <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
                                                                                                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{skill.name}</Typography>
                                                                                                        {skill.type && <Chip label={skill.type} size="small" sx={{ height: 18, fontSize: '0.65rem' }} />}
                                                                                                        {!isEnabled && <Chip label="disabled" size="small" color="warning" sx={{ height: 18, fontSize: '0.65rem' }} />}
                                                                                                    </Box>
                                                                                                    <Switch
                                                                                                        checked={isEnabled}
                                                                                                        onChange={(e) => {
                                                                                                            fetch(`/api/skills/${skill.id}`, {
                                                                                                                credentials: 'include',
                                                                                                                method: 'PUT',
                                                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                                                body: JSON.stringify({ ...skill, enabled: e.target.checked })
                                                                                                            })
                                                                                                                .then(res => res.json())
                                                                                                                .then(() => {
                                                                                                                    showSnackbar(`Tool ${e.target.checked ? 'enabled' : 'disabled'}`, 'success');
                                                                                                                    fetchSkills();
                                                                                                                })
                                                                                                                .catch(error => showSnackbar(`Failed to update tool: ${error.message}`, 'error'));
                                                                                                        }}
                                                                                                        size="small"
                                                                                                    />
                                                                                                </Box>
                                                                                                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, fontSize: '0.8rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                                                                                    {skill.description || 'No description'}
                                                                                                </Typography>
                                                                                                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                                                                                                    {skill.createdAt ? `Created ${new Date(skill.createdAt).toLocaleDateString()}` : 'Built-in'}
                                                                                                </Typography>
                                                                                            </CardContent>
                                                                                            <CardActions sx={{ pt: 0, px: 1 }}>
                                                                                                <Button
                                                                                                    size="small"
                                                                                                    onClick={() => {
                                                                                                        setEditingSkill(skill);
                                                                                                        setSkillFormData({ systemPrompt: '', ...skill });
                                                                                                        setSkillDialogOpen(true);
                                                                                                    }}
                                                                                                    sx={{
                                                                                                        color: 'var(--accent-primary)',
                                                                                                        '&:hover': { bgcolor: 'var(--accent-muted)' },
                                                                                                    }}
                                                                                                >
                                                                                                    Edit
                                                                                                </Button>
                                                                                                <Button
                                                                                                    size="small"
                                                                                                    onClick={() => handleDeleteSkill(skill.id)}
                                                                                                    sx={{
                                                                                                        color: 'var(--error, #f87171)',
                                                                                                        '&:hover': { bgcolor: 'rgba(248,113,113,0.10)' },
                                                                                                    }}
                                                                                                >
                                                                                                    Delete
                                                                                                </Button>
                                                                                            </CardActions>
                                                                                        </Card>
                                                                                    </Grid>
                                                                                    );
                                                                                })}
                                                                            </Grid>
                                                                        </Box>
                                                                    )}
                                                                </>
                                                            )}
                                                            </Box>
                                                            </Collapse>
                                                        </Box>
                                                        );
                                                    })()}

                                                    {/* Skills Sub-Tab — markdown instructional files */}
                                                    {agentSubTab === 1 && (() => {
                                                        const sq = skillsSearchQuery.trim().toLowerCase();
                                                        const filteredMdSkills = mdSkills.filter(skill => {
                                                            const isEnabled = skill.enabled !== false;
                                                            if (skillsEnabledFilter === 'enabled' && !isEnabled) return false;
                                                            if (skillsEnabledFilter === 'disabled' && isEnabled) return false;
                                                            if (sq) {
                                                                const name = (skill.name || '').toLowerCase();
                                                                const desc = (skill.description || '').toLowerCase();
                                                                const triggers = (skill.triggers || '').toLowerCase();
                                                                if (!name.includes(sq) && !desc.includes(sq) && !triggers.includes(sq)) return false;
                                                            }
                                                            return true;
                                                        });
                                                        return (
                                                        <Box>
                                                            <Box
                                                                onClick={() => setSkillsLibraryExpanded(v => !v)}
                                                                role="button"
                                                                tabIndex={0}
                                                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSkillsLibraryExpanded(v => !v); } }}
                                                                sx={{
                                                                    display: 'flex',
                                                                    justifyContent: 'space-between',
                                                                    mb: skillsLibraryExpanded ? 2 : 0,
                                                                    alignItems: 'center',
                                                                    gap: 2,
                                                                    flexWrap: 'wrap',
                                                                    cursor: 'pointer',
                                                                    p: 1.25,
                                                                    borderRadius: 1.5,
                                                                    border: '1px solid var(--border-primary)',
                                                                    bgcolor: 'var(--bg-tertiary)',
                                                                    transition: 'background-color 0.15s, border-color 0.15s',
                                                                    '&:hover': { bgcolor: 'var(--bg-hover)', borderColor: 'var(--border-hover)' },
                                                                }}
                                                            >
                                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flex: 1, minWidth: 0 }}>
                                                                    <ExpandMoreIcon
                                                                        sx={{
                                                                            fontSize: 20,
                                                                            color: 'var(--text-tertiary)',
                                                                            transform: skillsLibraryExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                                                                            transition: 'transform 0.18s ease',
                                                                        }}
                                                                    />
                                                                    <Box sx={{ minWidth: 0 }}>
                                                                        <Typography variant="subtitle1" sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                                                            Skills Library
                                                                        </Typography>
                                                                        <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>
                                                                            {mdSkills.length} skill{mdSkills.length === 1 ? '' : 's'}
                                                                            {skillsLibraryExpanded ? ` · showing ${filteredMdSkills.length}` : ''}
                                                                            {' · '}markdown guides the chat model loads on demand
                                                                        </Typography>
                                                                    </Box>
                                                                </Box>
                                                                <Button
                                                                    variant="contained"
                                                                    size="small"
                                                                    onClick={(e) => { e.stopPropagation(); openMdSkillEditor(null); }}
                                                                >
                                                                    New Skill
                                                                </Button>
                                                            </Box>

                                                            <Collapse in={skillsLibraryExpanded} timeout="auto" unmountOnExit>
                                                            <Box sx={{ pt: 1 }}>
                                                            {mdSkills.length === 0 ? (
                                                                <Alert severity="info">
                                                                    No skills yet. Click "New Skill" to write your first one — describe a procedure the model should follow when a task matches the triggers.
                                                                </Alert>
                                                            ) : (
                                                                <>
                                                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
                                                                        <TextField
                                                                            fullWidth
                                                                            size="small"
                                                                            placeholder="Search skills by name, description, or triggers"
                                                                            value={skillsSearchQuery}
                                                                            onChange={(e) => setSkillsSearchQuery(e.target.value)}
                                                                            InputProps={{
                                                                                startAdornment: (
                                                                                    <InputAdornment position="start">
                                                                                        <SearchIcon fontSize="small" />
                                                                                    </InputAdornment>
                                                                                ),
                                                                                endAdornment: skillsSearchQuery ? (
                                                                                    <InputAdornment position="end">
                                                                                        <IconButton size="small" onClick={() => setSkillsSearchQuery('')}>
                                                                                            <ClearIcon fontSize="small" />
                                                                                        </IconButton>
                                                                                    </InputAdornment>
                                                                                ) : null
                                                                            }}
                                                                        />
                                                                        <ToggleButtonGroup
                                                                            value={skillsEnabledFilter}
                                                                            exclusive
                                                                            size="small"
                                                                            onChange={(e, v) => { if (v !== null) setSkillsEnabledFilter(v); }}
                                                                        >
                                                                            <ToggleButton value="all">All</ToggleButton>
                                                                            <ToggleButton value="enabled">Enabled</ToggleButton>
                                                                            <ToggleButton value="disabled">Disabled</ToggleButton>
                                                                        </ToggleButtonGroup>
                                                                    </Box>

                                                                    {filteredMdSkills.length === 0 ? (
                                                                        <Alert severity="info">No skills match the current filters.</Alert>
                                                                    ) : (
                                                                        <Box sx={{ maxHeight: 600, overflow: 'auto', pr: 0.5 }}>
                                                                            <Grid container spacing={1.5}>
                                                                                {filteredMdSkills.map(skill => {
                                                                                    const isEnabled = skill.enabled !== false;
                                                                                    return (
                                                                                    <Grid item xs={12} md={6} key={skill.id}>
                                                                                        <Card variant="outlined" sx={{ opacity: isEnabled ? 1 : 0.62 }}>
                                                                                            <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                                                                                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', mb: 0.5, gap: 1 }}>
                                                                                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                                                                                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{skill.name}</Typography>
                                                                                                        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.25, flexWrap: 'wrap' }}>
                                                                                                            {skill.owner == null && (
                                                                                                                <Chip label="global" size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
                                                                                                            )}
                                                                                                            {!isEnabled && (
                                                                                                                <Chip label="disabled" size="small" color="warning" sx={{ height: 18, fontSize: '0.65rem' }} />
                                                                                                            )}
                                                                                                        </Box>
                                                                                                    </Box>
                                                                                                    <Switch
                                                                                                        checked={isEnabled}
                                                                                                        onChange={(e) => handleToggleMdSkill(skill, e.target.checked)}
                                                                                                        size="small"
                                                                                                        inputProps={{ 'aria-label': isEnabled ? 'Disable skill' : 'Enable skill' }}
                                                                                                    />
                                                                                                </Box>
                                                                                                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, fontSize: '0.8rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                                                                                    {skill.description || 'No description'}
                                                                                                </Typography>
                                                                                                {skill.triggers && (
                                                                                                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5, fontSize: '0.65rem' }}>
                                                                                                        Triggers: {skill.triggers}
                                                                                                    </Typography>
                                                                                                )}
                                                                                                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: '0.65rem' }}>
                                                                                                    {skill.bodyPreview || '(empty body)'}
                                                                                                </Typography>
                                                                                            </CardContent>
                                                                                            <CardActions sx={{ pt: 0, px: 1 }}>
                                                                                                <Button
                                                                                                    size="small"
                                                                                                    onClick={() => openMdSkillEditor(skill)}
                                                                                                    sx={{
                                                                                                        color: 'var(--accent-primary)',
                                                                                                        '&:hover': { bgcolor: 'var(--accent-muted)' },
                                                                                                    }}
                                                                                                >
                                                                                                    Edit
                                                                                                </Button>
                                                                                                <Button
                                                                                                    size="small"
                                                                                                    onClick={() => handleDeleteMdSkill(skill)}
                                                                                                    sx={{
                                                                                                        color: 'var(--error, #f87171)',
                                                                                                        '&:hover': { bgcolor: 'rgba(248,113,113,0.10)' },
                                                                                                    }}
                                                                                                >
                                                                                                    Delete
                                                                                                </Button>
                                                                                            </CardActions>
                                                                                        </Card>
                                                                                    </Grid>
                                                                                    );
                                                                                })}
                                                                            </Grid>
                                                                        </Box>
                                                                    )}
                                                                </>
                                                            )}
                                                            </Box>
                                                            </Collapse>
                                                        </Box>
                                                        );
                                                    })()}

                                                </CardContent>
                                            </Card>
                                        </Grid>
                                    ))}
                                </Grid>
                            </AppsPanel>
                        )}
                    </Box>
                </Box>
            </Box>

            {/* Agent Dialog */}
            <Dialog open={agentDialogOpen} onClose={() => { setAgentDialogOpen(false); setEditingAgent(null); }} maxWidth="md" fullWidth fullScreen={isMobile}>
                <DialogTitle>{editingAgent ? 'Edit Agent' : 'Create Agent'}</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth
                        label="Name"
                        value={agentFormData.name}
                        onChange={(e) => setAgentFormData({ ...agentFormData, name: e.target.value })}
                        sx={{ mt: 2, mb: 2 }}
                    />
                    <TextField
                        fullWidth
                        label="Description"
                        multiline
                        rows={2}
                        value={agentFormData.description}
                        onChange={(e) => setAgentFormData({ ...agentFormData, description: e.target.value })}
                        sx={{ mb: 2 }}
                    />
                    <FormControl fullWidth sx={{ mb: 2 }}>
                        <InputLabel>Model</InputLabel>
                        <Select
                            value={agentFormData.modelName || ''}
                            onChange={(e) => setAgentFormData({ ...agentFormData, modelName: e.target.value })}
                            label="Model"
                        >
                            <MenuItem value="">None</MenuItem>
                            {models.map(model => (
                                <MenuItem key={model.name} value={model.name}>{model.name}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <TextField
                        fullWidth
                        label="System Prompt"
                        multiline
                        rows={4}
                        value={agentFormData.systemPrompt}
                        onChange={(e) => setAgentFormData({ ...agentFormData, systemPrompt: e.target.value })}
                        sx={{ mb: 2 }}
                    />
                    <Autocomplete
                        multiple
                        options={skills.map(s => s.name).filter(Boolean)}
                        value={Array.isArray(agentFormData.skills) ? agentFormData.skills : []}
                        onChange={(e, newValue) => setAgentFormData({ ...agentFormData, skills: newValue })}
                        renderTags={(value, getTagProps) =>
                            value.map((option, index) => (
                                <Chip variant="outlined" label={option} size="small" {...getTagProps({ index })} key={option} />
                            ))
                        }
                        renderInput={(params) => (
                            <TextField
                                {...params}
                                label="Allowed Skills"
                                placeholder="Select tools"
                                helperText="Restrict this agent to a specific set of tools. Leave empty to allow all enabled tools."
                            />
                        )}
                        sx={{ mb: 2 }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => { setAgentDialogOpen(false); setEditingAgent(null); }}>Cancel</Button>
                    <Button onClick={editingAgent ? handleUpdateAgent : handleCreateAgent} variant="contained">
                        {editingAgent ? 'Update' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Markdown Skill Dialog */}
            <Dialog
                open={mdSkillDialogOpen}
                onClose={() => { setMdSkillDialogOpen(false); setEditingMdSkill(null); }}
                maxWidth="md"
                fullWidth
            >
                <DialogTitle>{editingMdSkill ? 'Edit Skill' : 'New Skill'}</DialogTitle>
                <DialogContent>
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>
                        Write a markdown procedure. The chat model will load this via its <code>load_skill</code> tool when a task matches the name, description, or triggers.
                    </Typography>
                    <TextField
                        fullWidth
                        label="Name"
                        value={mdSkillFormData.name}
                        onChange={(e) => setMdSkillFormData({ ...mdSkillFormData, name: e.target.value })}
                        sx={{ mt: 1, mb: 2 }}
                        helperText={editingMdSkill ? `ID: ${editingMdSkill.id}` : 'ID will be derived from the name on save'}
                        disabled={!!editingMdSkill}
                    />
                    <TextField
                        fullWidth
                        label="Description"
                        value={mdSkillFormData.description}
                        onChange={(e) => setMdSkillFormData({ ...mdSkillFormData, description: e.target.value })}
                        sx={{ mb: 2 }}
                        helperText="One-line summary shown to the model when deciding whether to load this skill"
                    />
                    <TextField
                        fullWidth
                        label="Triggers"
                        value={mdSkillFormData.triggers}
                        onChange={(e) => setMdSkillFormData({ ...mdSkillFormData, triggers: e.target.value })}
                        sx={{ mb: 2 }}
                        helperText="Comma-separated keywords that hint when this skill applies"
                    />
                    <TextField
                        fullWidth
                        label="Body (Markdown)"
                        multiline
                        rows={16}
                        value={mdSkillFormData.body}
                        onChange={(e) => setMdSkillFormData({ ...mdSkillFormData, body: e.target.value })}
                        sx={{ mb: 1, '& textarea': { fontFamily: 'monospace', fontSize: '0.85rem' } }}
                        placeholder={'## Steps\n1. Call web_search with the repo URL\n2. Summarize stars, languages, recent commits\n3. Report findings to the user'}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => { setMdSkillDialogOpen(false); setEditingMdSkill(null); }}>Cancel</Button>
                    <Button
                        onClick={handleSaveMdSkill}
                        variant="contained"
                        disabled={!mdSkillFormData.name.trim()}
                    >
                        {editingMdSkill ? 'Save' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Tool Dialog */}
            <Dialog open={skillDialogOpen} onClose={() => { setSkillDialogOpen(false); setEditingSkill(null); }} maxWidth="md" fullWidth fullScreen={isMobile}>
                <DialogTitle>{editingSkill ? 'Edit Tool' : 'Create Tool'}</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth
                        label="Name"
                        value={skillFormData.name}
                        onChange={(e) => setSkillFormData({ ...skillFormData, name: e.target.value })}
                        sx={{ mt: 2, mb: 2 }}
                    />
                    <TextField
                        fullWidth
                        label="Description"
                        multiline
                        rows={2}
                        value={skillFormData.description}
                        onChange={(e) => setSkillFormData({ ...skillFormData, description: e.target.value })}
                        sx={{ mb: 2 }}
                    />
                    <FormControl fullWidth sx={{ mb: 2 }}>
                        <InputLabel>Type</InputLabel>
                        <Select
                            value={skillFormData.type}
                            onChange={(e) => setSkillFormData({ ...skillFormData, type: e.target.value })}
                            label="Type"
                        >
                            <MenuItem value="tool">Tool</MenuItem>
                            <MenuItem value="function">Function</MenuItem>
                            <MenuItem value="command">Command</MenuItem>
                        </Select>
                    </FormControl>
                    <TextField
                        fullWidth
                        label="Code"
                        multiline
                        rows={8}
                        value={skillFormData.code}
                        onChange={(e) => setSkillFormData({ ...skillFormData, code: e.target.value })}
                        sx={{ mb: 2, fontFamily: 'monospace' }}
                        helperText="Enter the code or script for this tool"
                    />
                    <TextField
                        fullWidth
                        label="Prompt"
                        multiline
                        rows={4}
                        value={skillFormData.systemPrompt || ''}
                        onChange={(e) => setSkillFormData({ ...skillFormData, systemPrompt: e.target.value })}
                        sx={{ mb: 2 }}
                        helperText="Optional. Instructions the model sees when this tool is called — use it to enforce defaults, output format, or behavior rules. First sentence also appears in the tool description shown to the model during selection."
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => { setSkillDialogOpen(false); setEditingSkill(null); }}>Cancel</Button>
                    <Button onClick={editingSkill ? handleUpdateSkill : handleCreateSkill} variant="contained">
                        {editingSkill ? 'Update' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Task Dialog */}
            <Dialog open={taskDialogOpen} onClose={() => setTaskDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
                <DialogTitle>Create Task</DialogTitle>
                <DialogContent>
                    <FormControl fullWidth sx={{ mt: 2, mb: 2 }}>
                        <InputLabel>Agent</InputLabel>
                        <Select
                            value={taskFormData.agentId}
                            onChange={(e) => setTaskFormData({ ...taskFormData, agentId: e.target.value })}
                            label="Agent"
                        >
                            {agents.map(agent => (
                                <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <TextField
                        fullWidth
                        label="Description"
                        multiline
                        rows={3}
                        value={taskFormData.description}
                        onChange={(e) => setTaskFormData({ ...taskFormData, description: e.target.value })}
                        sx={{ mb: 2 }}
                    />
                    <FormControl fullWidth sx={{ mb: 2 }}>
                        <InputLabel>Priority</InputLabel>
                        <Select
                            value={taskFormData.priority}
                            onChange={(e) => setTaskFormData({ ...taskFormData, priority: e.target.value })}
                            label="Priority"
                        >
                            <MenuItem value="low">Low</MenuItem>
                            <MenuItem value="medium">Medium</MenuItem>
                            <MenuItem value="high">High</MenuItem>
                        </Select>
                    </FormControl>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setTaskDialogOpen(false)}>Cancel</Button>
                    <Button onClick={handleCreateTask} variant="contained">Create</Button>
                </DialogActions>
            </Dialog>

            {/* Reset Confirmation Dialog */}
            <Dialog open={resetDialogOpen} onClose={() => setResetDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
                <DialogTitle>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <WarningIcon color="error" />
                        <Typography variant="h6">System Reset Confirmation</Typography>
                    </Box>
                </DialogTitle>
                <DialogContent>
                    <Alert severity="error" sx={{ mb: 3 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                            This action cannot be undone!
                        </Typography>
                        <Typography variant="body2">
                            This will:
                        </Typography>
                        <ul style={{ marginTop: 8, marginBottom: 0 }}>
                            <li>Stop all running model instances</li>
                            <li>Delete all downloaded models</li>
                            <li>Clean up Docker containers and volumes</li>
                        </ul>
                        <Typography variant="body2" sx={{ mt: 1 }}>
                            Preserved: API keys, system prompts, configurations
                        </Typography>
                    </Alert>

                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={resetChecked}
                                onChange={(e) => setResetChecked(e.target.checked)}
                                color="error"
                            />
                        }
                        label="I understand this will delete all models"
                    />

                    <TextField
                        fullWidth
                        label="Type RESET to confirm"
                        value={resetConfirmation}
                        onChange={(e) => setResetConfirmation(e.target.value)}
                        sx={{ mt: 2 }}
                        helperText="Type the word RESET in capital letters"
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => {
                        setResetDialogOpen(false);
                        setResetConfirmation('');
                        setResetChecked(false);
                    }}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSystemReset}
                        color="error"
                        variant="contained"
                        disabled={!resetChecked || resetConfirmation !== 'RESET'}
                    >
                        Reset System
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Load HuggingFace repo via sglang (non-GGUF formats) */}
            <Dialog
                open={hfLoadDialog.open}
                onClose={() => !hfLoading && setHfLoadDialog({ open: false, repoId: '', format: '' })}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle sx={{ pb: 1 }}>
                    Load via sglang
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>
                        {hfLoadDialog.format ? `${hfLoadDialog.format.toUpperCase()} · ` : ''}sglang downloads weights from HuggingFace on first start
                    </Typography>
                </DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
                        <TextField
                            label="HuggingFace repo"
                            value={hfLoadDialog.repoId}
                            disabled
                            size="small"
                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                        />
                        <TextField
                            label="Max model length (context window)"
                            type="number"
                            value={hfLoadConfig.maxModelLen}
                            onChange={e => setHfLoadConfig(c => ({ ...c, maxModelLen: e.target.value }))}
                            inputProps={{ min: 256, max: 1048576, step: 1024 }}
                            size="small"
                            helperText="Larger = more VRAM. The chat tool catalog is ~7K tokens, so set ≥16K for chat use."
                        />
                        <TextField
                            label="GPU memory utilization"
                            type="number"
                            value={hfLoadConfig.memFractionStatic}
                            onChange={e => setHfLoadConfig(c => ({ ...c, memFractionStatic: e.target.value }))}
                            inputProps={{ min: 0.1, max: 1.0, step: 0.05 }}
                            size="small"
                            helperText="Fraction of GPU memory sglang may use (0.1–1.0)."
                        />
                        <TextField
                            label="Tensor parallel size"
                            type="number"
                            value={hfLoadConfig.tensorParallelSize}
                            onChange={e => setHfLoadConfig(c => ({ ...c, tensorParallelSize: e.target.value }))}
                            inputProps={{ min: 1, max: 8, step: 1 }}
                            size="small"
                            helperText="Number of GPUs to split the model across. Auto-prefilled to all detected GPUs."
                        />
                        <TextField
                            label="CPU offload (GB)"
                            type="number"
                            value={hfLoadConfig.cpuOffloadGb}
                            onChange={e => setHfLoadConfig(c => ({ ...c, cpuOffloadGb: e.target.value }))}
                            inputProps={{ min: 0, max: 256, step: 1 }}
                            size="small"
                            helperText="Move N GB of weights to CPU RAM to fit a larger model. 0 = GPU only."
                        />
                        <FormControl size="small">
                            <InputLabel>KV cache dtype</InputLabel>
                            <Select
                                label="KV cache dtype"
                                value={hfLoadConfig.kvCacheDtype}
                                onChange={e => setHfLoadConfig(c => ({ ...c, kvCacheDtype: e.target.value }))}
                            >
                                <MenuItem value="auto">auto</MenuItem>
                                <MenuItem value="fp8">fp8</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl size="small">
                            <InputLabel>Tool-call parser</InputLabel>
                            <Select
                                label="Tool-call parser"
                                value={hfLoadConfig.toolCallParser}
                                onChange={e => setHfLoadConfig(c => ({ ...c, toolCallParser: e.target.value }))}
                            >
                                <MenuItem value="">auto-detect from repo name</MenuItem>
                                <MenuItem value="hermes">hermes (Qwen, OpenChat, default)</MenuItem>
                                <MenuItem value="qwen3_coder">qwen3_coder</MenuItem>
                                <MenuItem value="llama3_json">llama3_json</MenuItem>
                                <MenuItem value="mistral">mistral</MenuItem>
                                <MenuItem value="deepseek_v3">deepseek_v3</MenuItem>
                                <MenuItem value="phi4_mini_json">phi4_mini_json</MenuItem>
                                <MenuItem value="glm45">glm45</MenuItem>
                                <MenuItem value="granite">granite</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControlLabel
                            control={<Switch checked={hfLoadConfig.contextShift} onChange={e => setHfLoadConfig(c => ({ ...c, contextShift: e.target.checked }))} />}
                            label="Context shift (auto-truncate to fit context window)"
                        />
                        <FormControlLabel
                            control={<Switch checked={hfLoadConfig.disableThinking} onChange={e => setHfLoadConfig(c => ({ ...c, disableThinking: e.target.checked }))} />}
                            label="Disable thinking (suppress <think> blocks for reasoning models)"
                        />
                        <FormControlLabel
                            control={<Switch checked={hfLoadConfig.compressMemory} onChange={e => setHfLoadConfig(c => ({ ...c, compressMemory: e.target.checked }))} />}
                            label="AIMem (compress older conversation messages)"
                        />
                        <FormControlLabel
                            control={<Switch checked={hfLoadConfig.trustRemoteCode} onChange={e => setHfLoadConfig(c => ({ ...c, trustRemoteCode: e.target.checked }))} />}
                            label="Trust remote code (required for some custom architectures)"
                        />
                        <FormControlLabel
                            control={<Switch checked={hfLoadConfig.enforceEager} onChange={e => setHfLoadConfig(c => ({ ...c, enforceEager: e.target.checked }))} />}
                            label="Enforce eager (disable CUDA graphs)"
                        />
                        <Typography variant="caption" sx={{ color: 'text.secondary', mt: -1.5, ml: 5 }}>
                            Off (default) uses CUDA graphs for ~10-30% more throughput. Flip ON only if you hit cudaErrorUnsupportedPtxVersion (older driver / arch).
                        </Typography>
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setHfLoadDialog({ open: false, repoId: '', format: '' })} disabled={hfLoading}>
                        Cancel
                    </Button>
                    <Button onClick={handleLoadHf} variant="contained" disabled={hfLoading}>
                        {hfLoading ? <CircularProgress size={18} /> : 'Load with sglang'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* llama.cpp Load Dialog — opened by clicking Load on a downloaded
                GGUF model. Mirrors the HF sglang dialog so the user gets the same
                "configure and launch" pattern for both backends. */}
            <Dialog
                open={llamacppLoadDialog.open}
                onClose={() => !llamacppLoading && setLlamacppLoadDialog({ open: false, modelName: '' })}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle sx={{ pb: 1 }}>
                    Load with llama.cpp
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.5 }}>
                        GGUF · Configure GPU offload, context, and KV cache before launching
                    </Typography>
                </DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
                        <TextField
                            label="Model"
                            value={llamacppLoadDialog.modelName}
                            disabled
                            size="small"
                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                        />

                        {/* Optimal Settings — moved from the old Launch Settings
                            panel into the dialog so the user can apply them per
                            launch, not as a global default. */}
                        {(() => {
                            const matchedModel = models.find(m => m.name === llamacppLoadDialog.modelName);
                            return matchedModel?.fileSize ? (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
                                    <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                                    <Typography variant="caption" sx={{ flex: 1, color: 'text.secondary' }}>
                                        {(matchedModel.fileSize / 1024 / 1024 / 1024).toFixed(1)} GB on disk
                                    </Typography>
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        startIcon={loadingOptimalSettings ? <CircularProgress size={14} color="inherit" /> : <AutoAwesomeIcon sx={{ fontSize: 14 }} />}
                                        onClick={() => fetchOptimalSettings(matchedModel)}
                                        disabled={loadingOptimalSettings}
                                    >
                                        Apply Optimal
                                    </Button>
                                </Box>
                            ) : null;
                        })()}
                        {optimalSettingsNotes.length > 0 && (
                            <Box>
                                {optimalSettingsNotes.map((note, idx) => (
                                    <Alert key={idx} severity="info" sx={{ py: 0, mb: 0.5, '& .MuiAlert-message': { fontSize: '0.75rem' } }}>
                                        {note}
                                    </Alert>
                                ))}
                            </Box>
                        )}

                        <FormControl size="small">
                            <InputLabel>GPU Layers</InputLabel>
                            <Select
                                label="GPU Layers"
                                value={llamacppConfig.nGpuLayers}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, nGpuLayers: e.target.value })}
                            >
                                <MenuItem value={-1}>All (-1)</MenuItem>
                                <MenuItem value={0}>None (CPU)</MenuItem>
                                <MenuItem value={10}>10</MenuItem>
                                <MenuItem value={20}>20</MenuItem>
                                <MenuItem value={30}>30</MenuItem>
                                <MenuItem value={40}>40</MenuItem>
                                <MenuItem value={50}>50</MenuItem>
                                <MenuItem value={80}>80</MenuItem>
                                <MenuItem value={100}>100</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl size="small">
                            <InputLabel>Context Size</InputLabel>
                            <Select
                                label="Context Size"
                                value={llamacppConfig.contextSize}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, contextSize: e.target.value })}
                            >
                                <MenuItem value={2048}>2048</MenuItem>
                                <MenuItem value={4096}>4096</MenuItem>
                                <MenuItem value={8192}>8192</MenuItem>
                                <MenuItem value={16384}>16K</MenuItem>
                                <MenuItem value={32768}>32K</MenuItem>
                                <MenuItem value={65536}>64K</MenuItem>
                                <MenuItem value={131072}>128K</MenuItem>
                                <MenuItem value={262144}>256K</MenuItem>
                                <MenuItem value={524288}>512K</MenuItem>
                                <MenuItem value={1048576}>1M</MenuItem>
                            </Select>
                        </FormControl>

                        <FormControl size="small">
                            <InputLabel>KV cache K</InputLabel>
                            <Select
                                label="KV cache K"
                                value={llamacppConfig.cacheTypeK}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, cacheTypeK: e.target.value })}
                            >
                                <MenuItem value="f16">f16 (default)</MenuItem>
                                <MenuItem value="q8_0">q8_0 (saves memory)</MenuItem>
                                <MenuItem value="q4_0">q4_0 (max savings)</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl size="small">
                            <InputLabel>KV cache V</InputLabel>
                            <Select
                                label="KV cache V"
                                value={llamacppConfig.cacheTypeV}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, cacheTypeV: e.target.value })}
                            >
                                <MenuItem value="f16">f16 (default)</MenuItem>
                                <MenuItem value="q8_0">q8_0 (saves memory)</MenuItem>
                                <MenuItem value="q4_0">q4_0 (max savings)</MenuItem>
                            </Select>
                        </FormControl>
                        {((llamacppConfig.cacheTypeK !== 'f16' || llamacppConfig.cacheTypeV !== 'f16') && !llamacppConfig.flashAttention) && (
                            <Alert severity="warning" sx={{ fontSize: '0.78rem', py: 0.5, '& .MuiAlert-message': { py: 0.5 } }}>
                                Quantized KV cache requires Flash Attention. llama.cpp will reject this combo at load. Enable the Flash Attention toggle below or revert KV cache to f16.
                            </Alert>
                        )}

                        <TextField
                            label="Threads"
                            type="number"
                            value={llamacppConfig.threads}
                            onChange={e => setLlamacppConfig({ ...llamacppConfig, threads: parseInt(e.target.value) || 0 })}
                            inputProps={{ min: 0, step: 1 }}
                            size="small"
                            helperText="0 = auto"
                        />
                        <FormControl size="small">
                            <InputLabel>Parallel Slots</InputLabel>
                            <Select
                                label="Parallel Slots"
                                value={llamacppConfig.parallelSlots}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, parallelSlots: e.target.value })}
                            >
                                <MenuItem value={1}>1</MenuItem>
                                <MenuItem value={2}>2</MenuItem>
                                <MenuItem value={4}>4</MenuItem>
                                <MenuItem value={8}>8</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl size="small">
                            <InputLabel>Batch Size</InputLabel>
                            <Select
                                label="Batch Size"
                                value={llamacppConfig.batchSize}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, batchSize: e.target.value })}
                            >
                                <MenuItem value={256}>256</MenuItem>
                                <MenuItem value={512}>512</MenuItem>
                                <MenuItem value={1024}>1024</MenuItem>
                                <MenuItem value={2048}>2048</MenuItem>
                                <MenuItem value={4096}>4096</MenuItem>
                                <MenuItem value={8192}>8192</MenuItem>
                                <MenuItem value={16384}>16384</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControl size="small">
                            <InputLabel>Micro-batch</InputLabel>
                            <Select
                                label="Micro-batch"
                                value={llamacppConfig.ubatchSize}
                                onChange={e => setLlamacppConfig({ ...llamacppConfig, ubatchSize: e.target.value })}
                            >
                                <MenuItem value={128}>128</MenuItem>
                                <MenuItem value={256}>256</MenuItem>
                                <MenuItem value={512}>512</MenuItem>
                                <MenuItem value={1024}>1024</MenuItem>
                                <MenuItem value={2048}>2048</MenuItem>
                                <MenuItem value={4096}>4096</MenuItem>
                            </Select>
                        </FormControl>

                        <FormControlLabel
                            control={<Switch checked={llamacppConfig.flashAttention} onChange={e => setLlamacppConfig({ ...llamacppConfig, flashAttention: e.target.checked })} />}
                            label="Flash Attention"
                        />
                        <FormControlLabel
                            control={<Switch checked={llamacppConfig.contextShift} onChange={e => setLlamacppConfig({ ...llamacppConfig, contextShift: e.target.checked })} />}
                            label="Context shift (auto-truncate to fit context window)"
                        />
                        <FormControlLabel
                            control={<Switch checked={llamacppConfig.swaFull} onChange={e => setLlamacppConfig({ ...llamacppConfig, swaFull: e.target.checked })} />}
                            label="SWA full cache (sliding-window attention)"
                        />
                        <FormControlLabel
                            control={<Switch checked={!llamacppConfig.disableThinking} onChange={e => setLlamacppConfig({ ...llamacppConfig, disableThinking: !e.target.checked })} />}
                            label="Reasoning enabled (allow <think> blocks)"
                        />
                        <FormControlLabel
                            control={<Switch checked={llamacppConfig.compressMemory} onChange={e => setLlamacppConfig({ ...llamacppConfig, compressMemory: e.target.checked })} />}
                            label="AIMem (compress older conversation messages)"
                        />

                        {/* MTP (multi-token prediction / speculative decoding) —
                            llama.cpp PR #22673 (May 2026). Bottom of the dialog
                            because the default ('none') is silent serial
                            decode; only flip it on for an `-MTP-` variant
                            GGUF, or wire a draft model. Options carry a
                            primary label + a secondary description;
                            renderValue collapses the selected option back to
                            the short title so the field stays compact. */}
                        <Box sx={{ mt: 1, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                MTP (advanced)
                            </Typography>
                            <Tooltip title={SETTINGS_TOOLTIPS.specType} placement="top-start">
                                <FormControl size="small" fullWidth>
                                    <InputLabel>MTP mode</InputLabel>
                                    <Select
                                        value={llamacppConfig.specType}
                                        label="MTP mode"
                                        onChange={e => setLlamacppConfig({ ...llamacppConfig, specType: e.target.value })}
                                        renderValue={(value) => ({
                                            'none': 'Off — serial decode (no MTP)',
                                            'draft-mtp': 'MTP heads (built into this model)',
                                            'draft-simple': 'Draft model (separate smaller GGUF)',
                                        }[value])}
                                    >
                                        <MenuItem value="none">
                                            <Box>
                                                <Typography variant="body2" sx={{ fontWeight: 600 }}>Off — serial decode (no MTP)</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                                    Default. One token per forward pass. Best when the model has no MTP heads and you don't want to manage a draft GGUF.
                                                </Typography>
                                            </Box>
                                        </MenuItem>
                                        <MenuItem value="draft-mtp">
                                            <Box>
                                                <Typography variant="body2" sx={{ fontWeight: 600 }}>MTP heads (built into this model)</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                                    Use the multi-token-prediction heads already baked into the GGUF. No second model needed. ~1.5–2× single-stream tok/s. Only works on <code>-MTP-</code> variant checkpoints: DeepSeek-V3 / R1, Qwen3-Next-MTP, Qwen3.5/3.6-MTP. Refuses to start on a plain non-MTP GGUF.
                                                </Typography>
                                            </Box>
                                        </MenuItem>
                                        <MenuItem value="draft-simple">
                                            <Box>
                                                <Typography variant="body2" sx={{ fontWeight: 600 }}>Draft model (separate smaller GGUF)</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                                    Classic speculative decoding: a small fast model proposes tokens, the main model verifies. Best when the draft shares the main model's tokenizer (e.g. Qwen2.5-0.5B-Instruct as draft for Qwen3-8B-Instruct). Specify the draft path below.
                                                </Typography>
                                            </Box>
                                        </MenuItem>
                                    </Select>
                                </FormControl>
                            </Tooltip>
                            {llamacppConfig.specType !== 'none' && (
                                <Tooltip title={SETTINGS_TOOLTIPS.specDraftNMax} placement="top-start">
                                    <TextField
                                        size="small"
                                        type="number"
                                        label="Draft tokens per step"
                                        value={llamacppConfig.specDraftNMax}
                                        onChange={e => setLlamacppConfig({ ...llamacppConfig, specDraftNMax: Math.max(1, Math.min(16, Number(e.target.value) || 1)) })}
                                        inputProps={{ min: 1, max: 16 }}
                                        sx={{ mt: 1.5 }}
                                        fullWidth
                                    />
                                </Tooltip>
                            )}
                            {llamacppConfig.specType === 'draft-simple' && (
                                <Tooltip title={SETTINGS_TOOLTIPS.specDraftModel} placement="top-start">
                                    <TextField
                                        size="small"
                                        label="Draft model path"
                                        placeholder="/models/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf"
                                        value={llamacppConfig.specDraftModel}
                                        onChange={e => setLlamacppConfig({ ...llamacppConfig, specDraftModel: e.target.value })}
                                        sx={{ mt: 1.5 }}
                                        fullWidth
                                    />
                                </Tooltip>
                            )}
                        </Box>
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setLlamacppLoadDialog({ open: false, modelName: '' })} disabled={llamacppLoading}>
                        Cancel
                    </Button>
                    <Button onClick={handleLoadLlamacppFromDialog} variant="contained" disabled={llamacppLoading}>
                        {llamacppLoading ? <CircularProgress size={18} /> : 'Load with llama.cpp'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* User Menu */}
            <Menu
                anchorEl={userMenuAnchor}
                open={Boolean(userMenuAnchor)}
                onClose={handleUserMenuClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
                <Box sx={{ px: 2, py: 1, minWidth: 200 }}>
                    <Typography variant="body2" color="text.secondary">
                        Signed in as
                    </Typography>
                    <Typography variant="body1" fontWeight={600}>
                        {user?.username}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                        {user?.email}
                    </Typography>
                </Box>
                <Divider />
                <MenuItem onClick={handleLogout}>
                    <LogoutIcon sx={{ mr: 1, fontSize: 18 }} />
                    Logout
                </MenuItem>
            </Menu>

            <Snackbar
                open={snackbarOpen}
                autoHideDuration={4000}
                onClose={() => setSnackbarOpen(false)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            >
                <Alert
                    onClose={() => setSnackbarOpen(false)}
                    severity={snackbarSeverity}
                    variant="filled"
                    sx={{ borderRadius: 2 }}
                >
                    {snackbarMessage}
                </Alert>
            </Snackbar>
        </ThemeProvider>
    );
};

export default App;
