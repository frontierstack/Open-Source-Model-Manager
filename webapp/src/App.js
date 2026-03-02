import React, { useState, useEffect, useRef } from 'react';
import { w3cwebsocket as W3CWebSocket } from "websocket";
import { useAuthStore } from './stores/useAuthStore';
import { logout as performLogout } from './services/auth';
import { ThemeProvider, createTheme, alpha } from '@mui/material/styles';
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
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import AppsIcon from '@mui/icons-material/Apps';
import CancelIcon from '@mui/icons-material/Cancel';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import CodeIcon from '@mui/icons-material/Code';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
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
import LogoutIcon from '@mui/icons-material/Logout';
import Menu from '@mui/material/Menu';

// LM Studio inspired dark theme
const darkTheme = createTheme({
    palette: {
        mode: 'dark',
        background: {
            default: '#09090b',
            paper: '#18181b',
        },
        primary: {
            main: '#a78bfa',
            light: '#c4b5fd',
            dark: '#7c3aed',
        },
        secondary: {
            main: '#22d3ee',
            light: '#67e8f9',
            dark: '#06b6d4',
        },
        success: {
            main: '#22c55e',
            light: '#4ade80',
        },
        warning: {
            main: '#f59e0b',
        },
        error: {
            main: '#ef4444',
        },
        text: {
            primary: '#fafafa',
            secondary: '#a1a1aa',
        },
        divider: 'rgba(255, 255, 255, 0.06)',
    },
    typography: {
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        h1: {
            fontWeight: 700,
            fontSize: '2rem',
            letterSpacing: '-0.025em',
        },
        h2: {
            fontWeight: 600,
            fontSize: '1.5rem',
            letterSpacing: '-0.02em',
        },
        h3: {
            fontWeight: 600,
            fontSize: '1.25rem',
            letterSpacing: '-0.015em',
        },
        h5: {
            fontWeight: 600,
            fontSize: '1rem',
            letterSpacing: '-0.01em',
        },
        h6: {
            fontWeight: 600,
            fontSize: '0.875rem',
        },
        body1: {
            fontSize: '0.875rem',
        },
        body2: {
            fontSize: '0.8125rem',
        },
        caption: {
            fontSize: '0.75rem',
        },
    },
    shape: {
        borderRadius: 8,
    },
    components: {
        MuiButton: {
            styleOverrides: {
                root: {
                    borderRadius: 6,
                    textTransform: 'none',
                    fontWeight: 500,
                    fontSize: '0.8125rem',
                    padding: '6px 12px',
                    boxShadow: 'none',
                    '&:hover': {
                        boxShadow: 'none',
                    },
                },
                contained: {
                    '&:hover': {
                        boxShadow: '0 0 0 1px rgba(167, 139, 250, 0.5)',
                    },
                },
                outlined: {
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    '&:hover': {
                        borderColor: 'rgba(255, 255, 255, 0.2)',
                        backgroundColor: 'rgba(255, 255, 255, 0.02)',
                    },
                },
            },
        },
        MuiPaper: {
            styleOverrides: {
                root: {
                    backgroundImage: 'none',
                    borderRadius: 8,
                },
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    backgroundImage: 'none',
                    borderRadius: 12,
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
                },
            },
        },
        MuiTextField: {
            styleOverrides: {
                root: {
                    '& .MuiOutlinedInput-root': {
                        borderRadius: 8,
                        fontSize: '0.875rem',
                        '& fieldset': {
                            borderColor: 'rgba(255, 255, 255, 0.08)',
                        },
                        '&:hover fieldset': {
                            borderColor: 'rgba(255, 255, 255, 0.15)',
                        },
                        '&.Mui-focused fieldset': {
                            borderColor: '#a78bfa',
                            borderWidth: 1,
                        },
                    },
                },
            },
        },
        MuiChip: {
            styleOverrides: {
                root: {
                    borderRadius: 4,
                    fontWeight: 500,
                    fontSize: '0.75rem',
                    height: 24,
                },
            },
        },
        MuiSelect: {
            styleOverrides: {
                root: {
                    fontSize: '0.875rem',
                },
            },
        },
        MuiInputLabel: {
            styleOverrides: {
                root: {
                    fontSize: '0.875rem',
                },
            },
        },
        MuiTab: {
            styleOverrides: {
                root: {
                    textTransform: 'none',
                    fontWeight: 500,
                    fontSize: '0.8125rem',
                    minHeight: 40,
                    padding: '8px 16px',
                },
            },
        },
        MuiTabs: {
            styleOverrides: {
                indicator: {
                    height: 2,
                },
            },
        },
    },
});

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
    enforceEager: "Disable CUDA graphs and use eager execution. Useful for debugging but slower. Keep disabled for production."
};

