// MUI-compatible wrapper around lucide-react icons so the sweep across
// App.js (~46 icon imports, hundreds of usage sites) is a one-line
// import-path change instead of a per-site rewrite.
//
// Each export accepts MUI's common icon props — sx={{ fontSize, color
// }}, fontSize="small|inherit", className — translates them to
// lucide's API (size + strokeWidth + style + className), and renders
// the corresponding lucide glyph.
//
// For icons not in lucide we fall back to the MUI Material Icon so the
// rest of the page doesn't break; sweep those individually when their
// host tab gets ported.

import React from 'react';
import {
    Menu as LucideMenu,
    Trash2 as LucideTrash,
    Pencil as LucidePencil,
    Download as LucideDownload,
    RefreshCw as LucideRefresh,
    CheckCircle2 as LucideCheck,
    AlertTriangle as LucideWarning,
    Play as LucidePlay,
    Square as LucideSquare,
    Search as LucideSearch,
    Settings as LucideSettings,
    HardDrive as LucideHardDrive,
    Terminal as LucideTerminal,
    ChevronDown as LucideChevronDown,
    ChevronUp as LucideChevronUp,
    Save as LucideSave,
    X as LucideX,
    Cpu as LucideCpu,
    MessageSquare as LucideMessage,
    Sliders as LucideSliders,
    Info as LucideInfo,
    HelpCircle as LucideHelp,
    BookOpen as LucideBook,
    Filter as LucideFilter,
    KeyRound as LucideKey,
    Copy as LucideCopy,
    Eye as LucideEye,
    EyeOff as LucideEyeOff,
    Plus as LucidePlus,
    Mail as LucideMail,
    GripVertical as LucideGrip,
    ArrowLeft as LucideArrowLeft,
    ArrowRight as LucideArrowRight,
    ArrowUp as LucideArrowUp,
    ArrowDown as LucideArrowDown,
    ChevronLeft as LucideChevronLeft,
    ChevronRight as LucideChevronRight,
    LayoutGrid as LucideGrid,
    Ban as LucideBan,
    Code2 as LucideCode,
    Sparkles as LucideSparkles,
    Heart as LucideHeart,
    UserCircle as LucideUserCircle,
    Users as LucideUsers,
    LogOut as LucideLogout,
} from 'lucide-react';

// Translate MUI icon props → lucide props.
//   sx.fontSize → size (number)
//   sx.color    → style.color
//   fontSize="small" → size 18; fontSize="medium" → 22; "large" → 28
//   sx other rules    → style spread (best-effort; nested selectors
//                        like '&:hover' just get dropped — they don't
//                        apply to icon glyphs anyway)
//
// strokeWidth defaults to 1.75 to match the chat:3002 line weight.
function adapt(LucideIcon) {
    return function MuiCompatIcon({
        sx,
        fontSize: fontSizeProp,
        size,
        strokeWidth = 1.75,
        style,
        ...rest
    }) {
        let resolvedSize = size;
        let extraStyle = {};

        if (sx && typeof sx === 'object') {
            for (const [k, v] of Object.entries(sx)) {
                if (k === 'fontSize' && (typeof v === 'number' || typeof v === 'string')) {
                    if (typeof v === 'number') resolvedSize = resolvedSize ?? v;
                } else if (k === 'color') {
                    extraStyle.color = v;
                } else if (k === 'opacity') {
                    extraStyle.opacity = v;
                } else if (typeof v !== 'object') {
                    // Pass through scalar style props (mr, ml, etc. won't render
                    // here but won't break either).
                }
            }
        }

        if (resolvedSize == null) {
            if (fontSizeProp === 'small')      resolvedSize = 18;
            else if (fontSizeProp === 'large') resolvedSize = 28;
            else if (fontSizeProp === 'inherit') resolvedSize = 'inherit';
            else                                 resolvedSize = 22;
        }

        return (
            <LucideIcon
                size={resolvedSize === 'inherit' ? undefined : resolvedSize}
                strokeWidth={strokeWidth}
                style={{ ...extraStyle, ...style, verticalAlign: 'middle' }}
                {...rest}
            />
        );
    };
}

// Each MUI icon name kept as the export so App.js's existing
// <DeleteIcon /> / <EditIcon /> / etc. usage just works after the
// import path swap.
export const MenuIcon            = adapt(LucideMenu);
export const DeleteIcon          = adapt(LucideTrash);
export const EditIcon            = adapt(LucidePencil);
export const CloudDownloadIcon   = adapt(LucideDownload);
export const RefreshIcon         = adapt(LucideRefresh);
export const CheckCircleIcon     = adapt(LucideCheck);
export const WarningIcon         = adapt(LucideWarning);
export const PlayArrowIcon       = adapt(LucidePlay);
export const StopIcon            = adapt(LucideSquare);
export const SearchIcon          = adapt(LucideSearch);
export const SettingsIcon        = adapt(LucideSettings);
export const StorageIcon         = adapt(LucideHardDrive);
export const TerminalIcon        = adapt(LucideTerminal);
export const ExpandMoreIcon      = adapt(LucideChevronDown);
export const ExpandLessIcon      = adapt(LucideChevronUp);
export const SaveIcon            = adapt(LucideSave);
export const ClearIcon           = adapt(LucideX);
export const MemoryIcon          = adapt(LucideCpu);
export const ChatIcon            = adapt(LucideMessage);
export const TuneIcon            = adapt(LucideSliders);
export const InfoIcon            = adapt(LucideInfo);
export const HelpOutlineIcon     = adapt(LucideHelp);
export const MenuBookIcon        = adapt(LucideBook);
export const FilterListIcon      = adapt(LucideFilter);
export const VpnKeyIcon          = adapt(LucideKey);
export const ContentCopyIcon     = adapt(LucideCopy);
export const VisibilityIcon      = adapt(LucideEye);
export const VisibilityOffIcon   = adapt(LucideEyeOff);
export const AddIcon             = adapt(LucidePlus);
export const EmailIcon           = adapt(LucideMail);
export const DragIndicatorIcon   = adapt(LucideGrip);
export const ArrowBackIcon       = adapt(LucideArrowLeft);
export const ArrowForwardIcon    = adapt(LucideArrowRight);
export const ArrowUpwardIcon     = adapt(LucideArrowUp);
export const ArrowDownwardIcon   = adapt(LucideArrowDown);
export const NavigateBeforeIcon  = adapt(LucideChevronLeft);
export const NavigateNextIcon    = adapt(LucideChevronRight);
export const AppsIcon            = adapt(LucideGrid);
export const CancelIcon          = adapt(LucideBan);
export const RestartAltIcon      = adapt(LucideRefresh);
export const CodeIcon            = adapt(LucideCode);
export const AutoAwesomeIcon     = adapt(LucideSparkles);
export const FavoriteIcon        = adapt(LucideHeart);
export const AccountCircleIcon   = adapt(LucideUserCircle);
export const PeopleIcon          = adapt(LucideUsers);
export const LogoutIcon          = adapt(LucideLogout);
