import React, { useState, useEffect, useRef, useMemo } from 'react';
// Use native WebSocket (W3C-compliant in all modern browsers)
import { useAuthStore } from './stores/useAuthStore';
import { useAppStore } from './stores/useAppStore';
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
import IconButton from '@mui/material/IconButton';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import SearchIcon from '@mui/icons-material/Search';
import SettingsIcon from '@mui/icons-material/Settings';
import StorageIcon from '@mui/icons-material/Storage';
import TerminalIcon from '@mui/icons-material/Terminal';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import SaveIcon from '@mui/icons-material/Save';
import ClearIcon from '@mui/icons-material/Clear';
import MemoryIcon from '@mui/icons-material/Memory';
import ChatIcon from '@mui/icons-material/Chat';
import TuneIcon from '@mui/icons-material/Tune';
import InfoIcon from '@mui/icons-material/Info';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import FilterListIcon from '@mui/icons-material/FilterList';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import AddIcon from '@mui/icons-material/Add';
import EmailIcon from '@mui/icons-material/Email';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import AppsIcon from '@mui/icons-material/Apps';
import CancelIcon from '@mui/icons-material/Cancel';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import CodeIcon from '@mui/icons-material/Code';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import FavoriteIcon from '@mui/icons-material/Favorite';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Snackbar from '@mui/material/Snackbar';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
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
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import LinearProgress from '@mui/material/LinearProgress';
import Checkbox from '@mui/material/Checkbox';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import PeopleIcon from '@mui/icons-material/People';
import LogoutIcon from '@mui/icons-material/Logout';
import Menu from '@mui/material/Menu';

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
    if (!bytes) return 'N/A';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb < 1) {
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(0)} MB`;
    }
    return `${gb.toFixed(2)} GB`;
};

// Settings tooltips - detailed descriptions for all vLLM configuration options
const SETTINGS_TOOLTIPS = {
    maxModelLen: "Maximum number of tokens the model can process at once. Larger values allow longer conversations but require more VRAM. Your prompt + response must fit within this limit.",
    cpuOffloadGb: "Amount of model weights (in GB) to offload to CPU RAM. Use when model doesn't fit entirely in GPU VRAM. Note: GGUF + CPU offload may have issues (vLLM GitHub #8757).",
    gpuMemoryUtilization: "Fraction of GPU memory (0.0-1.0) that vLLM is allowed to use. Higher values allow larger context windows but leave less headroom for spikes.",
    tensorParallelSize: "Number of GPUs to use for tensor parallelism. Set to your GPU count to split the model across multiple GPUs for larger models.",
    maxNumSeqs: "Maximum number of concurrent sequences (requests) that can be processed simultaneously. Higher values improve throughput but use more memory.",
    kvCacheDtype: "Data type for KV cache. 'auto' uses model's native dtype, 'fp8' uses 8-bit precision to save memory with minimal quality loss.",
    trustRemoteCode: "Whether to trust remote code from the model repository. Required for some custom model architectures.",
    enforceEager: "Disable CUDA graphs and use eager execution. Useful for debugging but slower. Keep disabled for production.",
    contextShift: "Enable context shifting to automatically truncate old context when the limit is reached. Without this, requests fail when context is full. Recommended for long conversations.",
    disableThinking: "Disable thinking/reasoning mode for models that support it (e.g., Qwen3). When enabled, adds /no_think to prompts for faster, more direct responses."
};

// Settings tooltips for llama.cpp configuration options
const LLAMACPP_TOOLTIPS = {
    nGpuLayers: "Number of model layers to offload to GPU. -1 = all layers (recommended). Lower values offload less to GPU, useful for large models that don't fit in VRAM.",
    contextSize: "Maximum context window size in tokens. Larger values allow longer conversations but require more memory. Common values: 2048, 4096, 8192, 16384.",
    contextShift: "Enable context shifting to automatically discard old context when the limit is reached. Without this, inference stops when context is full. Recommended for long conversations.",
    flashAttention: "Enable flash attention for faster inference and lower memory usage. Recommended for most GPUs that support it.",
    cacheTypeK: "Data type for key cache. f16 = full precision, q8_0 = 8-bit quantized (saves memory), q4_0 = 4-bit quantized (maximum memory savings).",
    cacheTypeV: "Data type for value cache. Same options as key cache. Using quantized cache reduces memory but may slightly affect output quality.",
    threads: "Number of CPU threads to use. 0 = auto-detect (uses all available cores). Lower values leave more CPU for other tasks.",
    parallelSlots: "Number of parallel inference slots. Higher values allow more concurrent requests but use more memory.",
    batchSize: "Batch size for prompt processing. Larger values are faster but use more memory. Common values: 512, 1024, 2048.",
    ubatchSize: "Micro-batch size for processing. Should be smaller than batch size. Common values: 256, 512.",
    repeatPenalty: "Penalty for repeating tokens (1.0 = no penalty). Higher values (1.1-1.3) reduce repetition. Too high may affect coherence.",
    repeatLastN: "Number of recent tokens to consider for repetition penalty. 64-128 is usually sufficient.",
    presencePenalty: "Penalty for tokens that have appeared at all (0.0-1.0). Encourages the model to talk about new topics.",
    frequencyPenalty: "Penalty based on token frequency (0.0-1.0). Higher values reduce repetition of common phrases.",
    disableThinking: "Disable thinking/reasoning mode for models that support it (e.g., Qwen3). When enabled, adds /no_think to prompts for faster, more direct responses."
};

// Section Header Component
const SectionHeader = ({ icon, title, subtitle, action }) => (
    <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {icon && React.cloneElement(icon, { sx: { fontSize: 18, color: 'primary.main' } })}
                <Typography variant="h5" sx={{ color: 'text.primary' }}>{title}</Typography>
            </Box>
            {action}
        </Box>
        {subtitle && (
            <Typography variant="caption" sx={{ color: 'text.secondary', ml: icon ? 3.5 : 0 }}>
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
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' }
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

// Modern Doc Icon Component - sleek pill-shaped icon container
const DocIcon = ({ icon, color = 'primary' }) => {
    const colorMap = {
        primary: { bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.3)', icon: '#6366f1' },
        secondary: { bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.3)', icon: '#6366f1' },
        success: { bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.3)', icon: '#22c55e' },
        warning: { bg: 'rgba(251, 191, 36, 0.15)', border: 'rgba(251, 191, 36, 0.3)', icon: '#fbbf24' },
    };
    const colors = colorMap[color] || colorMap.primary;
    return (
        <Box sx={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: '10px',
            background: `linear-gradient(135deg, ${colors.bg} 0%, transparent 100%)`,
            border: `1px solid ${colors.border}`,
            flexShrink: 0,
        }}>
            {React.cloneElement(icon, { sx: { fontSize: 16, color: colors.icon } })}
        </Box>
    );
};

// Modern styled accordion for docs
const docAccordionSx = {
    bgcolor: 'transparent',
    boxShadow: 'none',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '12px !important',
    mb: 1.5,
    '&:before': { display: 'none' },
    '&.Mui-expanded': {
        margin: '0 0 12px 0 !important',
        border: '1px solid rgba(99, 102, 241, 0.2)',
    },
    '& .MuiAccordionSummary-root': {
        minHeight: 56,
        borderRadius: '12px',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
        '&.Mui-expanded': { minHeight: 56 },
    },
    '& .MuiAccordionSummary-content': {
        margin: '12px 0',
        '&.Mui-expanded': { margin: '12px 0' },
    },
    '& .MuiAccordionDetails-root': {
        pt: 0,
        pb: 2,
        px: 2,
    },
};

// Compact table styling for docs
const compactTableSx = {
    '& .MuiTableCell-root': {
        py: 1,
        px: 1.5,
        fontSize: '0.8rem',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
    },
    '& .MuiTableCell-head': {
        fontWeight: 600,
        color: 'text.secondary',
        fontSize: '0.7rem',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        bgcolor: 'rgba(255,255,255,0.02)',
    },
};

const App = () => {
    // Core state
    const [models, setModels] = useState([]);
    const [instances, setInstances] = useState([]);
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
            preferences.fontSize || 'medium'
        );
    }, [preferences.theme, preferences.fontFamily, preferences.fontSize]);

    // UI state
    const [activeTab, setActiveTab] = useState(0);
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [snackbarSeverity, setSnackbarSeverity] = useState('success');

    // HuggingFace search state
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [selectedModelFiles, setSelectedModelFiles] = useState([]);
    const [ggufRepo, setGgufRepo] = useState('');
    const [ggufFile, setGgufFile] = useState('');
    const [fileFilter, setFileFilter] = useState('all'); // 'all', 'single', 'split'
    const [searchSortBy, setSearchSortBy] = useState('downloads'); // 'downloads', 'likes', 'params', 'trending', 'newest'
    const [searchSizeFilter, setSearchSizeFilter] = useState('all'); // 'all', 'small', 'medium', 'large', 'xlarge'
    const [searchPage, setSearchPage] = useState(1);
    const ITEMS_PER_PAGE = 24;

    // User management state
    const [users, setUsers] = useState([]);
    const [usersLoading, setUsersLoading] = useState(false);
    const [selectedUser, setSelectedUser] = useState(null);
    const [userDialogOpen, setUserDialogOpen] = useState(false);
    const [userDialogMode, setUserDialogMode] = useState('create'); // 'create', 'edit', 'resetPassword', 'invite'
    const [newUserData, setNewUserData] = useState({ username: '', email: '', password: '', role: 'user' });

    // Backend selection (llamacpp works with older GPUs like Maxwell 5.2+)
    const [selectedBackend, setSelectedBackend] = useState('llamacpp');

    // Model configuration state for vLLM
    const [modelConfig, setModelConfig] = useState({
        maxModelLen: 4096,
        cpuOffloadGb: 0,
        gpuMemoryUtilization: 0.9,
        tensorParallelSize: 1,
        maxNumSeqs: 256,
        kvCacheDtype: 'auto',
        trustRemoteCode: true,
        enforceEager: false,
        contextShift: true,
        disableThinking: false
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
        disableThinking: false
    });

    // Optimal settings state
    const [loadingOptimalSettings, setLoadingOptimalSettings] = useState(false);
    const [optimalSettingsNotes, setOptimalSettingsNotes] = useState([]);
    const [selectedModelForOptimal, setSelectedModelForOptimal] = useState(null);

    // API Keys state
    const [apiKeys, setApiKeys] = useState([]);
    const [newKeyName, setNewKeyName] = useState('');
    const [newKeyPermissions, setNewKeyPermissions] = useState(['query', 'models']);
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
        code: ''
    });

    // Tasks state
    const [tasks, setTasks] = useState([]);
    const [taskDialogOpen, setTaskDialogOpen] = useState(false);
    const [taskFormData, setTaskFormData] = useState({
        agentId: '',
        description: '',
        priority: 'medium'
    });

    // Agent permissions state
    const [agentPermissions, setAgentPermissions] = useState({
        allowFileRead: true,
        allowFileWrite: true,
        allowFileDelete: true,
        allowToolExecution: true,
        allowModelAccess: true,
        allowCollaboration: true
    });

    // Agent sub-tab state
    const [agentSubTab, setAgentSubTab] = useState(0);

    // System reset state
    const [resetDialogOpen, setResetDialogOpen] = useState(false);
    const [resetConfirmation, setResetConfirmation] = useState('');
    const [resetChecked, setResetChecked] = useState(false);

    // Tab order state
    const [tabOrder, setTabOrder] = useState(() => {
        const defaultOrder = [0, 1, 2, 3, 4, 5, 6];
        try {
            const saved = localStorage.getItem('tabOrder');
            if (saved) {
                const parsed = JSON.parse(saved);
                // Validate: must have exactly 7 elements and include all tab IDs 0-6
                const hasAllTabs = defaultOrder.every(id => parsed.includes(id));
                if (parsed.length === 7 && hasAllTabs) {
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

    // Docs accordion order state
    const [docsAccordionOrder, setDocsAccordionOrder] = useState(() => {
        const saved = localStorage.getItem('docsAccordionOrder');
        return saved ? JSON.parse(saved) : [0, 1, 2, 3, 4, 5];
    });

    // API Builder state
    const [apiBuilderEndpoint, setApiBuilderEndpoint] = useState('/api/chat');
    const [apiBuilderLang, setApiBuilderLang] = useState('curl');
    const [apiBuilderAuthType, setApiBuilderAuthType] = useState('bearer');

    // Refs
    const logsEndRef = useRef(null);
    const logsContainerRef = useRef(null);
    const wsRef = useRef(null);
    const isUserNearBottomRef = useRef(true);

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
            logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    };

    useEffect(() => {
        scrollToBottom();
        // Save logs to localStorage (keep last 500 entries to avoid storage issues)
        try {
            const logsToSave = logs.slice(-500);
            localStorage.setItem('modelserver_logs', JSON.stringify(logsToSave));
        } catch (error) {
            console.error('Failed to save logs to localStorage:', error);
        }
    }, [logs]);

    // Reset search page when sort/size filters change
    useEffect(() => {
        setSearchPage(1);
    }, [searchSortBy, searchSizeFilter]);

    // Fetch users when Users tab is selected
    // Note: Using tabOrder here instead of visibleTabOrder since this runs early in component
    // and visibleTabOrder is derived later. The check is still valid because we also check admin role.
    useEffect(() => {
        if (tabOrder[activeTab] === 2 && user?.role === 'admin') {
            fetchUsers();
        }
    }, [activeTab, user?.role, tabOrder]);

    // Initial data fetch and WebSocket setup
    useEffect(() => {
        fetchModels();
        fetchInstances();
        fetchApiKeys();
        fetchDownloads();
        fetchApps();
        fetchAgents();
        fetchSkills();
        fetchTasks();
        fetchAgentPermissions();

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
                        const msg = data.message.trim();
                        // Auto-detect level from message content if not provided
                        let level = data.level || 'info';
                        if (!data.level) {
                            const lower = msg.toLowerCase();
                            if (lower.includes('error') || lower.includes('failed') || lower.includes('fatal') || lower.startsWith('error:')) level = 'error';
                            else if (lower.includes('warning') || lower.includes('⚠️') || lower.includes('warn')) level = 'warning';
                            else if (lower.includes('✓') || lower.includes('success') || lower.includes('complete') || lower.includes('ready') || lower.includes('started') || lower.includes('running')) level = 'success';
                        }
                        setLogs(prevLogs => [...prevLogs, {
                            message: msg,
                            level: level,
                            timestamp: Date.now()
                        }]);
                    } else if (data.type === 'status') {
                        const severity = data.level === 'error' ? 'error' :
                                         data.level === 'success' ? 'success' :
                                         data.message.toLowerCase().includes('error') ? 'error' : 'success';
                        showSnackbar(data.message, severity);
                        fetchModels();
                        fetchInstances();
                        setLoading(false);
                    } else if (data.type === 'download_started') {
                        fetchDownloads();
                        showSnackbar(`Download started: ${data.modelName}`, 'info');
                    } else if (data.type === 'download_progress') {
                        setActiveDownloads(prev => prev.map(d =>
                            d.downloadId === data.downloadId ? { ...d, progress: data.progress } : d
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
            const [llamacppRes, vllmRes] = await Promise.allSettled([
                fetch('/api/llamacpp/instances', { credentials: 'include' }),
                fetch('/api/vllm/instances', { credentials: 'include' }),
            ]);

            const allInstances = [];

            // Parse llama.cpp instances
            if (llamacppRes.status === 'fulfilled' && llamacppRes.value.ok) {
                const llamacppData = await llamacppRes.value.json();
                const llamacppInstances = Array.isArray(llamacppData) ? llamacppData : (llamacppData.instances || []);
                allInstances.push(...llamacppInstances);
            }

            // Parse vLLM instances
            if (vllmRes.status === 'fulfilled' && vllmRes.value.ok) {
                const vllmData = await vllmRes.value.json();
                const vllmInstances = Array.isArray(vllmData) ? vllmData : (vllmData.instances || []);
                allInstances.push(...vllmInstances);
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

    const fetchTasks = () => {
        fetch('/api/tasks', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setTasks(data))
            .catch(error => console.error('Error fetching tasks:', error));
    };

    const fetchAgentPermissions = () => {
        fetch('/api/agent-permissions', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setAgentPermissions(data))
            .catch(error => console.error('Error fetching agent permissions:', error));
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
    "gpuMemoryUtilization": 0.9,
    "tensorParallelSize": 1,
    "maxNumSeqs": 256
  }'

# OR API Key + Secret Authentication
curl -k -X POST ${baseUrl}/api/models/Llama-2-7B-GGUF/load \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "maxModelLen": 4096,
    "cpuOffloadGb": 0,
    "gpuMemoryUtilization": 0.9,
    "tensorParallelSize": 1,
    "maxNumSeqs": 256
  }'`,
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
        'gpuMemoryUtilization': 0.9,
        'tensorParallelSize': 1,
        'maxNumSeqs': 256
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
        'gpuMemoryUtilization': 0.9,
        'tensorParallelSize': 1,
        'maxNumSeqs': 256
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
    gpuMemoryUtilization = 0.9
    tensorParallelSize = 1
    maxNumSeqs = 256
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
    gpuMemoryUtilization: 0.9,
    tensorParallelSize: 1,
    maxNumSeqs: 256
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
    gpuMemoryUtilization: 0.9,
    tensorParallelSize: 1,
    maxNumSeqs: 256
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
            '/api/vllm/instances': {
                curl: `# Bearer Token Authentication
curl -X GET ${baseUrl}/api/vllm/instances \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -X GET ${baseUrl}/api/vllm/instances \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.get(
    '${baseUrl}/api/vllm/instances',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    }
)

# OR API Key + Secret Authentication
response = requests.get(
    '${baseUrl}/api/vllm/instances',
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

$response = Invoke-RestMethod -Uri "${baseUrl}/api/vllm/instances" -Method Get -Headers $headers
$response | ForEach-Object { Write-Output "$($_.name): $($_.status) on port $($_.port)" }`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/vllm/instances', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer your_bearer_token'
  }
})
.then(res => res.json())
.then(instances => instances.forEach(i => console.log(\`\${i.name}: \${i.status} on port \${i.port}\`)))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/vllm/instances', {
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
            '/api/vllm/instances/:name': {
                curl: `# Bearer Token Authentication
curl -X DELETE ${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -X DELETE ${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

# Bearer Token Authentication
response = requests.delete(
    '${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF',
    headers={
        'Authorization': 'Bearer your_bearer_token'
    }
)

# OR API Key + Secret Authentication
response = requests.delete(
    '${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF',
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

$response = Invoke-RestMethod -Uri "${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF" -Method Delete -Headers $headers
Write-Output $response.message`,
                javascript: `// Bearer Token Authentication
fetch('${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF', {
  method: 'DELETE',
  headers: {
    'Authorization': 'Bearer your_bearer_token'
  }
})
.then(res => res.json())
.then(data => console.log(data.message))
.catch(err => console.error(err));

// OR API Key + Secret Authentication
fetch('${baseUrl}/api/vllm/instances/Llama-2-7B-GGUF', {
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
# - {"done":true,"mapReduce":{"enabled":true,"chunkCount":3,"synthesized":true}}`,
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
            // BACKEND MANAGEMENT
            // ============================================================================
            '/api/backend/active': {
                curl: `# Get active backend (llamacpp or vllm)
curl -k -X GET ${baseUrl}/api/backend/active \\
  -H "Authorization: Bearer your_bearer_token"

# Set active backend
curl -k -X POST ${baseUrl}/api/backend/active \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{"backend": "llamacpp"}'`,
                python: `import requests

# Get current backend
response = requests.get(
    '${baseUrl}/api/backend/active',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)
print(f"Current backend: {response.json()['backend']}")

# Set backend to llama.cpp
response = requests.post(
    '${baseUrl}/api/backend/active',
    headers={
        'Authorization': 'Bearer your_bearer_token',
        'Content-Type': 'application/json'
    },
    json={'backend': 'llamacpp'},
    verify=False
)
print(f"Backend set to: {response.json()['backend']}")`,
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

# Get current backend
$response = Invoke-RestMethod -Uri "${baseUrl}/api/backend/active" -Headers $headers
Write-Output "Current backend: $($response.backend)"

# Set backend
$body = @{ backend = "llamacpp" } | ConvertTo-Json
$response = Invoke-RestMethod -Uri "${baseUrl}/api/backend/active" -Method Post -Headers $headers -Body $body
Write-Output "Backend set to: $($response.backend)"`,
                javascript: `// Get current backend
fetch('${baseUrl}/api/backend/active', {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(data => console.log('Current backend:', data.backend));

// Set backend
fetch('${baseUrl}/api/backend/active', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your_bearer_token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ backend: 'llamacpp' })
})
.then(res => res.json())
.then(data => console.log('Backend set to:', data.backend));`
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
print(f"Uploaded: {result['filename']}, Type: {result['type']}")`,
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
Write-Output "Uploaded: $($response.filename)"`,
                javascript: `// Bearer Token Authentication
const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('${baseUrl}/api/chat/upload', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer your_bearer_token' },
  body: formData
})
.then(res => res.json())
.then(data => console.log('Uploaded:', data.filename, 'Type:', data.type))
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
            // VLLM SLOTS
            // ============================================================================
            '/api/vllm/instances/:name/slots': {
                curl: `# Get KV cache slots for a vLLM instance
curl -k -X GET "${baseUrl}/api/vllm/instances/llama-7b/slots" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X GET "${baseUrl}/api/vllm/instances/llama-7b/slots" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.get(
    f'${baseUrl}/api/vllm/instances/{model_name}/slots',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.get(
    f'${baseUrl}/api/vllm/instances/{model_name}/slots',
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

$slots = Invoke-RestMethod -Uri "${baseUrl}/api/vllm/instances/$modelName/slots" -Headers $headers
Write-Output "Used: $($slots.used), Total: $($slots.total)"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/vllm/instances/\${modelName}/slots\`, {
  headers: { 'Authorization': 'Bearer your_bearer_token' }
})
.then(res => res.json())
.then(slots => console.log('Used:', slots.used, 'Total:', slots.total))
.catch(err => console.error(err));`
            },
            '/api/vllm/instances/:name/slots/clear': {
                curl: `# Clear KV cache for a vLLM instance
curl -k -X POST "${baseUrl}/api/vllm/instances/llama-7b/slots/clear" \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -k -X POST "${baseUrl}/api/vllm/instances/llama-7b/slots/clear" \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`,
                python: `import requests

model_name = "llama-7b"

# Bearer Token Authentication
response = requests.post(
    f'${baseUrl}/api/vllm/instances/{model_name}/slots/clear',
    headers={'Authorization': 'Bearer your_bearer_token'},
    verify=False
)

# OR API Key + Secret Authentication
response = requests.post(
    f'${baseUrl}/api/vllm/instances/{model_name}/slots/clear',
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

$response = Invoke-RestMethod -Uri "${baseUrl}/api/vllm/instances/$modelName/slots/clear" -Method Post -Headers $headers
Write-Output "KV cache cleared"`,
                javascript: `const modelName = 'llama-7b';

// Bearer Token Authentication
fetch(\`${baseUrl}/api/vllm/instances/\${modelName}/slots/clear\`, {
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

    // Tab definitions
    const tabDefinitions = [
        { id: 0, icon: <SearchIcon sx={{ fontSize: 18 }} />, label: 'Discover' },
        { id: 1, icon: <StorageIcon sx={{ fontSize: 18 }} />, label: 'My Models' },
        { id: 2, icon: <PeopleIcon sx={{ fontSize: 18 }} />, label: 'Users' },
        { id: 3, icon: <VpnKeyIcon sx={{ fontSize: 18 }} />, label: 'API Keys', adminOnly: true },
        { id: 4, icon: <MenuBookIcon sx={{ fontSize: 18 }} />, label: 'Docs' },
        { id: 5, icon: <TerminalIcon sx={{ fontSize: 18 }} />, label: 'Logs' },
        { id: 6, icon: <AppsIcon sx={{ fontSize: 18 }} />, label: 'Apps', adminOnly: true }
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
            })
            .catch(error => {
                showSnackbar(`Search failed: ${error.message}`, 'error');
                setSearching(false);
            });
    };

    const handleSelectModel = (modelId) => {
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

    const handleSelectGGUFFile = (filename) => {
        setGgufFile(filename);
    };

    const handlePullModel = () => {
        if (!ggufRepo || !ggufFile) {
            showSnackbar('Please provide both repository and file name', 'warning');
            return;
        }
        setLoading(true);
        setLogs([]);
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
        showSnackbar(`Starting ${modelName} with ${selectedBackend}...`, 'info');
        setLogs([]);

        // Build config based on selected backend
        const config = selectedBackend === 'vllm'
            ? { backend: 'vllm', ...modelConfig }
            : { backend: 'llamacpp', ...llamacppConfig };

        fetch(`/api/models/${modelName}/load`, {
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
        })
        .catch(error => showSnackbar(error.message, 'error'));
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
                    backend: selectedBackend  // Pass the selected backend
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to get optimal settings');
            }

            const data = await response.json();

            // Apply settings based on backend
            if (data.backend === 'llamacpp' || selectedBackend === 'llamacpp') {
                // Apply llama.cpp optimal settings
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
                    frequencyPenalty: data.settings.frequencyPenalty
                }));
            } else {
                // Apply the optimal vLLM settings to modelConfig
                setModelConfig(prev => ({
                    ...prev,
                    maxModelLen: data.settings.maxModelLen,
                    cpuOffloadGb: data.settings.cpuOffloadGb,
                    gpuMemoryUtilization: data.settings.gpuMemoryUtilization,
                    tensorParallelSize: data.settings.tensorParallelSize,
                    maxNumSeqs: data.settings.maxNumSeqs,
                    kvCacheDtype: data.settings.kvCacheDtype,
                    trustRemoteCode: data.settings.trustRemoteCode,
                    enforceEager: data.settings.enforceEager
                }));
            }

            setOptimalSettingsNotes(data.notes || []);

            const hardwareInfo = `${data.hardware.gpuCount} GPU(s) with ${data.hardware.gpuMemoryGB}GB VRAM, ${data.hardware.cpuCores} CPU cores`;
            showSnackbar(`Optimal ${selectedBackend} settings applied for ${model.name} (${hardwareInfo})`, 'success');
        } catch (error) {
            showSnackbar(error.message, 'error');
        } finally {
            setLoadingOptimalSettings(false);
        }
    };

    const handleStopInstance = (modelName, backend = 'llamacpp') => {
        showSnackbar(`Stopping ${modelName}...`, 'info');
        const endpoint = backend === 'vllm'
            ? `/api/vllm/instances/${modelName}`
            : `/api/llamacpp/instances/${modelName}`;
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
                    setSkillFormData({ name: '', description: '', type: 'tool', parameters: {}, code: '' });
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
                    setSkillFormData({ name: '', description: '', type: 'tool', parameters: {}, code: '' });
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

    // Permission handlers
    const handleUpdatePermissions = (newPermissions) => {
        fetch('/api/agent-permissions', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(newPermissions)
        })
            .then(res => res.json())
            .then(data => {
                showSnackbar('Permissions updated successfully', 'success');
                setAgentPermissions(data);
            })
            .catch(error => showSnackbar('Failed to update permissions', 'error'));
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
                {/* Main Content */}
                <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Header */}
                    <Box sx={{
                        px: 3,
                        py: 3,
                        minHeight: '72px',
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        bgcolor: 'background.paper',
                    }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                <Typography variant="h1" sx={{
                                    background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
                                    WebkitBackgroundClip: 'text',
                                    WebkitTextFillColor: 'transparent',
                                }}>
                                    Open Source Model Manager
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                                <Chip
                                    icon={wsConnected ? <CheckCircleIcon sx={{ fontSize: 18 }} /> : <WarningIcon sx={{ fontSize: 18 }} />}
                                    label={wsConnected ? "Connected" : "Disconnected"}
                                    size="medium"
                                    color={wsConnected ? "success" : "error"}
                                    variant="outlined"
                                    sx={{ height: 32, fontSize: '0.875rem', '& .MuiChip-icon': { ml: 0.5 } }}
                                />
                                {instances.length > 0 && (
                                    <Chip
                                        icon={<MemoryIcon sx={{ fontSize: 18 }} />}
                                        label={`${instances.length} Active`}
                                        size="medium"
                                        color="secondary"
                                        variant="outlined"
                                        sx={{ height: 32, fontSize: '0.875rem' }}
                                    />
                                )}
                                <Chip
                                    icon={<AccountCircleIcon sx={{ fontSize: 18, color: 'text.primary' }} />}
                                    label={user?.username || 'User'}
                                    size="medium"
                                    variant="outlined"
                                    onClick={handleUserMenuOpen}
                                    sx={{
                                        height: 32,
                                        fontSize: '0.875rem',
                                        borderColor: 'divider',
                                        color: 'text.primary',
                                        '& .MuiChip-icon': { ml: 0.5 },
                                        cursor: 'pointer',
                                        '&:hover': { bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08) }
                                    }}
                                />
                            </Box>
                        </Box>

                        {/* Tabs */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
                            <Tabs
                                value={activeTab}
                                onChange={handleTabChange}
                                sx={{ flex: 1 }}
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

                    {/* Tab Panels */}
                    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
                        {/* Discover Tab */}
                        {visibleTabOrder[activeTab] === 0 && (
                            <Grid container spacing={3}>
                                {/* Search Section */}
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <SectionHeader
                                                icon={<SearchIcon />}
                                                title="Search HuggingFace"
                                                subtitle="Find and download GGUF models from HuggingFace"
                                            />
                                            <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
                                                <TextField
                                                    fullWidth
                                                    placeholder="Search for models (e.g., llama, mistral, qwen)..."
                                                    value={searchQuery}
                                                    onChange={(e) => setSearchQuery(e.target.value)}
                                                    onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                                                    size="small"
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
                                                    sx={{ minWidth: 100 }}
                                                >
                                                    {searching ? <CircularProgress size={20} /> : 'Search'}
                                                </Button>
                                            </Box>

                                            {/* Search Filters */}
                                            <Box sx={{ display: 'flex', gap: 2, mt: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                    <FilterListIcon sx={{ color: 'text.secondary', fontSize: 18 }} />
                                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>Filters:</Typography>
                                                </Box>
                                                <FormControl size="small" sx={{ minWidth: 140 }}>
                                                    <InputLabel>Sort By</InputLabel>
                                                    <Select
                                                        value={searchSortBy}
                                                        onChange={(e) => setSearchSortBy(e.target.value)}
                                                        label="Sort By"
                                                    >
                                                        <MenuItem value="downloads">Most Downloads</MenuItem>
                                                        <MenuItem value="downloads_asc">Fewest Downloads</MenuItem>
                                                        <MenuItem value="likes">Most Likes</MenuItem>
                                                        <MenuItem value="likes_asc">Fewest Likes</MenuItem>
                                                        <MenuItem value="params">Largest First</MenuItem>
                                                        <MenuItem value="params_asc">Smallest First</MenuItem>
                                                        <MenuItem value="trending">Trending</MenuItem>
                                                        <MenuItem value="newest">Newest</MenuItem>
                                                        <MenuItem value="oldest">Oldest</MenuItem>
                                                    </Select>
                                                </FormControl>
                                                <FormControl size="small" sx={{ minWidth: 120 }}>
                                                    <InputLabel>Size</InputLabel>
                                                    <Select
                                                        value={searchSizeFilter}
                                                        onChange={(e) => setSearchSizeFilter(e.target.value)}
                                                        label="Size"
                                                    >
                                                        <MenuItem value="all">All Sizes</MenuItem>
                                                        <MenuItem value="small">≤3B (Small)</MenuItem>
                                                        <MenuItem value="medium">7B-13B (Medium)</MenuItem>
                                                        <MenuItem value="large">14B-40B (Large)</MenuItem>
                                                        <MenuItem value="xlarge">40B+ (XL)</MenuItem>
                                                    </Select>
                                                </FormControl>
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
                                                        typeTags.push({ label: 'Embed', color: 'rgba(99,102,241,0.3)', textColor: '#6366f1' });
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
                                                                            transition: 'all 0.15s',
                                                                            '&:hover': {
                                                                                borderColor: 'primary.main',
                                                                                bgcolor: 'rgba(99, 102, 241, 0.03)',
                                                                            },
                                                                        }}
                                                                        onClick={() => handleSelectModel(model.id)}
                                                                    >
                                                                        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                                                            <Typography variant="h6" sx={{
                                                                                whiteSpace: 'nowrap',
                                                                                overflow: 'hidden',
                                                                                textOverflow: 'ellipsis',
                                                                                mb: 0.5,
                                                                                fontSize: '0.95rem'
                                                                            }}>
                                                                                {model.id.split('/')[1]}
                                                                            </Typography>
                                                                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
                                                                                {model.id.split('/')[0]}
                                                                            </Typography>
                                                                            {/* Model Type Tags */}
                                                                            {typeTags.length > 0 && (
                                                                                <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
                                                                                    {typeTags.map((tag, idx) => (
                                                                                        <Chip
                                                                                            key={idx}
                                                                                            label={tag.label}
                                                                                            size="small"
                                                                                            sx={{
                                                                                                height: 18,
                                                                                                fontSize: '0.65rem',
                                                                                                bgcolor: tag.color,
                                                                                                color: tag.textColor,
                                                                                                fontWeight: 500
                                                                                            }}
                                                                                        />
                                                                                    ))}
                                                                                </Box>
                                                                            )}
                                                                            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
                                                                                {paramSize && (
                                                                                    <Chip label={paramSize} size="small" color="secondary" sx={{ height: 22 }} />
                                                                                )}
                                                                                <Tooltip title="Downloads" arrow>
                                                                                    <Chip
                                                                                        icon={<CloudDownloadIcon sx={{ fontSize: 12 }} />}
                                                                                        label={formatNumber(model.downloads)}
                                                                                        size="small"
                                                                                        variant="outlined"
                                                                                        sx={{ fontSize: '0.65rem', height: 22 }}
                                                                                    />
                                                                                </Tooltip>
                                                                                {model.likes > 0 && (
                                                                                    <Tooltip title="Likes" arrow>
                                                                                        <Chip
                                                                                            icon={<FavoriteIcon sx={{ fontSize: 12 }} />}
                                                                                            label={formatNumber(model.likes)}
                                                                                            size="small"
                                                                                            variant="outlined"
                                                                                            sx={{ fontSize: '0.65rem', height: 22 }}
                                                                                        />
                                                                                    </Tooltip>
                                                                                )}
                                                                                {model.contextLength && (
                                                                                    <Tooltip title={model.contextEstimated ? "Estimated context length" : "Context length"} arrow>
                                                                                        <Chip
                                                                                            icon={<MemoryIcon sx={{ fontSize: 12 }} />}
                                                                                            label={model.contextLength >= 1048576 ? `${(model.contextLength / 1048576).toFixed(0)}M` :
                                                                                                   model.contextLength >= 1024 ? `${Math.round(model.contextLength / 1024)}K` :
                                                                                                   model.contextLength}
                                                                                            size="small"
                                                                                            variant="outlined"
                                                                                            sx={{ fontSize: '0.65rem', height: 22, borderStyle: model.contextEstimated ? 'dashed' : 'solid' }}
                                                                                        />
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

                                {/* Selected Model Files */}
                                {selectedModelFiles.length > 0 && (
                                    <Grid item xs={12}>
                                        <Card>
                                            <CardContent>
                                                <SectionHeader
                                                    icon={<CloudDownloadIcon />}
                                                    title={`Select Quantization`}
                                                    subtitle={ggufRepo}
                                                />
                                                {/* File Type Filter */}
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, mt: 2 }}>
                                                    <FilterListIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                                                    <ToggleButtonGroup
                                                        value={fileFilter}
                                                        exclusive
                                                        onChange={(e, newFilter) => newFilter && setFileFilter(newFilter)}
                                                        size="small"
                                                    >
                                                        <ToggleButton value="all">
                                                            All ({selectedModelFiles.length})
                                                        </ToggleButton>
                                                        <ToggleButton value="single">
                                                            Single ({selectedModelFiles.filter(f => !isSplitFile(f.rfilename)).length})
                                                        </ToggleButton>
                                                        <ToggleButton value="split">
                                                            Split ({selectedModelFiles.filter(f => isSplitFile(f.rfilename)).length})
                                                        </ToggleButton>
                                                    </ToggleButtonGroup>
                                                </Box>
                                                <TableContainer sx={{ maxHeight: 350 }}>
                                                    <Table size="small" stickyHeader>
                                                        <TableHead>
                                                            <TableRow>
                                                                <TableCell>File</TableCell>
                                                                <TableCell>Quant</TableCell>
                                                                <TableCell>Type</TableCell>
                                                                <TableCell>Size</TableCell>
                                                                <TableCell align="right">Action</TableCell>
                                                            </TableRow>
                                                        </TableHead>
                                                        <TableBody>
                                                            {selectedModelFiles
                                                                .filter(file => {
                                                                    if (fileFilter === 'all') return true;
                                                                    if (fileFilter === 'single') return !isSplitFile(file.rfilename);
                                                                    if (fileFilter === 'split') return isSplitFile(file.rfilename);
                                                                    return true;
                                                                })
                                                                .map(file => {
                                                                const quant = extractQuantization(file.rfilename);
                                                                const isSelected = ggufFile === file.rfilename;
                                                                const isSplit = isSplitFile(file.rfilename);
                                                                const splitInfo = getSplitInfo(file.rfilename);
                                                                return (
                                                                    <TableRow
                                                                        key={file.rfilename}
                                                                        hover
                                                                        selected={isSelected}
                                                                        sx={{ cursor: 'pointer' }}
                                                                        onClick={() => handleSelectGGUFFile(file.rfilename)}
                                                                    >
                                                                        <TableCell>
                                                                            <Typography variant="body2" sx={{
                                                                                maxWidth: 300,
                                                                                whiteSpace: 'nowrap',
                                                                                overflow: 'hidden',
                                                                                textOverflow: 'ellipsis'
                                                                            }}>
                                                                                {file.rfilename}
                                                                            </Typography>
                                                                        </TableCell>
                                                                        <TableCell>
                                                                            {quant && <Chip label={quant} size="small" color="primary" variant="outlined" />}
                                                                        </TableCell>
                                                                        <TableCell>
                                                                            {isSplit ? (
                                                                                <Chip
                                                                                    label={`Part ${splitInfo?.part}/${splitInfo?.total}`}
                                                                                    size="small"
                                                                                    color="warning"
                                                                                    variant="outlined"
                                                                                />
                                                                            ) : (
                                                                                <Chip label="Single" size="small" color="success" variant="outlined" />
                                                                            )}
                                                                        </TableCell>
                                                                        <TableCell>{formatFileSize(file.size)}</TableCell>
                                                                        <TableCell align="right">
                                                                            {isSelected ? (
                                                                                <CheckCircleIcon sx={{ color: 'success.main', fontSize: 20 }} />
                                                                            ) : (
                                                                                <Button size="small" variant="text">Select</Button>
                                                                            )}
                                                                        </TableCell>
                                                                    </TableRow>
                                                                );
                                                            })}
                                                        </TableBody>
                                                    </Table>
                                                </TableContainer>
                                                {ggufFile && (
                                                    <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                                                        <Button
                                                            variant="contained"
                                                            startIcon={loading ? <CircularProgress size={16} /> : <CloudDownloadIcon />}
                                                            onClick={handlePullModel}
                                                            disabled={loading}
                                                            fullWidth
                                                        >
                                                            {loading ? 'Downloading...' : `Download ${ggufFile}`}
                                                        </Button>
                                                    </Box>
                                                )}
                                            </CardContent>
                                        </Card>
                                    </Grid>
                                )}

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
                                                    {activeDownloads.map(download => (
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
                                                                    variant="determinate"
                                                                    value={download.progress || 0}
                                                                    sx={{ flex: 1, height: 6, borderRadius: 3 }}
                                                                />
                                                                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'right' }}>
                                                                    {download.progress || 0}%
                                                                </Typography>
                                                            </Box>
                                                            <Box sx={{ mt: 1 }}>
                                                                <Chip
                                                                    label={download.status}
                                                                    size="small"
                                                                    color={download.status === 'downloading' ? 'primary' : download.status === 'completed' ? 'success' : 'warning'}
                                                                />
                                                            </Box>
                                                        </Box>
                                                    ))}
                                                </Box>
                                            </CardContent>
                                        </Card>
                                    </Grid>
                                )}
                            </Grid>
                        )}

                        {/* My Models Tab */}
                        {visibleTabOrder[activeTab] === 1 && (
                            <Grid container spacing={3}>
                                {/* Running Instances */}
                                {instances.length > 0 && (
                                    <Grid item xs={12}>
                                        <Card sx={{ borderColor: 'success.dark', borderWidth: 1 }}>
                                            <CardContent>
                                                <SectionHeader
                                                    icon={<MemoryIcon />}
                                                    title="Running Instances"
                                                    subtitle={`${instances.length} model${instances.length > 1 ? 's' : ''} currently loaded`}
                                                />
                                                <Grid container spacing={2} sx={{ mt: 1 }}>
                                                    {instances.map(instance => (
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
                                                                                <Tooltip title={`Backend: ${instance.backend === 'llamacpp' ? 'llama.cpp' : 'vLLM'}`}>
                                                                                    <Chip
                                                                                        label={instance.backend === 'llamacpp' ? 'llama.cpp' : 'vLLM'}
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
                                                                                {instance.backend === 'vllm' && instance.config?.cpuOffloadGb > 0 && (
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
                                                                                {instance.backend === 'vllm' ? (
                                                                                    <>
                                                                                        <Tooltip title="GPU memory utilization">
                                                                                            <Chip
                                                                                                label={`GPU: ${Math.round((instance.config?.gpuMemoryUtilization || 0.9) * 100)}%`}
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
                                                                                                label={`Seqs: ${instance.config?.maxNumSeqs || 256}`}
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
                                                        const isRunning = model.loadedIn === 'vllm' || model.loadedIn === 'llamacpp';
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

                                {/* Launch Settings Panel */}
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <SectionHeader
                                                icon={<SettingsIcon />}
                                                title="Launch Settings"
                                                subtitle="Configure model instance parameters (applied when loading models)"
                                            />

                                            {/* Backend Selection */}
                                            <Box sx={{ mb: 3, p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                                                    <Typography variant="subtitle2" sx={{ minWidth: 100 }}>
                                                        Backend:
                                                    </Typography>
                                                    <ToggleButtonGroup
                                                        value={selectedBackend}
                                                        exclusive
                                                        onChange={(e, newBackend) => newBackend && setSelectedBackend(newBackend)}
                                                        size="small"
                                                    >
                                                        <ToggleButton value="llamacpp" sx={{ px: 2 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <span>llama.cpp</span>
                                                                <Chip label="GPU 5.2+" size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
                                                            </Box>
                                                        </ToggleButton>
                                                        <ToggleButton value="vllm" sx={{ px: 2 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <span>vLLM</span>
                                                                <Chip label="GPU 6.0+" size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
                                                            </Box>
                                                        </ToggleButton>
                                                    </ToggleButtonGroup>
                                                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                                                        {selectedBackend === 'llamacpp'
                                                            ? 'Recommended for GGUF models. Works with older GPUs (Maxwell 5.2+).'
                                                            : 'Best for newer GPUs (Pascal 6.0+). May have issues with some GGUF models.'}
                                                    </Typography>
                                                </Box>
                                            </Box>

                                            {/* Optimal Settings Section - shown for both backends */}
                                            <Box sx={{ mb: 3, p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                                                    <AutoAwesomeIcon color="primary" />
                                                    <Typography variant="subtitle2" sx={{ minWidth: 120 }}>
                                                        Optimal Settings
                                                    </Typography>
                                                    <FormControl size="small" sx={{ minWidth: 200, flex: 1 }}>
                                                        <InputLabel>Select Model</InputLabel>
                                                        <Select
                                                            value={selectedModelForOptimal || ''}
                                                            onChange={(e) => setSelectedModelForOptimal(e.target.value)}
                                                            label="Select Model"
                                                        >
                                                            {models.filter(m => m.fileSize).map(model => (
                                                                <MenuItem key={model.name} value={model.name}>
                                                                    {model.name} ({(model.fileSize / 1024 / 1024 / 1024).toFixed(1)}GB)
                                                                </MenuItem>
                                                            ))}
                                                        </Select>
                                                    </FormControl>
                                                    <Tooltip title={`Calculate optimal ${selectedBackend} settings based on your hardware and the selected model size`}>
                                                        <Button
                                                            variant="contained"
                                                            size="small"
                                                            startIcon={loadingOptimalSettings ? <CircularProgress size={16} color="inherit" /> : <AutoAwesomeIcon />}
                                                            onClick={() => {
                                                                const model = models.find(m => m.name === selectedModelForOptimal);
                                                                if (model) fetchOptimalSettings(model);
                                                            }}
                                                            disabled={!selectedModelForOptimal || loadingOptimalSettings}
                                                        >
                                                            Apply Optimal
                                                        </Button>
                                                    </Tooltip>
                                                </Box>
                                                {optimalSettingsNotes.length > 0 && (
                                                    <Box sx={{ mt: 1.5 }}>
                                                        {optimalSettingsNotes.map((note, idx) => (
                                                            <Alert key={idx} severity="info" sx={{ py: 0, mb: 0.5, '& .MuiAlert-message': { fontSize: '0.75rem' } }}>
                                                                {note}
                                                            </Alert>
                                                        ))}
                                                    </Box>
                                                )}
                                            </Box>

                                            {/* vLLM Settings (shown when vLLM backend selected) */}
                                            {selectedBackend === 'vllm' && (
                                            <Grid container spacing={3}>
                                                {/* vLLM Core Settings Section */}
                                                <Grid item xs={12} md={6}>
                                                    <CollapsibleSection title="Model & Context" icon={<MemoryIcon />}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.maxModelLen} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Max Model Length</InputLabel>
                                                                        <Select
                                                                            value={modelConfig.maxModelLen}
                                                                            onChange={(e) => setModelConfig({...modelConfig, maxModelLen: e.target.value})}
                                                                            label="Max Model Length"
                                                                            endAdornment={<HelpOutlineIcon sx={{ fontSize: 16, color: 'text.secondary', mr: 2 }} />}
                                                                        >
                                                                            <MenuItem value={512}>512</MenuItem>
                                                                            <MenuItem value={1024}>1024</MenuItem>
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
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.cpuOffloadGb} arrow placement="top">
                                                                    <TextField
                                                                        fullWidth
                                                                        label="CPU Offload (GB)"
                                                                        type="number"
                                                                        size="small"
                                                                        value={modelConfig.cpuOffloadGb}
                                                                        onChange={(e) => setModelConfig({...modelConfig, cpuOffloadGb: parseFloat(e.target.value) || 0})}
                                                                        helperText="0 = all on GPU"
                                                                        InputProps={{
                                                                            endAdornment: <HelpOutlineIcon sx={{ fontSize: 16, color: 'text.secondary' }} />,
                                                                            inputProps: { min: 0, step: 1 }
                                                                        }}
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            {modelConfig.maxModelLen <= 2048 && (
                                                                <Grid item xs={12}>
                                                                    <Alert severity="warning" sx={{ py: 0.5, '& .MuiAlert-message': { fontSize: '0.75rem' } }}>
                                                                        Small context ({modelConfig.maxModelLen}). If your prompt exceeds this, the request will fail. Consider 4096+ for most use cases.
                                                                    </Alert>
                                                                </Grid>
                                                            )}
                                                            {modelConfig.cpuOffloadGb > 0 && (
                                                                <Grid item xs={12}>
                                                                    <Alert severity="info" sx={{ py: 0.5, '& .MuiAlert-message': { fontSize: '0.75rem' } }}>
                                                                        CPU offloading enabled ({modelConfig.cpuOffloadGb}GB). Note: GGUF + CPU offload may have issues (vLLM GitHub #8757).
                                                                    </Alert>
                                                                </Grid>
                                                            )}
                                                        </Grid>
                                                    </CollapsibleSection>

                                                    <CollapsibleSection title="GPU Memory" icon={<TuneIcon />} defaultExpanded={false}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.gpuMemoryUtilization} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>GPU Memory %</InputLabel>
                                                                        <Select
                                                                            value={modelConfig.gpuMemoryUtilization}
                                                                            onChange={(e) => setModelConfig({...modelConfig, gpuMemoryUtilization: e.target.value})}
                                                                            label="GPU Memory %"
                                                                        >
                                                                            <MenuItem value={0.5}>50%</MenuItem>
                                                                            <MenuItem value={0.6}>60%</MenuItem>
                                                                            <MenuItem value={0.7}>70%</MenuItem>
                                                                            <MenuItem value={0.8}>80%</MenuItem>
                                                                            <MenuItem value={0.85}>85%</MenuItem>
                                                                            <MenuItem value={0.9}>90%</MenuItem>
                                                                            <MenuItem value={0.95}>95%</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.kvCacheDtype} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>KV Cache Dtype</InputLabel>
                                                                        <Select
                                                                            value={modelConfig.kvCacheDtype}
                                                                            onChange={(e) => setModelConfig({...modelConfig, kvCacheDtype: e.target.value})}
                                                                            label="KV Cache Dtype"
                                                                        >
                                                                            <MenuItem value="auto">auto</MenuItem>
                                                                            <MenuItem value="fp8">fp8</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>
                                                </Grid>

                                                {/* Performance Section */}
                                                <Grid item xs={12} md={6}>
                                                    <CollapsibleSection title="Performance" icon={<SettingsIcon />} defaultExpanded={false}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.tensorParallelSize} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Tensor Parallel</InputLabel>
                                                                        <Select
                                                                            value={modelConfig.tensorParallelSize}
                                                                            onChange={(e) => setModelConfig({...modelConfig, tensorParallelSize: e.target.value})}
                                                                            label="Tensor Parallel"
                                                                        >
                                                                            <MenuItem value={1}>1 GPU</MenuItem>
                                                                            <MenuItem value={2}>2 GPUs</MenuItem>
                                                                            <MenuItem value={4}>4 GPUs</MenuItem>
                                                                            <MenuItem value={8}>8 GPUs</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.maxNumSeqs} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Max Sequences</InputLabel>
                                                                        <Select
                                                                            value={modelConfig.maxNumSeqs}
                                                                            onChange={(e) => setModelConfig({...modelConfig, maxNumSeqs: e.target.value})}
                                                                            label="Max Sequences"
                                                                        >
                                                                            <MenuItem value={32}>32</MenuItem>
                                                                            <MenuItem value={64}>64</MenuItem>
                                                                            <MenuItem value={128}>128</MenuItem>
                                                                            <MenuItem value={256}>256</MenuItem>
                                                                            <MenuItem value={512}>512</MenuItem>
                                                                            <MenuItem value={1024}>1024</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>

                                                    <CollapsibleSection title="Advanced" icon={<TuneIcon />} defaultExpanded={false}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={12}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.trustRemoteCode} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={modelConfig.trustRemoteCode}
                                                                                onChange={(e) => setModelConfig({...modelConfig, trustRemoteCode: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Trust Remote Code</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.enforceEager} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={modelConfig.enforceEager}
                                                                                onChange={(e) => setModelConfig({...modelConfig, enforceEager: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Enforce Eager Mode</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.contextShift} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={modelConfig.contextShift}
                                                                                onChange={(e) => setModelConfig({...modelConfig, contextShift: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Context Shift</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={SETTINGS_TOOLTIPS.disableThinking} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={modelConfig.disableThinking}
                                                                                onChange={(e) => setModelConfig({...modelConfig, disableThinking: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Disable Thinking</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>
                                                </Grid>
                                            </Grid>
                                            )}

                                            {/* llama.cpp Settings (shown when llamacpp backend selected) */}
                                            {selectedBackend === 'llamacpp' && (
                                            <Grid container spacing={3}>
                                                {/* GPU & Context Section */}
                                                <Grid item xs={12} md={6}>
                                                    <CollapsibleSection title="GPU & Context" icon={<MemoryIcon />}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.nGpuLayers} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>GPU Layers</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.nGpuLayers}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, nGpuLayers: e.target.value})}
                                                                            label="GPU Layers"
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
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.contextSize} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Context Size</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.contextSize}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, contextSize: e.target.value})}
                                                                            label="Context Size"
                                                                        >
                                                                            <MenuItem value={512}>512</MenuItem>
                                                                            <MenuItem value={1024}>1024</MenuItem>
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
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.flashAttention} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={llamacppConfig.flashAttention}
                                                                                onChange={(e) => setLlamacppConfig({...llamacppConfig, flashAttention: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Flash Attention</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.contextShift} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={llamacppConfig.contextShift}
                                                                                onChange={(e) => setLlamacppConfig({...llamacppConfig, contextShift: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Context Shift</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.disableThinking} arrow placement="top">
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={llamacppConfig.disableThinking}
                                                                                onChange={(e) => setLlamacppConfig({...llamacppConfig, disableThinking: e.target.checked})}
                                                                                size="small"
                                                                            />
                                                                        }
                                                                        label={
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="body2">Disable Thinking</Typography>
                                                                                <HelpOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                                                                            </Box>
                                                                        }
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>

                                                    <CollapsibleSection title="KV Cache" icon={<TuneIcon />} defaultExpanded={false}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.cacheTypeK} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Cache Type K</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.cacheTypeK}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, cacheTypeK: e.target.value})}
                                                                            label="Cache Type K"
                                                                        >
                                                                            <MenuItem value="f16">f16 (default)</MenuItem>
                                                                            <MenuItem value="q8_0">q8_0 (saves memory)</MenuItem>
                                                                            <MenuItem value="q4_0">q4_0 (max savings)</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.cacheTypeV} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Cache Type V</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.cacheTypeV}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, cacheTypeV: e.target.value})}
                                                                            label="Cache Type V"
                                                                        >
                                                                            <MenuItem value="f16">f16 (default)</MenuItem>
                                                                            <MenuItem value="q8_0">q8_0 (saves memory)</MenuItem>
                                                                            <MenuItem value="q4_0">q4_0 (max savings)</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>
                                                </Grid>

                                                {/* Performance Section */}
                                                <Grid item xs={12} md={6}>
                                                    <CollapsibleSection title="Performance" icon={<SettingsIcon />} defaultExpanded={false}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.threads} arrow placement="top">
                                                                    <TextField
                                                                        fullWidth
                                                                        label="Threads"
                                                                        type="number"
                                                                        size="small"
                                                                        value={llamacppConfig.threads}
                                                                        onChange={(e) => setLlamacppConfig({...llamacppConfig, threads: parseInt(e.target.value) || 0})}
                                                                        helperText="0 = auto"
                                                                        InputProps={{ inputProps: { min: 0 } }}
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.parallelSlots} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Parallel Slots</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.parallelSlots}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, parallelSlots: e.target.value})}
                                                                            label="Parallel Slots"
                                                                        >
                                                                            <MenuItem value={1}>1</MenuItem>
                                                                            <MenuItem value={2}>2</MenuItem>
                                                                            <MenuItem value={4}>4</MenuItem>
                                                                            <MenuItem value={8}>8</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.batchSize} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Batch Size</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.batchSize}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, batchSize: e.target.value})}
                                                                            label="Batch Size"
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
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.ubatchSize} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Micro-batch</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.ubatchSize}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, ubatchSize: e.target.value})}
                                                                            label="Micro-batch"
                                                                        >
                                                                            <MenuItem value={128}>128</MenuItem>
                                                                            <MenuItem value={256}>256</MenuItem>
                                                                            <MenuItem value={512}>512</MenuItem>
                                                                            <MenuItem value={1024}>1024</MenuItem>
                                                                            <MenuItem value={2048}>2048</MenuItem>
                                                                            <MenuItem value={4096}>4096</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>

                                                    <CollapsibleSection title="Repetition Control" icon={<TuneIcon />} defaultExpanded={false}>
                                                        <Grid container spacing={2}>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.repeatPenalty} arrow placement="top">
                                                                    <TextField
                                                                        fullWidth
                                                                        label="Repeat Penalty"
                                                                        type="number"
                                                                        size="small"
                                                                        value={llamacppConfig.repeatPenalty}
                                                                        onChange={(e) => setLlamacppConfig({...llamacppConfig, repeatPenalty: parseFloat(e.target.value) || 1.0})}
                                                                        InputProps={{ inputProps: { min: 1.0, max: 2.0, step: 0.05 } }}
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.repeatLastN} arrow placement="top">
                                                                    <FormControl fullWidth size="small">
                                                                        <InputLabel>Repeat Last N</InputLabel>
                                                                        <Select
                                                                            value={llamacppConfig.repeatLastN}
                                                                            onChange={(e) => setLlamacppConfig({...llamacppConfig, repeatLastN: e.target.value})}
                                                                            label="Repeat Last N"
                                                                        >
                                                                            <MenuItem value={32}>32</MenuItem>
                                                                            <MenuItem value={64}>64</MenuItem>
                                                                            <MenuItem value={128}>128</MenuItem>
                                                                            <MenuItem value={256}>256</MenuItem>
                                                                            <MenuItem value={512}>512</MenuItem>
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.presencePenalty} arrow placement="top">
                                                                    <TextField
                                                                        fullWidth
                                                                        label="Presence Penalty"
                                                                        type="number"
                                                                        size="small"
                                                                        value={llamacppConfig.presencePenalty}
                                                                        onChange={(e) => setLlamacppConfig({...llamacppConfig, presencePenalty: parseFloat(e.target.value) || 0})}
                                                                        InputProps={{ inputProps: { min: 0, max: 1.0, step: 0.1 } }}
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={6}>
                                                                <Tooltip title={LLAMACPP_TOOLTIPS.frequencyPenalty} arrow placement="top">
                                                                    <TextField
                                                                        fullWidth
                                                                        label="Frequency Penalty"
                                                                        type="number"
                                                                        size="small"
                                                                        value={llamacppConfig.frequencyPenalty}
                                                                        onChange={(e) => setLlamacppConfig({...llamacppConfig, frequencyPenalty: parseFloat(e.target.value) || 0})}
                                                                        InputProps={{ inputProps: { min: 0, max: 1.0, step: 0.1 } }}
                                                                    />
                                                                </Tooltip>
                                                            </Grid>
                                                        </Grid>
                                                    </CollapsibleSection>
                                                </Grid>
                                            </Grid>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Grid>
                            </Grid>
                        )}

                        {/* Users Tab */}
                        {visibleTabOrder[activeTab] === 2 && (
                            <Grid container spacing={3}>
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                                                <SectionHeader
                                                    icon={<PeopleIcon />}
                                                    title="User Management"
                                                    subtitle="Manage user accounts and permissions"
                                                />
                                                {user?.role === 'admin' && (
                                                    <Button
                                                        variant="outlined"
                                                        startIcon={<EmailIcon />}
                                                        onClick={() => {
                                                            setUserDialogMode('invite');
                                                            setNewUserData({ username: '', email: '', password: '', role: 'user' });
                                                            setUserDialogOpen(true);
                                                        }}
                                                    >
                                                        Invite User
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

                        {/* User Dialog */}
                        <Dialog open={userDialogOpen} onClose={handleCloseUserDialog} maxWidth="sm" fullWidth>
                            <DialogTitle>
                                {userDialogMode === 'create' ? 'Create New User' :
                                 userDialogMode === 'edit' ? `Edit User: ${selectedUser?.username}` :
                                 userDialogMode === 'invite' ? 'Invite User by Email' :
                                 `Reset Password: ${selectedUser?.username}`}
                            </DialogTitle>
                            <DialogContent>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                                    {userDialogMode === 'create' && (
                                        <TextField
                                            label="Username"
                                            value={newUserData.username}
                                            onChange={(e) => setNewUserData({ ...newUserData, username: e.target.value })}
                                            fullWidth
                                        />
                                    )}
                                    {(userDialogMode === 'create' || userDialogMode === 'edit') && (
                                        <>
                                            <TextField
                                                label="Email"
                                                type="email"
                                                value={newUserData.email}
                                                onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })}
                                                fullWidth
                                            />
                                            <FormControl fullWidth>
                                                <InputLabel>Role</InputLabel>
                                                <Select
                                                    value={newUserData.role}
                                                    label="Role"
                                                    onChange={(e) => setNewUserData({ ...newUserData, role: e.target.value })}
                                                >
                                                    <MenuItem value="user">User</MenuItem>
                                                    <MenuItem value="admin">Admin</MenuItem>
                                                </Select>
                                            </FormControl>
                                        </>
                                    )}
                                    {userDialogMode === 'invite' && (
                                        <>
                                            <TextField
                                                autoFocus
                                                label="Email Address"
                                                type="email"
                                                value={newUserData.email}
                                                onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })}
                                                fullWidth
                                                required
                                                helperText="User will receive an email to complete registration"
                                            />
                                            <FormControl fullWidth>
                                                <InputLabel>Role</InputLabel>
                                                <Select
                                                    value={newUserData.role}
                                                    label="Role"
                                                    onChange={(e) => setNewUserData({ ...newUserData, role: e.target.value })}
                                                >
                                                    <MenuItem value="user">User</MenuItem>
                                                    <MenuItem value="admin">Admin</MenuItem>
                                                </Select>
                                            </FormControl>
                                        </>
                                    )}
                                    {(userDialogMode === 'create' || userDialogMode === 'resetPassword') && (
                                        <TextField
                                            label={userDialogMode === 'create' ? 'Password' : 'New Password'}
                                            type="password"
                                            value={newUserData.password}
                                            onChange={(e) => setNewUserData({ ...newUserData, password: e.target.value })}
                                            fullWidth
                                            helperText="Minimum 8 characters"
                                        />
                                    )}
                                </Box>
                            </DialogContent>
                            <DialogActions>
                                <Button onClick={handleCloseUserDialog}>Cancel</Button>
                                <Button
                                    variant="contained"
                                    onClick={
                                        userDialogMode === 'create' ? handleCreateUser :
                                        userDialogMode === 'edit' ? handleUpdateUser :
                                        userDialogMode === 'invite' ? handleInviteUser :
                                        handleResetPassword
                                    }
                                    disabled={
                                        userDialogMode === 'create' ? (!newUserData.username || !newUserData.email || !newUserData.password || newUserData.password.length < 8) :
                                        userDialogMode === 'edit' ? !newUserData.email :
                                        userDialogMode === 'invite' ? !newUserData.email :
                                        !newUserData.password || newUserData.password.length < 8
                                    }
                                >
                                    {userDialogMode === 'create' ? 'Create' :
                                     userDialogMode === 'edit' ? 'Save' :
                                     userDialogMode === 'invite' ? 'Send Invite' :
                                     'Reset Password'}
                                </Button>
                            </DialogActions>
                        </Dialog>

                        {/* API Keys Tab (Admin Only) */}
                        {visibleTabOrder[activeTab] === 3 && isAdmin && (
                            <Grid container spacing={3}>
                                <Grid item xs={12}>
                                    <Card>
                                        <CardContent>
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                                                <SectionHeader
                                                    icon={<VpnKeyIcon />}
                                                    title="API Key Management"
                                                    subtitle="Create and manage API keys for programmatic access"
                                                />
                                                <Button
                                                    variant="contained"
                                                    startIcon={<AddIcon />}
                                                    onClick={() => setShowCreateKeyDialog(!showCreateKeyDialog)}
                                                >
                                                    Create API Key
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
                                                                    <MenuItem value="skills">Manage Skills</MenuItem>
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
                                                <Card variant="outlined" sx={{ mb: 3, p: 2, bgcolor: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
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
                                                                    <MenuItem value="skills">Manage Skills</MenuItem>
                                                                    <MenuItem value="models">Manage Models</MenuItem>
                                                                    <MenuItem value="instances">Manage Instances</MenuItem>
                                                                    <MenuItem value="admin">Admin Access</MenuItem>
                                                                </Select>
                                                            </FormControl>
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
                                                                                <Box sx={{ width: '100%', bgcolor: 'rgba(255,255,255,0.05)', borderRadius: 1, height: 4, overflow: 'hidden' }}>
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
                            <Box>
                                <SectionHeader
                                    icon={<MenuBookIcon />}
                                    title="Documentation & API Reference"
                                    subtitle="Complete guide to getting started, API usage, and configuration"
                                />

                                
                                {/* Quick Start Guide */}
                                <Accordion sx={{ ...docAccordionSx, mt: 2 }} defaultExpanded>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<PlayArrowIcon />} color="success" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Quick Start</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Get up and running in 3 steps</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        {/* Condensed 3-step flow */}
                                        <Grid container spacing={2}>
                                            <Grid item xs={12} md={4}>
                                                <Box sx={{ p: 2, bgcolor: 'rgba(99, 102, 241, 0.08)', borderRadius: 2, height: '100%', border: '1px solid rgba(99, 102, 241, 0.15)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                                                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'primary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 }}>1</Box>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Load Model</Typography>
                                                    </Box>
                                                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'text.secondary', lineHeight: 1.5 }}>
                                                        <strong style={{ color: '#fafafa' }}>Discover</strong> → Download → <strong style={{ color: '#fafafa' }}>My Models</strong> → Load
                                                    </Typography>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={4}>
                                                <Box sx={{ p: 2, bgcolor: 'rgba(99, 102, 241, 0.08)', borderRadius: 2, height: '100%', border: '1px solid rgba(99, 102, 241, 0.15)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                                                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'secondary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, color: '#ffffff' }}>2</Box>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Choose Interface</Typography>
                                                    </Box>
                                                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'text.secondary', lineHeight: 1.5 }}>
                                                        <strong style={{ color: '#fafafa' }}>AI Chat</strong> for web • <strong style={{ color: '#fafafa' }}>Koda CLI</strong> for terminal • <strong style={{ color: '#fafafa' }}>API</strong> for code
                                                    </Typography>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={4}>
                                                <Box sx={{ p: 2, bgcolor: 'rgba(34, 197, 94, 0.08)', borderRadius: 2, height: '100%', border: '1px solid rgba(34, 197, 94, 0.15)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                                                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: 'success.main', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, color: '#09090b' }}>3</Box>
                                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Create API Key</Typography>
                                                    </Box>
                                                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'text.secondary', lineHeight: 1.5 }}>
                                                        <strong style={{ color: '#fafafa' }}>API Keys</strong> tab → Create → Copy credentials
                                                    </Typography>
                                                </Box>
                                            </Grid>
                                        </Grid>

                                        {/* Interface quick reference */}
                                        <Box sx={{ mt: 2.5, p: 2, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>
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
                                                            <TableCell sx={{ fontWeight: 600, color: 'primary.main' }}>AI Chat</TableCell>
                                                            <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>https://localhost:3002</TableCell>
                                                            <TableCell sx={{ color: 'text.secondary' }}>Web chat interface with streaming</TableCell>
                                                        </TableRow>
                                                        <TableRow>
                                                            <TableCell sx={{ fontWeight: 600, color: 'secondary.main' }}>Koda CLI</TableCell>
                                                            <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>curl -sk {baseUrl}/api/cli/install | bash</TableCell>
                                                            <TableCell sx={{ color: 'text.secondary' }}>Terminal, automation</TableCell>
                                                        </TableRow>
                                                        <TableRow>
                                                            <TableCell sx={{ fontWeight: 600, color: 'success.main' }}>Direct API</TableCell>
                                                            <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{baseUrl}/api/chat</TableCell>
                                                            <TableCell sx={{ color: 'text.secondary' }}>Integrations</TableCell>
                                                        </TableRow>
                                                    </TableBody>
                                                </Table>
                                            </TableContainer>
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* API Builder */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<CodeIcon />} color="secondary" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>API Code Builder</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Generate code snippets for any endpoint</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Box sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>
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
                                                            <MenuItem value="/api/models/:name/load">POST /api/models/:name/load - Load Model</MenuItem>
                                                            <MenuItem value="/api/models/:name">DELETE /api/models/:name - Delete Model</MenuItem>
                                                            <MenuItem value="/api/model-configs/:modelName">GET /api/model-configs/:name - Get Model Config</MenuItem>
                                                            <MenuItem value="/api/model-configs/:modelName/update">PUT /api/model-configs/:name - Update Model Config</MenuItem>
                                                            <MenuItem value="/api/huggingface/search">GET /api/huggingface/search - Search HuggingFace</MenuItem>
                                                            <MenuItem value="/api/huggingface/files/:owner/:repo">GET /api/huggingface/files/:owner/:repo - List HuggingFace Files</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Downloads ───</MenuItem>
                                                            <MenuItem value="/api/downloads">GET /api/downloads - List Active Downloads</MenuItem>
                                                            <MenuItem value="/api/downloads/:downloadId">DELETE /api/downloads/:id - Cancel Download</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Instances ───</MenuItem>
                                                            <MenuItem value="/api/vllm/instances">GET /api/vllm/instances - List vLLM Instances</MenuItem>
                                                            <MenuItem value="/api/vllm/instances/:name">DELETE /api/vllm/instances/:name - Stop vLLM Instance</MenuItem>
                                                            <MenuItem value="/api/vllm/instances/:name/slots">GET /api/vllm/instances/:name/slots - Get KV Cache Slots</MenuItem>
                                                            <MenuItem value="/api/vllm/instances/:name/slots/clear">POST /api/vllm/instances/:name/slots/clear - Clear KV Cache</MenuItem>
                                                            <MenuItem value="/api/llamacpp/instances">GET /api/llamacpp/instances - List llama.cpp Instances</MenuItem>
                                                            <MenuItem value="/api/llamacpp/instances/:name">DELETE /api/llamacpp/instances/:name - Stop llama.cpp Instance</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── System Prompts ───</MenuItem>
                                                            <MenuItem value="/api/system-prompts">GET /api/system-prompts - List System Prompts</MenuItem>
                                                            <MenuItem value="/api/system-prompts/:modelName">GET /api/system-prompts/:name - Get System Prompt</MenuItem>
                                                            <MenuItem value="/api/system-prompts/:modelName/update">PUT /api/system-prompts/:name - Update System Prompt</MenuItem>
                                                            <MenuItem value="/api/system-prompts/:modelName/delete">DELETE /api/system-prompts/:name - Delete System Prompt</MenuItem>
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Backend & System ───</MenuItem>
                                                            <MenuItem value="/api/backend/active">GET/POST /api/backend/active - Get/Set Backend</MenuItem>
                                                            <MenuItem value="/api/system/resources">GET /api/system/resources - System Hardware Info</MenuItem>
                                                            <MenuItem value="/api/system/optimal-settings">POST /api/system/optimal-settings - Calculate Settings</MenuItem>
                                                            <MenuItem value="/api/system/reset">POST /api/system/reset - System Reset (Admin)</MenuItem>
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
                                                            <MenuItem value="/api/skills/:skillName/execute">POST /api/skills/:name/execute - Execute Skill</MenuItem>
                                                            <MenuItem value="/api/agents/skills/available">GET /api/agents/skills/available - Available Skills</MenuItem>
                                                            <MenuItem value="/api/agents/skills/discover">GET /api/agents/skills/discover - Discover Skills</MenuItem>
                                                            <MenuItem value="/api/agents/skills/recommend">POST /api/agents/skills/recommend - Recommend Skills</MenuItem>
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
                                                            <MenuItem disabled sx={{ fontWeight: 600, opacity: 1 }}>─── Documentation ───</MenuItem>
                                                            <MenuItem value="/api/docs">GET /api/docs - Get API Documentation</MenuItem>
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
                                            <Box sx={{ mt: 2, bgcolor: '#09090b', p: 2, borderRadius: 1, position: 'relative' }}>
                                                <IconButton
                                                    size="small"
                                                    sx={{ position: 'absolute', top: 8, right: 8 }}
                                                    onClick={() => copyToClipboard(getApiBuilderCode())}
                                                >
                                                    <ContentCopyIcon sx={{ fontSize: 16 }} />
                                                </IconButton>
                                                <pre style={{ margin: 0, color: '#22c55e', fontSize: '0.75rem', overflow: 'auto', paddingRight: 40 }}>
                                                    {getApiBuilderCode()}
                                                </pre>
                                            </Box>
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* Koda CLI Commands */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<TerminalIcon />} color="primary" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Koda CLI</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Terminal commands and installation</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        {/* Installation - condensed */}
                                        <Box sx={{ mb: 2, p: 2, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                <CloudDownloadIcon sx={{ fontSize: 14, color: 'secondary.main' }} />
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.8rem', color: 'secondary.main' }}>Install</Typography>
                                            </Box>
                                            <Box sx={{ bgcolor: 'rgba(0,0,0,0.4)', p: 1.5, borderRadius: 1, fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                    <Chip label="Linux/macOS" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.2)' }} />
                                                    <span>curl -sk {baseUrl}/api/cli/install | bash</span>
                                                </Box>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                                                    <Chip label="Windows" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.2)' }} />
                                                    <span>iwr -useb {baseUrl}/api/cli/install.ps1 | iex</span>
                                                </Box>
                                            </Box>
                                        </Box>

                                        {/* Commands - compact two-column layout */}
                                        <Grid container spacing={2}>
                                            <Grid item xs={12} md={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Core Commands</Typography>
                                                    <Table size="small" sx={compactTableSx}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/auth</TableCell><TableCell sx={{ color: 'text.secondary' }}>Authenticate</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/init</TableCell><TableCell sx={{ color: 'text.secondary' }}>Create koda.md</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/project</TableCell><TableCell sx={{ color: 'text.secondary' }}>New project</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/clear</TableCell><TableCell sx={{ color: 'text.secondary' }}>Clear history</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/help</TableCell><TableCell sx={{ color: 'text.secondary' }}>Show commands</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/quit</TableCell><TableCell sx={{ color: 'text.secondary' }}>Exit CLI</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Modes & Search</Typography>
                                                    <Table size="small" sx={compactTableSx}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/mode standalone</TableCell><TableCell sx={{ color: 'text.secondary' }}>Direct chat (default)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/mode agent</TableCell><TableCell sx={{ color: 'text.secondary' }}>Task-aware mode</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/mode agent collab</TableCell><TableCell sx={{ color: 'text.secondary' }}>Multi-agent</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/web</TableCell><TableCell sx={{ color: 'text.secondary' }}>Toggle web search</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/websearch, /ws</TableCell><TableCell sx={{ color: 'text.secondary' }}>Aliases for /web</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>
                                        </Grid>

                                        {/* Features - compact chips */}
                                        <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                                            <Chip label="Tab completion" size="small" sx={{ bgcolor: 'rgba(99,102,241,0.15)', fontSize: '0.7rem' }} />
                                            <Chip label="Autonomous skills" size="small" sx={{ bgcolor: 'rgba(99,102,241,0.15)', fontSize: '0.7rem' }} />
                                            <Chip label="Animated UI" size="small" sx={{ bgcolor: 'rgba(34,197,94,0.15)', fontSize: '0.7rem' }} />
                                            <Chip label="Context tracking" size="small" sx={{ bgcolor: 'rgba(251,191,36,0.15)', fontSize: '0.7rem' }} />
                                            <Chip label="Multi-line paste" size="small" sx={{ bgcolor: 'rgba(99,102,241,0.15)', fontSize: '0.7rem' }} />
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* Chat Web Search & URL Fetch */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<SearchIcon />} color="secondary" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Chat Web Search & URL Fetch</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Web search, URL fetching, and content extraction</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, p: 1.5, bgcolor: 'rgba(34, 197, 94, 0.1)', borderRadius: 2, border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                                            <CheckCircleIcon sx={{ fontSize: 18, color: 'success.main' }} />
                                            <Typography sx={{ fontSize: '0.85rem' }}>Powered by DuckDuckGo, Scrapling (StealthyFetcher), Playwright, and Brave Search</Typography>
                                        </Box>

                                        <Grid container spacing={2}>
                                            <Grid item xs={12} md={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2, height: '100%' }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>How to Use</Typography>
                                                    <Box sx={{ fontSize: '0.8rem' }}>
                                                        <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.8rem' }}><strong>1.</strong> Open the Chat interface (port 3002)</Typography>
                                                        <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.8rem' }}><strong>2.</strong> Click the <strong>globe icon</strong> to enable web search</Typography>
                                                        <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.8rem' }}><strong>3.</strong> Click the <strong>link icon</strong> to enable URL fetching</Typography>
                                                        <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.8rem' }}><strong>4.</strong> Ask questions — results are auto-injected into context</Typography>
                                                        <Typography variant="body2" sx={{ fontSize: '0.8rem' }}><strong>5.</strong> Pasted URLs are automatically fetched when URL Fetch is on</Typography>
                                                    </Box>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2, height: '100%' }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Search Engine Stack</Typography>
                                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                                        <Chip label="DuckDuckGo (primary)" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="Scrapling fallback" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                        <Chip label="Brave Search fallback" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.15)' }} />
                                                        <Chip label="Smart query extraction" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="Time-range filtering" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                    </Box>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2, height: '100%' }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Content Fetching Stack</Typography>
                                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                                        <Chip label="Scrapling StealthyFetcher (primary)" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                        <Chip label="Playwright fallback" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="Axios fallback" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.15)' }} />
                                                        <Chip label="CAPTCHA evasion" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                        <Chip label="XHR/SPA interception" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="Smart content extraction" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.15)' }} />
                                                    </Box>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12} md={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2, height: '100%' }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>URL Fetch Feature</Typography>
                                                    <Box sx={{ fontSize: '0.8rem' }}>
                                                        <Typography variant="body2" sx={{ mb: 0.5, fontSize: '0.78rem' }}><code style={{ fontSize: '0.72rem', padding: '1px 4px', borderRadius: 3, backgroundColor: 'rgba(99,102,241,0.12)' }}>POST /api/url/fetch</code></Typography>
                                                        <Typography variant="body2" sx={{ mb: 0.3, fontSize: '0.78rem' }}>Up to 3 URLs per request, 12k chars/URL</Typography>
                                                        <Typography variant="body2" sx={{ mb: 0.3, fontSize: '0.78rem' }}>Smart truncation: 30% beginning + 70% end</Typography>
                                                        <Typography variant="body2" sx={{ fontSize: '0.78rem' }}>Toggle via link icon in chat toolbar</Typography>
                                                    </Box>
                                                </Box>
                                            </Grid>
                                            <Grid item xs={12}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>
                                                    <Typography sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', mb: 1, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Features</Typography>
                                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                                        <Chip label="5 results with full content" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="24k char content budget" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="Smart query extraction" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                        <Chip label="Content condensation" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                        <Chip label="Source citations" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.15)' }} />
                                                        <Chip label="Article body extraction" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(99,102,241,0.15)' }} />
                                                        <Chip label="Shadow DOM traversal" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(34,197,94,0.15)' }} />
                                                        <Chip label="Smart truncation (30/70 split)" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.15)' }} />
                                                    </Box>
                                                </Box>
                                            </Grid>
                                        </Grid>
                                    </AccordionDetails>
                                </Accordion>

                                {/* Configuration Flags */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<TuneIcon />} color="warning" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Configuration Flags</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>llama.cpp and vLLM backend settings</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Grid container spacing={2}>
                                            {/* llama.cpp Settings */}
                                            <Grid item xs={12} lg={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(99, 102, 241, 0.05)', borderRadius: 2, border: '1px solid rgba(99, 102, 241, 0.1)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                        <Chip label="llama.cpp" size="small" sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'rgba(255, 255, 255, 0.15)', color: '#ffffff', fontWeight: 600 }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>Maxwell 5.2+</Typography>
                                                    </Box>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.7rem' } }}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main', width: 110 }}>nGpuLayers</TableCell><TableCell sx={{ color: 'text.secondary' }}>-1</TableCell><TableCell sx={{ color: 'text.secondary' }}>GPU layers (-1=all)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>contextSize</TableCell><TableCell sx={{ color: 'text.secondary' }}>4096</TableCell><TableCell sx={{ color: 'text.secondary' }}>Context window size</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>flashAttention</TableCell><TableCell sx={{ color: 'text.secondary' }}>false</TableCell><TableCell sx={{ color: 'text.secondary' }}>Flash attention (faster)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>cacheTypeK/V</TableCell><TableCell sx={{ color: 'text.secondary' }}>f16</TableCell><TableCell sx={{ color: 'text.secondary' }}>KV cache (f16/q8_0/q4_0)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>threads</TableCell><TableCell sx={{ color: 'text.secondary' }}>0</TableCell><TableCell sx={{ color: 'text.secondary' }}>CPU threads (0=auto)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>parallelSlots</TableCell><TableCell sx={{ color: 'text.secondary' }}>1</TableCell><TableCell sx={{ color: 'text.secondary' }}>Concurrent requests</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>batchSize</TableCell><TableCell sx={{ color: 'text.secondary' }}>512</TableCell><TableCell sx={{ color: 'text.secondary' }}>Prompt batch size</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>repeatPenalty</TableCell><TableCell sx={{ color: 'text.secondary' }}>1.0</TableCell><TableCell sx={{ color: 'text.secondary' }}>Repetition penalty</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>disableThinking</TableCell><TableCell sx={{ color: 'text.secondary' }}>false</TableCell><TableCell sx={{ color: 'text.secondary' }}>Skip reasoning mode</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>

                                            {/* vLLM Settings */}
                                            <Grid item xs={12} lg={6}>
                                                <Box sx={{ p: 1.5, bgcolor: 'rgba(99, 102, 241, 0.05)', borderRadius: 2, border: '1px solid rgba(99, 102, 241, 0.1)' }}>
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                        <Chip label="vLLM" size="small" sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'rgba(255, 255, 255, 0.15)', color: '#ffffff', fontWeight: 600 }} />
                                                        <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>Pascal 6.0+</Typography>
                                                    </Box>
                                                    <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.5, px: 1, fontSize: '0.7rem' } }}>
                                                        <TableBody>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main', width: 130 }}>maxModelLen</TableCell><TableCell sx={{ color: 'text.secondary' }}>4096</TableCell><TableCell sx={{ color: 'text.secondary' }}>Max context length</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>cpuOffloadGb</TableCell><TableCell sx={{ color: 'text.secondary' }}>0</TableCell><TableCell sx={{ color: 'text.secondary' }}>CPU offload (GB)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>gpuMemoryUtil</TableCell><TableCell sx={{ color: 'text.secondary' }}>0.9</TableCell><TableCell sx={{ color: 'text.secondary' }}>GPU memory fraction</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>tensorParallelSize</TableCell><TableCell sx={{ color: 'text.secondary' }}>1</TableCell><TableCell sx={{ color: 'text.secondary' }}>Multi-GPU parallelism</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>maxNumSeqs</TableCell><TableCell sx={{ color: 'text.secondary' }}>256</TableCell><TableCell sx={{ color: 'text.secondary' }}>Max concurrent seqs</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>kvCacheDtype</TableCell><TableCell sx={{ color: 'text.secondary' }}>auto</TableCell><TableCell sx={{ color: 'text.secondary' }}>Cache dtype (auto/fp8)</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>trustRemoteCode</TableCell><TableCell sx={{ color: 'text.secondary' }}>true</TableCell><TableCell sx={{ color: 'text.secondary' }}>Trust HF code</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>enforceEager</TableCell><TableCell sx={{ color: 'text.secondary' }}>false</TableCell><TableCell sx={{ color: 'text.secondary' }}>Disable CUDA graphs</TableCell></TableRow>
                                                            <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>disableThinking</TableCell><TableCell sx={{ color: 'text.secondary' }}>false</TableCell><TableCell sx={{ color: 'text.secondary' }}>Skip reasoning mode</TableCell></TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </Box>
                                            </Grid>
                                        </Grid>
                                    </AccordionDetails>
                                </Accordion>

                                {/* API Key Permissions */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<VpnKeyIcon />} color="primary" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>API Permissions</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Permission scopes for API keys</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                                            <Box sx={{ flex: '1 1 180px', p: 1.5, bgcolor: 'rgba(99, 102, 241, 0.08)', borderRadius: 2, border: '1px solid rgba(99, 102, 241, 0.15)' }}>
                                                <Chip label="query" size="small" sx={{ mb: 1, bgcolor: 'primary.main', color: '#09090b', fontWeight: 600, fontSize: '0.7rem' }} />
                                                <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>Chat, completions, web search, Playwright</Typography>
                                            </Box>
                                            <Box sx={{ flex: '1 1 180px', p: 1.5, bgcolor: 'rgba(99, 102, 241, 0.08)', borderRadius: 2, border: '1px solid rgba(99, 102, 241, 0.15)' }}>
                                                <Chip label="models" size="small" sx={{ mb: 1, bgcolor: 'secondary.main', color: '#ffffff', fontWeight: 600, fontSize: '0.7rem' }} />
                                                <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>List, download, load/unload, configs</Typography>
                                            </Box>
                                            <Box sx={{ flex: '1 1 180px', p: 1.5, bgcolor: 'rgba(34, 197, 94, 0.08)', borderRadius: 2, border: '1px solid rgba(34, 197, 94, 0.15)' }}>
                                                <Chip label="instances" size="small" sx={{ mb: 1, bgcolor: 'success.main', color: '#09090b', fontWeight: 600, fontSize: '0.7rem' }} />
                                                <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>List, stop, slots, clear KV cache</Typography>
                                            </Box>
                                            <Box sx={{ flex: '1 1 180px', p: 1.5, bgcolor: 'rgba(59, 130, 246, 0.08)', borderRadius: 2, border: '1px solid rgba(59, 130, 246, 0.15)' }}>
                                                <Chip label="agents" size="small" sx={{ mb: 1, bgcolor: 'info.main', color: '#09090b', fontWeight: 600, fontSize: '0.7rem' }} />
                                                <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>Agents, skills, tasks, file ops</Typography>
                                            </Box>
                                            <Box sx={{ flex: '1 1 180px', p: 1.5, bgcolor: 'rgba(239, 68, 68, 0.08)', borderRadius: 2, border: '1px solid rgba(239, 68, 68, 0.15)' }}>
                                                <Chip label="admin" size="small" sx={{ mb: 1, bgcolor: 'error.main', color: '#fafafa', fontWeight: 600, fontSize: '0.7rem' }} />
                                                <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>API keys, backend, system, apps</Typography>
                                            </Box>
                                        </Box>
                                        <Box sx={{ mt: 2, p: 1, bgcolor: 'rgba(251, 191, 36, 0.08)', borderRadius: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <WarningIcon sx={{ fontSize: 14, color: 'warning.main' }} />
                                            <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>Auth endpoints use session auth only. <code style={{ fontSize: '0.65rem' }}>/api/cli/install</code> is public.</Typography>
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* API Endpoints */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<StorageIcon />} color="secondary" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>API Endpoints</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Complete endpoint reference by category</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Box sx={{ bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 2, overflow: 'hidden' }}>
                                        <TableContainer>
                                            <Table size="small" sx={{ ...compactTableSx, '& .MuiTableCell-root': { py: 0.75, px: 1.5, fontSize: '0.75rem' } }}>
                                                <TableBody>
                                                    {/* Query Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(99, 102, 241, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="query" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'primary.main', color: '#09090b' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Query Endpoints</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/chat</TableCell><TableCell sx={{ color: 'text.secondary', width: 50 }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Chat with streaming support</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/chat/stream</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>SSE streaming chat</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/chat/upload</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Upload files for chat</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/complete</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Text completion</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/conversations</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List/create conversations</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/conversations/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Manage conversation</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/search</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Web search with content fetch</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/url/fetch</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Fetch URLs for chat context</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/playwright/fetch</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Stealth browser fetch</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/playwright/interact</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Page interaction</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'primary.main' }}>/api/playwright/status</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Browser status</TableCell></TableRow>

                                                    {/* Models Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(99, 102, 241, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="models" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'secondary.main', color: '#ffffff' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Model Management</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/models</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List all models</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/models/pull</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Download from HuggingFace</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/models/:name/load</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Start model instance</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/models/:name</TableCell><TableCell sx={{ color: 'text.secondary' }}>DELETE</TableCell><TableCell sx={{ color: 'text.secondary' }}>Delete model</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/model-configs/:name</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT</TableCell><TableCell sx={{ color: 'text.secondary' }}>Get/update model config</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/huggingface/search</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Search GGUF models</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/huggingface/files/:repo</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List repo files</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/downloads</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List active downloads</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/downloads/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>DELETE</TableCell><TableCell sx={{ color: 'text.secondary' }}>Cancel download</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/system/resources</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Hardware info</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>/api/system/optimal-settings</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Calculate optimal settings</TableCell></TableRow>

                                                    {/* Instances Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="instances" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'success.main', color: '#09090b' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Instance Management</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/vllm/instances</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List vLLM instances</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/vllm/instances/:name</TableCell><TableCell sx={{ color: 'text.secondary' }}>DELETE</TableCell><TableCell sx={{ color: 'text.secondary' }}>Stop vLLM instance</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/vllm/instances/:name/slots</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Get KV cache slots</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/vllm/instances/:name/slots/clear</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Clear KV cache</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/llamacpp/instances</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List llama.cpp instances</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/llamacpp/instances/:name</TableCell><TableCell sx={{ color: 'text.secondary' }}>DELETE</TableCell><TableCell sx={{ color: 'text.secondary' }}>Stop llama.cpp instance</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/system-prompts</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List system prompts</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>/api/system-prompts/:name</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Manage system prompt</TableCell></TableRow>

                                                    {/* Agents Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(59, 130, 246, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="agents" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'info.main', color: '#09090b' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Agent System</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agents</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List/create agents</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agents/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Manage agent</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agents/:id/regenerate-key</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Regenerate agent key</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agent-permissions</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT</TableCell><TableCell sx={{ color: 'text.secondary' }}>Manage permissions</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/skills</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List/create skills</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/skills/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Manage skill</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/skills/:name/execute</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Execute skill</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agents/skills/discover</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Discover skills</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/tasks</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List/create tasks</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/tasks/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Manage task</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agent/file/read</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Read file</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agent/file/write</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Write file</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agent/file/delete</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Delete file</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agent/file/list</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List directory</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>/api/agent/file/move</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Move/rename file</TableCell></TableRow>

                                                    {/* Admin Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(239, 68, 68, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="admin" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'error.main', color: '#fafafa' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Administration</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/auth/has-users</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Check if users exist</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/auth/register</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Register user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/auth/login</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Login</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/auth/logout</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Logout</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/auth/me</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Get current user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/auth/password</TableCell><TableCell sx={{ color: 'text.secondary' }}>PUT</TableCell><TableCell sx={{ color: 'text.secondary' }}>Change password</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/users</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List/create users</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/users/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Update/delete user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/users/:id/disable</TableCell><TableCell sx={{ color: 'text.secondary' }}>PUT</TableCell><TableCell sx={{ color: 'text.secondary' }}>Disable user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/users/:id/enable</TableCell><TableCell sx={{ color: 'text.secondary' }}>PUT</TableCell><TableCell sx={{ color: 'text.secondary' }}>Enable user</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/api-keys</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>List/create API keys</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/api-keys/:id</TableCell><TableCell sx={{ color: 'text.secondary' }}>PUT/DEL</TableCell><TableCell sx={{ color: 'text.secondary' }}>Update/delete key</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/api-keys/:id/revoke</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Revoke API key</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/api-keys/:id/stats</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>Get key stats</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/backend/active</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET/POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Get/set backend</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/apps</TableCell><TableCell sx={{ color: 'text.secondary' }}>GET</TableCell><TableCell sx={{ color: 'text.secondary' }}>List apps</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/apps/:name/start</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Start app</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/apps/:name/stop</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Stop app</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/apps/:name/restart</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Restart app</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>/api/system/reset</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>Reset system</TableCell></TableRow>

                                                    {/* OpenAI Compatible */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(251, 191, 36, 0.1)', py: 0.75 }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                <Chip label="OpenAI" size="small" sx={{ height: 18, fontSize: '0.65rem', bgcolor: 'rgba(251,191,36,0.3)' }} />
                                                                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }}>Instance Ports (8001+)</Typography>
                                                            </Box>
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'warning.main' }}>/v1/chat/completions</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>OpenAI-compatible chat</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'warning.main' }}>/v1/completions</TableCell><TableCell sx={{ color: 'text.secondary' }}>POST</TableCell><TableCell sx={{ color: 'text.secondary' }}>OpenAI-compatible text</TableCell></TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* Utility Scripts */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <DocIcon icon={<TerminalIcon sx={{ fontSize: 16 }} />} color="secondary" />
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>Utility Scripts</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Management scripts and custom patches</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        {/* Management Scripts */}
                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'primary.main' }}>
                                            Management Scripts
                                        </Typography>
                                        <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', mb: 1.5 }}>
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
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>./start.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Start all services (webapp and model backends).</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>./stop.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Stop all services and cleanup running model instances.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>./build.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Build Docker images with parallel builds, auto-resume, and state tracking.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'warning.main' }}>./reload.sh [service]</TableCell><TableCell sx={{ color: 'text.secondary' }}>Rebuild and restart services without data loss. Options: webapp, all</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>./update.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Quick rebuild of webapp only (for code updates).</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'error.main' }}>./reset.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Full system reset. Removes all data except downloaded models. Options: --rebuild</TableCell></TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>

                                        {/* Internal Scripts */}
                                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem', mb: 1, color: 'primary.main' }}>
                                            Internal Scripts
                                        </Typography>
                                        <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', mb: 1.5 }}>
                                            Scripts in the <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>scripts/</code> folder for specific tasks.
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
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'info.main' }}>scripts/manage-users.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Interactive user account management: list users, create admin, reset passwords, delete accounts.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>scripts/install-agents-cli.sh</TableCell><TableCell sx={{ color: 'text.secondary' }}>Install Koda CLI on Linux/macOS. Creates ~/.local/bin/koda symlink.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'success.main' }}>scripts/install-agents-cli.ps1</TableCell><TableCell sx={{ color: 'text.secondary' }}>Install Koda CLI on Windows PowerShell. Creates AppData shortcut.</TableCell></TableRow>
                                                    <TableRow><TableCell sx={{ fontFamily: 'monospace', color: 'secondary.main' }}>scripts/download_model.py</TableCell><TableCell sx={{ color: 'text.secondary' }}>Python script for downloading GGUF models from HuggingFace (used internally by webapp).</TableCell></TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>

                                        {/* Build Options */}
                                        <Box sx={{ p: 1.5, bgcolor: 'rgba(99, 102, 241, 0.08)', borderRadius: 1.5, border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                                            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, mb: 0.5, color: 'info.main' }}>Build Script Options</Typography>
                                            <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary', fontFamily: 'monospace' }}>
                                                ./build.sh --no-cache    # Force rebuild without Docker cache<br/>
                                                ./build.sh --no-parallel # Sequential builds (for low RAM)<br/>
                                                ./build.sh --no-resume   # Clear build state, start fresh<br/>
                                                ./build.sh --retry 3     # Set retry attempts (default: 2)
                                            </Typography>
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* System Reset */}
                                <Accordion sx={docAccordionSx}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: 'text.secondary' }} />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                            <Box sx={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                width: 32,
                                                height: 32,
                                                borderRadius: '10px',
                                                background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, transparent 100%)',
                                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                            }}>
                                                <WarningIcon sx={{ fontSize: 16, color: '#ef4444' }} />
                                            </Box>
                                            <Box>
                                                <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>System Reset</Typography>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Delete models and clean up resources</Typography>
                                            </Box>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Box sx={{ p: 2, bgcolor: 'rgba(239, 68, 68, 0.08)', borderRadius: 2, border: '1px solid rgba(239, 68, 68, 0.2)', mb: 2 }}>
                                            <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                                                Stops all instances, deletes all models, and cleans up Docker resources. API keys and configuration are preserved.
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
                                    </AccordionDetails>
                                </Accordion>
                            </Box>
                        )}

                        {/* Logs Tab */}
                        {visibleTabOrder[activeTab] === 5 && (() => {
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
                            <Card sx={{ height: 'calc(100vh - 220px)' }}>
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
                                        <Button size="small" variant="outlined" onClick={() => setLogs([])} startIcon={<ClearIcon />}>Clear</Button>
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
                                                    bgcolor: logFilter === f.key ? (f.color === 'default' ? 'rgba(99,102,241,0.2)' : `${f.color}22`) : 'rgba(255,255,255,0.04)',
                                                    border: logFilter === f.key ? `1px solid ${f.color === 'default' ? 'rgba(99,102,241,0.5)' : f.color + '66'}` : '1px solid transparent',
                                                    color: logFilter === f.key ? (f.color === 'default' ? 'primary.main' : f.color) : 'text.secondary',
                                                    '&:hover': { bgcolor: f.color === 'default' ? 'rgba(99,102,241,0.1)' : `${f.color}15` }
                                                }}
                                            />
                                        ))}
                                        {/* Search input */}
                                        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', bgcolor: 'rgba(255,255,255,0.04)', borderRadius: 1, px: 1, py: 0.25, border: '1px solid', borderColor: 'divider', minWidth: 180 }}>
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
                                                const message = typeof log === 'string' ? log : log.message;
                                                const level = typeof log === 'string' ? 'info' : (log.level || 'info');
                                                const timestamp = log.timestamp ? new Date(log.timestamp) : null;
                                                const timeStr = timestamp ? timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
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
                                                            parts.push(<span key={key++} style={{ color: '#a5b4fc', backgroundColor: 'rgba(99,102,241,0.15)', padding: '1px 6px', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600 }}>{match[1]}</span>);
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
                                                        // Container names (llamacpp-*, vllm-*)
                                                        match = remaining.match(/^((?:llamacpp|vllm)-[\w\-]+)/);
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
                                                            borderLeft: `2px solid ${isStepMsg ? 'rgba(99,102,241,0.3)' : levelConfig.border}`,
                                                            borderTop: isStepMsg ? '1px solid rgba(255,255,255,0.04)' : 'none',
                                                            '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' },
                                                            transition: 'background-color 0.15s',
                                                        }}
                                                    >
                                                        {/* Timestamp */}
                                                        {timeStr && (
                                                            <Typography component="span" sx={{
                                                                fontFamily: '"Fira Code", monospace',
                                                                fontSize: '0.68rem',
                                                                color: 'rgba(255,255,255,0.18)',
                                                                mr: 1.5,
                                                                mt: '2px',
                                                                flexShrink: 0,
                                                                userSelect: 'none',
                                                            }}>
                                                                {timeStr}
                                                            </Typography>
                                                        )}
                                                        {/* Level icon */}
                                                        <Typography component="span" sx={{
                                                            fontFamily: '"Fira Code", monospace',
                                                            fontSize: '0.72rem',
                                                            color: levelConfig.color,
                                                            mr: 1,
                                                            mt: '2px',
                                                            flexShrink: 0,
                                                            width: 12,
                                                            textAlign: 'center',
                                                            userSelect: 'none',
                                                        }}>
                                                            {levelConfig.icon}
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
                            );
                        })()}

                        {/* Apps Tab (Admin Only) */}
                        {visibleTabOrder[activeTab] === 6 && isAdmin && (
                            <Box>
                                <SectionHeader
                                    icon={<AppsIcon />}
                                    title="Apps Management"
                                    subtitle="Manage integrated applications and agent systems"
                                />

                                <Grid container spacing={3} sx={{ mt: 1 }}>
                                    {apps.filter(app => !app.integrated).map(app => (
                                        <Grid item xs={12} md={6} key={app.name}>
                                            <Card>
                                                <CardContent>
                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                                                        <Box>
                                                            <Typography variant="h6" sx={{ mb: 0.5 }}>
                                                                {app.displayName}
                                                            </Typography>
                                                            <Typography variant="body2" color="text.secondary">
                                                                {app.description}
                                                            </Typography>
                                                        </Box>
                                                        <Chip
                                                            label={app.status?.status || 'unknown'}
                                                            size="small"
                                                            color={app.status?.status === 'running' ? 'success' : app.status?.status === 'stopped' ? 'default' : 'error'}
                                                        />
                                                    </Box>

                                                    <Divider sx={{ my: 2 }} />

                                                    {app.url && (
                                                        <Box sx={{ mb: 2 }}>
                                                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                                                Access URL:
                                                            </Typography>
                                                            <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'primary.main' }}>
                                                                {app.url}
                                                            </Typography>
                                                        </Box>
                                                    )}

                                                    {app.ports && app.ports.length > 0 && (
                                                        <Box sx={{ mb: 2 }}>
                                                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                                                Ports:
                                                            </Typography>
                                                            {app.ports.map((port, idx) => (
                                                                <Chip
                                                                    key={idx}
                                                                    label={`${port.external} (${port.protocol.toUpperCase()})`}
                                                                    size="small"
                                                                    variant="outlined"
                                                                    sx={{ mr: 0.5 }}
                                                                />
                                                            ))}
                                                        </Box>
                                                    )}

                                                    <CardActions sx={{ p: 0, gap: 1, flexWrap: 'wrap' }}>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            color="success"
                                                            startIcon={<PlayArrowIcon />}
                                                            onClick={() => handleAppStart(app.name)}
                                                            disabled={app.status?.status === 'running'}
                                                        >
                                                            Start
                                                        </Button>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            color="error"
                                                            startIcon={<StopIcon />}
                                                            onClick={() => handleAppStop(app.name)}
                                                            disabled={app.status?.status === 'stopped' || app.status?.status === 'not_found'}
                                                        >
                                                            Stop
                                                        </Button>
                                                        <Button
                                                            size="small"
                                                            variant="outlined"
                                                            startIcon={<RestartAltIcon />}
                                                            onClick={() => handleAppRestart(app.name)}
                                                            disabled={app.status?.status === 'stopped' || app.status?.status === 'not_found'}
                                                        >
                                                            Restart
                                                        </Button>
                                                    </CardActions>
                                                </CardContent>
                                            </Card>
                                        </Grid>
                                    ))}

                                    {/* Backend Selection Section */}
                                    <Grid item xs={12}>
                                        <Card sx={{ bgcolor: 'background.default' }}>
                                            <CardContent>
                                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                                                    <Box>
                                                        <Typography variant="h6">Inference Backend</Typography>
                                                        <Typography variant="body2" color="text.secondary">
                                                            Select the backend engine for loading and running models
                                                        </Typography>
                                                    </Box>
                                                </Box>

                                                <Grid container spacing={2}>
                                                    {apps.filter(app => app.isBackend).map(app => (
                                                        <Grid item xs={12} md={6} key={app.name}>
                                                            <Card
                                                                variant={app.isActive ? "elevation" : "outlined"}
                                                                sx={{
                                                                    border: app.isActive ? '2px solid' : '1px solid',
                                                                    borderColor: app.isActive ? 'success.main' : 'divider',
                                                                    bgcolor: app.isActive ? 'action.selected' : 'background.paper'
                                                                }}
                                                            >
                                                                <CardContent>
                                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                                                                        <Typography variant="h6">{app.displayName}</Typography>
                                                                        <Chip
                                                                            label={app.isActive ? 'Active' : 'Inactive'}
                                                                            size="small"
                                                                            color={app.isActive ? 'success' : 'default'}
                                                                        />
                                                                    </Box>
                                                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                                                        {app.description}
                                                                    </Typography>
                                                                    <Button
                                                                        fullWidth
                                                                        variant={app.isActive ? "outlined" : "contained"}
                                                                        color={app.isActive ? "success" : "primary"}
                                                                        startIcon={app.isActive ? <CheckCircleIcon /> : <PlayArrowIcon />}
                                                                        disabled={app.isActive}
                                                                        onClick={async () => {
                                                                            try {
                                                                                showSnackbar(`Switching to ${app.displayName}...`, 'info');
                                                                                const response = await fetch('/api/backend/active', {
                                                                                    method: 'POST',
                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                    credentials: 'include',
                                                                                    body: JSON.stringify({ backend: app.backendType })
                                                                                });
                                                                                if (!response.ok) {
                                                                                    const err = await response.json();
                                                                                    throw new Error(err.error || 'Failed to switch backend');
                                                                                }
                                                                                const data = await response.json();
                                                                                showSnackbar(data.message, 'success');
                                                                                fetchApps();
                                                                                setSelectedBackend(app.backendType);
                                                                            } catch (error) {
                                                                                showSnackbar(error.message, 'error');
                                                                            }
                                                                        }}
                                                                    >
                                                                        {app.isActive ? 'Currently Active' : 'Activate'}
                                                                    </Button>
                                                                </CardContent>
                                                            </Card>
                                                        </Grid>
                                                    ))}
                                                </Grid>
                                            </CardContent>
                                        </Card>
                                    </Grid>

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

                                                    <Tabs value={agentSubTab} onChange={(e, v) => setAgentSubTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
                                                        <Tab label="Skills" />
                                                        <Tab label="Permissions" />
                                                    </Tabs>

                                                    {/* Skills Sub-Tab */}
                                                    {agentSubTab === 0 && (
                                                        <Box>
                                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                                                                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                                                    Skills Library ({skills.length})
                                                                </Typography>
                                                                <Button
                                                                    variant="contained"
                                                                    size="small"
                                                                    onClick={() => {
                                                                        setEditingSkill(null);
                                                                        setSkillFormData({ name: '', description: '', type: 'tool', parameters: {}, code: '' });
                                                                        setSkillDialogOpen(true);
                                                                    }}
                                                                >
                                                                    Create Skill
                                                                </Button>
                                                            </Box>

                                                            {skills.length === 0 ? (
                                                                <Alert severity="info">No skills created yet. Click "Create Skill" to get started.</Alert>
                                                            ) : (
                                                                <Accordion defaultExpanded={false}>
                                                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                                                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                                                                            View All Skills ({skills.length})
                                                                        </Typography>
                                                                    </AccordionSummary>
                                                                    <AccordionDetails>
                                                                        <Grid container spacing={2}>
                                                                    {skills.map(skill => (
                                                                        <Grid item xs={12} md={6} key={skill.id}>
                                                                            <Card variant="outlined">
                                                                                <CardContent>
                                                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', mb: 1 }}>
                                                                                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flex: 1 }}>
                                                                                            <Typography variant="h6">{skill.name}</Typography>
                                                                                            <Chip label={skill.type} size="small" />
                                                                                        </Box>
                                                                                        <Switch
                                                                                            checked={skill.enabled !== false}
                                                                                            onChange={(e) => {
                                                                                                fetch(`/api/skills/${skill.id}`, {
                                                                                                    credentials: 'include',
                                                                                                    method: 'PUT',
                                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                                    body: JSON.stringify({ ...skill, enabled: e.target.checked })
                                                                                                })
                                                                                                    .then(res => res.json())
                                                                                                    .then(() => {
                                                                                                        showSnackbar(`Skill ${e.target.checked ? 'disabled' : 'enabled'}`, 'success');
                                                                                                        fetchSkills();
                                                                                                    })
                                                                                                    .catch(error => showSnackbar(`Failed to update skill: ${error.message}`, 'error'));
                                                                                            }}
                                                                                            size="small"
                                                                                        />
                                                                                    </Box>
                                                                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                                                                        {skill.description || 'No description'}
                                                                                    </Typography>
                                                                                    <Typography variant="caption" color="text.secondary">
                                                                                        Created: {skill.createdAt ? new Date(skill.createdAt).toLocaleDateString() : 'Built-in'}
                                                                                    </Typography>
                                                                                </CardContent>
                                                                                <CardActions>
                                                                                    <Button
                                                                                        size="small"
                                                                                        onClick={() => {
                                                                                            setEditingSkill(skill);
                                                                                            setSkillFormData(skill);
                                                                                            setSkillDialogOpen(true);
                                                                                        }}
                                                                                    >
                                                                                        Edit
                                                                                    </Button>
                                                                                    <Button size="small" color="error" onClick={() => handleDeleteSkill(skill.id)}>
                                                                                        Delete
                                                                                    </Button>
                                                                                </CardActions>
                                                                            </Card>
                                                                        </Grid>
                                                                    ))}
                                                                        </Grid>
                                                                    </AccordionDetails>
                                                                </Accordion>
                                                            )}
                                                        </Box>
                                                    )}

                                                    {/* Permissions Sub-Tab */}
                                                    {agentSubTab === 1 && (
                                                        <Box>
                                                            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
                                                                Global Agent Permissions
                                                            </Typography>
                                                            <Grid container spacing={2}>
                                                                <Grid item xs={12} md={6}>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={agentPermissions.allowFileRead}
                                                                                onChange={(e) => handleUpdatePermissions({ ...agentPermissions, allowFileRead: e.target.checked })}
                                                                            />
                                                                        }
                                                                        label="Allow File Read"
                                                                    />
                                                                </Grid>
                                                                <Grid item xs={12} md={6}>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={agentPermissions.allowFileWrite}
                                                                                onChange={(e) => handleUpdatePermissions({ ...agentPermissions, allowFileWrite: e.target.checked })}
                                                                            />
                                                                        }
                                                                        label="Allow File Write"
                                                                    />
                                                                </Grid>
                                                                <Grid item xs={12} md={6}>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={agentPermissions.allowFileDelete}
                                                                                onChange={(e) => handleUpdatePermissions({ ...agentPermissions, allowFileDelete: e.target.checked })}
                                                                            />
                                                                        }
                                                                        label="Allow File Delete"
                                                                    />
                                                                </Grid>
                                                                <Grid item xs={12} md={6}>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={agentPermissions.allowToolExecution}
                                                                                onChange={(e) => handleUpdatePermissions({ ...agentPermissions, allowToolExecution: e.target.checked })}
                                                                            />
                                                                        }
                                                                        label="Allow Tool Execution"
                                                                    />
                                                                </Grid>
                                                                <Grid item xs={12} md={6}>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={agentPermissions.allowModelAccess}
                                                                                onChange={(e) => handleUpdatePermissions({ ...agentPermissions, allowModelAccess: e.target.checked })}
                                                                            />
                                                                        }
                                                                        label="Allow Model Access"
                                                                    />
                                                                </Grid>
                                                                <Grid item xs={12} md={6}>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Switch
                                                                                checked={agentPermissions.allowCollaboration}
                                                                                onChange={(e) => handleUpdatePermissions({ ...agentPermissions, allowCollaboration: e.target.checked })}
                                                                            />
                                                                        }
                                                                        label="Allow Collaboration"
                                                                    />
                                                                </Grid>
                                                            </Grid>
                                                        </Box>
                                                    )}
                                                </CardContent>
                                            </Card>
                                        </Grid>
                                    ))}
                                </Grid>
                            </Box>
                        )}
                    </Box>
                </Box>
            </Box>

            {/* Agent Dialog */}
            <Dialog open={agentDialogOpen} onClose={() => { setAgentDialogOpen(false); setEditingAgent(null); }} maxWidth="md" fullWidth>
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
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => { setAgentDialogOpen(false); setEditingAgent(null); }}>Cancel</Button>
                    <Button onClick={editingAgent ? handleUpdateAgent : handleCreateAgent} variant="contained">
                        {editingAgent ? 'Update' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Skill Dialog */}
            <Dialog open={skillDialogOpen} onClose={() => { setSkillDialogOpen(false); setEditingSkill(null); }} maxWidth="md" fullWidth>
                <DialogTitle>{editingSkill ? 'Edit Skill' : 'Create Skill'}</DialogTitle>
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
                        helperText="Enter the code or script for this skill"
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
            <Dialog open={taskDialogOpen} onClose={() => setTaskDialogOpen(false)} maxWidth="sm" fullWidth>
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
            <Dialog open={resetDialogOpen} onClose={() => setResetDialogOpen(false)} maxWidth="sm" fullWidth>
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