// Settings tooltips for llama.cpp configuration options
const LLAMACPP_TOOLTIPS = {
    nGpuLayers: "Number of model layers to offload to GPU. -1 = all layers (recommended). Lower values offload less to GPU, useful for large models that don't fit in VRAM.",
    contextSize: "Maximum context window size in tokens. Larger values allow longer conversations but require more memory. Common values: 2048, 4096, 8192, 16384.",
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
    frequencyPenalty: "Penalty based on token frequency (0.0-1.0). Higher values reduce repetition of common phrases."
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

    // Auth state
    const { user } = useAuthStore();
    const [userMenuAnchor, setUserMenuAnchor] = useState(null);

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

    // System prompt state
    const [systemPrompts, setSystemPrompts] = useState({});
    const [selectedModelForPrompt, setSelectedModelForPrompt] = useState('');
    const [currentSystemPrompt, setCurrentSystemPrompt] = useState('');
    const [systemPromptDirty, setSystemPromptDirty] = useState(false);

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
        enforceEager: false
    });

    // Model configuration state for llama.cpp
    const [llamacppConfig, setLlamacppConfig] = useState({
        nGpuLayers: -1,
        contextSize: 4096,
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
        frequencyPenalty: 0.0
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
        const saved = localStorage.getItem('tabOrder');
        return saved ? JSON.parse(saved) : [0, 1, 2, 3, 4, 5, 6];
    });

    // Docs accordion order state
    const [docsAccordionOrder, setDocsAccordionOrder] = useState(() => {
        const saved = localStorage.getItem('docsAccordionOrder');
        return saved ? JSON.parse(saved) : [0, 1, 2, 3, 4, 5];
    });

    // API Builder state
    const [apiBuilderEndpoint, setApiBuilderEndpoint] = useState('/api/chat');
    const [apiBuilderLang, setApiBuilderLang] = useState('curl');

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
    const openWebUIUrl = `${protocol}//${hostname}:3002`;

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

    // Initial data fetch and WebSocket setup
    useEffect(() => {
        fetchModels();
        fetchInstances();
        fetchSystemPrompts();
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

        const client = new W3CWebSocket(wsUrl);
        wsRef.current = client;

        client.onopen = () => {
            setWsConnected(true);
            showSnackbar('Connected to backend', 'success');
        };

        client.onmessage = (message) => {
            try {
                const data = JSON.parse(message.data);
                if (data.type === 'log') {
                    setLogs(prevLogs => [...prevLogs, {
                        message: data.message.trim(),
                        level: data.level || 'info'
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
                    // Remove download from UI
                    setActiveDownloads(prev => prev.filter(d => d.downloadId !== data.downloadId));
                } else if (data.type === 'service_status_changed') {
                    fetchApps();
                }
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
                // Don't crash the UI - just log the error
            }
        };

        client.onclose = () => {
            setWsConnected(false);
            showSnackbar('Disconnected from backend', 'error');
        };

        client.onerror = () => {
            setWsConnected(false);
            showSnackbar('WebSocket connection error', 'error');
        };

        return () => {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
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

    const fetchInstances = () => {
        fetch('/api/vllm/instances', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setInstances(data))
            .catch(error => console.error('Error fetching instances:', error));
    };

    const fetchSystemPrompts = () => {
        fetch('/api/system-prompts', { credentials: 'include' })
            .then(res => res.json())
            .then(data => setSystemPrompts(data))
            .catch(error => console.error('Error fetching system prompts:', error));
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
                powershell: `# Disable SSL certificate validation (for self-signed certs)
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Bearer Token Authentication
$headers = @{
    "Authorization" = "Bearer your_bearer_token"
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
            }
        };

        return examples[endpoint]?.[lang] || 'Select an endpoint and language';
    };

    // Tab reordering handlers with drag and drop
    const [draggedTab, setDraggedTab] = useState(null);

    const handleDragStart = (e, index) => {
        setDraggedTab(index);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e, index) => {
        e.preventDefault();
        if (draggedTab === null || draggedTab === index) return;

        const newOrder = [...tabOrder];
        const draggedItem = newOrder[draggedTab];
        newOrder.splice(draggedTab, 1);
        newOrder.splice(index, 0, draggedItem);

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
        { id: 2, icon: <ChatIcon sx={{ fontSize: 18 }} />, label: 'System Prompts' },
        { id: 3, icon: <VpnKeyIcon sx={{ fontSize: 18 }} />, label: 'API Keys' },
        { id: 4, icon: <MenuBookIcon sx={{ fontSize: 18 }} />, label: 'Docs' },
        { id: 5, icon: <TerminalIcon sx={{ fontSize: 18 }} />, label: 'Logs' },
        { id: 6, icon: <AppsIcon sx={{ fontSize: 18 }} />, label: 'Apps' }
    ];

    // HuggingFace handlers
    const handleSearch = () => {
        if (!searchQuery.trim()) return;
        setSearching(true);
        fetch(`/api/huggingface/search?query=${encodeURIComponent(searchQuery)}`, {
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

    const handleStopInstance = (modelName) => {
        showSnackbar(`Stopping ${modelName}...`, 'info');
        fetch(`/api/vllm/instances/${modelName}`, {
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

    // System prompt handlers
    const handleSelectModelForPrompt = (modelName) => {
        setSelectedModelForPrompt(modelName);
        setCurrentSystemPrompt(systemPrompts[modelName] || '');
        setSystemPromptDirty(false);
    };

    const handleSystemPromptChange = (value) => {
        setCurrentSystemPrompt(value);
        setSystemPromptDirty(value !== (systemPrompts[selectedModelForPrompt] || ''));
    };

    const handleSaveSystemPrompt = () => {
        if (!selectedModelForPrompt) return;
        fetch(`/api/system-prompts/${encodeURIComponent(selectedModelForPrompt)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt: currentSystemPrompt }),
        })
        .then(response => {
            if (!response.ok) throw new Error('Failed to save');
            return response.json();
        })
        .then(() => {
            setSystemPrompts(prev => ({
                ...prev,
                [selectedModelForPrompt]: currentSystemPrompt
            }));
            setSystemPromptDirty(false);
            showSnackbar('System prompt saved', 'success');
        })
        .catch(error => showSnackbar(error.message, 'error'));
    };

    const handleClearSystemPrompt = () => {
        setCurrentSystemPrompt('');
        setSystemPromptDirty(systemPrompts[selectedModelForPrompt] !== '');
    };

    return (
        <ThemeProvider theme={darkTheme}>
            <CssBaseline />
            <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
                {/* Main Content */}
                <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Header */}
                    <Box sx={{
                        px: 3,
                        py: 2,
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        bgcolor: 'background.paper',
                    }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                <Typography variant="h1" sx={{
                                    background: 'linear-gradient(135deg, #a78bfa 0%, #22d3ee 100%)',
                                    WebkitBackgroundClip: 'text',
                                    WebkitTextFillColor: 'transparent',
                                }}>
                                    Open Source Model Manager
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                                <Chip
                                    icon={wsConnected ? <CheckCircleIcon sx={{ fontSize: 14 }} /> : <WarningIcon sx={{ fontSize: 14 }} />}
                                    label={wsConnected ? "Connected" : "Disconnected"}
                                    size="small"
                                    color={wsConnected ? "success" : "error"}
                                    variant="outlined"
                                    sx={{ '& .MuiChip-icon': { ml: 0.5 } }}
                                />
                                {instances.length > 0 && (
                                    <Chip
                                        icon={<MemoryIcon sx={{ fontSize: 14 }} />}
                                        label={`${instances.length} Active`}
                                        size="small"
                                        color="secondary"
                                        variant="outlined"
                                    />
                                )}
                                <Chip
                                    icon={<AccountCircleIcon sx={{ fontSize: 14 }} />}
                                    label={user?.username || 'User'}
                                    size="small"
                                    color="primary"
                                    variant="outlined"
                                    onClick={handleUserMenuOpen}
                                    sx={{
                                        '& .MuiChip-icon': { ml: 0.5 },
                                        cursor: 'pointer',
                                        '&:hover': { bgcolor: 'rgba(167, 139, 250, 0.08)' }
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
                                {tabOrder.map((tabId, index) => {
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
                        {tabOrder[activeTab] === 0 && (
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

                                            {/* Search Results */}
                                            {searchResults.length > 0 && (
                                                <Box sx={{ mt: 3 }}>
                                                    <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                                                        Found {searchResults.length} models
                                                    </Typography>
                                                    <Grid container spacing={2}>
                                                        {searchResults.slice(0, 12).map(model => {
                                                            const paramSize = extractParameterSize(model.id);
                                                            return (
                                                                <Grid item xs={12} sm={6} md={4} key={model.id}>
                                                                    <Card
                                                                        variant="outlined"
                                                                        sx={{
                                                                            cursor: 'pointer',
                                                                            transition: 'all 0.15s',
                                                                            '&:hover': {
                                                                                borderColor: 'primary.main',
                                                                                bgcolor: 'rgba(167, 139, 250, 0.03)',
                                                                            },
                                                                        }}
                                                                        onClick={() => handleSelectModel(model.id)}
                                                                    >
                                                                        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                                                            <Typography variant="h6" sx={{
                                                                                whiteSpace: 'nowrap',
                                                                                overflow: 'hidden',
                                                                                textOverflow: 'ellipsis',
                                                                                mb: 1
                                                                            }}>
                                                                                {model.id.split('/')[1]}
                                                                            </Typography>
                                                                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                                                                {model.id.split('/')[0]}
                                                                            </Typography>
                                                                            <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
                                                                                {paramSize && (
                                                                                    <Chip label={paramSize} size="small" color="secondary" />
                                                                                )}
                                                                                <Chip
                                                                                    label={`${(model.downloads / 1000).toFixed(0)}k`}
                                                                                    size="small"
                                                                                    variant="outlined"
                                                                                    sx={{ fontSize: '0.7rem' }}
                                                                                />
                                                                            </Box>
                                                                        </CardContent>
                                                                    </Card>
                                                                </Grid>
                                                            );
                                                        })}
                                                    </Grid>
                                                </Box>
                                            )}
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
                                                        <Box key={download.downloadId} sx={{ mb: 2, p: 2, bgcolor: 'rgba(167, 139, 250, 0.05)', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
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
                        {tabOrder[activeTab] === 1 && (
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
                                                                                        color={instance.backend === 'llamacpp' ? 'primary' : 'secondary'}
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
                                                                                    </>
                                                                                )}
                                                                            </Box>
                                                                        </Box>
                                                                        <Tooltip title="Stop Instance">
                                                                            <IconButton
                                                                                size="small"
                                                                                onClick={() => handleStopInstance(instance.name)}
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
                                                        const isRunning = model.loadedIn === 'vllm';
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
                                                            <Grid item xs={12}>
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
                                                                                <Typography variant="body2">Enforce Eager Mode (Debug)</Typography>
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
                                                                        </Select>
                                                                    </FormControl>
                                                                </Tooltip>
                                                            </Grid>
                                                            <Grid item xs={12}>
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

                        {/* System Prompts Tab */}
                        {tabOrder[activeTab] === 2 && (
                            <Grid container spacing={3}>
                                <Grid item xs={12} md={4}>
                                    <Card sx={{ height: '100%' }}>
                                        <CardContent>
                                            <SectionHeader
                                                icon={<ChatIcon />}
                                                title="Select Model"
                                                subtitle="Choose a model to configure its system prompt"
                                            />
                                            {models.length === 0 ? (
                                                <Box sx={{ textAlign: 'center', py: 4 }}>
                                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                                        No models available
                                                    </Typography>
                                                </Box>
                                            ) : (
                                                <List sx={{ mt: 1 }}>
                                                    {models.map(model => {
                                                        const hasPrompt = !!systemPrompts[model.name];
                                                        const isSelected = selectedModelForPrompt === model.name;
                                                        return (
                                                            <ListItemButton
                                                                key={model.name}
                                                                selected={isSelected}
                                                                onClick={() => handleSelectModelForPrompt(model.name)}
                                                                sx={{
                                                                    borderRadius: 1,
                                                                    mb: 0.5,
                                                                    '&.Mui-selected': {
                                                                        bgcolor: 'rgba(167, 139, 250, 0.1)',
                                                                        '&:hover': {
                                                                            bgcolor: 'rgba(167, 139, 250, 0.15)',
                                                                        },
                                                                    },
                                                                }}
                                                            >
                                                                <ListItemText
                                                                    primary={model.name}
                                                                    primaryTypographyProps={{
                                                                        sx: {
                                                                            whiteSpace: 'nowrap',
                                                                            overflow: 'hidden',
                                                                            textOverflow: 'ellipsis',
                                                                            fontSize: '0.875rem',
                                                                        }
                                                                    }}
                                                                />
                                                                {hasPrompt && (
                                                                    <Chip
                                                                        label="Configured"
                                                                        size="small"
                                                                        color="success"
                                                                        variant="outlined"
                                                                        sx={{ fontSize: '0.7rem', height: 20 }}
                                                                    />
                                                                )}
                                                            </ListItemButton>
                                                        );
                                                    })}
                                                </List>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Grid>

                                <Grid item xs={12} md={8}>
                                    <Card sx={{ height: '100%' }}>
                                        <CardContent>
                                            <SectionHeader
                                                icon={<ChatIcon />}
                                                title="System Prompt"
                                                subtitle={selectedModelForPrompt ? `Editing prompt for ${selectedModelForPrompt}` : 'Select a model to edit its system prompt'}
                                            />
                                            {selectedModelForPrompt ? (
                                                <Box sx={{ mt: 2 }}>
                                                    <TextField
                                                        fullWidth
                                                        multiline
                                                        rows={12}
                                                        placeholder="Enter a system prompt for this model...

Example:
You are a helpful coding assistant. When writing code, always include comments explaining the logic. Prefer clear, readable code over clever one-liners."
                                                        value={currentSystemPrompt}
                                                        onChange={(e) => handleSystemPromptChange(e.target.value)}
                                                        sx={{
                                                            '& .MuiOutlinedInput-root': {
                                                                fontFamily: '"Fira Code", monospace',
                                                                fontSize: '0.8125rem',
                                                            },
                                                        }}
                                                    />
                                                    <Box sx={{ display: 'flex', gap: 1, mt: 2, justifyContent: 'flex-end' }}>
                                                        <Button
                                                            variant="outlined"
                                                            startIcon={<ClearIcon />}
                                                            onClick={handleClearSystemPrompt}
                                                            disabled={!currentSystemPrompt}
                                                        >
                                                            Clear
                                                        </Button>
                                                        <Button
                                                            variant="contained"
                                                            startIcon={<SaveIcon />}
                                                            onClick={handleSaveSystemPrompt}
                                                            disabled={!systemPromptDirty}
                                                        >
                                                            Save Prompt
                                                        </Button>
                                                    </Box>
                                                    <Typography variant="caption" sx={{ color: 'text.secondary', mt: 2, display: 'block' }}>
                                                        System prompts are saved persistently and will be loaded even after page refresh.
                                                        They are stored per-model and can be used by chat interfaces like Open WebUI.
                                                    </Typography>
                                                </Box>
                                            ) : (
                                                <Box sx={{ textAlign: 'center', py: 8 }}>
                                                    <ChatIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
                                                    <Typography variant="body1" sx={{ color: 'text.secondary' }}>
                                                        Select a model from the list to configure its system prompt
                                                    </Typography>
                                                </Box>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Grid>
                            </Grid>
                        )}

                        {/* API Keys Tab */}
                        {tabOrder[activeTab] === 3 && (
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
                                                                label="Bearer Token Only (for OpenWebUI - no secret required)"
                                                            />
                                                            <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}>
                                                                Enable this for OpenWebUI compatibility. Bearer tokens can be used with "Authorization: Bearer &lt;token&gt;" header without requiring a secret.
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
                                                <Card variant="outlined" sx={{ mb: 3, p: 2, bgcolor: 'rgba(167, 139, 250, 0.05)', border: '1px solid rgba(167, 139, 250, 0.3)' }}>
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
                        {tabOrder[activeTab] === 4 && (
                            <Box>
                                <SectionHeader
                                    icon={<MenuBookIcon />}
                                    title="Documentation & API Reference"
                                    subtitle="Complete guide to getting started, API usage, and configuration"
                                />

                                
                                {/* Quick Start Guide */}
                                <Accordion sx={{ mt: 2 }}>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <InfoIcon color="primary" />
                                            <Typography variant="h6">Quick Start Guide</Typography>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
                                            Getting Started in 4 Simple Steps
                                        </Typography>

                                        <Box sx={{ mb: 3, p: 2, bgcolor: 'rgba(34, 211, 238, 0.05)', borderRadius: 1 }}>
                                            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1, color: 'secondary.main' }}>
                                                Step 1: Load a Model
                                            </Typography>
                                            <Typography variant="body2" sx={{ mb: 1 }}>
                                                Go to the "Discover" tab to search and download models, then go to "My Models" tab and click "Load" on your model.
                                            </Typography>
                                            <Typography variant="body2" sx={{ mb: 2, fontSize: '0.8rem', fontStyle: 'italic' }}>
                                                Configure launch settings (GPU layers, context size, batch size) before starting.
                                            </Typography>

                                            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1, mt: 2, color: 'secondary.main' }}>
                                                Step 2: Create API Key (Optional - For External Access)
                                            </Typography>
                                            <Typography variant="body2" sx={{ mb: 1 }}>
                                                The webapp UI requires no authentication. For external API access or OpenWebUI, create an API key in the "API Keys" tab.
                                            </Typography>
                                            <Typography variant="body2" sx={{ mb: 2, fontSize: '0.8rem', fontStyle: 'italic' }}>
                                                Set permissions (query, models, instances, admin) and configure rate limits as needed.
                                            </Typography>

                                            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1, mt: 2, color: 'secondary.main' }}>
                                                Step 3: Install koda CLI (Optional)
                                            </Typography>
                                            <Typography variant="body2" sx={{ mb: 1 }}>
                                                Install the koda CLI for managing AI agents from the terminal:
                                            </Typography>
                                            <Box sx={{ bgcolor: 'rgba(0,0,0,0.3)', p: 2, borderRadius: 1, fontFamily: 'monospace', fontSize: '0.875rem', mb: 1 }}>
                                                curl -sk ${baseUrl}/api/cli/install | bash
                                            </Box>
                                            <Typography variant="body2" sx={{ mb: 1 }}>
                                                Then run: <code style={{ backgroundColor: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 3 }}>koda</code> to enter the interactive shell.
                                            </Typography>
                                            <Typography variant="body2" sx={{ fontSize: '0.8rem', fontStyle: 'italic' }}>
                                                Use /init to configure your API credentials, /help for available commands.
                                            </Typography>

                                            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1, mt: 2, color: 'secondary.main' }}>
                                                Step 4: Start Using Your Models
                                            </Typography>
                                            <Typography variant="body2" component="div">
                                                <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
                                                    <li>Webapp: Use the API Code Builder below</li>
                                                    <li>Open WebUI: Chat interface at {openWebUIUrl}</li>
                                                    <li>External API: cURL, Python, or any HTTP client</li>
                                                </ul>
                                            </Typography>
                                        </Box>
                                    </AccordionDetails>
                                </Accordion>

                                {/* API Builder */}
                                <Accordion>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <VpnKeyIcon color="secondary" />
                                            <Typography variant="h6">API Builder</Typography>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        {/* API Builder */}
                                        <Box sx={{ mb: 4, p: 3, bgcolor: 'rgba(167, 139, 250, 0.05)', borderRadius: 2, border: '1px solid rgba(167, 139, 250, 0.2)' }}>
                                            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2, color: 'primary.main' }}>
                                                API Code Builder
                                            </Typography>
                                            <Grid container spacing={2}>
                                                <Grid item xs={12} md={6}>
                                                    <FormControl fullWidth size="small">
                                                        <InputLabel>Endpoint</InputLabel>
                                                        <Select
                                                            value={apiBuilderEndpoint || '/api/chat'}
                                                            onChange={(e) => setApiBuilderEndpoint(e.target.value)}
                                                            label="Endpoint"
                                                        >
                                                            <MenuItem value="/api/chat">POST /api/chat - Simple Chat</MenuItem>
                                                            <MenuItem value="/api/complete">POST /api/complete - Text Completion</MenuItem>
                                                            <MenuItem value="/api/models">GET /api/models - List Models</MenuItem>
                                                            <MenuItem value="/api/models/pull">POST /api/models/pull - Download Model</MenuItem>
                                                            <MenuItem value="/api/models/:name/load">POST /api/models/:name/load - Load Model</MenuItem>
                                                            <MenuItem value="/api/models/:name">DELETE /api/models/:name - Delete Model</MenuItem>
                                                            <MenuItem value="/api/vllm/instances">GET /api/vllm/instances - List Instances</MenuItem>
                                                            <MenuItem value="/api/vllm/instances/:name">DELETE /api/vllm/instances/:name - Stop Instance</MenuItem>
                                                            <MenuItem disabled>─── Apps Management ───</MenuItem>
                                                            <MenuItem value="/api/apps">GET /api/apps - List Apps</MenuItem>
                                                            <MenuItem value="/api/apps/:name/start">POST /api/apps/:name/start - Start App</MenuItem>
                                                            <MenuItem value="/api/apps/:name/stop">POST /api/apps/:name/stop - Stop App</MenuItem>
                                                            <MenuItem value="/api/apps/:name/restart">POST /api/apps/:name/restart - Restart App</MenuItem>
                                                            <MenuItem disabled>─── Agents System ───</MenuItem>
                                                            <MenuItem value="/api/agents">GET /api/agents - List Agents</MenuItem>
                                                            <MenuItem value="/api/agents/create">POST /api/agents - Create Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id">GET /api/agents/:id - Get Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id/update">PUT /api/agents/:id - Update Agent</MenuItem>
                                                            <MenuItem value="/api/agents/:id/delete">DELETE /api/agents/:id - Delete Agent</MenuItem>
                                                            <MenuItem value="/api/skills">GET /api/skills - List Skills</MenuItem>
                                                            <MenuItem value="/api/tasks">GET /api/tasks - List Tasks</MenuItem>
                                                            <MenuItem value="/api/tasks/create">POST /api/tasks - Create Task</MenuItem>
                                                            <MenuItem value="/api/agent-permissions">GET /api/agent-permissions - Get Permissions</MenuItem>
                                                        </Select>
                                                    </FormControl>
                                                </Grid>
                                                <Grid item xs={12} md={6}>
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

                                        <Divider sx={{ my: 3 }} />

                                        {/* Endpoint Examples */}
                                        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
                                            POST /api/chat - Simple Chat Endpoint
                                        </Typography>
                                        <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
                                            Send a chat message to a running model with easy request/response format. Automatically routes to the first running model if no model specified.
                                        </Typography>
                                        <Box sx={{ bgcolor: '#09090b', p: 2, borderRadius: 1, mb: 2 }}>
                                            <pre style={{ margin: 0, color: '#22c55e', fontSize: '0.75rem', overflow: 'auto' }}>
{`# Bearer Token Authentication
curl -X POST ${baseUrl}/api/chat \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Explain quantum computing",
    "model": "Llama-2-7B",
    "temperature": 0.7,
    "maxTokens": 500
  }'

# OR API Key + Secret Authentication
curl -X POST ${baseUrl}/api/chat \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Explain quantum computing",
    "model": "Llama-2-7B",
    "temperature": 0.7,
    "maxTokens": 500
  }'`}
                                            </pre>
                                        </Box>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>Response:</Typography>
                                        <Box sx={{ bgcolor: '#09090b', p: 2, borderRadius: 1, mt: 1, mb: 3 }}>
                                            <pre style={{ margin: 0, color: '#a78bfa', fontSize: '0.75rem' }}>
{`{
  "success": true,
  "response": "Quantum computing is...",
  "model": "Llama-2-7B",
  "tokens": {
    "prompt_tokens": 5,
    "completion_tokens": 150,
    "total_tokens": 155
  }
}`}
                                            </pre>
                                        </Box>

                                        <Divider sx={{ my: 3 }} />

                                        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
                                            POST /api/complete - Text Completion
                                        </Typography>
                                        <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
                                            Generate text completion for a prompt. Perfect for completion tasks without chat formatting.
                                        </Typography>
                                        <Box sx={{ bgcolor: '#09090b', p: 2, borderRadius: 1, mb: 3 }}>
                                            <pre style={{ margin: 0, color: '#22c55e', fontSize: '0.75rem', overflow: 'auto' }}>
{`# Bearer Token Authentication
curl -X POST ${baseUrl}/api/complete \\
  -H "Authorization: Bearer your_bearer_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "The capital of France is",
    "model": "Llama-2-7B",
    "maxTokens": 50
  }'

# OR API Key + Secret Authentication
curl -X POST ${baseUrl}/api/complete \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "The capital of France is",
    "model": "Llama-2-7B",
    "maxTokens": 50
  }'`}
                                            </pre>
                                        </Box>

                                        <Divider sx={{ my: 3 }} />

                                        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
                                            GET /api/models - List All Models
                                        </Typography>
                                        <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
                                            Retrieve all downloaded models with status, running instances, configuration, and port information.
                                        </Typography>
                                        <Box sx={{ bgcolor: '#09090b', p: 2, borderRadius: 1, mb: 3 }}>
                                            <pre style={{ margin: 0, color: '#22c55e', fontSize: '0.75rem', overflow: 'auto' }}>
{`# Bearer Token Authentication
curl -X GET ${baseUrl}/api/models \\
  -H "Authorization: Bearer your_bearer_token"

# OR API Key + Secret Authentication
curl -X GET ${baseUrl}/api/models \\
  -H "X-API-Key: your_api_key" \\
  -H "X-API-Secret: your_api_secret"`}
                                            </pre>
                                        </Box>

                                    </AccordionDetails>
                                </Accordion>

                                {/* Configuration Flags */}
                                <Accordion>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <SettingsIcon color="primary" />
                                            <Typography variant="h6">Configuration Flags Reference</Typography>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <TableContainer>
                                            <Table size="small">
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell><strong>Flag</strong></TableCell>
                                                        <TableCell><strong>Type</strong></TableCell>
                                                        <TableCell><strong>Default</strong></TableCell>
                                                        <TableCell><strong>Description</strong></TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>maxModelLen</TableCell>
                                                        <TableCell>integer</TableCell>
                                                        <TableCell>4096</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.maxModelLen}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>cpuOffloadGb</TableCell>
                                                        <TableCell>float</TableCell>
                                                        <TableCell>0</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.cpuOffloadGb}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>gpuMemoryUtilization</TableCell>
                                                        <TableCell>float</TableCell>
                                                        <TableCell>0.9</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.gpuMemoryUtilization}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>tensorParallelSize</TableCell>
                                                        <TableCell>integer</TableCell>
                                                        <TableCell>1</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.tensorParallelSize}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>maxNumSeqs</TableCell>
                                                        <TableCell>integer</TableCell>
                                                        <TableCell>256</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.maxNumSeqs}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>kvCacheDtype</TableCell>
                                                        <TableCell>string</TableCell>
                                                        <TableCell>auto</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.kvCacheDtype} (Options: auto, fp8)</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>trustRemoteCode</TableCell>
                                                        <TableCell>boolean</TableCell>
                                                        <TableCell>true</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.trustRemoteCode}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>enforceEager</TableCell>
                                                        <TableCell>boolean</TableCell>
                                                        <TableCell>false</TableCell>
                                                        <TableCell>{SETTINGS_TOOLTIPS.enforceEager}</TableCell>
                                                    </TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                    </AccordionDetails>
                                </Accordion>

                                {/* API Endpoints */}
                                <Accordion>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <StorageIcon color="secondary" />
                                            <Typography variant="h6">API Endpoints</Typography>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <TableContainer>
                                            <Table size="small">
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell><strong>Endpoint</strong></TableCell>
                                                        <TableCell><strong>Method</strong></TableCell>
                                                        <TableCell><strong>Description</strong></TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    {/* Query Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(167, 139, 250, 0.1)', fontWeight: 600 }}>
                                                            Query Endpoints (query permission)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/chat</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Send chat messages to running models with automatic routing and streaming support</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/complete</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Generate text completions from prompts without chat formatting</TableCell>
                                                    </TableRow>

                                                    {/* Models Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(34, 211, 238, 0.1)', fontWeight: 600 }}>
                                                            Model Management Endpoints (models permission)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/models</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all downloaded models with status, port info, and configuration details</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/models/pull</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Download GGUF models from HuggingFace repositories with progress tracking</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/models/:name/load</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Start a vLLM instance for a model with custom GPU, context, and performance settings</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/models/:name</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Stop running instance and permanently delete model files from disk</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/downloads</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List active model downloads with progress information</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/downloads/:downloadId</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Cancel an active model download</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/huggingface/search</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Search HuggingFace for GGUF models with filtering and ranking</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/huggingface/files/:owner/:repo</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List available GGUF files in a HuggingFace repository</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/system-prompts</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all system prompts for all models</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/system-prompts/:modelName</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get system prompt for a specific model</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/system-prompts/:modelName</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update system prompt for a specific model</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/system-prompts/:modelName</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Delete system prompt for a specific model</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/model-configs</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all model configurations</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/model-configs/:modelName</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get configuration for a specific model</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/model-configs/:modelName</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update configuration for a specific model</TableCell>
                                                    </TableRow>

                                                    {/* Instances Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', fontWeight: 600 }}>
                                                            Instance Management Endpoints (instances permission)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/vllm/instances</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all running vLLM instances with port assignments and status information</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/vllm/instances/:name</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Stop and remove a specific vLLM Docker container instance</TableCell>
                                                    </TableRow>

                                                    {/* Admin Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(239, 68, 68, 0.1)', fontWeight: 600 }}>
                                                            Admin Endpoints (admin permission)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/api-keys</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List API keys (without secrets) with usage statistics</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/api-keys</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Create new API key with specified permissions and rate limits</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/api-keys/:id</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update an existing API key's settings</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/api-keys/:id/revoke</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Revoke (deactivate) an API key</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/api-keys/:id</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Permanently delete an API key</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/api-keys/:id/stats</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get usage statistics for a specific API key</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/system/reset</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Reset system - delete all models and data</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/apps</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List managed applications (Open WebUI)</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/apps/:name/start</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Start an application service</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/apps/:name/stop</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Stop an application service</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/apps/:name/restart</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Restart an application service</TableCell>
                                                    </TableRow>

                                                    {/* Agents Permission */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(139, 92, 246, 0.1)', fontWeight: 600 }}>
                                                            Agent Management Endpoints (agents permission)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agents</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all AI agents</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agents/:id</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get a single agent by ID</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agents</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Create new AI agent</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agents/:id</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update agent configuration</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agents/:id</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Delete an agent</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agents/:id/regenerate-key</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Regenerate agent API key</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/skills</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all agent skills</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/skills/:id</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get a single skill by ID</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/skills</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Create new skill</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/skills/:id</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update skill definition</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/skills/:id</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Delete a skill</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/tasks</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List all agent tasks</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/tasks/:id</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get a single task by ID</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/tasks</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Create new task for an agent</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/tasks/:id</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update task status or details</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/tasks/:id</TableCell>
                                                        <TableCell>DELETE</TableCell>
                                                        <TableCell>Delete a task</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent-permissions</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get global agent permissions</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent-permissions</TableCell>
                                                        <TableCell>PUT</TableCell>
                                                        <TableCell>Update global agent permissions</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent/file/read</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Read file (for agent file operations)</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent/file/write</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Write file (for agent file operations)</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent/file/delete</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Delete file (for agent file operations)</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent/file/list</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>List directory contents (for agent file operations)</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/agent/file/move</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Move/rename file (for agent file operations)</TableCell>
                                                    </TableRow>

                                                    {/* Instance Slots */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(34, 197, 94, 0.15)', fontWeight: 600 }}>
                                                            KV Cache Slot Management (instances permission)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/vllm/instances/:name/slots</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get KV cache slot status for a model instance</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/vllm/instances/:name/slots/clear</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>Clear KV cache slots for a model instance</TableCell>
                                                    </TableRow>

                                                    {/* Public Endpoints */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(156, 163, 175, 0.1)', fontWeight: 600 }}>
                                                            Public Endpoints (no authentication required)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/api/cli/install</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Get koda CLI installation script</TableCell>
                                                    </TableRow>

                                                    {/* vLLM Instance APIs */}
                                                    <TableRow>
                                                        <TableCell colSpan={3} sx={{ bgcolor: 'rgba(251, 191, 36, 0.1)', fontWeight: 600 }}>
                                                            vLLM Instance APIs (OpenAI-compatible on ports 8001+)
                                                        </TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/v1/chat/completions</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>OpenAI-compatible chat completions on vLLM instance ports</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/v1/completions</TableCell>
                                                        <TableCell>POST</TableCell>
                                                        <TableCell>OpenAI-compatible text completions on vLLM instance ports</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/v1/models</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>List models available on vLLM instance</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>/health</TableCell>
                                                        <TableCell>GET</TableCell>
                                                        <TableCell>Health check endpoint for vLLM instance</TableCell>
                                                    </TableRow>
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                    </AccordionDetails>
                                </Accordion>

                                {/* System Reset */}
                                <Accordion>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <WarningIcon color="error" />
                                            <Typography variant="h6">System Reset</Typography>
                                        </Box>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <Alert severity="warning" sx={{ mb: 2 }}>
                                            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                                                Danger Zone
                                            </Typography>
                                            <Typography variant="body2">
                                                This will stop all instances, delete all models, and clean up Docker resources. API keys and configuration will be preserved.
                                            </Typography>
                                        </Alert>
                                        <Button
                                            variant="outlined"
                                            color="error"
                                            onClick={() => setResetDialogOpen(true)}
                                            fullWidth
                                        >
                                            Reset System
                                        </Button>
                                    </AccordionDetails>
                                </Accordion>
                            </Box>
                        )}

                        {/* Logs Tab */}
                        {tabOrder[activeTab] === 5 && (
                            <Card sx={{ height: 'calc(100vh - 220px)' }}>
                                <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                                    <SectionHeader
                                        icon={<TerminalIcon />}
                                        title="Process Logs"
                                        subtitle="Real-time logs from model downloads and instance operations"
                                        action={
                                            <Button
                                                size="small"
                                                variant="outlined"
                                                onClick={() => setLogs([])}
                                                startIcon={<ClearIcon />}
                                            >
                                                Clear
                                            </Button>
                                        }
                                    />
                                    <Paper
                                        ref={logsContainerRef}
                                        onScroll={handleLogsScroll}
                                        sx={{
                                            flex: 1,
                                            p: 2,
                                            mt: 2,
                                            overflow: 'auto',
                                            bgcolor: '#000',
                                            borderRadius: 1,
                                            border: '1px solid',
                                            borderColor: 'divider',
                                        }}
                                    >
                                        {logs.length === 0 ? (
                                            <Typography sx={{
                                                fontFamily: '"Fira Code", monospace',
                                                fontSize: '0.8125rem',
                                                color: 'text.secondary',
                                            }}>
                                                Waiting for activity...
                                            </Typography>
                                        ) : (
                                            logs.map((log, index) => {
                                                const message = typeof log === 'string' ? log : log.message;
                                                const level = typeof log === 'string' ? 'info' : log.level;
                                                const color = level === 'error' ? '#ef4444' :
                                                              level === 'success' ? '#22c55e' :
                                                              level === 'warning' ? '#f59e0b' :
                                                              '#a1a1aa';
                                                return (
                                                    <Typography
                                                        key={index}
                                                        sx={{
                                                            fontFamily: '"Fira Code", monospace',
                                                            fontSize: '0.8125rem',
                                                            color: color,
                                                            mb: 0.25,
                                                            lineHeight: 1.5,
                                                            whiteSpace: 'pre-wrap',
                                                            wordBreak: 'break-all',
                                                        }}
                                                    >
                                                        {message}
                                                    </Typography>
                                                );
                                            })
                                        )}
                                        <div ref={logsEndRef} />
                                    </Paper>
                                </CardContent>
                            </Card>
                        )}

                        {/* Apps Tab */}
                        {tabOrder[activeTab] === 6 && (
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
                                                                                        Created: {new Date(skill.createdAt).toLocaleDateString()}
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
