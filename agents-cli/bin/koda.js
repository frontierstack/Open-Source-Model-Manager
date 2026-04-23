#!/usr/bin/env node

/**
 * koda CLI
 * Interactive AI assistant for your projects
 */

const readline = require('readline');
const axios = require('axios');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const Diff = require('diff');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.koda');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Colors for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

function colorize(text, color) {
    return `${colors[color] || ''}${text}${colors.reset}`;
}

// Quiet logging - only show user-relevant messages
let quietMode = true;

// Chat history for improved UI
const chatHistory = [];
const MAX_HISTORY = 50;

// Mode tracking
let websearchMode = false; // Web search enhancement mode
let lastWebModeError = false; // Track if last skill failure was due to web mode requirement
let cachedSkills = []; // Cache last successful skills fetch for resilience
const conversationContext = []; // For session awareness
let userWorkingDirectory = process.cwd(); // Track user's CWD

// Token and context tracking
let lastTokenUsage = { prompt: 0, completion: 0, total: 0 };
let totalTokensUsed = 0;
let contextWindowUsed = 0;
let contextWindowLimit = 4096; // Default, will be updated from API
let lastApiCallStartTime = 0;
let lastApiCallEndTime = 0;
let lastTokensPerSecond = 0;

// API key usage tracking (from server)
let apiKeyUsage = {
    dailyTokens: 0,
    rateLimitTokens: null,
    rateLimitRequests: null,
    tokenUsagePercentage: 0,
    name: null
};

// Multi-file awareness - working set tracking
let workingFiles = new Map(); // Map of filePath -> { content, lastModified, size, inFocus }
const MAX_WORKING_FILES = 20; // Maximum files in working set
let focusMode = false; // If true, only focused files are included in context
let focusFiles = new Set(); // Set of file paths that are focused

// Performance optimizations
let skillPromptCache = null; // Cache for skill system prompt
let skillPromptCacheTime = 0; // Timestamp when cache was built
const SKILL_PROMPT_CACHE_TTL = 300000; // 5 minutes

// ============================================================================
// CODE QUALITY METRICS
// ============================================================================

// Analyze code complexity and quality
function analyzeCodeQuality(content, filePath) {
    const ext = path.extname(filePath);
    const lines = content.split('\n');
    const metrics = {
        totalLines: lines.length,
        codeLines: 0,
        commentLines: 0,
        blankLines: 0,
        functions: 0,
        classes: 0,
        todos: [],
        longFunctions: [],
        complexityScore: 0,
        issues: []
    };

    let inBlockComment = false;
    let currentFunction = null;
    let functionStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Blank lines
        if (!trimmed) {
            metrics.blankLines++;
            continue;
        }

        // Comments
        if (['.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp'].includes(ext)) {
            if (trimmed.startsWith('/*')) inBlockComment = true;
            if (inBlockComment) {
                metrics.commentLines++;
                if (trimmed.endsWith('*/')) inBlockComment = false;
                continue;
            }
            if (trimmed.startsWith('//')) {
                metrics.commentLines++;
                // Check for TODOs
                if (/TODO|FIXME|HACK|XXX/i.test(line)) {
                    metrics.todos.push({ line: i + 1, text: trimmed });
                }
                continue;
            }
        } else if (['.py'].includes(ext)) {
            if (trimmed.startsWith('#')) {
                metrics.commentLines++;
                if (/TODO|FIXME|HACK|XXX/i.test(line)) {
                    metrics.todos.push({ line: i + 1, text: trimmed });
                }
                continue;
            }
        }

        metrics.codeLines++;

        // Function detection
        if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
            if (/function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|=>\s*{/.test(line)) {
                if (currentFunction) {
                    const functionLength = i - functionStartLine;
                    if (functionLength > 50) {
                        metrics.longFunctions.push({
                            name: currentFunction,
                            startLine: functionStartLine + 1,
                            length: functionLength
                        });
                    }
                }
                metrics.functions++;
                const match = line.match(/function\s+(\w+)|const\s+(\w+)\s*=/);
                currentFunction = match ? (match[1] || match[2]) : 'anonymous';
                functionStartLine = i;
            }
            if (/class\s+\w+/.test(line)) metrics.classes++;
        } else if (['.py'].includes(ext)) {
            if (/def\s+\w+/.test(line)) {
                if (currentFunction) {
                    const functionLength = i - functionStartLine;
                    if (functionLength > 50) {
                        metrics.longFunctions.push({
                            name: currentFunction,
                            startLine: functionStartLine + 1,
                            length: functionLength
                        });
                    }
                }
                metrics.functions++;
                const match = line.match(/def\s+(\w+)/);
                currentFunction = match ? match[1] : 'unknown';
                functionStartLine = i;
            }
            if (/class\s+\w+/.test(line)) metrics.classes++;
        }

        // Complexity indicators
        if (/if|else|for|while|switch|case|catch/.test(line)) metrics.complexityScore++;
    }

    // Calculate final complexity score
    if (metrics.codeLines > 0) {
        metrics.complexityScore = (metrics.complexityScore / metrics.codeLines * 100).toFixed(2);
    }

    // Generate issues
    if (metrics.totalLines > 1000) {
        metrics.issues.push('File is very long (>1000 lines) - consider splitting');
    }
    if (metrics.longFunctions.length > 0) {
        metrics.issues.push(`${metrics.longFunctions.length} function(s) are too long (>50 lines)`);
    }
    if (metrics.todos.length > 5) {
        metrics.issues.push(`Many TODOs found (${metrics.todos.length}) - consider addressing them`);
    }
    if (metrics.commentLines / metrics.totalLines < 0.1 && metrics.codeLines > 100) {
        metrics.issues.push('Low comment ratio (<10%) - add more documentation');
    }

    return metrics;
}
// ============================================================================
// CODE REFACTORING TOOLS
// ============================================================================

// Parse JavaScript/TypeScript code into AST
function parseCode(content, filePath) {
    const ext = path.extname(filePath);
    const isTypeScript = ['.ts', '.tsx'].includes(ext);
    const isJSX = ['.jsx', '.tsx'].includes(ext);

    try {
        return parser.parse(content, {
            sourceType: 'module',
            plugins: [
                isTypeScript && 'typescript',
                isJSX && 'jsx',
                'decorators-legacy',
                'classProperties',
                'objectRestSpread',
                'optionalChaining',
                'nullishCoalescingOperator'
            ].filter(Boolean)
        });
    } catch (error) {
        throw new Error(`Failed to parse ${filePath}: ${error.message}`);
    }
}

// Find all references to a symbol in the AST
function findReferences(ast, symbolName) {
    const references = [];

    traverse(ast, {
        Identifier(path) {
            if (path.node.name === symbolName) {
                references.push({
                    line: path.node.loc.start.line,
                    column: path.node.loc.start.column,
                    type: path.parent.type,
                    path: path
                });
            }
        }
    });

    return references;
}

// Extract function from selected lines
function extractFunction(content, filePath, startLine, endLine, functionName) {
    const lines = content.split('\n');

    // Validate line numbers
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
        throw new Error('Invalid line range');
    }

    // Extract the selected code
    const selectedCode = lines.slice(startLine - 1, endLine).join('\n');

    // Parse to analyze variables
    const ast = parseCode(content, filePath);

    // Find variables used in selected code
    const usedVars = new Set();
    const declaredVars = new Set();

    try {
        const selectedAst = parser.parse(selectedCode, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript']
        });

        traverse(selectedAst, {
            Identifier(path) {
                if (path.isReferencedIdentifier()) {
                    usedVars.add(path.node.name);
                }
            },
            VariableDeclarator(path) {
                if (path.node.id.name) {
                    declaredVars.add(path.node.id.name);
                }
            }
        });
    } catch (e) {
        // If parsing fails, continue without variable analysis
    }

    // Parameters are variables used but not declared in selection
    const parameters = Array.from(usedVars).filter(v => !declaredVars.has(v));

    // Detect if code has return statement
    const hasReturn = selectedCode.includes('return ');

    // Generate new function
    const indent = lines[startLine - 1].match(/^\s*/)[0];
    const paramStr = parameters.length > 0 ? parameters.join(', ') : '';
    const newFunction = [
        `${indent}function ${functionName}(${paramStr}) {`,
        selectedCode,
        `${indent}}`
    ].join('\n');

    // Generate function call to replace selected code
    const functionCall = `${indent}${hasReturn ? 'return ' : ''}${functionName}(${paramStr});`;

    // Create new content
    const newLines = [
        ...lines.slice(0, startLine - 1),
        functionCall,
        ...lines.slice(endLine)
    ];

    // Insert function at appropriate location (before the usage)
    const insertLine = Math.max(0, startLine - 2);
    newLines.splice(insertLine, 0, '', newFunction, '');

    return {
        newContent: newLines.join('\n'),
        functionCode: newFunction,
        parameters: parameters,
        hasReturn: hasReturn
    };
}

// Rename symbol across file
function renameSymbol(content, filePath, oldName, newName) {
    const ast = parseCode(content, filePath);
    const references = findReferences(ast, oldName);

    if (references.length === 0) {
        throw new Error(`Symbol '${oldName}' not found in ${filePath}`);
    }

    // Replace all occurrences from end to start (to preserve positions)
    const lines = content.split('\n');
    const sortedRefs = references.sort((a, b) => b.line - a.line || b.column - a.column);

    for (const ref of sortedRefs) {
        const lineIndex = ref.line - 1;
        const line = lines[lineIndex];
        const before = line.substring(0, ref.column);
        const after = line.substring(ref.column + oldName.length);
        lines[lineIndex] = before + newName + after;
    }

    return {
        newContent: lines.join('\n'),
        replacements: references.length,
        locations: references.map(r => ({ line: r.line, column: r.column }))
    };
}

// Move function/class to another file
function moveCode(sourceContent, sourcePath, destPath, symbolName) {
    const ast = parseCode(sourceContent, sourcePath);
    let codeToMove = null;
    let startLine = null;
    let endLine = null;
    let type = null;

    // Find the function or class to move
    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id && path.node.id.name === symbolName) {
                codeToMove = generate(path.node).code;
                startLine = path.node.loc.start.line;
                endLine = path.node.loc.end.line;
                type = 'function';
                path.stop();
            }
        },
        ClassDeclaration(path) {
            if (path.node.id && path.node.id.name === symbolName) {
                codeToMove = generate(path.node).code;
                startLine = path.node.loc.start.line;
                endLine = path.node.loc.end.line;
                type = 'class';
                path.stop();
            }
        },
        VariableDeclaration(path) {
            if (path.node.declarations[0].id.name === symbolName) {
                codeToMove = generate(path.node).code;
                startLine = path.node.loc.start.line;
                endLine = path.node.loc.end.line;
                type = 'variable';
                path.stop();
            }
        }
    });

    if (!codeToMove) {
        throw new Error(`Symbol '${symbolName}' not found in ${sourcePath}`);
    }

    // Remove from source
    const sourceLines = sourceContent.split('\n');
    const newSourceContent = [
        ...sourceLines.slice(0, startLine - 1),
        ...sourceLines.slice(endLine)
    ].join('\n');

    // Determine export statement
    const exportLine = `export { ${symbolName} };`;

    // Determine import statement for source file
    const relativePath = path.relative(path.dirname(sourcePath), destPath).replace(/\\/g, '/');
    const importPath = relativePath.startsWith('.') ? relativePath : './' + relativePath;
    const importLine = `import { ${symbolName} } from '${importPath.replace(/\.\w+$/, '')}';`;

    // Add to destination (create or append)
    let newDestContent = '';
    if (fsSync.existsSync(destPath)) {
        const destContent = fsSync.readFileSync(destPath, 'utf8');
        newDestContent = destContent + '\n\n' + codeToMove + '\n\n' + exportLine;
    } else {
        newDestContent = codeToMove + '\n\n' + exportLine;
    }

    return {
        newSourceContent,
        newDestContent,
        importLine,
        codeToMove,
        type,
        startLine,
        endLine
    };
}

function log(message, color = null) {
    if (color) {
        console.log(colorize(message, color));
    } else {
        console.log(message);
    }
}

function logDim(message) {
    console.log(colorize(message, 'dim'));
}

function logError(message) {
    console.log(colorize('Error: ', 'red') + message);
}

function logSuccess(message) {
    console.log(colorize('✓ ', 'green') + message);
}

function logInfo(message) {
    console.log(colorize('→ ', 'cyan') + message);
}

// ============================================================================
// MODERN ANIMATION SYSTEM
// ============================================================================

// Spinner frames for different animation styles
const spinnerFrames = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    pulse: ['◐', '◓', '◑', '◒'],
    bounce: ['⠁', '⠂', '⠄', '⠂'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
    box: ['▖', '▘', '▝', '▗'],
    arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    line: ['|', '/', '-', '\\'],
    circle: ['◴', '◷', '◶', '◵'],
    brain: ['🧠', '💭', '💡', '✨'],
    wave: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
    glow: ['◯', '◉', '●', '◉'],
    blocks: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎']
};

// Thinking message variations for variety
const thinkingMessages = [
    'Thinking',
    'Processing',
    'Analyzing',
    'Computing',
    'Reasoning',
    'Working',
    'Generating'
];

// Skill-specific messages for better context
const skillThinkingMessages = {
    'create_file': ['Writing file', 'Creating content', 'Generating file'],
    'read_file': ['Reading file', 'Loading content', 'Parsing file'],
    'update_file': ['Updating file', 'Modifying content', 'Applying changes'],
    'delete_file': ['Removing file', 'Deleting content'],
    'list_directory': ['Scanning directory', 'Listing files'],
    'web_search': ['Searching web', 'Finding results', 'Querying search'],
    'fetch_url': ['Fetching page', 'Loading content', 'Downloading'],
    'git_status': ['Checking repo', 'Getting status'],
    'git_diff': ['Computing diff', 'Comparing changes'],
    'create_pdf': ['Generating PDF', 'Creating document'],
    'run_python': ['Executing script', 'Running Python'],
    'run_bash': ['Executing command', 'Running shell']
};

// Current animation state
let activeAnimation = null;
let animationInterval = null;
let animationFrameIndex = 0;
let animationStartTime = 0;

// Start an animated spinner with a message
function startAnimation(message, style = 'dots', options = {}) {
    stopAnimation(); // Stop any existing animation

    const frames = spinnerFrames[style] || spinnerFrames.dots;
    const { color = 'cyan', showElapsed = true, prefix = '' } = options;

    animationFrameIndex = 0;
    animationStartTime = Date.now();

    // Store the initial cursor position by saving the message line
    activeAnimation = {
        message,
        frames,
        style,
        color,
        showElapsed,
        prefix,
        line: ''
    };

    // Write initial frame
    const frame = frames[0];
    activeAnimation.line = `${prefix}${colorize(frame, color)} ${colorize(message, 'white')}`;
    process.stdout.write(activeAnimation.line);

    // Start the animation interval
    animationInterval = setInterval(() => {
        if (!activeAnimation) return;

        animationFrameIndex = (animationFrameIndex + 1) % frames.length;
        const frame = frames[animationFrameIndex];
        const elapsed = ((Date.now() - animationStartTime) / 1000).toFixed(1);

        // Clear the current line and rewrite
        process.stdout.write('\r\x1b[K'); // Clear line

        const timeDisplay = showElapsed ? ` ${colorize(`${elapsed}s`, 'dim')}` : '';
        activeAnimation.line = `${prefix}${colorize(frame, color)} ${colorize(activeAnimation.message, 'white')}${timeDisplay}`;
        process.stdout.write(activeAnimation.line);
    }, 80);

    return activeAnimation;
}

// Stop the current animation and clear the line
function stopAnimation(clearLine = true) {
    if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
    }
    if (activeAnimation && clearLine) {
        process.stdout.write('\r\x1b[K'); // Clear the animation line
    }
    activeAnimation = null;
}

// Update the animation message (for skill execution progress)
function updateAnimationMessage(newMessage, newColor = null) {
    if (!activeAnimation) return;

    activeAnimation.message = newMessage;
    if (newColor) activeAnimation.color = newColor;

    const frame = activeAnimation.frames[animationFrameIndex];
    const elapsed = ((Date.now() - animationStartTime) / 1000).toFixed(1);
    const timeDisplay = activeAnimation.showElapsed ? ` ${colorize(`${elapsed}s`, 'dim')}` : '';

    process.stdout.write('\r\x1b[K');
    activeAnimation.line = `${activeAnimation.prefix}${colorize(frame, activeAnimation.color)} ${colorize(newMessage, 'white')}${timeDisplay}`;
    process.stdout.write(activeAnimation.line);
}

// Show a brief completion indicator with modern styling
function showCompletionFlash(message, success = true, details = null) {
    const icon = success ? colorize('✓', 'green') : colorize('✗', 'red');
    const msgColor = success ? 'green' : 'red';
    let output = `\r\x1b[K${icon} ${colorize(message, msgColor)}`;
    if (details) {
        output += colorize(` → ${details}`, 'dim');
    }
    process.stdout.write(output + '\n');
}

// Show a subtle info message
function showInfoFlash(message, icon = '[i]') {
    process.stdout.write(`\r\x1b[K${colorize(icon, 'cyan')} ${colorize(message, 'dim')}\n`);
}

// ============================================================================
// TOOL-CALL TRAIL (Claude Code / Gemini CLI style)
// ============================================================================

// Short action label used as the verb in "● Action(target)"
function skillActionLabel(skillName) {
    const map = {
        create_file: 'Write', update_file: 'Edit', read_file: 'Read',
        delete_file: 'Delete', append_to_file: 'Append', move_file: 'Move',
        copy_file: 'Copy', list_directory: 'List', create_directory: 'Mkdir',
        delete_directory: 'Rmdir', tail_file: 'Tail', head_file: 'Head',
        search_files: 'Search', search_replace_file: 'Replace',
        diff_files: 'Diff', download_file: 'Download',
        get_file_metadata: 'Stat',
        git_status: 'Git', git_diff: 'Git', git_log: 'Git', git_branch: 'Git',
        web_search: 'WebSearch', fetch_url: 'Fetch',
        playwright_fetch: 'Fetch', playwright_interact: 'Browse',
        run_bash: 'Bash', run_python: 'Python',
        run_powershell: 'PowerShell', run_cmd: 'Cmd',
        dns_lookup: 'DNS', check_port: 'Port', ping_host: 'Ping',
        http_request: 'HTTP', curl_request: 'Curl',
        list_processes: 'Processes', list_ports: 'Ports',
        list_services: 'Services', system_info: 'SysInfo',
        disk_usage: 'Disk', read_pdf: 'Read', create_pdf: 'Write',
        html_to_pdf: 'Render', markdown_to_html: 'Render',
        sqlite_query: 'SQL', sqlite_list_tables: 'SQL',
        parse_json: 'Parse', parse_csv: 'Parse',
        base64_encode: 'Encode', base64_decode: 'Decode',
        hash_data: 'Hash', zip_files: 'Zip', unzip_file: 'Unzip',
        tar_create: 'Tar', tar_extract: 'Untar', extract_archive: 'Extract',
        ocr_image: 'OCR', screenshot: 'Screenshot', convert_image: 'Convert',
        read_email_file: 'ReadEmail'
    };
    if (map[skillName]) return map[skillName];
    return skillName.split('_')
        .map(w => w ? w[0].toUpperCase() + w.slice(1) : '')
        .join('');
}

// Reduce the skill's params to a compact "(target)" string
function summarizeSkillTarget(skillName, params) {
    params = params || {};
    const rel = (p) => (p || '').replace(userWorkingDirectory, '.');
    if (params.filePath) return rel(params.filePath);
    if (params.path) return rel(params.path);
    if (params.source && params.destination) return `${rel(params.source)} → ${rel(params.destination)}`;
    if (params.dirPath || params.directory) return rel(params.dirPath || params.directory);
    if (params.url) {
        try { return new URL(params.url).hostname; } catch { return String(params.url).slice(0, 60); }
    }
    if (params.query) {
        const q = String(params.query);
        return `"${q.slice(0, 40)}${q.length > 40 ? '…' : ''}"`;
    }
    if (params.command) return String(params.command).split(/\s+/)[0];
    if (params.host || params.hostname) return params.host || params.hostname;
    if (params.domain) return params.domain;
    if (params.pattern) return `/${String(params.pattern).slice(0, 40)}/`;
    return '';
}

// Build the "⎿ …" one-line summary that appears under the tool call
function summarizeSkillResult(skillName, params, result) {
    if (!result || result.success === false) {
        const err = (result && result.error) ? String(result.error) : 'failed';
        return colorize('✗ ' + err.split('\n')[0].slice(0, 200), 'red');
    }
    const data = (result.data && typeof result.data === 'object') ? result.data : result;
    const rel = (p) => (p || '').replace(userWorkingDirectory, '.');

    switch (skillName) {
        case 'read_file': {
            const content = data.content || '';
            const lineCount = content ? content.split('\n').length : 0;
            const fp = rel(data.filePath || params.filePath);
            return `Read ${lineCount} lines from ${fp}`;
        }
        case 'tail_file':
        case 'head_file': {
            const content = data.content || '';
            const lineCount = content ? content.split('\n').length : 0;
            return `Read ${lineCount} lines`;
        }
        case 'create_file': {
            const lines = (params.content || '').split('\n').length;
            return `Created ${rel(data.filePath || params.filePath)} (${lines} lines)`;
        }
        case 'update_file':
            return `Updated ${rel(data.filePath || params.filePath)}`;
        case 'append_to_file':
            return `Appended to ${rel(data.filePath || params.filePath)}`;
        case 'delete_file':
            return `Deleted ${rel(data.filePath || params.filePath)}`;
        case 'move_file':
            return `Moved to ${rel(data.destination || params.destination || params.dest)}`;
        case 'copy_file':
            return `Copied to ${rel(data.destination || params.destination || params.dest)}`;
        case 'list_directory': {
            const entries = data.entries || data.files || data.items || [];
            const suffix = data.recursive ? ' (recursive)' : '';
            const trunc = data.truncated ? ' (truncated)' : '';
            return `Listed ${entries.length} entries${suffix}${trunc}`;
        }
        case 'create_directory':
            return `Created ${rel(data.dirPath || params.dirPath || params.directory)}`;
        case 'delete_directory':
            return `Removed ${rel(data.dirPath || params.dirPath || params.directory)}`;
        case 'search_files': {
            const matches = data.matches || data.results || [];
            return `Found ${matches.length} matches`;
        }
        case 'web_search': {
            const count = data.count || (data.results || []).length;
            return `Found ${count} results`;
        }
        case 'fetch_url':
        case 'playwright_fetch': {
            const len = (data.content || data.html || '').length;
            return `Fetched ${(len / 1024).toFixed(1)} KB`;
        }
        case 'git_status':
            return `Branch ${data.branch || '?'}${data.dirty ? ' (dirty)' : ''}`;
        case 'git_diff':
        case 'git_log':
        case 'git_branch':
            return 'Done';
        case 'run_bash':
        case 'run_python':
        case 'run_powershell':
        case 'run_cmd': {
            const out = (data.stdout || data.output || '');
            const outLines = out ? out.split('\n').length : 0;
            const code = data.exitCode !== undefined ? ` exit=${data.exitCode}` : '';
            return `Ran command · ${outLines} output lines${code}`;
        }
        case 'dns_lookup':
            return (data.addresses || data.records || []).slice(0, 3).join(', ') || 'Done';
        case 'check_port':
            return data.open ? 'Open' : 'Closed';
        case 'ping_host':
            return data.reachable ? `Reachable (${data.avgTime || '?'}ms)` : 'Unreachable';
        case 'http_request':
        case 'curl_request':
            return `HTTP ${data.status || data.statusCode || '?'}`;
        case 'list_processes': {
            const procs = data.processes || data.list || [];
            return `${procs.length} processes`;
        }
        case 'hash_data':
            return `${params.algorithm || 'sha256'}: ${(data.hash || '').slice(0, 16)}…`;
        case 'base64_encode':
        case 'base64_decode':
            return `${(data.result || '').length} bytes`;
        case 'read_pdf': {
            const pages = data.pageCount || data.pages || '?';
            return `Read PDF · ${pages} pages`;
        }
    }

    // Generic fallbacks
    if (typeof data === 'string') return data.slice(0, 120);
    if (data.summary) return String(data.summary).slice(0, 160);
    if (data.message) return String(data.message).slice(0, 160);
    return 'Done';
}

// Format and print a tool-call trail entry. Also returns the rendered
// block so it can be replayed on redraw.
function renderToolCall(entry) {
    const bulletColor = entry.success ? 'cyan' : 'red';
    const targetStr = entry.target ? colorize(`(${entry.target})`, 'dim') : '';
    // Clear any lingering animation cursor and write a persistent trail block
    process.stdout.write('\r\x1b[K');
    log('  ' + colorize('●', bulletColor) + ' ' +
        colorize(entry.action, 'bright') + targetStr);
    log('    ' + colorize('⎿ ', 'dim') + entry.summary);
}

// Begin a live tool-call render. Writes the action header + an animated
// "⎿ running" line that is rewritten in place when the skill finishes.
// Caller gets back a handle whose finish(result) swaps in the real summary.
// Deliberately touches only the one spinner line on completion so nothing
// goes wrong if the header scrolled off-screen mid-run.
function beginToolCall(skillName, params) {
    const action = skillActionLabel(skillName);
    const target = summarizeSkillTarget(skillName, params);
    const targetStr = target ? colorize(`(${target})`, 'dim') : '';

    // Clear any leftover animation artefact before we start writing.
    process.stdout.write('\r\x1b[K');

    // Fixed header line — stays cyan regardless of outcome; failures show
    // in red inside the ⎿ summary (via summarizeSkillResult).
    log('  ' + colorize('●', 'cyan') + ' ' +
        colorize(action, 'bright') + targetStr);

    const spinner = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let frame = 0;
    const drawFrame = () => {
        const f = spinner[frame++ % spinner.length];
        process.stdout.write('\r\x1b[K' +
            '    ' + colorize('⎿ ', 'dim') +
            colorize(f, 'yellow') + colorize(' working…', 'dim'));
    };
    drawFrame();
    const interval = setInterval(drawFrame, 80);

    return {
        skillName, params, action, target,
        finish(result) {
            clearInterval(interval);
            const entry = {
                skillName,
                action,
                target,
                success: !!(result && result.success !== false),
                summary: summarizeSkillResult(skillName, params, result)
            };
            // Overwrite the animated line in place with the final summary.
            process.stdout.write('\r\x1b[K' +
                '    ' + colorize('⎿ ', 'dim') + entry.summary + '\n');
            chatHistory.push({ role: 'tool', content: entry });
            if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        }
    };
}

// Push a tool-call entry to chatHistory AND render it immediately. The entry
// survives re-renders of the chat history because 'tool' role is rendered by
// displayChatHistory().
function recordToolCall(skillName, params, result) {
    const entry = {
        skillName,
        action: skillActionLabel(skillName),
        target: summarizeSkillTarget(skillName, params),
        success: !!(result && result.success !== false),
        summary: summarizeSkillResult(skillName, params, result)
    };
    chatHistory.push({ role: 'tool', content: entry });
    if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
    renderToolCall(entry);
}

// Get a random thinking message for variety
function getRandomThinkingMessage() {
    return thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
}

// Get a skill-specific thinking message
function getSkillThinkingMessage(skillName) {
    const messages = skillThinkingMessages[skillName];
    if (messages && messages.length > 0) {
        return messages[Math.floor(Math.random() * messages.length)];
    }
    return formatSkillAction(skillName);
}

// Format a skill name for display (e.g., create_file -> "Creating file")
function formatSkillAction(skillName) {
    const actionMap = {
        'create_file': 'Creating file',
        'read_file': 'Reading file',
        'update_file': 'Updating file',
        'delete_file': 'Deleting file',
        'list_directory': 'Listing directory',
        'create_directory': 'Creating directory',
        'delete_directory': 'Deleting directory',
        'move_file': 'Moving file',
        'copy_file': 'Copying file',
        'append_to_file': 'Appending to file',
        'search_files': 'Searching files',
        'tail_file': 'Reading file tail',
        'head_file': 'Reading file head',
        'diff_files': 'Comparing files',
        'search_replace_file': 'Search & replace',
        'download_file': 'Downloading file',
        'get_file_metadata': 'Getting metadata',
        'git_status': 'Checking git status',
        'git_diff': 'Getting git diff',
        'git_log': 'Reading git log',
        'git_branch': 'Listing branches',
        'system_info': 'Getting system info',
        'disk_usage': 'Checking disk usage',
        'list_processes': 'Listing processes',
        'kill_process': 'Stopping process',
        'start_process': 'Starting process',
        'fetch_url': 'Fetching URL',
        'http_request': 'HTTP request',
        'dns_lookup': 'DNS lookup',
        'check_port': 'Checking port',
        'ping_host': 'Pinging host',
        'curl_request': 'Making cURL request',
        'base64_encode': 'Encoding base64',
        'base64_decode': 'Decoding base64',
        'hash_data': 'Computing hash',
        'parse_json': 'Parsing JSON',
        'parse_csv': 'Parsing CSV',
        'compress_data': 'Compressing data',
        'decompress_data': 'Decompressing data',
        'zip_files': 'Creating zip archive',
        'unzip_file': 'Extracting zip',
        'tar_create': 'Creating tar archive',
        'tar_extract': 'Extracting tar',
        'extract_archive': 'Extracting archive',
        'run_bash': 'Running bash command',
        'run_python': 'Running Python',
        'run_powershell': 'Running PowerShell',
        'run_cmd': 'Running command',
        'read_pdf': 'Reading PDF',
        'create_pdf': 'Creating PDF',
        'html_to_pdf': 'Converting to PDF',
        'pdf_page_count': 'Counting PDF pages',
        'sqlite_query': 'Querying database',
        'sqlite_list_tables': 'Listing tables',
        'ocr_image': 'Reading image text',
        'screenshot': 'Taking screenshot',
        'convert_image': 'Converting image',
        'clipboard_read': 'Reading clipboard',
        'clipboard_write': 'Writing clipboard',
        'web_search': 'Searching the web',
        'playwright_fetch': 'Fetching page',
        'playwright_interact': 'Interacting with page',
        'read_email_file': 'Reading email',
        'get_env_var': 'Getting env variable',
        'set_env_var': 'Setting env variable',
        'which_command': 'Locating command',
        'get_uptime': 'Getting uptime',
        'list_ports': 'Listing ports',
        'list_services': 'Listing services',
        'generate_uuid': 'Generating UUID',
        'get_timestamp': 'Getting timestamp',
        'find_patterns': 'Finding patterns',
        'analyze_code': 'Analyzing code'
    };
    return actionMap[skillName] || `Using ${skillName.replace(/_/g, ' ')}`;
}

// Detect if user request is a simple file save/write that should skip web search
function isFileSaveRequest(message) {
    const lowerMsg = message.toLowerCase();

    // Patterns that indicate saving previously generated content
    const savePatterns = [
        /\b(save|put|write|store|export)\b.*(that|this|it)\b.*(to|in|into)\b.*(a\s+)?(file|txt|text|document|report)/i,
        /\b(go\s+ahead|please|can\s+you)\b.*(save|put|write|create)\b.*(file|txt|document)/i,
        /\b(save|write)\b.*(that|it|this)\b/i,
        /\b(create|make)\b.*(a\s+)?(file|txt|report)\b.*(with|from|using)\b.*(that|this|it|the\s+above)/i,
        /\bput\s+(that|this|it)\s+in\s+a\s+file\b/i
    ];

    for (const pattern of savePatterns) {
        if (pattern.test(message)) {
            return true;
        }
    }

    return false;
}

// Add message to chat history
function addToHistory(role, content) {
    chatHistory.push({ role, content });
    if (chatHistory.length > MAX_HISTORY) {
        chatHistory.shift();
    }
}

// ============================================================================
// MODERN UI COMPONENTS
// ============================================================================

// Box drawing characters for modern terminal UI
const boxChars = {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
    leftT: '├',
    rightT: '┤',
    topT: '┬',
    bottomT: '┴',
    cross: '┼'
};

// Get terminal width safely
function getTerminalWidth() {
    return process.stdout.columns || 80;
}

// Draw a modern panel/card with title and content
function drawPanel(title, content, options = {}) {
    const {
        color = 'cyan',
        width = Math.min(getTerminalWidth() - 4, 80),
        padding = 1
    } = options;

    const lines = [];
    const innerWidth = width - 2 - (padding * 2);

    // Top border with title
    const titleStr = title ? ` ${title} ` : '';
    const titleLen = title ? titleStr.length : 0;
    const leftPad = Math.floor((width - 2 - titleLen) / 2);
    const rightPad = width - 2 - titleLen - leftPad;

    lines.push(
        colorize(boxChars.topLeft, color) +
        colorize(boxChars.horizontal.repeat(leftPad), 'dim') +
        (title ? colorize(titleStr, color) : '') +
        colorize(boxChars.horizontal.repeat(rightPad), 'dim') +
        colorize(boxChars.topRight, color)
    );

    // Content lines with word wrapping
    const contentLines = wrapText(content, innerWidth);
    for (const line of contentLines) {
        const paddedLine = ' '.repeat(padding) + line.padEnd(innerWidth) + ' '.repeat(padding);
        lines.push(
            colorize(boxChars.vertical, 'dim') +
            paddedLine +
            colorize(boxChars.vertical, 'dim')
        );
    }

    // Bottom border
    lines.push(
        colorize(boxChars.bottomLeft, color) +
        colorize(boxChars.horizontal.repeat(width - 2), 'dim') +
        colorize(boxChars.bottomRight, color)
    );

    return lines.join('\n');
}

// Word wrap text to fit width
function wrapText(text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        if (currentLine.length + word.length + 1 <= maxWidth) {
            currentLine += (currentLine ? ' ' : '') + word;
        } else {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
        }
    }
    if (currentLine) lines.push(currentLine);

    return lines.length > 0 ? lines : [''];
}

// Draw a progress bar
function drawProgressBar(current, total, width = 30, options = {}) {
    const {
        filledChar = '█',
        emptyChar = '░',
        showPercent = true,
        color = 'cyan'
    } = options;

    const percent = Math.min(100, Math.round((current / total) * 100));
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;

    let bar = colorize(filledChar.repeat(filled), color) + colorize(emptyChar.repeat(empty), 'dim');

    if (showPercent) {
        bar += ` ${colorize(percent + '%', 'white')}`;
    }

    return bar;
}

// Status indicator icons (ASCII-safe for terminal compatibility)
const statusIcons = {
    success: colorize('[ok]', 'green'),
    error: colorize('[x]', 'red'),
    warning: colorize('[!]', 'yellow'),
    info: colorize('[i]', 'cyan'),
    pending: colorize('[ ]', 'dim'),
    running: colorize('[*]', 'cyan'),
    complete: colorize('[+]', 'green')
};

// Draw a status line with icon
function drawStatus(status, message, details = null) {
    const icon = statusIcons[status] || statusIcons.info;
    let line = `${icon} ${message}`;
    if (details) {
        line += colorize(` (${details})`, 'dim');
    }
    return line;
}

// Draw a horizontal separator
function drawSeparator(width = null, char = '─', color = 'dim') {
    const w = width || getTerminalWidth() - 2;
    return colorize(char.repeat(w), color);
}

// Draw a section header
function drawHeader(text, options = {}) {
    const {
        width = getTerminalWidth() - 2,
        color = 'cyan',
        style = 'line' // 'line', 'box', 'minimal'
    } = options;

    if (style === 'box') {
        return drawPanel(text, '', { color, width: Math.min(width, text.length + 10) });
    } else if (style === 'minimal') {
        return colorize(`▸ ${text}`, color);
    } else {
        // Line style (default)
        const textLen = text.length + 2;
        const sideLen = Math.floor((width - textLen) / 2);
        return (
            colorize('─'.repeat(sideLen), 'dim') +
            colorize(` ${text} `, color) +
            colorize('─'.repeat(width - textLen - sideLen), 'dim')
        );
    }
}

// Format skill execution result for display
function formatSkillResult(skillName, result, elapsed = null) {
    const action = formatSkillAction(skillName);
    const timeStr = elapsed ? colorize(` (${elapsed}ms)`, 'dim') : '';

    if (result.success) {
        return `${statusIcons.success} ${colorize(action, 'green')}${timeStr}`;
    } else {
        return `${statusIcons.error} ${colorize(action, 'red')}${timeStr}`;
    }
}

// Format code blocks cleanly without borders for easy copying
function formatCodeBlocks(content) {
    // Match code blocks with ```language or just ```
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

    return content.replace(codeBlockRegex, (match, language, code) => {
        const lang = language || 'code';
        const lines = code.trimEnd().split('\n');

        // Modern header with language badge
        let formatted = '\n' + colorize('╭─', 'dim') + colorize(` ${lang.toUpperCase()} `, 'yellow') + colorize('─'.repeat(Math.max(1, 50 - lang.length)), 'dim') + colorize('╮', 'dim') + '\n';

        // Code lines with subtle left border
        for (const line of lines) {
            formatted += colorize('│ ', 'dim') + line + '\n';
        }

        // Footer
        formatted += colorize('╰' + '─'.repeat(Math.min(54, lang.length + 6)) + '╯', 'dim') + '\n';
        return formatted;
    });
}

// ============================================================================
// Markdown-to-ANSI renderer
// ============================================================================
// Models routinely respond with markdown-flavored text: headers, bullet
// lists, **bold**, `inline code`, fenced code blocks, etc. Before this
// renderer, koda just printed the raw markdown source, which looked like
// an unstructured wall of text in the terminal. This renderer converts the
// common subset to ANSI-styled output and hard-wraps paragraphs to the
// current terminal width with a hanging indent, so responses read like a
// proper article instead of an unreadable blob.
// ============================================================================

// Strip ANSI escape sequences so we can measure visible width for wrapping.
function stripAnsi(str) {
    return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

// Wrap a single logical line (already styled with ANSI) at `width` visible
// characters, indenting the first line with `firstIndent` and subsequent
// wrapped lines with `nextIndent`. Preserves ANSI codes across wraps by
// splitting on whitespace only.
function wrapAnsiLine(text, width, firstIndent = '', nextIndent = '') {
    if (!text) return firstIndent;
    const words = text.split(/(\s+)/).filter(w => w.length > 0);
    const lines = [];
    let current = firstIndent;
    let currentVis = stripAnsi(firstIndent).length;
    const firstVisLen = currentVis;

    for (const w of words) {
        if (/^\s+$/.test(w)) {
            // Only keep one space between words, and only if we're not at
            // the start of a fresh line.
            if (currentVis > stripAnsi(lines.length === 0 ? firstIndent : nextIndent).length) {
                current += ' ';
                currentVis += 1;
            }
            continue;
        }
        const wLen = stripAnsi(w).length;
        if (currentVis + wLen > width && currentVis > firstVisLen) {
            // Trim trailing space before wrap
            lines.push(current.replace(/\s+$/, ''));
            current = nextIndent + w;
            currentVis = stripAnsi(nextIndent).length + wLen;
        } else {
            current += w;
            currentVis += wLen;
        }
    }
    if (current.replace(/\s+$/, '').length > 0) {
        lines.push(current.replace(/\s+$/, ''));
    }
    return lines.join('\n');
}

// Apply inline markdown (bold, italic, inline code, links) to a single
// line of plain text. Returns text with ANSI escapes inlined.
function applyInlineMarkdown(text) {
    if (!text) return '';
    let out = text;

    // Fenced `code` first, so the * inside backticks doesn't get eaten by
    // the bold/italic replacements.
    out = out.replace(/`([^`\n]+)`/g, (_m, c) => '\x1b[33;2m' + c + '\x1b[0m');

    // Bold: **text**
    out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, (_m, c) => '\x1b[1m' + c + '\x1b[22m');

    // Italic: *text* or _text_, avoiding ** which is handled above.
    out = out.replace(/(^|[^*])\*([^*\n][^*\n]*?)\*(?!\*)/g, (_m, pre, c) => pre + '\x1b[3m' + c + '\x1b[23m');
    out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, (_m, pre, c) => pre + '\x1b[3m' + c + '\x1b[23m');

    // Links: [text](url) — show text in blue underline, url dimmed in parens.
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
        '\x1b[4;34m' + label + '\x1b[0m' + colorize(' (' + url + ')', 'dim'));

    return out;
}

// Render a markdown string to a styled, wrapped block ready to log.
// The output always ends without a trailing newline.
function renderMarkdown(text, options = {}) {
    if (!text) return '';

    const termWidth = getTerminalWidth();
    const baseIndent = options.indent != null ? options.indent : '  ';
    const width = options.width || Math.max(40, termWidth - 2);

    const source = String(text);
    const srcLines = source.split('\n');
    const out = [];
    let paragraph = [];
    let inCodeFence = false;
    let codeLang = '';
    let codeBuf = [];

    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        // Join soft-wrapped lines into one logical paragraph; the terminal
        // wrapper will re-wrap at `width`.
        const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length === 0) { paragraph = []; return; }
        const styled = applyInlineMarkdown(joined);
        out.push(wrapAnsiLine(styled, width, baseIndent, baseIndent));
        paragraph = [];
    };

    const flushCode = () => {
        if (codeBuf.length === 0) {
            return;
        }
        // Delegate to the existing fenced-code renderer so code blocks look
        // consistent with the one used elsewhere.
        const fenced = '```' + (codeLang || '') + '\n' + codeBuf.join('\n') + '\n```';
        // formatCodeBlocks prepends its own newline; indent each rendered
        // line with the base indent so code sits visually under the body.
        const rendered = formatCodeBlocks(fenced).replace(/\n(?!$)/g, '\n' + baseIndent);
        out.push(baseIndent.trimEnd() + rendered.trimEnd());
        codeBuf = [];
        codeLang = '';
    };

    for (let i = 0; i < srcLines.length; i++) {
        const rawLine = srcLines[i];

        // Fenced code block tracking
        const fenceMatch = rawLine.match(/^\s*(```|~~~)(\w*)\s*$/);
        if (fenceMatch) {
            if (!inCodeFence) {
                flushParagraph();
                inCodeFence = true;
                codeLang = fenceMatch[2] || '';
                codeBuf = [];
            } else {
                flushCode();
                inCodeFence = false;
            }
            continue;
        }
        if (inCodeFence) {
            codeBuf.push(rawLine);
            continue;
        }

        // Blank line: paragraph break
        if (rawLine.trim() === '') {
            flushParagraph();
            // Collapse runs of blank lines: only emit a single blank if the
            // previous output line isn't already blank.
            if (out.length > 0 && out[out.length - 1] !== '') {
                out.push('');
            }
            continue;
        }

        // Headers (# through ######)
        const headerMatch = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (headerMatch) {
            flushParagraph();
            const level = headerMatch[1].length;
            const title = applyInlineMarkdown(headerMatch[2]);
            let prefix, color, bold;
            if (level === 1) {
                prefix = '';
                color = 'cyan';
                bold = true;
            } else if (level === 2) {
                prefix = colorize('▸ ', 'cyan');
                color = 'cyan';
                bold = true;
            } else {
                prefix = colorize('· ', 'cyan');
                color = 'yellow';
                bold = false;
            }
            const line = baseIndent + prefix +
                (bold ? '\x1b[1m' : '') + colorize(title, color) + (bold ? '\x1b[22m' : '');
            out.push(line);
            if (level === 1) {
                const underlineLen = Math.min(stripAnsi(title).length + 2, width - baseIndent.length);
                out.push(baseIndent + colorize('─'.repeat(Math.max(3, underlineLen)), 'dim'));
            }
            continue;
        }

        // Bullet list (- * +)
        const bulletMatch = rawLine.match(/^(\s*)([-*+])\s+(.*)$/);
        if (bulletMatch) {
            flushParagraph();
            const extraIndent = bulletMatch[1] || '';
            const lead = baseIndent + extraIndent + colorize('•', 'cyan') + ' ';
            const nextLead = baseIndent + extraIndent + '  ';
            const body = applyInlineMarkdown(bulletMatch[3]);
            out.push(wrapAnsiLine(body, width, lead, nextLead));
            continue;
        }

        // Numbered list (1. 2. etc.)
        const numMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (numMatch) {
            flushParagraph();
            const extraIndent = numMatch[1] || '';
            const numStr = numMatch[2] + '.';
            const lead = baseIndent + extraIndent + colorize(numStr, 'cyan') + ' ';
            const nextLead = baseIndent + extraIndent + ' '.repeat(numStr.length + 1);
            const body = applyInlineMarkdown(numMatch[3]);
            out.push(wrapAnsiLine(body, width, lead, nextLead));
            continue;
        }

        // Blockquote
        if (/^\s*>\s?/.test(rawLine)) {
            flushParagraph();
            const body = applyInlineMarkdown(rawLine.replace(/^\s*>\s?/, ''));
            const lead = baseIndent + colorize('│ ', 'dim');
            out.push(wrapAnsiLine(colorize(body, 'dim'), width, lead, lead));
            continue;
        }

        // Horizontal rule
        if (/^\s*[-*_]{3,}\s*$/.test(rawLine)) {
            flushParagraph();
            const len = Math.max(10, width - baseIndent.length - 2);
            out.push(baseIndent + colorize('─'.repeat(len), 'dim'));
            continue;
        }

        // Regular paragraph line: accumulate for wrapping
        paragraph.push(rawLine.trim());
    }

    // Flush anything left over
    if (inCodeFence) {
        flushCode();
    }
    flushParagraph();

    // Strip a trailing blank paragraph separator
    while (out.length > 0 && out[out.length - 1] === '') out.pop();

    return out.join('\n');
}

// Display colored diff
// Modern unified diff renderer — Claude Code / Gemini CLI aesthetic.
// Shows a summary line with +/− stats, then line-numbered hunks with coloured
// gutter and soft-grey context lines. Safely truncates very large diffs.
function displayDiff(oldContent, newContent, filePath, options = {}) {
    const {
        context = 3,
        maxLines = 120,
        indent = '    ',
        showHeader = true
    } = options;

    const oldText = oldContent || '';
    const newText = newContent || '';
    const relativePath = filePath.replace(userWorkingDirectory, '.');
    const isNew = !oldText && newText;
    const isDelete = oldText && !newText;

    const structured = Diff.structuredPatch(
        relativePath,
        relativePath,
        oldText,
        newText,
        '',
        '',
        { context }
    );

    // Count additions / removals for the summary chip
    let added = 0;
    let removed = 0;
    for (const hunk of structured.hunks) {
        for (const line of hunk.lines) {
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
        }
    }

    const label = isNew ? 'Create' : isDelete ? 'Delete' : 'Edit';
    const labelColor = isNew ? 'green' : isDelete ? 'red' : 'cyan';
    const stats = `${colorize('+' + added, 'green')} ${colorize('−' + removed, 'red')}`;

    log('');
    if (showHeader) {
        log('  ' + colorize('●', labelColor) + ' ' +
            colorize(label, labelColor) + colorize(`(${relativePath})`, 'bright') +
            '  ' + stats);
    }

    // For pure create / delete, show the content with a single marker column
    if (isNew || isDelete) {
        const body = (isNew ? newText : oldText).split('\n');
        const gutterWidth = Math.max(2, String(body.length).length);
        const marker = isNew ? '+' : '-';
        const color = isNew ? 'green' : 'red';
        const shown = Math.min(body.length, maxLines);
        for (let i = 0; i < shown; i++) {
            const gutter = colorize(String(i + 1).padStart(gutterWidth), 'dim');
            log(indent + gutter + ' ' + colorize(marker + ' ' + body[i], color));
        }
        if (body.length > shown) {
            log(indent + colorize(`… ${body.length - shown} more lines`, 'dim'));
        }
        log('');
        return;
    }

    if (structured.hunks.length === 0) {
        log(indent + colorize('(no changes)', 'dim'));
        log('');
        return;
    }

    const lastHunk = structured.hunks[structured.hunks.length - 1];
    const maxLineNo = Math.max(
        lastHunk.oldStart + lastHunk.oldLines,
        lastHunk.newStart + lastHunk.newLines
    );
    const gutterWidth = Math.max(2, String(maxLineNo).length);

    let linesShown = 0;
    let truncated = false;

    for (let h = 0; h < structured.hunks.length && !truncated; h++) {
        const hunk = structured.hunks[h];
        let oldLn = hunk.oldStart;
        let newLn = hunk.newStart;

        if (h > 0) {
            log(indent + colorize('⋮'.padStart(gutterWidth + 2), 'dim'));
        }

        for (const line of hunk.lines) {
            if (linesShown >= maxLines) { truncated = true; break; }
            const marker = line[0];
            const body = line.slice(1);
            let gutterNum;
            let coloredBody;
            if (marker === '+') {
                gutterNum = String(newLn).padStart(gutterWidth);
                coloredBody = colorize('+ ' + body, 'green');
                newLn++;
            } else if (marker === '-') {
                gutterNum = String(oldLn).padStart(gutterWidth);
                coloredBody = colorize('- ' + body, 'red');
                oldLn++;
            } else if (marker === '\\') {
                // "\ No newline at end of file" — render as context
                gutterNum = ' '.repeat(gutterWidth);
                coloredBody = colorize('  ' + body, 'dim');
            } else {
                gutterNum = String(newLn).padStart(gutterWidth);
                coloredBody = colorize('  ' + body, 'gray');
                oldLn++;
                newLn++;
            }
            log(indent + colorize(gutterNum, 'dim') + ' ' + coloredBody);
            linesShown++;
        }
    }
    if (truncated) {
        log(indent + colorize(`… diff truncated (${added + removed} total changes)`, 'dim'));
    }
    log('');
}

// Prompt user for confirmation. Enter / empty line accepts (Y is the
// default) — this matches the common CLI convention and avoids the
// accidental-cancellation footgun. The main readline (if any) is paused
// so stdin isn't double-consumed while we're waiting on y/n/s.
function promptConfirmation(message, timeoutMs = 30000) {
    // Non-interactive / single-shot / CI mode auto-accepts.
    const autoYes = process.env.KODA_YES === '1' ||
        global.__kodaAutoConfirm === true ||
        (!process.stdin.isTTY && process.env.KODA_YES !== '0');
    if (autoYes) {
        process.stdout.write(colorize(`${message} [Y/n/s]: `, 'yellow') + colorize('Y [auto]\n', 'dim'));
        return Promise.resolve('yes');
    }

    return new Promise((resolve) => {
        const mainRl = global.__kodaMainRl;
        if (mainRl && typeof mainRl.pause === 'function') mainRl.pause();

        const wasRaw = process.stdin.isRaw;
        if (process.stdin.setRawMode) process.stdin.setRawMode(false);

        // Y is highlighted as the default; n / s are available options.
        process.stdout.write(
            colorize(`${message} `, 'yellow') +
            colorize('[', 'dim') +
            colorize('Y', 'green') +
            colorize('/n/s=skip] ', 'dim')
        );

        let timeoutId = null;
        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            if (timeoutId) clearTimeout(timeoutId);
            if (process.stdin.setRawMode && wasRaw) process.stdin.setRawMode(true);
            if (mainRl && typeof mainRl.resume === 'function') mainRl.resume();
        };

        const onData = (data) => {
            const answer = data.toString().trim().toLowerCase();
            cleanup();
            // Default (empty / Enter) = yes. Explicit 'n' or 'no' = no. 's' = skip.
            if (answer === '' || answer === 'y' || answer === 'yes') resolve('yes');
            else if (answer === 's' || answer === 'skip') resolve('skip');
            else resolve('no');
        };

        timeoutId = setTimeout(() => {
            cleanup();
            process.stdout.write(colorize('\n(timed out - accepting default: yes)\n', 'dim'));
            resolve('yes');
        }, timeoutMs);

        process.stdin.once('data', onData);
    });
}

// ============================================================================
// MULTI-FILE AWARENESS & SMART CONTEXT MANAGEMENT
// ============================================================================

// Add file to working set
function addToWorkingSet(filePath, content = null) {
    // Resolve to absolute path
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    // Check if file exists and read content if not provided
    if (content === null && fsSync.existsSync(absolutePath)) {
        try {
            content = fsSync.readFileSync(absolutePath, 'utf8');
        } catch (error) {
            return false;
        }
    }

    // Check working set size limit
    if (workingFiles.size >= MAX_WORKING_FILES && !workingFiles.has(absolutePath)) {
        // Remove least recently used file (first one in Map)
        const firstKey = workingFiles.keys().next().value;
        workingFiles.delete(firstKey);
    }

    workingFiles.set(absolutePath, {
        content: content || '',
        lastModified: Date.now(),
        size: (content || '').length,
        inFocus: focusFiles.has(absolutePath)
    });

    return true;
}

// Scan the current working directory for well-known project context files
// (koda.md, AGENTS.md, CLAUDE.md, README.md) and load them into the working
// set so every query automatically carries that context. This is the
// difference between koda saying "I don't have access to your project" and
// actually knowing what the project is on turn one.
function autoLoadProjectContext() {
    const candidates = ['koda.md', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'README'];
    const loaded = [];
    for (const name of candidates) {
        const full = path.join(userWorkingDirectory, name);
        try {
            if (!fsSync.existsSync(full)) continue;
            const stat = fsSync.statSync(full);
            if (!stat.isFile()) continue;
            // Skip absurdly large context files — the working set should stay
            // cheap, and anything >200 KB probably isn't hand-written guidance.
            if (stat.size > 200 * 1024) continue;
            if (addToWorkingSet(full)) loaded.push(name);
        } catch { /* unreadable — ignore */ }
    }
    return loaded;
}

// Remove file from working set
function removeFromWorkingSet(filePath) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);
    workingFiles.delete(absolutePath);
    focusFiles.delete(absolutePath);
}

// Get working set summary
function getWorkingSetSummary() {
    if (workingFiles.size === 0) {
        return 'No files in working set';
    }

    const files = Array.from(workingFiles.entries()).map(([filePath, info]) => {
        const relativePath = filePath.replace(userWorkingDirectory, '.');
        const focusMarker = info.inFocus || focusFiles.has(filePath) ? ' 🎯' : '';
        const sizeKB = (info.size / 1024).toFixed(1);
        return `  ${relativePath}${focusMarker} (${sizeKB} KB)`;
    });

    return files.join('\n');
}

// Build context from working files.
//
// Files are emitted as a "peek" manifest rather than a full content dump:
//   - tiny files (<= SMALL_FILE_THRESHOLD chars) are included verbatim,
//   - larger files show a header (size, line count) plus a short preview
//     and an instruction telling the model to use read_file with
//     startLine/endLine or chunkIndex to pull in the rest on demand.
//
// koda.md is deliberately excluded — /init writes it as a structured
// summary, and re-injecting its content every turn is what was pushing
// small-context models over the edge.
function buildWorkingFilesContext() {
    if (workingFiles.size === 0) {
        return '';
    }

    // Filter files based on focus mode
    let filesToInclude = Array.from(workingFiles.entries());
    if (focusMode && focusFiles.size > 0) {
        filesToInclude = filesToInclude.filter(([filePath]) => focusFiles.has(filePath));
    }

    // Skip koda.md — it's a summary the model can read_file on demand.
    filesToInclude = filesToInclude.filter(([filePath]) => path.basename(filePath) !== 'koda.md');

    if (filesToInclude.length === 0) {
        return '';
    }

    const SMALL_FILE_THRESHOLD = 1500; // chars — fully inline below this
    const PEEK_LINES = 20;             // preview line count for larger files

    let context = '\n[Working Files — peek only; use read_file to see more]\n';
    for (const [filePath, info] of filesToInclude) {
        const relativePath = filePath.replace(userWorkingDirectory, '.');
        const content = info.content || '';
        const lines = content.split('\n');
        const lineCount = lines.length;

        if (content.length <= SMALL_FILE_THRESHOLD) {
            context += `\n--- ${relativePath} (${content.length} chars, ${lineCount} lines) ---\n`;
            context += content;
            context += '\n';
        } else {
            const preview = lines.slice(0, PEEK_LINES).join('\n');
            context += `\n--- ${relativePath} (${content.length} chars, ${lineCount} lines — preview of first ${PEEK_LINES}) ---\n`;
            context += preview;
            context += `\n... (${lineCount - PEEK_LINES} more lines — call read_file with startLine/endLine or chunkIndex to see them, and search_replace_file to edit targeted sections without rewriting the whole file)\n`;
        }
    }
    context += '[End Working Files]\n\n';

    return context;
}

// Auto-detect imports and suggest related files
function detectImports(content, filePath) {
    const imports = [];
    const fileDir = path.dirname(filePath);

    // JavaScript/TypeScript imports
    const jsImportRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
    let match;
    while ((match = jsImportRegex.exec(content)) !== null) {
        let importPath = match[1];
        // Resolve relative imports
        if (importPath.startsWith('.')) {
            importPath = path.resolve(fileDir, importPath);
            // Add common extensions if not present
            if (!path.extname(importPath)) {
                for (const ext of ['.js', '.ts', '.jsx', '.tsx']) {
                    if (fsSync.existsSync(importPath + ext)) {
                        imports.push(importPath + ext);
                        break;
                    }
                }
            } else if (fsSync.existsSync(importPath)) {
                imports.push(importPath);
            }
        }
    }

    // Python imports
    const pythonImportRegex = /from\s+(\S+)\s+import|import\s+(\S+)/g;
    while ((match = pythonImportRegex.exec(content)) !== null) {
        const module = match[1] || match[2];
        if (module && module.startsWith('.')) {
            const modulePath = path.resolve(fileDir, module.replace(/\./g, '/') + '.py');
            if (fsSync.existsSync(modulePath)) {
                imports.push(modulePath);
            }
        }
    }

    return imports;
}

// Display chat history with modern styling
function displayChatHistory() {
    console.clear();

    // Compact single-line banner — less visual noise than the old ASCII block
    const termWidth = getTerminalWidth();
    const barWidth = Math.min(termWidth, 120);
    log('');
    log(' ' + colorize('◆', 'cyan') + colorize(' koda', 'bright') +
        colorize('  ·  ', 'dim') +
        colorize('a terminal agent for your projects', 'dim'));
    log(' ' + colorize('─'.repeat(barWidth - 3), 'dim'));
    log('');

    // Display chat messages with improved formatting
    if (chatHistory.length === 0) {
        const cwdLabel = userWorkingDirectory.length > 60
            ? '…' + userWorkingDirectory.slice(-59)
            : userWorkingDirectory;
        log(' ' + colorize('●', 'cyan') + ' ' + colorize('Ready', 'bright') +
            colorize('  ' + cwdLabel, 'dim'));
        log(' ' + colorize('⎿', 'dim') + ' ' +
            colorize('type a question or a file op — koda picks tools automatically', 'dim'));
        log('');
        log(' ' + colorize('tips', 'yellow') + colorize('  Tab', 'cyan') +
            colorize(' cycles / commands   ', 'dim') +
            colorize('/help', 'cyan') + colorize(' commands   ', 'dim') +
            colorize('/web', 'cyan') + colorize(' toggle search   ', 'dim') +
            colorize('/exit', 'yellow') + colorize(' quit', 'dim'));
        log('');
    } else {
        let lastWasSystem = false;
        let prevRole = null;
        for (const msg of chatHistory) {
            // Dim separator between turns so each exchange reads as its own block
            if (prevRole && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'assistant-streaming')
                && prevRole !== msg.role) {
                log('');
            }

            if (msg.role === 'user') {
                if (lastWasSystem) { log(''); lastWasSystem = false; }
                const lines = msg.content.split('\n');
                const labelPlain = '▶ You ';
                const label = colorize('▶', 'green') + ' ' + colorize('You', 'bright') + ' ';
                if (lines.length > 1) {
                    // Multi-line message: render as a quote-bar block so the
                    // bounds are obvious without the heavy box-drawing.
                    log(label);
                    for (const line of lines) {
                        log('  ' + colorize('│', 'green') + ' ' + line);
                    }
                } else {
                    log(label + msg.content);
                }
            } else if (msg.role === 'assistant' || msg.role === 'assistant-streaming') {
                if (lastWasSystem) { log(''); lastWasSystem = false; }
                const cleanedContent = cleanSkillSyntax(msg.content);
                if (cleanedContent) {
                    const label = colorize('◆', 'cyan') + ' ' + colorize('Koda', 'bright') + ' ';
                    if (msg.role === 'assistant') {
                        // Final message — run the markdown renderer with no
                        // indent so it sits flush left, then inline the label
                        // with the first line for a compact "Koda: answer"
                        // look. Multi-line responses still wrap cleanly.
                        const rendered = renderMarkdown(cleanedContent, { indent: '' });
                        if (rendered) {
                            const firstNl = rendered.indexOf('\n');
                            if (firstNl === -1) {
                                log(label + rendered);
                            } else {
                                log(label + rendered.slice(0, firstNl));
                                log(rendered.slice(firstNl + 1));
                            }
                        } else {
                            log(label);
                        }
                    } else {
                        // Streaming fallback (rare — usually streamed directly
                        // via stdout.write during generation). Keep minimal.
                        const formattedContent = formatCodeBlocks(cleanedContent);
                        log(label + formattedContent);
                    }
                }
            } else if (msg.role === 'tool') {
                // Tool-call trail entry — Claude Code / Gemini CLI style
                if (msg.content && typeof msg.content === 'object') {
                    renderToolCall(msg.content);
                }
                lastWasSystem = true;
            } else if (msg.role === 'system') {
                // System messages with subtle styling (ASCII-safe icon)
                log(colorize('  [i] ', 'dim') + colorize(msg.content, 'dim'));
                lastWasSystem = true;
            }
            prevRole = msg.role;
        }
        log('');
    }

    // Modern status bar
    displayStatusBar();
}

// Fetch and update API key usage from server
async function updateApiKeyUsage(api) {
    if (!api) return;

    try {
        const result = await api.getAuthInfo();
        if (result.success && result.data && result.data.apiKey) {
            const apiKey = result.data.apiKey;
            apiKeyUsage = {
                dailyTokens: apiKey.stats.dailyTokens || 0,
                rateLimitTokens: apiKey.rateLimitTokens,
                rateLimitRequests: apiKey.rateLimitRequests,
                tokenUsagePercentage: apiKey.stats.tokenUsagePercentage || 0,
                name: apiKey.name
            };
        }
    } catch (error) {
        // Silently fail - usage stats are not critical
    }
}

// Display status bar with token and context stats - modern compact design
function displayStatusBar() {
    const termWidth = getTerminalWidth();
    const leftParts = [];
    const rightParts = [];

    // "koda" label acts as the left anchor — no mode concept anymore.
    leftParts.push(colorize('◆', 'cyan') + colorize(' koda', 'bright'));

    // Web search indicator
    if (websearchMode) {
        leftParts.push(colorize('web', 'green'));
    } else {
        leftParts.push(colorize('web off', 'dim'));
    }

    // Compact cwd label
    const cwdLabel = userWorkingDirectory.length > 38
        ? '…' + userWorkingDirectory.slice(-37)
        : userWorkingDirectory;
    leftParts.push(colorize(cwdLabel, 'dim'));

    // Context window (compact)
    if (contextWindowLimit > 0) {
        const contextPercent = Math.round((contextWindowUsed / contextWindowLimit) * 100);
        const contextColor = contextPercent > 80 ? 'red' : contextPercent > 60 ? 'yellow' : 'dim';
        rightParts.push(colorize(`ctx ${contextPercent}%`, contextColor));
    }

    // Tokens/sec
    if (lastTokenUsage.total > 0 && lastTokensPerSecond > 0) {
        rightParts.push(colorize(`${lastTokensPerSecond.toFixed(1)} tok/s`, 'dim'));
    }

    // Session tokens
    if (totalTokensUsed > 0) {
        rightParts.push(colorize(`${totalTokensUsed.toLocaleString()} tok`, 'dim'));
    }

    // API key usage
    if (apiKeyUsage.rateLimitTokens) {
        const percentUsed = parseFloat(apiKeyUsage.tokenUsagePercentage || 0);
        const percentLeft = 100 - percentUsed;
        const usageColor = percentLeft < 20 ? 'red' : percentLeft < 40 ? 'yellow' : 'dim';
        rightParts.push(colorize(`${percentLeft.toFixed(0)}% budget`, usageColor));
    }

    const sep = colorize(' · ', 'dim');
    const left = leftParts.join(sep);
    const right = rightParts.join(sep);

    const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');
    const leftLen = stripAnsi(left).length;
    const rightLen = stripAnsi(right).length;
    const barWidth = Math.min(termWidth, 120);
    const padding = Math.max(1, barWidth - leftLen - rightLen - 2);

    // Dim rule, then the status line itself
    log(colorize('─'.repeat(barWidth - 2), 'dim'));
    if (rightParts.length > 0) {
        log(' ' + left + ' '.repeat(padding) + right);
    } else {
        log(' ' + left);
    }
    console.log('');
}

// Track if we're currently streaming (to avoid flicker)
let isStreaming = false;
let lastStreamedMessage = '';
let lastCleanedMessage = ''; // Track the cleaned version for comparison

// Helper function to clean skill syntax from response text
// Handles complex multi-line skill calls with triple-quoted strings
function cleanSkillSyntax(text) {
    if (!text) return '';

    let result = text;

    // Step 0: Strip thinking model tags (<think>...</think>)
    // Remove complete thinking blocks
    result = result.replace(/<think>[\s\S]*?<\/think>/g, '');
    // Remove unclosed/in-progress thinking tags (streaming)
    result = result.replace(/<think>[\s\S]*$/g, '');
    // Remove orphaned closing tags
    result = result.replace(/<\/think>/g, '');

    // Step 0b: Strip Harmony / "OSS" formatting tokens that leak through from
    // gpt-oss / Kimi / DeepSeek style checkpoints. The tool-call body itself
    // is parsed elsewhere; here we just make sure the user never reads raw
    // "<|channel>thought" / "<|tool_call>" / "<eos>" text on screen.
    //
    // Strategy: scrub any paired <|tag>…<tag|> block (with or without the
    // underscore / namespace variants), then sweep up lone markers. The
    // filter only triggers on tags containing a vertical bar, so regular
    // HTML like <div> survives untouched.
    result = result.replace(/<\|?\/?tool_?call\|?>[\s\S]*?<\|?\/?tool_?call\|?>/g, '');
    result = result.replace(/<\|?\/?tool_?response\|?>[\s\S]*?<\|?\/?tool_?response\|?>/g, '');
    // Lone / unmatched markers (streaming, truncated output, etc.)
    result = result.replace(/<\|?\/?tool_?call\|?>/g, '');
    result = result.replace(/<\|?\/?tool_?response\|?>/g, '');
    result = result.replace(/<\|?channel\|?>[^<\n]*?<\|?channel\|?>/g, '');
    result = result.replace(/<\|?channel\|?>\s*(thought|analysis|commentary)?/gi, '');
    result = result.replace(/<channel\|>/g, '');
    result = result.replace(/<\|?(eos|bos|im_start|im_end|start|end|assistant|user|system|return)\|?>/g, '');

    // Step 1: Remove complete multi-line skill calls with triple-quoted strings
    // Pattern: [SKILL:name(param="""...multiline...""")]
    // Use a function-based replacement to handle nested content
    result = removeCompleteSkillCalls(result);

    // Step 2: Remove partial/incomplete skill calls during streaming
    // Pattern: [SKILL:name(... without closing )]
    result = removePartialSkillCalls(result);

    // Step 3: Remove truncated skill markers: [S, [SK, [SKI, [SKIL, [SKILL (without colon)
    result = result.replace(/\[S(?:K(?:I(?:L(?:L)?)?)?)?$/g, '');

    // Step 3b: Remove stray lone brackets that are remnants of skill parsing
    // These appear as lone '[' characters on their own line or at line endings
    result = result.replace(/^\[\s*$/gm, '');          // Lines that are just '['
    result = result.replace(/\n\[\s*\n/g, '\n');       // '[' between newlines
    result = result.replace(/\[\s*$/g, '');            // '[' at end of text

    // Step 4: Remove variant formats with hyphen: [SKILL - ...] or [SKILL- ...]
    result = result.replace(/\[SKILL\s*-[^\]]*\]/g, '');
    result = result.replace(/\[SKILL\s*-[^\]]*$/g, '');

    // Step 5: Remove JSON skill formats
    result = result.replace(/```json\s*\n?\s*\{[\s\S]*?"skill"[\s\S]*?\}\s*\n?```/g, '');
    result = result.replace(/```json\s*\n?\s*\{[^`]*$/g, '');
    result = result.replace(/\{"skill"\s*:\s*"\w+"\s*,\s*"params"\s*:\s*\{[^}]+\}\}/g, '');
    result = result.replace(/\{"skill"\s*:\s*"[^"]*"?\s*,?\s*"?params"?\s*:?\s*\{?[^}]*$/g, '');

    // Step 5b: Bare `call:name(args)` — parsed as Pattern 5 skill calls but
    // still show up verbatim in the streamed text. Strip both complete and
    // truncated forms so the user only sees the clean `● SkillName(...)`
    // display from the skill runner.
    result = result.replace(/(^|\n)[ \t]*call:[\w_]+\s*\([\s\S]*?\)\s*/g, '$1');
    result = result.replace(/(^|\n)[ \t]*call:[\w_]+\s*\([\s\S]*$/g, '$1');

    // Step 5c: Strip lone "thought" / "thinking" preambles that Gemma and
    // a few other checkpoints emit between calls. Single-word lines only —
    // don't eat a sentence that starts with "thought" in normal prose.
    // Loop until stable so back-to-back "thought\nthought\n" both vanish.
    let prev;
    do {
        prev = result;
        result = result.replace(/(^|\n)[ \t]*(thought|thinking|reasoning)[ \t]*(\n|$)/gi, '$1');
    } while (result !== prev);

    // Step 6: Clean up whitespace artifacts
    result = result
        .replace(/^\s*$/gm, '')           // Remove lines that are only whitespace
        .replace(/\n{3,}/g, '\n\n')       // Collapse multiple newlines to max 2
        .replace(/[ \t]+$/gm, '')         // Remove trailing spaces
        .trim();

    return result;
}

// Remove complete skill calls including multi-line ones with triple-quoted strings
function removeCompleteSkillCalls(text) {
    let result = text;
    let changed = true;
    let iterations = 0;
    const maxIterations = 50; // Prevent infinite loops

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        // Find [SKILL: pattern
        const skillStartIdx = result.indexOf('[SKILL:');
        if (skillStartIdx === -1) break;

        // Find the skill name
        const colonIdx = skillStartIdx + 7;
        let parenIdx = result.indexOf('(', colonIdx);
        if (parenIdx === -1) break;

        // Now find the matching )] by tracking quotes and parentheses
        let i = parenIdx + 1;
        let depth = 1;
        let inSingleQuote = false;
        let inTripleQuote = false;
        let escapeNext = false;

        while (i < result.length && depth > 0) {
            if (escapeNext) {
                escapeNext = false;
                i++;
                continue;
            }

            const char = result[i];
            const nextThree = result.substring(i, i + 3);

            if (char === '\\' && !inTripleQuote) {
                escapeNext = true;
                i++;
                continue;
            }

            // Handle triple quotes
            if (nextThree === '"""') {
                inTripleQuote = !inTripleQuote;
                i += 3;
                continue;
            }

            // Handle single quotes (only if not in triple quote)
            if (char === '"' && !inTripleQuote) {
                inSingleQuote = !inSingleQuote;
                i++;
                continue;
            }

            // Track parentheses (only if not in any quote)
            if (!inSingleQuote && !inTripleQuote) {
                if (char === '(') depth++;
                if (char === ')') depth--;
            }

            i++;
        }

        // If we found matching )], remove the skill call
        if (depth === 0 && i < result.length && result[i] === ']') {
            result = result.substring(0, skillStartIdx) + result.substring(i + 1);
            changed = true;
        } else {
            // Couldn't find complete skill call, might be partial - stop here
            break;
        }
    }

    return result;
}

// Remove partial/incomplete skill calls (during streaming)
function removePartialSkillCalls(text) {
    // Look for [SKILL: that doesn't have a complete )]
    const skillStartIdx = text.indexOf('[SKILL:');
    if (skillStartIdx === -1) return text;

    // Check if there's a complete skill call by scanning for matching )]
    let i = skillStartIdx + 7;
    let depth = 0;
    let inSingleQuote = false;
    let inTripleQuote = false;
    let escapeNext = false;
    let foundOpenParen = false;

    while (i < text.length) {
        if (escapeNext) {
            escapeNext = false;
            i++;
            continue;
        }

        const char = text[i];
        const nextThree = text.substring(i, i + 3);

        if (char === '\\' && !inTripleQuote) {
            escapeNext = true;
            i++;
            continue;
        }

        // Handle triple quotes
        if (nextThree === '"""') {
            inTripleQuote = !inTripleQuote;
            i += 3;
            continue;
        }

        // Handle single quotes (only if not in triple quote)
        if (char === '"' && !inTripleQuote) {
            inSingleQuote = !inSingleQuote;
            i++;
            continue;
        }

        // Track parentheses (only if not in any quote)
        if (!inSingleQuote && !inTripleQuote) {
            if (char === '(') {
                depth++;
                foundOpenParen = true;
            }
            if (char === ')') depth--;

            // Found complete )]
            if (foundOpenParen && depth === 0 && char === ')' && i + 1 < text.length && text[i + 1] === ']') {
                // This is a complete skill call, recurse to find more
                const before = text.substring(0, skillStartIdx);
                const after = text.substring(i + 2);
                return removePartialSkillCalls(before + after);
            }
        }

        i++;
    }

    // If we get here, we have an incomplete skill call - remove from [SKILL: to end
    return text.substring(0, skillStartIdx).trim();
}

// Track the raw cleaned content (without formatting) for accurate comparison
let lastRawCleanedContent = '';

// Update streaming message without full screen refresh (reduces flicker)
function updateStreamingMessage(message) {
    if (!isStreaming) return;

    // Clean skill syntax from the message before displaying
    const cleanedMessage = cleanSkillSyntax(message);

    // Only display if there's actual content (not just skill calls)
    if (!cleanedMessage) {
        return;
    }

    // On first message, write the prefix and content
    if (lastRawCleanedContent === '') {
        const formattedContent = formatCodeBlocks(cleanedMessage);
        process.stdout.write(
            colorize('◆', 'cyan') + ' ' +
            colorize('Koda', 'bright') + ' '
        );
        process.stdout.write(formattedContent);
        lastStreamedMessage = message;
        lastRawCleanedContent = cleanedMessage;
        lastCleanedMessage = formattedContent;
    } else {
        // Compare raw content to determine what's new
        // This avoids issues with formatting differences
        if (cleanedMessage.startsWith(lastRawCleanedContent)) {
            // New content added - only write the new part
            const newRawContent = cleanedMessage.substring(lastRawCleanedContent.length);
            if (newRawContent) {
                const formattedNewContent = formatCodeBlocks(newRawContent);
                process.stdout.write(formattedNewContent);
                lastStreamedMessage = message;
                lastRawCleanedContent = cleanedMessage;
                lastCleanedMessage = formatCodeBlocks(cleanedMessage);
            }
        } else if (cleanedMessage === lastRawCleanedContent) {
            // Content unchanged - no action needed
            lastStreamedMessage = message;
        } else if (cleanedMessage.length < lastRawCleanedContent.length) {
            // Content got shorter (skill syntax stripped) - just update tracking
            // Don't rewrite the screen, the next content will append correctly
            lastStreamedMessage = message;
            lastRawCleanedContent = cleanedMessage;
            lastCleanedMessage = formatCodeBlocks(cleanedMessage);
        } else {
            // Content diverged - find common prefix and append from there
            let commonLen = 0;
            const minLen = Math.min(cleanedMessage.length, lastRawCleanedContent.length);
            while (commonLen < minLen && cleanedMessage[commonLen] === lastRawCleanedContent[commonLen]) {
                commonLen++;
            }

            if (commonLen > 0 && commonLen === lastRawCleanedContent.length) {
                // Old content is prefix of new - just append the new part
                const newPart = cleanedMessage.substring(commonLen);
                process.stdout.write(formatCodeBlocks(newPart));
            } else {
                // Content completely diverged - append on new line to avoid confusion
                process.stdout.write('\n' + formatCodeBlocks(cleanedMessage));
            }

            lastStreamedMessage = message;
            lastRawCleanedContent = cleanedMessage;
            lastCleanedMessage = formatCodeBlocks(cleanedMessage);
        }
    }
}

// Reset streaming state (call before starting new stream)
function resetStreamingState() {
    isStreaming = false;
    lastStreamedMessage = '';
    lastCleanedMessage = '';
    lastRawCleanedContent = '';
}

// Encryption utilities
function getEncryptionKey() {
    // Generate a machine-specific key from hostname and username
    const machineId = `${os.hostname()}-${os.userInfo().username}`;
    return crypto.createHash('sha256').update(machineId).digest();
}

function encryptData(data) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptData(encryptedData) {
    const key = getEncryptionKey();
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}

// Load configuration
function loadConfig() {
    try {
        if (fsSync.existsSync(CONFIG_FILE)) {
            const fileContent = fsSync.readFileSync(CONFIG_FILE, 'utf8');

            // Try to decrypt first (new format)
            if (fileContent.includes(':')) {
                try {
                    return decryptData(fileContent);
                } catch (decryptError) {
                    // If decryption fails, might be old plaintext format
                    try {
                        const plainConfig = JSON.parse(fileContent);
                        // Re-save as encrypted
                        saveConfig(plainConfig);
                        return plainConfig;
                    } catch (jsonError) {
                        console.error(colorize('Error loading config:', 'red'), 'Invalid format');
                        return null;
                    }
                }
            } else {
                // Old plaintext format - migrate to encrypted
                const plainConfig = JSON.parse(fileContent);
                saveConfig(plainConfig);
                return plainConfig;
            }
        }
    } catch (error) {
        console.error(colorize('Error loading config:', 'red'), error.message);
    }
    return null;
}

// Save configuration (encrypted)
function saveConfig(config) {
    try {
        if (!fsSync.existsSync(CONFIG_DIR)) {
            fsSync.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        const encrypted = encryptData(config);
        fsSync.writeFileSync(CONFIG_FILE, encrypted, 'utf8');
        // Set restrictive permissions (owner read/write only)
        fsSync.chmodSync(CONFIG_FILE, 0o600);
        return true;
    } catch (error) {
        console.error(colorize('Error saving config:', 'red'), error.message);
        return false;
    }
}

// API client (quiet mode - no logging)
class AgentAPI {
    constructor(baseUrl, apiKey, apiSecret) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
    }

    async request(method, endpoint, data = null, timeout = 120000) {
        try {
            const config = {
                method,
                url: `${this.baseUrl}${endpoint}`,
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey,
                    'X-API-Secret': this.apiSecret
                },
                // Disable SSL verification for self-signed certificates
                httpsAgent: new (require('https').Agent)({
                    rejectUnauthorized: false
                }),
                timeout: timeout // Default 2 minute timeout
            };

            if (data) {
                config.data = data;
            }

            const response = await axios(config);
            return { success: true, data: response.data };
        } catch (error) {
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    // Get current authentication info (user or API key with usage stats)
    async getAuthInfo() {
        return this.request('GET', '/api/auth/me');
    }

    // Chat with model
    async chat(message, model = null, maxTokens = 4000) {
        lastApiCallStartTime = Date.now();
        // Use 3 minute timeout for chat requests (model generation can be slow)
        const result = await this.request('POST', '/api/chat', { message, model, maxTokens }, 180000);
        lastApiCallEndTime = Date.now();

        // Calculate tokens per second if we have token info
        if (result.success && result.data.tokens) {
            const timeElapsed = (lastApiCallEndTime - lastApiCallStartTime) / 1000; // seconds
            const tokensGenerated = result.data.tokens.completion_tokens || 0;
            if (timeElapsed > 0 && tokensGenerated > 0) {
                lastTokensPerSecond = tokensGenerated / timeElapsed;
            }
        }

        // Update context window limit if provided
        if (result.success && result.data.contextSize) {
            contextWindowLimit = result.data.contextSize;
        }

        return result;
    }

    async getAgents() {
        return this.request('GET', '/api/agents');
    }

    async getAgent(id) {
        return this.request('GET', `/api/agents/${id}`);
    }

    async createAgent(data) {
        return this.request('POST', '/api/agents', data);
    }

    async updateAgent(id, data) {
        return this.request('PUT', `/api/agents/${id}`, data);
    }

    async deleteAgent(id) {
        return this.request('DELETE', `/api/agents/${id}`);
    }

    async getTasks(agentId = null) {
        const endpoint = agentId ? `/api/tasks?agentId=${agentId}` : '/api/tasks';
        return this.request('GET', endpoint);
    }

    async createTask(data) {
        return this.request('POST', '/api/tasks', data);
    }

    async updateTask(id, data) {
        return this.request('PUT', `/api/tasks/${id}`, data);
    }

    async getSkills() {
        return this.request('GET', '/api/skills');
    }

    async createSkill(data) {
        return this.request('POST', '/api/skills', data);
    }

    async getPermissions() {
        return this.request('GET', '/api/agent-permissions');
    }

    async updatePermissions(data) {
        return this.request('PUT', '/api/agent-permissions', data);
    }

    async fileRead(filePath) {
        return this.request('POST', '/api/agent/file/read', { filePath });
    }

    async fileWrite(filePath, content) {
        return this.request('POST', '/api/agent/file/write', { filePath, content });
    }

    async fileDelete(filePath) {
        return this.request('POST', '/api/agent/file/delete', { filePath });
    }

    async fileList(dirPath) {
        return this.request('POST', '/api/agent/file/list', { dirPath });
    }

    async fileMove(sourcePath, destPath) {
        return this.request('POST', '/api/agent/file/move', { sourcePath, destPath });
    }

    // Web search using DuckDuckGo (with optional content fetching)
    async webSearch(query, limit = 5, fetchContent = false, contentLimit = 3) {
        let url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        if (fetchContent) {
            url += `&fetchContent=true&contentLimit=${contentLimit}`;
        }
        return this.request('GET', url);
    }

    // Execute a skill
    async executeSkill(skillName, params, agentId = null) {
        const data = { ...params };
        if (agentId) {
            data.agentId = agentId;
        }
        return this.request('POST', `/api/skills/${skillName}/execute`, data);
    }

    // Streaming chat with model - Server-Sent Events
    /**
     * Stream a chat completion.
     *
     * The first argument can be either:
     *   - a plain string (legacy single-turn behavior), or
     *   - an object { messages, systemPrompt, temperature } where
     *     messages is an array of { role, content } pairs. When this
     *     shape is used, the request body uses the `messages` field
     *     which the backend (/api/chat/stream) routes through the full
     *     OpenAI-compatible path — giving the model a real system role
     *     separate from the user turn. This is what allows a 500-line
     *     skill catalog to not bleed into the user's "10+10" question.
     */
    async chatStream(message, model = null, maxTokens = 4000, onToken, onComplete) {
        lastApiCallStartTime = Date.now();

        // Timeout constants.
        //
        // Web-enabled queries legitimately take a long time BEFORE the first
        // response byte: the backend has to run the search, fetch up to 5
        // URLs via Scrapling/Playwright (each with a 30s budget), build the
        // prompt, and only then start streaming model tokens. A short
        // "connection timeout" on the Node.js request kills the socket while
        // the server is still working and surfaces as "Failed to connect to
        // server" — which is wrong, the connection was already open.
        //
        // We rely on ACTIVITY_TIMEOUT (started immediately after the request
        // is sent, reset on every response byte) and MAX_TOTAL_TIMEOUT as
        // the outer ceiling. No Node socket `timeout` option — that caused
        // the bug.
        const ACTIVITY_TIMEOUT = 300000;   // 5 min: first byte + inter-token silence
        const MAX_TOTAL_TIMEOUT = 900000;  // 15 minutes max total time

        try {
            const https = require('https');
            const url = require('url');

            const parsedUrl = url.parse(this.baseUrl);
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: '/api/chat/stream',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey,
                    'X-API-Secret': this.apiSecret,
                    'Accept': 'text/event-stream'
                },
                rejectUnauthorized: false
                // Intentionally NO `timeout` option: Node treats it as a
                // socket-idle timeout which would fire during the long
                // pre-first-byte window on web-enabled queries. We use our
                // own ACTIVITY_TIMEOUT below instead.
            };

            // Build the request body. When the caller passes an object with
            // a messages array, forward it as a proper OpenAI-style messages
            // request so the server can set a real system role. Otherwise
            // fall back to the legacy single-string form for any code path
            // that hasn't migrated yet.
            let postData;
            if (message && typeof message === 'object' && Array.isArray(message.messages)) {
                const bodyObj = {
                    messages: message.messages,
                    model,
                    maxTokens
                };
                if (typeof message.temperature === 'number') {
                    bodyObj.temperature = message.temperature;
                }
                postData = JSON.stringify(bodyObj);
            } else {
                postData = JSON.stringify({ message, model, maxTokens });
            }

            return new Promise((resolve, reject) => {
                let resolved = false;
                let activityTimer = null;
                let totalTimer = null;

                const cleanup = () => {
                    if (activityTimer) clearTimeout(activityTimer);
                    if (totalTimer) clearTimeout(totalTimer);
                };

                const resetActivityTimer = () => {
                    if (activityTimer) clearTimeout(activityTimer);
                    activityTimer = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            if (req) req.destroy();
                            reject(new Error(
                                `Stream timeout: no data received for ${Math.round(ACTIVITY_TIMEOUT / 1000)}s. ` +
                                `The server may still be processing (web scraping, map-reduce, or a slow model). ` +
                                `Try a shorter query or disable /web.`
                            ));
                        }
                    }, ACTIVITY_TIMEOUT);
                };

                // Set total timeout
                totalTimer = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        req.destroy();
                        reject(new Error('Request timeout: Maximum time of 10 minutes exceeded'));
                    }
                }, MAX_TOTAL_TIMEOUT);

                const req = https.request(options, (res) => {
                    // Start activity timer once connected
                    resetActivityTimer();

                    if (res.statusCode !== 200) {
                        let errorData = '';
                        res.on('data', (chunk) => {
                            errorData += chunk;
                        });
                        res.on('end', () => {
                            if (!resolved) {
                                resolved = true;
                                cleanup();
                                try {
                                    const error = JSON.parse(errorData);
                                    reject(new Error(error.error || `Request failed with status ${res.statusCode}`));
                                } catch (e) {
                                    reject(new Error(`Request failed with status ${res.statusCode}: ${errorData.substring(0, 200)}`));
                                }
                            }
                        });
                        return;
                    }

                    let buffer = '';
                    let fullResponse = '';
                    let tokens = null;

                    res.on('data', (chunk) => {
                        // Reset activity timer on any data
                        resetActivityTimer();

                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.slice(6).trim();

                                // Handle [DONE] marker
                                if (dataStr === '[DONE]') {
                                    if (!resolved && !tokens) {
                                        resolved = true;
                                        cleanup();
                                        lastApiCallEndTime = Date.now();
                                        if (onComplete) {
                                            onComplete(fullResponse, null);
                                        }
                                        resolve({
                                            success: true,
                                            data: { response: fullResponse, tokens: null }
                                        });
                                    }
                                    continue;
                                }

                                try {
                                    const data = JSON.parse(dataStr);

                                    if (data.error) {
                                        if (!resolved) {
                                            resolved = true;
                                            cleanup();
                                            const errorMsg = typeof data.error === 'object'
                                                ? (data.error.message || JSON.stringify(data.error))
                                                : data.error;
                                            reject(new Error(errorMsg));
                                        }
                                        return;
                                    }

                                    if (data.done) {
                                        if (!resolved) {
                                            resolved = true;
                                            cleanup();
                                            lastApiCallEndTime = Date.now();
                                            tokens = data.tokens;

                                            if (tokens) {
                                                const timeElapsed = (lastApiCallEndTime - lastApiCallStartTime) / 1000;
                                                const tokensGenerated = tokens.completion_tokens || 0;
                                                if (timeElapsed > 0 && tokensGenerated > 0) {
                                                    lastTokensPerSecond = tokensGenerated / timeElapsed;
                                                }
                                            }

                                            // Update context window limit if provided
                                            if (data.contextSize) {
                                                contextWindowLimit = data.contextSize;
                                            }

                                            if (onComplete) {
                                                onComplete(fullResponse, tokens);
                                            }

                                            resolve({
                                                success: true,
                                                data: {
                                                    response: fullResponse,
                                                    tokens: tokens,
                                                    model: data.model
                                                }
                                            });
                                        }
                                    } else if (data.type === 'auto_continuation') {
                                        // Server is auto-continuing the response - skip, tokens keep flowing
                                    } else if (data.token) {
                                        fullResponse += data.token;
                                        if (onToken) {
                                            onToken(data.token);
                                        }
                                    } else if (data.choices && data.choices[0]?.delta?.content) {
                                        // Handle OpenAI-compatible streaming format
                                        const content = data.choices[0].delta.content;
                                        fullResponse += content;
                                        if (onToken) {
                                            onToken(content);
                                        }
                                    }
                                } catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                    });

                    res.on('end', () => {
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            lastApiCallEndTime = Date.now();
                            if (onComplete) {
                                onComplete(fullResponse, tokens);
                            }
                            resolve({
                                success: true,
                                data: { response: fullResponse, tokens: tokens }
                            });
                        }
                    });

                    res.on('error', (error) => {
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            reject(error);
                        }
                    });
                });

                // No `req.on('timeout')` handler: we removed the socket
                // idle timeout from the request options. ACTIVITY_TIMEOUT
                // (started right after req.end()) is the real budget.

                req.on('error', (error) => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        reject(error);
                    }
                });

                req.write(postData);
                req.end();

                // Start the activity timer NOW so the pre-first-byte window
                // (the server running web search + scraping + prompt build)
                // is bounded. Any response data resets it inside res.on.
                resetActivityTimer();
            });

        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// ============================================================================
// SKILL CALLING FRAMEWORK
// ============================================================================

// Maximum iterations for skill execution loop (prevent infinite loops)
const MAX_SKILL_ITERATIONS = 10;

// Parse skill calls from AI response
// Format: [SKILL:skill_name(param1="value1", param2="value2")]
// or JSON format: {"skill": "skill_name", "params": {...}}
// Helper function to unescape string escape sequences (like \n, \t, \\)
// Uses single-pass replacement to correctly handle sequences like \\n (backslash + n)
function unescapeString(str) {
    if (!str) return str;
    return str.replace(/\\(.)/g, (match, char) => {
        switch (char) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case '\\': return '\\';
            case '"': return '"';
            default: return match; // Keep unknown escapes as-is
        }
    });
}

function parseSkillCalls(response) {
    const skillCalls = [];

    // Pattern 1: [SKILL:name(params)] - handles multi-line content with triple quotes
    // We need to find skill calls that may contain multi-line content
    const skillStartPattern = /\[SKILL:(\w+)\(/g;
    let startMatch;
    while ((startMatch = skillStartPattern.exec(response)) !== null) {
        const skillName = startMatch[1];
        const startIndex = startMatch.index + startMatch[0].length;

        // Find the matching )] by tracking parentheses and handling quoted strings
        let depth = 1;
        let i = startIndex;
        let inQuote = false;
        let inTripleQuote = false;
        let escapeNext = false;

        while (i < response.length && depth > 0) {
            const char = response[i];
            const nextThree = response.substring(i, i + 3);

            if (escapeNext) {
                escapeNext = false;
                i++;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                i++;
                continue;
            }

            // Handle triple quotes
            if (nextThree === '"""') {
                inTripleQuote = !inTripleQuote;
                i += 3;
                continue;
            }

            // Handle single quotes (only if not in triple quote)
            if (char === '"' && !inTripleQuote) {
                inQuote = !inQuote;
                i++;
                continue;
            }

            // Track parentheses (only if not in any quote)
            if (!inQuote && !inTripleQuote) {
                if (char === '(') depth++;
                if (char === ')') depth--;
            }

            i++;
        }

        // Check if we found the closing )]
        if (depth === 0 && response[i] === ']') {
            const paramsStr = response.substring(startIndex, i - 1);
            const fullMatch = response.substring(startMatch.index, i + 1);
            const params = {};

            // Parse key="value" pairs with support for escaped quotes
            // Also handle key="""multi-line value"""
            const tripleQuotePattern = /(\w+)\s*=\s*"""([\s\S]*?)"""/g;
            let paramMatch;
            while ((paramMatch = tripleQuotePattern.exec(paramsStr)) !== null) {
                // Triple-quoted strings keep their content as-is (no unescape needed)
                params[paramMatch[1]] = paramMatch[2].trim();
            }

            // Parse single-quoted params (that weren't already captured by triple quotes)
            const singleQuotePattern = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
            while ((paramMatch = singleQuotePattern.exec(paramsStr)) !== null) {
                // Only add if not already captured by triple quote pattern
                if (!(paramMatch[1] in params)) {
                    params[paramMatch[1]] = unescapeString(paramMatch[2]);
                }
            }

            skillCalls.push({ skillName, params, fullMatch });
        }
    }

    // Also support the simpler bracket pattern for backwards compatibility
    const simpleBracketPattern = /\[SKILL:(\w+)\(([^[\]]*)\)\]/g;
    let match;
    while ((match = simpleBracketPattern.exec(response)) !== null) {
        // Skip if already captured by the more complex parser above
        const alreadyCaptured = skillCalls.some(sc => sc.fullMatch === match[0]);
        if (alreadyCaptured) continue;

        const skillName = match[1];
        const paramsStr = match[2];
        const params = {};

        // Parse key="value" pairs with support for escaped quotes
        const paramPattern = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
        let paramMatch;
        while ((paramMatch = paramPattern.exec(paramsStr)) !== null) {
            params[paramMatch[1]] = unescapeString(paramMatch[2]);
        }

        skillCalls.push({ skillName, params, fullMatch: match[0] });
    }

    // Pattern 2: JSON blocks with skill calls
    const jsonPattern = /```json\s*\n?\s*(\{[\s\S]*?"skill"[\s\S]*?\})\s*\n?```/g;
    while ((match = jsonPattern.exec(response)) !== null) {
        try {
            const json = JSON.parse(match[1]);
            if (json.skill) {
                skillCalls.push({
                    skillName: json.skill,
                    params: json.params || {},
                    fullMatch: match[0]
                });
            }
        } catch (e) {
            // Invalid JSON, skip
        }
    }

    // Pattern 3: Inline JSON skill calls
    const inlineJsonPattern = /\{"skill"\s*:\s*"(\w+)"\s*,\s*"params"\s*:\s*(\{[^}]+\})\}/g;
    while ((match = inlineJsonPattern.exec(response)) !== null) {
        try {
            const params = JSON.parse(match[2]);
            skillCalls.push({
                skillName: match[1],
                params: params,
                fullMatch: match[0]
            });
        } catch (e) {
            // Invalid JSON params, skip
        }
    }

    // Pattern 4: Harmony / "OSS" tool-call tokens the GPT-style models emit
    // natively (gpt-oss, Kimi, some DeepSeek checkpoints). Variants in the
    // wild: <|tool_call>…<tool_call|>, <|toolcall>…<toolcall|>,
    // <|tool_call|>…<|/tool_call|>, with or without a "call:Ns:" namespace
    // prefix. The tag, the pipe position, and the function-name underscore
    // are all optional — the body is always `name(args)`.
    //
    // Without this, koda misses the call, the file op never runs, and the
    // model still claims success because *it* thinks it just ran the tool.
    const harmonyPattern = /<\|?\/?tool_?call\|?>\s*(?:call:)?(?:[\w\-]+:)?([\w_]+)\s*\(([\s\S]*?)\)\s*<\|?\/?tool_?call\|?>/g;
    while ((match = harmonyPattern.exec(response)) !== null) {
        const rawName = match[1];
        const paramsStr = match[2];
        const skillName = normalizeSkillName(rawName);
        const params = {};
        const paramPattern = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
        let pm;
        while ((pm = paramPattern.exec(paramsStr)) !== null) {
            params[pm[1]] = unescapeString(pm[2]);
        }
        skillCalls.push({ skillName, params, fullMatch: match[0] });
    }

    // Pattern 5: BARE `call:name(params)` emitted by Gemma and a few other
    // models that learned the syntax from tool-use training data without the
    // surrounding <|tool_call|> wrapper. Without this koda misses the call
    // entirely, dumps the raw `call:...` text to the user as narration, and
    // the model retries repeatedly thinking it never worked.
    //
    // Must track parens through quoted strings because edit-style skills
    // (search_replace_file) frequently contain unbalanced `(` or `)` inside
    // their search/replace params.
    const barePrefix = /(^|\n)[ \t]*call:([\w_]+)\s*\(/g;
    let bm;
    while ((bm = barePrefix.exec(response)) !== null) {
        const rawName = bm[2];
        const openParenIdx = bm.index + bm[0].length; // index AFTER "("
        let depth = 1;
        let i = openParenIdx;
        let inQuote = false;
        let escapeNext = false;
        while (i < response.length && depth > 0) {
            const ch = response[i];
            if (escapeNext) { escapeNext = false; i++; continue; }
            if (ch === '\\') { escapeNext = true; i++; continue; }
            if (ch === '"' && !escapeNext) { inQuote = !inQuote; i++; continue; }
            if (!inQuote) {
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                if (depth === 0) break;
                // Guard: don't consume another `call:...(` as inner body.
                if (response.substr(i, 5) === '\ncall') break;
            }
            i++;
        }
        if (depth !== 0) continue; // unbalanced — skip, model will retry
        const paramsStr = response.substring(openParenIdx, i);
        const fullMatch = response.substring(bm.index + (bm[1] ? bm[1].length : 0), i + 1);
        const skillName = normalizeSkillName(rawName);
        const params = {};
        const paramPattern = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
        let pm2;
        while ((pm2 = paramPattern.exec(paramsStr)) !== null) {
            params[pm2[1]] = unescapeString(pm2[2]);
        }
        // Avoid duplicates if another pattern already captured this span.
        if (!skillCalls.some(sc => sc.fullMatch === fullMatch)) {
            skillCalls.push({ skillName, params, fullMatch });
        }
    }

    return skillCalls;
}

// Harmony models sometimes emit concatenated names like "updatefile"
// instead of "update_file". Resolve to the real skill name by matching
// against the cached catalogue (case + underscore-insensitive).
function normalizeSkillName(name) {
    if (!name) return name;
    if (cachedSkills.some(s => s.name === name)) return name;
    const key = name.toLowerCase().replace(/_/g, '');
    const hit = cachedSkills.find(s => s.name.toLowerCase().replace(/_/g, '') === key);
    return hit ? hit.name : name;
}

// Detect incomplete/malformed skill calls that the AI started but didn't finish
function detectMalformedSkillCalls(response) {
    const issues = [];

    // First, get all successfully parsed skill calls
    const parsedCalls = parseSkillCalls(response);
    const parsedMatches = parsedCalls.map(sc => sc.fullMatch);

    const noteIssue = (skillName, startIndex, hasCloser) => {
        const contextEnd = Math.min(startIndex + 100, response.length);
        const context = response.substring(startIndex, contextEnd);
        if (!hasCloser) {
            issues.push({
                type: 'incomplete_bracket',
                skillName,
                context: context.substring(0, 50) + '...'
            });
        } else {
            issues.push({
                type: 'malformed_params',
                skillName,
                context: context.substring(0, 50) + '...'
            });
        }
    };

    // Find all [SKILL: starts in the response
    const skillStartPattern = /\[SKILL:(\w+)\(/g;
    let match;
    while ((match = skillStartPattern.exec(response)) !== null) {
        const skillName = match[1];
        const startIndex = match.index;
        const wasParsed = parsedMatches.some(fullMatch => {
            const matchIndex = response.indexOf(fullMatch);
            return matchIndex === startIndex;
        });
        if (!wasParsed) {
            const hasCloser = response.substring(startIndex).includes(')]');
            noteIssue(skillName, startIndex, hasCloser);
        }
    }

    // Also detect bare `call:name(...)` that failed to parse (Gemma-style
    // calls whose argument got truncated mid-string). Without this the
    // [SKILL SYNTAX ERROR] feedback never fires for the most common
    // failure mode on small models.
    const bareStartPattern = /(^|\n)[ \t]*call:(\w+)\s*\(/g;
    while ((match = bareStartPattern.exec(response)) !== null) {
        const skillName = match[2];
        const startIndex = match.index + (match[1] ? match[1].length : 0);
        const wasParsed = parsedMatches.some(fullMatch => {
            const matchIndex = response.indexOf(fullMatch);
            return matchIndex >= startIndex - 2 && matchIndex <= startIndex + 2;
        });
        if (!wasParsed) {
            // Does the rest of the string contain a plausible closing `)`
            // at the same nesting depth? Cheap heuristic: look for `\n)` or
            // `")` anywhere after the start.
            const tail = response.substring(startIndex);
            const hasCloser = /\)\s*($|\n)/.test(tail);
            noteIssue(skillName, startIndex, hasCloser);
        }
    }

    return issues;
}

// Detect when AI claims to have performed file operations without actually executing skills
// Returns true if the AI likely hallucinated completion without skill execution
function detectFalseCompletionClaim(response, userMessage) {
    if (!response || !userMessage) return false;

    const responseLower = response.toLowerCase();
    const messageLower = userMessage.toLowerCase();

    // FIRST: Check if this is FUTURE INTENT, not a completion claim
    // Phrases like "I'll save", "I can save", "Let me save" are NOT false completion claims
    const futureIntentPatterns = [
        /\b(i'll|i will|let me|i can|i'm going to|going to|will now|can now|need to|should)\s+(save|write|create|generate)/i,
        /\b(now\s+)?(save|write|create|generate)\s+(this|the|it|a)\s+(to|as|into)/i,
        /\bproceed\s+to\s+(save|write|create)/i,
        /\b(about to|ready to)\s+(save|write|create)/i,
        // "I'll now create/save" patterns
        /\bi('ll| will)\s+now\s+(save|write|create)/i,
        // "Let me create/save the file" patterns
        /\blet\s+me\s+(now\s+)?(save|write|create|generate)/i
    ];

    const isFutureIntent = futureIntentPatterns.some(pattern => pattern.test(responseLower));
    if (isFutureIntent) {
        return false; // This is intent to save, not a false completion claim
    }

    // Patterns indicating user requested a file operation
    const fileOperationRequests = [
        /\b(delete|remove|rm|erase|clear|wipe)\b.*\b(file|folder|directory|dir|everything|all)\b/i,
        /\b(file|folder|directory|dir|everything|all)\b.*\b(delete|remove|rm|erase|clear|wipe)d?\b/i,
        // Match "delete/remove <filename>" without requiring the word "file" (e.g., "delete test.txt")
        /\b(delete|remove|rm|erase)\b.*\.\w{1,5}\b/i,
        /\b(delete|remove|rm|erase)\b\s+\S+/i,
        /\bcreate\b.*\b(file|folder|directory)\b/i,
        // Match "create <filename>" (e.g., "create test.txt")
        /\bcreate\b.*\.\w{1,5}\b/i,
        /\bmove\b.*\b(file|folder|directory)\b/i,
        /\brename\b.*\b(file|folder|directory)\b/i,
        /\bcopy\b.*\b(file|folder|directory)\b/i,
        // PDF-related requests
        /\b(put|save|write|convert|export)\b.*\b(in|into|to|as)\b.*\bpdf\b/i,
        /\b(create|generate|make)\b.*\bpdf\b/i,
        /\bpdf\b.*\b(report|file|document)\b/i,
        // TXT/file save requests
        /\b(put|save|write|export)\b.*\b(in|into|to|as)\b.*\b(txt|text|file)\b/i,
        /\b(put|save|write|export)\b.*\b(in|into|to)\b.*\.(txt|md|json|csv)\b/i,
        /\b(create|generate|make)\b.*\.(txt|md|json|csv)\b/i,
        /\bcalled\b.*\.(txt|md|json|csv|pdf)\b/i
    ];

    const userRequestedFileOp = fileOperationRequests.some(pattern => pattern.test(messageLower));
    if (!userRequestedFileOp) return false;

    // Patterns indicating AI claims to have ALREADY completed the operation (past tense only)
    // These should NOT match future intent - only actual completion claims
    const completionClaims = [
        /\b(have been|has been|were|was)\s+(deleted|removed|erased|cleared|wiped|created|moved|renamed|copied|saved|written)\b/i,
        /\bsuccessfully\s+(deleted|removed|erased|cleared|created|moved|renamed|copied|saved|written)\b/i,
        /\b(deleted|removed|erased|cleared|created|moved|renamed|copied|saved|written)\s+successfully\b/i,
        /\ball\s+(files|folders|directories|items)\b.*\b(deleted|removed|cleared)\b/i,
        /\b(done|completed|finished)\b.*\b(delet|remov|eras|clear|creat|mov|renam|cop|sav|writ)/i,
        /\bI('ve|\s+have)\s+(deleted|removed|created|moved|renamed|copied|saved|written)\b/i,
        // PDF-related completion claims
        /\bI('ve|\s+have)\s+(generated|created|saved|written)\b.*\bpdf\b/i,
        /\bpdf\b.*\b(has been\s+)?(generated|created|saved|written)\b/i,
        /\bsaved\s+(it\s+)?(at|to|in)\s+[`'"]?[^\s]*\.pdf/i,
        /\bpdf\s+(report|file|document)\b.*\b(created|generated|saved)\b/i,
        // TXT/file save completion claims - require past tense indicators
        /\bI('ve|\s+have)\s+(saved|written|created)\b.*\b(to|as|in)\b.*\b(a\s+)?(file|txt|text)\b/i,
        /\bsaved\s+(it\s+)?(at|to|in)\s+[`'"]?[^\s]*\.(txt|md|json|csv)/i,
        /\bfile\s+(has been\s+)?(named|called)\s+[`'"]?[^\s]+\.(txt|md|json|csv|pdf)/i,
        // "the report/summary has been saved/written" (past tense)
        /\b(the|a)\s+(report|summary|file|data)\b.*\b(is|has been)\s+(saved|written|created)\b/i,
        // "saved and written to" (clear past tense action)
        /\bI('ve|\s+have)\s+saved\b[^.]*\bto\s+[`'"]?[^\s`'"]+\.(txt|md|json|csv|pdf)/i
    ];

    const aiClaimsCompletion = completionClaims.some(pattern => pattern.test(responseLower));

    return aiClaimsCompletion;
}

// Skill categories for smart routing - ALL skills organized by function
const SKILL_CATEGORIES = {
    FILE_OPS: ['create_file', 'read_file', 'update_file', 'delete_file', 'delete_directory', 'list_directory', 'move_file', 'copy_file', 'create_directory', 'append_to_file', 'tail_file', 'head_file', 'search_files', 'get_file_metadata', 'diff_files', 'search_replace_file'],
    ARCHIVE: ['unzip_file', 'zip_files', 'tar_extract', 'tar_create', 'extract_archive'],
    NETWORK: ['fetch_url', 'dns_lookup', 'check_port', 'ping_host', 'http_request', 'download_file', 'curl_request'],
    WEB: ['playwright_fetch', 'playwright_interact', 'web_search'],
    PROCESS: ['list_processes', 'kill_process', 'start_process'],
    SYSTEM: ['system_info', 'disk_usage', 'get_uptime', 'list_ports', 'list_services', 'screenshot'],
    GIT: ['git_status', 'git_diff', 'git_log', 'git_branch'],
    ENV: ['get_env_var', 'set_env_var', 'which_command'],
    SHELL: ['run_bash', 'run_python', 'run_powershell', 'run_cmd'],
    WINDOWS: ['get_windows_services', 'get_registry_value', 'set_registry_value'],
    DATA: ['parse_json', 'parse_csv', 'base64_encode', 'base64_decode', 'hash_data', 'compress_data', 'decompress_data'],
    CODE: ['find_patterns', 'analyze_code'],
    PDF: ['create_pdf', 'html_to_pdf', 'markdown_to_html', 'read_pdf', 'pdf_page_count', 'pdf_to_images'],
    IMAGE: ['ocr_image', 'convert_image'],
    EMAIL: ['read_email_file'],
    MEDIA: ['analyze_video'],
    UTILITY: ['generate_uuid', 'get_timestamp', 'count_words'],
    DATABASE: ['sqlite_query', 'sqlite_list_tables'],
    CLIPBOARD: ['clipboard_read', 'clipboard_write']
};

// Map intent keywords to categories for smart detection
const INTENT_KEYWORDS = {
    FILE_OPS: ['file', 'create', 'read', 'write', 'delete', 'remove', 'list', 'directory', 'folder', 'move', 'copy', 'rename', 'append', 'tail', 'head', 'search file', 'find file', 'metadata', 'diff', 'replace in file'],
    ARCHIVE: ['zip', 'unzip', 'tar', 'archive', 'compress', 'extract', 'decompress', '.gz', '.tar', '.zip'],
    NETWORK: ['dns', 'ping', 'port', 'network', 'download', 'http request', 'curl', 'fetch url'],
    WEB: ['web', 'scrape', 'browse', 'website', 'webpage', 'search online', 'look up online', 'playwright'],
    PROCESS: ['process', 'kill', 'running', 'pid', 'spawn', 'execute process'],
    SYSTEM: ['system info', 'memory', 'cpu', 'disk usage', 'uptime', 'screenshot', 'services', 'open ports'],
    GIT: ['git', 'commit', 'branch', 'repository', 'repo', 'staged', 'unstaged'],
    ENV: ['environment', 'variable', 'env var', 'path variable', 'which command'],
    SHELL: ['bash', 'shell', 'script', 'python script', 'powershell', 'terminal', 'command line', 'run command'],
    WINDOWS: ['windows', 'registry', 'windows service'],
    DATA: ['json', 'csv', 'parse', 'encode', 'decode', 'base64', 'hash', 'md5', 'sha', 'checksum'],
    CODE: ['analyze code', 'code quality', 'pattern', 'complexity', 'refactor'],
    PDF: ['pdf', 'document', 'report', 'html to pdf', 'markdown to', 'generate report'],
    IMAGE: ['image', 'ocr', 'convert image', 'picture', 'photo', 'screenshot'],
    EMAIL: ['email', 'mail', '.eml'],
    MEDIA: ['video', 'media', 'analyze video', 'extract frames'],
    UTILITY: ['uuid', 'timestamp', 'current time', 'count words', 'word count'],
    DATABASE: ['sqlite', 'database', 'sql', 'query', 'table'],
    CLIPBOARD: ['clipboard', 'copy to clipboard', 'paste']
};

// Detect which skill categories are relevant based on user message
function detectIntentCategories(userMessage, websearchEnabled) {
    // FILE_OPS is the only always-on category — file CRUD is the most common
    // Koda workflow and small models get confused if it ever disappears.
    // Everything else (PROCESS/SYSTEM/GIT/ENV/WEB/…) ships only when the
    // message actually asks for it, keeping the skill catalog lean.
    const coreCategories = ['FILE_OPS'];

    if (!userMessage) {
        return websearchEnabled ? [...coreCategories, 'WEB'] : coreCategories;
    }

    const messageLower = userMessage.toLowerCase();
    const detectedCategories = new Set(coreCategories);

    // Check each category's keywords
    for (const [category, keywords] of Object.entries(INTENT_KEYWORDS)) {
        for (const keyword of keywords) {
            if (messageLower.includes(keyword)) {
                detectedCategories.add(category);
                break;
            }
        }
    }

    // IOC Pattern Detection - detect IPs, hashes, domains without requiring keywords
    // IPv4 address pattern (e.g., 115.191.18.57)
    const ipv4Pattern = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;
    // Hash patterns: MD5 (32), SHA1 (40), SHA256 (64) - standalone hex strings
    const hashPattern = /\b[a-fA-F0-9]{32}\b|\b[a-fA-F0-9]{40}\b|\b[a-fA-F0-9]{64}\b/;
    // Domain pattern (word.word or word.word.word, excluding file extensions after the dot)
    const domainPattern = /\b[a-zA-Z0-9][-a-zA-Z0-9]*\.(?!(?:txt|md|js|ts|py|json|html|css|tsx|jsx|log|cfg|ini|yaml|yml|xml|sh|bat|ps1|rb|go|rs|java|c|cpp|h|hpp)\b)[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?\b/;

    // Check for IOC patterns - enable NETWORK category for dns_lookup, ping_host, etc.
    const hasIOC = ipv4Pattern.test(userMessage) || hashPattern.test(userMessage) || domainPattern.test(userMessage);
    if (hasIOC) {
        detectedCategories.add('NETWORK');
    }

    // If websearch is enabled, include web-dependent categories
    if (websearchEnabled) {
        detectedCategories.add('WEB');
        detectedCategories.add('NETWORK');
    }

    return Array.from(detectedCategories);
}

// Get all skills in a category
function getSkillsInCategory(category) {
    return SKILL_CATEGORIES[category] || [];
}

// ============================================================================
// Query classification
// ============================================================================
//
// Koda used to always ship its 500+ line skill catalog as part of the user
// turn, which made small models hallucinate (the infamous "10+10 = 20 words"
// bug and "count to 5 using count_words skill"). The catalog is only useful
// when the user is asking for something that actually needs a skill — file
// operations, git, networking, shell, etc. For plain chat, math, factual
// questions, and code snippets, a lean system prompt gives far better
// results.
//
// classifyQuery returns one of:
//   'skill'        — the user clearly wants a filesystem/git/net/etc action
//   'math'         — a pure arithmetic expression
//   'greeting'     — hi/hello/hey/...
//   'code'         — write/show/explain code
//   'chat'         — everything else (facts, explanations, conversation)
//
// The 'skill' bucket still gets the full catalog. The other buckets get a
// short, focused system prompt.
// ============================================================================

// Keywords that signal a request that actually needs a skill call. Broader
// than the original "create/list/delete" set — it also catches natural
// project-state questions ("how many files in this project?"), file-refs
// with extensions ("edit README.md"), and review verbs ("check for bugs")
// which otherwise fell through to the lean prompt with no tool access.
const SKILL_TRIGGER_REGEX = new RegExp([
    // File / directory operations (broad verb set)
    '\\b(create|make|write|save|export|delete|remove|rm|erase|list|move|rename|copy|append|tail|head|edit|update|modify|change|fix|refactor|replace|rewrite|insert|add|open|read|view|show|display|cat|print|check|inspect|review|scan|analyze|audit|look\\s+at|describe|summariz|explain)\\b.*\\b(file|folder|directory|dir|path|pdf|txt|json|yaml|yml|csv|md|zip|tar|archive|readme|changelog|license|contributing|makefile|dockerfile|gitignore|code|codebase|project|repo|app|script|module|function|class)\\b',
    // "what does this project / app / repo do / for?" and similar
    '\\bwhat\\s+(does|is|are)\\s+(this|the|my|current)\\s+(project|repo|repository|codebase|app|script|folder|directory|code)\\b',
    '\\btell\\s+me\\s+(about|what.?s in)\\s+(this|the|my|current)?\\s*(project|repo|repository|codebase|app|folder|directory|file|code)\\b',
    '\\b(file|folder|directory|dir)\\b.*\\b(named|called)\\b',
    '\\b(ls|list)\\b.*(dir|directory|folder|files)',
    '\\blist\\s+(the\\s+)?(files|contents|directory|dir)\\b',
    // Shell-flavored commands at the start — "ls X", "list X", "cat X".
    // These verbs are rarely conversational, so any target is fine.
    '^\\s*(ls|list|cat|tail|head|dump)\\s+\\S+',
    // English verbs that are also conversational ("read the docs" means
    // consult documentation, not load a file). Only match when the target
    // looks file-shaped: contains ./_ or is a known project filename.
    // Note: [A-Z]{3,} is unusable here because the /i flag makes it match
    // lowercase too, so "read the docs" slipped through.
    '^\\s*(show|display|print|open|read|edit)\\s+(?:the\\s+)?(?=\\S*[./_]|(?:README|LICENSE|CHANGELOG|CONTRIBUTING|MAKEFILE|DOCKERFILE|TODO|NOTES|AUTHORS|INSTALL)\\b)[\\w\\-./]+',
    // "what\'s inside X", "what\'s in X", "contents of X"
    '\\b(what\'?s|what is|what are|whats)\\s+(the\\s+)?(files?|contents?|stuff|things?|items?|file|directory|dir|folder)?\\s*(in|inside|under|within|on)\\s+\\S+',
    '\\bcontents?\\s+of\\s+\\S+',
    '\\b(inside|under|within)\\s+(of\\s+)?(the\\s+)?[\\w\\-./]+',
    '\\b(what\'?s|whats)\\s+(in|inside)\\s+here\\b',
    // Short imperative retries — "redo", "retry", "try again", "do it",
    // "again". On their own these have no file-keywords so they were
    // falling to the lean prompt, and the model kept hallucinating
    // refusals instead of re-running the original request.
    '^(redo|retry|try\\s+again|again|do\\s+(it|that|this)|continue|keep\\s+going|go|proceed)\\s*[.!?]?$',
    // Explicit filename with extension anywhere in the query
    '\\b[\\w\\-\\.]+\\.(py|js|ts|jsx|tsx|mjs|cjs|md|txt|json|yaml|yml|toml|ini|env|csv|html|htm|css|scss|sh|bash|zsh|ps1|bat|cmd|conf|cfg|xml|log|sql|go|rs|rb|php|java|kt|swift|c|h|cpp|hpp|cs|dockerfile|makefile|gitignore)\\b',
    // Project-state questions ("how many files?", "what\'s in this project?")
    '\\bhow\\s+many\\b.*\\b(files?|folders?|directories|dirs?|lines?|tests?|functions?|classes?|modules?)\\b',
    '\\bwhat(\'?s| is)\\b.*\\bin\\s+(this|the|my|current)\\b.*\\b(project|folder|dir|directory|repo|repository|codebase)\\b',
    '\\b(project|folder|directory|codebase|repo)\\s+(structure|layout|tree|contents|files|overview)\\b',
    '\\b(show|list|display|dump)\\b.*\\b(project|directory|folder|files|structure|tree|contents)\\b',
    '\\bwhere\\s+(is|are)\\b.*\\b(files?|folders?|dirs?)\\b',
    // Review / diagnose verbs applied to code or project
    '\\b(check|scan|review|analyze|inspect|audit|lint)\\b.*\\b(code|project|codebase|repo|repository|file|files|folder|app|script)\\b',
    '\\b(check|find|scan|look)\\b.*\\b(for\\s+)?(bugs?|issues?|errors?|security|vulnerabilit|problems?|typos?|dead code|todos?)\\b',
    '\\b(any|possible)\\s+(improvements?|fixes|bugs?|issues?|suggestions?)\\b',
    // Git
    '\\bgit\\b',
    '\\b(commit|branch|staged|unstaged|repo|repository)\\b',
    // Network / web fetch
    '\\b(ping|dns|port|http|https|fetch|download|curl|wget)\\b',
    '\\b(scrape|scan|crawl)\\b',
    // Shell / process
    '\\b(run|execute)\\s+(bash|shell|command|script|python|node)\\b',
    '\\b(kill|pid|process)\\b',
    // System info
    '\\b(disk|uptime|cpu|memory|ram|system info)\\b',
    // Archives
    '\\b(zip|unzip|tar|extract|compress)\\b',
    // Database
    '\\b(sqlite|sql query|select\\s+.*\\s+from)\\b',
    // Env
    '\\benv(ironment)?\\s+(var|variable)\\b',
    // Search in filesystem
    '\\bsearch (for )?(files|in)\\b',
    '\\bgrep\\b'
].join('|'), 'i');

const MATH_REGEX = /^[\s0-9+\-*/().^%=,xX\s]+$/;
const MATH_WORDS_REGEX = /^(what('?s| is)|calculate|compute|solve)\s+([0-9().+\-*/^%\s]+|\d+[\s\S]*(times|plus|minus|divided|squared|cubed)[\s\S]*)/i;
const GREETING_REGEX = /^(hi|hello|hey|yo|howdy|greetings|sup|hola|bonjour)[\s!.,?]*$/i;
const CODE_REQUEST_REGEX = /\b(write|show|give me|generate|produce|implement)\s+(a|an|some)?\s*(python|javascript|js|typescript|ts|bash|shell|sql|go|rust|c\+\+|c#|java|regex|function|script|class|snippet|code|example)\b/i;

function classifyQuery(message, websearchEnabled = false) {
    const m = (message || '').trim();
    if (!m) return 'chat';

    // 1. Does this clearly need a skill call? Check before math/chat because
    // "list files in /tmp" contains no math but is a skill request.
    if (SKILL_TRIGGER_REGEX.test(m)) {
        return 'skill';
    }

    // 2. Pure arithmetic like "10+10", "(3+4)*2"
    if (m.length < 80 && MATH_REGEX.test(m) && /[0-9]/.test(m) && /[+\-*/^%]/.test(m)) {
        return 'math';
    }
    // 3. "what is 47 times 38" style
    if (MATH_WORDS_REGEX.test(m)) {
        return 'math';
    }

    // 4. Greetings
    if (GREETING_REGEX.test(m)) {
        return 'greeting';
    }

    // 5. Code snippet requests (unless it's also a file-save request, which
    // would have been caught above as a skill).
    if (CODE_REQUEST_REGEX.test(m)) {
        return 'code';
    }

    // Web searches are conversational by default — the web results get
    // injected into the system message later.
    return 'chat';
}

// Lean system prompt for non-skill queries. Deliberately short: a small
// model performs much better when the prompt fits comfortably in a few
// hundred tokens. The guardrails at the bottom are the minimum needed to
// stop the specific bugs observed in testing.
function buildLeanSystemPrompt(queryType, websearchEnabled = false) {
    const base =
`You are Koda, a concise AI assistant running in a terminal.

Answer the user's question directly. Do NOT restate, describe, or analyze the question itself. Do NOT comment on its length, word count, character count, or format — just answer.

Formatting rules (output is rendered as markdown in a terminal):
- Keep responses short unless the user asks for detail. A short answer is one or two sentences with no headers and no bullets.
- Only use structure when it actually helps: use ## Headers, - bullet lists, **bold**, and \`inline code\` when a response is long enough to benefit from structure. Never add headings or bullets just to look organized.
- For math, give the numerical result first, optionally followed by one-line reasoning.
- For factual questions, answer in one or two sentences.
- For code requests, output the code in a fenced code block with the language tag (\`\`\`python, \`\`\`js, etc) and keep the explanation brief.
- For news, summaries, or research responses, lead with a one-line summary, then use short bullets for the key points, and cite sources by number [1], [2] if they were provided.
- Never invent "skill" calls in square brackets — those are only used when actually executing tools, not for conversation.
- Never fabricate that you have executed a tool, saved a file, or counted words unless you actually did.`;

    const tail = websearchEnabled
        ? '\n\nWeb search is ON. If search results are provided below, use them as the primary source and cite briefly.'
        : '';

    return base + tail;
}

// Build system prompt with skill instructions - SMART ROUTING VERSION
function buildSkillSystemPrompt(skills, websearchEnabled = false, userMessage = '') {
    if (!skills || skills.length === 0) {
        return '';
    }

    const enabledSkills = skills.filter(s => s.enabled);
    if (enabledSkills.length === 0) {
        return '';
    }

    // Detect relevant categories based on user message
    const relevantCategories = detectIntentCategories(userMessage, websearchEnabled);

    // Get skills that should have expanded details (in relevant categories)
    const expandedSkillNames = new Set();
    for (const category of relevantCategories) {
        for (const skillName of getSkillsInCategory(category)) {
            expandedSkillNames.add(skillName);
        }
    }

    // Build compact skill catalog - ALL enabled skills visible
    const skillsByCategory = {};
    const allSkillNames = [];

    // Organize skills by category
    for (const skill of enabledSkills) {
        allSkillNames.push(skill.name);
        let foundCategory = null;
        for (const [category, skillList] of Object.entries(SKILL_CATEGORIES)) {
            if (skillList.includes(skill.name)) {
                foundCategory = category;
                break;
            }
        }
        const cat = foundCategory || 'OTHER';
        if (!skillsByCategory[cat]) skillsByCategory[cat] = [];
        skillsByCategory[cat].push(skill);
    }

    let prompt = `You are Koda, a helpful AI assistant. You can have normal conversations, answer questions, help with coding, math, explanations, and any other topics.

You have access to ${enabledSkills.length} skills across multiple categories. Execute skills directly when the user's request matches a skill's purpose.

IMPORTANT FILE PLACEMENT RULES:
- User's current working directory: ${userWorkingDirectory}
- When creating project files, ALWAYS organize them in a descriptive subdirectory based on the project type
- Use absolute paths starting with ${userWorkingDirectory}/
- NEVER use container-internal paths like /usr/src/app/ or /var/lib/

=== COMPLETE SKILL CATALOG ===
`;

    // Category display names
    const categoryNames = {
        FILE_OPS: '📁 File Operations',
        ARCHIVE: '📦 Archives',
        NETWORK: '🌐 Network',
        WEB: '🔍 Web Search & Scraping',
        PROCESS: '⚙️ Process Management',
        SYSTEM: '💻 System Info',
        GIT: '📝 Git Operations',
        ENV: '🔧 Environment',
        SHELL: '🖥️ Shell/Script Execution',
        WINDOWS: '🪟 Windows',
        DATA: '📊 Data Processing',
        CODE: '🔬 Code Analysis',
        PDF: '📄 PDF & Documents',
        IMAGE: '🖼️ Image Processing',
        EMAIL: '📧 Email',
        MEDIA: '🎬 Media',
        UTILITY: '🔢 Utilities',
        DATABASE: '🗄️ Database',
        CLIPBOARD: '📋 Clipboard',
        OTHER: '📌 Other'
    };

    // Display order
    const categoryOrder = ['FILE_OPS', 'WEB', 'NETWORK', 'PROCESS', 'SYSTEM', 'GIT', 'ENV', 'PDF', 'ARCHIVE', 'DATA', 'CODE', 'SHELL', 'IMAGE', 'MEDIA', 'DATABASE', 'EMAIL', 'CLIPBOARD', 'UTILITY', 'WINDOWS', 'OTHER'];

    // Only emit categories the message actually needs. Shipping all 20
    // categories every turn was blowing past small context windows (~65
    // skills × ~80 chars each = ~5 KB of catalog alone). The unused
    // category names are listed at the bottom so the model knows they
    // exist and can ask the user to re-phrase if a different tool is
    // needed; `OTHER` is always included because it catches user-added
    // skills that don't match any built-in category.
    const emittedCategories = new Set([...relevantCategories, 'OTHER']);
    const skippedCategories = [];

    for (const category of categoryOrder) {
        const skills = skillsByCategory[category];
        if (!skills || skills.length === 0) continue;

        if (!emittedCategories.has(category)) {
            skippedCategories.push(categoryNames[category] || category);
            continue;
        }

        const categoryName = categoryNames[category] || category;
        prompt += `\n${categoryName}:\n`;

        for (const skill of skills) {
            const params = skill.parameters || {};
            const paramList = Object.entries(params)
                .map(([name, type]) => `${name}`)
                .join(', ');

            // Expanded usage only for the first (most-relevant) category
            // and only for skills whose behavior isn't obvious from the
            // name (read_file/update_file/etc. are self-explanatory; search_
            // replace_file / head_file / diff_files benefit from the hint).
            // Usage excerpt capped at 120 chars to keep the prompt lean.
            const isTopCategory = relevantCategories[0] === category;
            const obviousNames = new Set(['create_file', 'read_file', 'update_file', 'delete_file', 'delete_directory', 'list_directory', 'create_directory', 'move_file', 'copy_file', 'append_to_file']);
            if (isTopCategory && skill.systemPrompt && !obviousNames.has(skill.name)) {
                prompt += `  • ${skill.name}(${paramList}) - ${skill.description || ''}\n`;
                prompt += `    Usage: ${skill.systemPrompt.substring(0, 120)}${skill.systemPrompt.length > 120 ? '…' : ''}\n`;
            } else {
                prompt += `  • ${skill.name}(${paramList}) - ${skill.description || ''}\n`;
            }
        }
    }

    if (skippedCategories.length > 0) {
        prompt += `\nOther categories available on request: ${skippedCategories.join(', ')}.\n`;
    }

    // Dynamic examples based on detected categories
    prompt += `
=== SKILL EXECUTION FORMAT ===
[SKILL:skill_name(param1="value1", param2="value2")]
`;

    // Category-specific examples (only show for relevant categories)
    const categoryExamples = {
        FILE_OPS: `
📁 FILE OPERATIONS EXAMPLES:
[SKILL:create_file(filePath="${userWorkingDirectory}/project/file.txt", content="content here")]
[SKILL:create_directory(dirPath="${userWorkingDirectory}/new_folder")]
[SKILL:read_file(filePath="${userWorkingDirectory}/path/to/file")]
[SKILL:update_file(filePath="${userWorkingDirectory}/path/to/file", content="new content")]
[SKILL:delete_file(filePath="${userWorkingDirectory}/path/to/file")]
[SKILL:delete_directory(dirPath="${userWorkingDirectory}/path/to/dir")]
[SKILL:list_directory(dirPath="${userWorkingDirectory}")]
[SKILL:list_directory(dirPath="${userWorkingDirectory}", recursive="true")]  # full tree incl. subdirectories; use when the user asks for "all files" or "everything"
[SKILL:move_file(sourcePath="/path/to/file", destPath="/path/to/new/location")]
[SKILL:copy_file(sourcePath="/path/to/file", destPath="/path/to/copy")]
[SKILL:append_to_file(filePath="${userWorkingDirectory}/file.txt", content="appended content")]
[SKILL:search_files(directory="${userWorkingDirectory}", pattern="*.js")]
[SKILL:diff_files(filePath1="/path/to/file1", filePath2="/path/to/file2")]
[SKILL:search_replace_file(filePath="/path/to/file", search="old", replace="new")]
`,
        PROCESS: `
⚙️ PROCESS MANAGEMENT EXAMPLES:
[SKILL:list_processes(sort_by="cpu", limit="20")]
[SKILL:kill_process(pid="1234")]
[SKILL:start_process(command="python", args="['script.py']")]
`,
        SYSTEM: `
💻 SYSTEM INFO EXAMPLES:
[SKILL:system_info()]
[SKILL:disk_usage(path="/")]
[SKILL:get_uptime()]
[SKILL:list_ports()]
[SKILL:list_services()]
`,
        GIT: `
📝 GIT EXAMPLES:
[SKILL:git_status()]
[SKILL:git_diff(staged="false")]
[SKILL:git_log(limit="10")]
[SKILL:git_branch()]
`,
        ENV: `
🔧 ENVIRONMENT EXAMPLES:
[SKILL:get_env_var(name="PATH")]
[SKILL:set_env_var(name="MY_VAR", value="my_value")]
[SKILL:which_command(command="node")]
`,
        WEB: `
🔍 WEB SEARCH & SCRAPING EXAMPLES:
[SKILL:web_search(query="latest security vulnerabilities 2024")]
[SKILL:playwright_fetch(url="https://example.com/article")]
[SKILL:playwright_interact(url="https://example.com", actions="[{\\"type\\":\\"click\\",\\"selector\\":\\"#button\\"}]")]
[SKILL:fetch_url(url="https://api.example.com/data")]

When asked to find or summarize web content:
1. Use web_search to find relevant URLs
2. Use playwright_fetch to get full page content (handles JS-rendered pages)
3. Summarize and present the content
`,
        NETWORK: `
🌐 NETWORK EXAMPLES:
[SKILL:dns_lookup(domain="example.com")]
[SKILL:check_port(host="localhost", port="8080", timeout="5")]
[SKILL:ping_host(host="google.com", count="4")]
[SKILL:http_request(url="https://api.example.com", method="POST", body="{\\"key\\":\\"value\\"}")]
[SKILL:download_file(url="https://example.com/file.zip", destPath="${userWorkingDirectory}/file.zip")]
`,
        PDF: `
📄 PDF & DOCUMENT EXAMPLES:
[SKILL:create_pdf(outputPath="${userWorkingDirectory}/report.pdf", title="Report", content="Report content")]
[SKILL:html_to_pdf(htmlPath="/path/to/file.html", outputPath="/path/to/output.pdf")]
[SKILL:markdown_to_html(mdPath="/path/to/file.md", outputPath="/path/to/output.html")]
[SKILL:read_pdf(filePath="/path/to/document.pdf")]
[SKILL:pdf_page_count(filePath="/path/to/document.pdf")]
`,
        ARCHIVE: `
📦 ARCHIVE EXAMPLES:
[SKILL:zip_files(files="['/path/file1.txt', '/path/file2.txt']", outputPath="/path/archive.zip")]
[SKILL:unzip_file(zipPath="/path/archive.zip", destPath="/path/extracted/")]
[SKILL:tar_create(files="/path/to/dir", outputPath="/path/archive.tar.gz")]
[SKILL:tar_extract(tarPath="/path/archive.tar.gz", destPath="/path/extracted/")]
`,
        DATA: `
📊 DATA PROCESSING EXAMPLES:
[SKILL:parse_json(content="{\\"key\\": \\"value\\"}")]
[SKILL:parse_csv(content="name,age\\nAlice,30\\nBob,25", delimiter=",")]
[SKILL:base64_encode(data="text to encode")]
[SKILL:base64_decode(data="dGV4dCB0byBkZWNvZGU=")]
[SKILL:hash_data(data="text to hash", algorithm="sha256")]
[SKILL:generate_uuid()]
[SKILL:get_timestamp()]
[SKILL:count_words(content="The quick brown fox jumps over the lazy dog.")]
`,
        SHELL: `
🖥️ SHELL EXECUTION EXAMPLES:
[SKILL:run_bash(command="ls -la")]
[SKILL:run_python(code="print('Hello World')")]
`,
        IMAGE: `
🖼️ IMAGE EXAMPLES:
[SKILL:screenshot(outputPath="${userWorkingDirectory}/screenshot.png")]
[SKILL:ocr_image(imagePath="/path/to/image.png")]
[SKILL:convert_image(inputPath="/path/image.png", outputPath="/path/image.jpg", format="jpeg")]
`,
        DATABASE: `
🗄️ DATABASE EXAMPLES:
[SKILL:sqlite_query(dbPath="/path/to/db.sqlite", query="SELECT * FROM users LIMIT 10")]
[SKILL:sqlite_list_tables(dbPath="/path/to/db.sqlite")]
`,
        CODE: `
🔬 CODE ANALYSIS EXAMPLES:
[SKILL:analyze_code(code="function hello() { return 'world'; }")]
[SKILL:find_patterns(content="TODO: fix this\\nFIXME: broken", pattern="TODO|FIXME")]

Note: analyze_code and find_patterns work on inline text content, not file paths.
To analyze a file, first read_file then pass its content to analyze_code.
`
    };

    // Add examples only for relevant categories
    for (const category of relevantCategories) {
        if (categoryExamples[category]) {
            prompt += categoryExamples[category];
        }
    }

    // Build dynamic available skills list — only the skills we actually
    // emitted above. Dumping all 65 skill names here every turn was
    // reintroducing most of the catalog size we'd just saved by filtering
    // categories. The model only needs to see the names it can use *now*.
    const emittedSkillNames = [];
    for (const category of Object.keys(skillsByCategory)) {
        if (!emittedCategories.has(category)) continue;
        for (const s of skillsByCategory[category]) emittedSkillNames.push(s.name);
    }
    const availableSkillsList = emittedSkillNames.join(', ');

    prompt += `
=== CRITICAL EXECUTION RULES ===
1. Use ONLY skills from the catalog above. Available: ${availableSkillsList}
2. DISCOVERY FIRST: For fuzzy requests ("delete that folder", "find the config"), use list_directory FIRST to see what exists, then act.
3. ALWAYS EXECUTE skills for file/directory operations - NEVER give shell commands or instructions instead. You have full access to the filesystem.
4. When the user says "create a file/directory", "delete", "read", "move", "copy" etc - you MUST call the corresponding skill. Do NOT tell the user to run mkdir, touch, or any other command.
5. When fixing code, use search_replace_file for targeted edits or update_file for a full rewrite — don't just show the fix.
6. TARGETED EDITS (IMPORTANT): For changing a small part of an existing file (tweaking a value, replacing a function, adding a few lines), use search_replace_file with the exact old snippet and the new snippet. Do NOT re-read the whole file and call update_file with the entire content — that costs many times more tokens and frequently truncates. Only use update_file when (a) the file is brand new, (b) the edit touches most of the file, or (c) search_replace_file could not find the snippet.
7. STOP LOOPING: After success, confirm briefly. Don't verify with extra skills.
8. For non-skill tasks (math, explanations, chat), respond conversationally.
9. NEVER fabricate skill results. Do not write "I've executed the X skill" unless you ACTUALLY called [SKILL:X(...)] in this same response.
10. NEVER answer a simple question by calling an unrelated skill. Math like "10+10" or "count to 5" requires NO skills — just answer directly.
11. NEVER restate, analyze, or comment on the user's message itself (length, word count, format). Answer the actual question.

WRONG: "You can create a directory by running: mkdir test"
RIGHT: [SKILL:create_directory(dirPath="${userWorkingDirectory}/test")]

WRONG: "To create a file, use: echo 'content' > test.txt"
RIGHT: [SKILL:create_file(filePath="${userWorkingDirectory}/test.txt", content="content")]

WRONG (tweaking one constant in a 500-line file):
  [SKILL:read_file(filePath="${userWorkingDirectory}/snake.html", startLine="1", endLine="500")]
  [SKILL:update_file(filePath="${userWorkingDirectory}/snake.html", content="<entire 500-line file rewritten>")]
RIGHT:
  [SKILL:read_file(filePath="${userWorkingDirectory}/snake.html", startLine="40", endLine="80")]
  [SKILL:search_replace_file(filePath="${userWorkingDirectory}/snake.html", search="width=\\"400\\" height=\\"400\\"", replace="width=\\"600\\" height=\\"600\\"")]

search_replace_file matches LITERAL text — do NOT escape regex metacharacters. Parens, braces, brackets, dots, asterisks, etc. go in as-is. The snippet must match byte-for-byte (whitespace, indentation, quote style included). If the replacement fails with "No matches", re-read the region with read_file to see the exact characters.

=== SKILL SYNTAX ===
- Complete each skill on ONE line: [SKILL:name(param="value")]
- String params need quotes: param="value"
- Escape newlines: \\n | Escape quotes: \\"
- BAD: [SKILL:read_file(filePath=/path)]  ← missing quotes
- GOOD: [SKILL:read_file(filePath="/path")]
`;

    // Add web search capability note
    if (websearchEnabled) {
        prompt += `
=== WEB CAPABILITIES ENABLED ===
- You CAN search the web and fetch content - use web_search, playwright_fetch
- DO NOT say "I can't browse the web" - you have full web access via skills
`;
    }

    prompt += `
Use skills naturally based on user requests. The catalog above shows the skills relevant to this turn; ${enabledSkills.length} total are available across all categories.
`;

    return prompt;
}

// Execute file operation skills locally (client-side)
// Extensions where the file on disk IS markdown and fences should be
// preserved verbatim. Everything else (code, config, plain text) gets
// markdown fences stripped before writing.
const MARKDOWN_DOC_EXTENSIONS = new Set([
    '.md', '.markdown', '.mdx', '.rst', '.adoc', '.asciidoc'
]);

// Strip markdown decoration the model wrapped around a payload it was
// asked to save to a file. The most common failure mode is the model
// returning content="```python\ncode\n```" when asked to save code —
// without this, the file literally contains the backticks and the
// "python" language tag, which breaks the script.
//
// Rules:
//   - If the target file is a markdown doc (.md, .rst, etc.) leave the
//     content alone. Fences there are intentional.
//   - Otherwise, if the content is entirely wrapped in a single fenced
//     code block, unwrap it.
//   - Trim a trailing newline chaser the renderer often leaves behind.
function sanitizeContentForFile(filePath, content) {
    if (content == null) return '';
    if (typeof content !== 'string') content = String(content);

    const ext = (filePath.match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
    if (MARKDOWN_DOC_EXTENSIONS.has(ext)) {
        return content;
    }

    let out = content;

    // Count fence lines up front. If the content has more than 2 fence
    // lines OR the fences aren't at the extremes (ignoring blank padding
    // lines), it's a multi-block document and we should NOT unwrap it —
    // unwrapping would splice the middle blocks together and corrupt the
    // file.
    const allLines = out.split('\n');
    // Identify the first/last non-blank line indices so trailing
    // newlines on fenced wraps don't confuse the "fence at extreme" test.
    let firstNonBlank = 0;
    while (firstNonBlank < allLines.length && allLines[firstNonBlank].trim() === '') firstNonBlank++;
    let lastNonBlank = allLines.length - 1;
    while (lastNonBlank >= 0 && allLines[lastNonBlank].trim() === '') lastNonBlank--;

    const fenceLineIndices = [];
    for (let i = 0; i < allLines.length; i++) {
        if (/^\s*(```|~~~)/.test(allLines[i])) fenceLineIndices.push(i);
    }
    const isMultiBlockDoc = fenceLineIndices.length > 2 ||
        (fenceLineIndices.length === 2 &&
            !(fenceLineIndices[0] === firstNonBlank && fenceLineIndices[1] === lastNonBlank));

    if (isMultiBlockDoc) {
        return out.replace(/^\n/, '').replace(/\n$/, '');
    }

    // Case 1: entire payload is a single fenced code block, optionally
    // with leading/trailing whitespace.
    //   ```python\n...code...\n```
    //   ```\n...code...\n```
    //   ~~~lang\n...code...\n~~~
    const fencedWhole = out.match(/^\s*(```|~~~)([^\n]*)\n([\s\S]*?)\n\1\s*$/);
    if (fencedWhole) {
        out = fencedWhole[3];
    } else {
        // Case 2: the model started with a fence but didn't close it, OR
        // left a bare opening/closing fence line, OR there's exactly one
        // clean block wrap the regex above missed due to whitespace
        // quirks. Only touch the content when we're confident the fence
        // is a wrapper, not part of a multi-block document — otherwise a
        // .py file containing two fenced blocks (i.e. a document being
        // misfiled as code) would get its interior mangled.
        const lines = out.split('\n');
        const fenceIdx = [];
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*(```|~~~)/.test(lines[i])) fenceIdx.push(i);
        }

        if (fenceIdx.length === 1) {
            // A single bare fence line: strip it only if it sits at an
            // extreme (the model opened or closed but not both).
            if (fenceIdx[0] === 0) {
                lines.shift();
                out = lines.join('\n');
            } else if (fenceIdx[0] === lines.length - 1) {
                lines.pop();
                out = lines.join('\n');
            }
        } else if (
            fenceIdx.length === 2 &&
            fenceIdx[0] === 0 &&
            fenceIdx[1] === lines.length - 1
        ) {
            // Exactly one wrap the earlier regex missed — strip both.
            lines.shift();
            lines.pop();
            out = lines.join('\n');
        }
        // 3+ fence lines or fences in the interior: leave it alone —
        // that's a multi-block document and stripping would corrupt it.
    }

    // Trim a single leading/trailing newline that the unwrap may leave.
    out = out.replace(/^\n/, '').replace(/\n$/, '');

    return out;
}

async function executeFileOperationSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'create_file':
            case 'update_file': {
                const filePath = params.filePath;
                const rawContent = params.content || '';
                const content = sanitizeContentForFile(filePath, rawContent);

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                // Ensure directory exists
                const dir = path.dirname(filePath);
                await fs.mkdir(dir, { recursive: true });

                // Write file
                await fs.writeFile(filePath, content, 'utf8');

                return {
                    success: true,
                    filePath: filePath,
                    message: `File ${skillName === 'create_file' ? 'created' : 'updated'}: ${filePath}`
                };
            }

            case 'read_file': {
                const filePath = params.filePath;
                const startLine = params.startLine ? parseInt(params.startLine) : null;
                const endLine = params.endLine ? parseInt(params.endLine) : null;
                const chunkIndex = params.chunkIndex ? parseInt(params.chunkIndex) : null;
                const chunkSize = params.chunkSize ? parseInt(params.chunkSize) : 500; // lines per chunk
                const maxContentChars = params.maxContentChars ? parseInt(params.maxContentChars) : 100000; // ~25k tokens

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                const content = await fs.readFile(filePath, 'utf8');
                const lines = content.split('\n');
                const totalLines = lines.length;
                const totalChars = content.length;
                const estimatedTokens = Math.ceil(totalChars / 4);

                // If specific line range requested
                if (startLine !== null || endLine !== null) {
                    const start = Math.max(0, (startLine || 1) - 1);
                    const end = Math.min(totalLines, endLine || totalLines);
                    const selectedLines = lines.slice(start, end);
                    return {
                        success: true,
                        filePath,
                        content: selectedLines.join('\n'),
                        lineRange: { start: start + 1, end: end },
                        totalLines,
                        totalChars: selectedLines.join('\n').length
                    };
                }

                // If chunk index requested
                if (chunkIndex !== null) {
                    const totalChunks = Math.ceil(totalLines / chunkSize);
                    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
                        return { success: false, error: `Invalid chunkIndex. Valid range: 0-${totalChunks - 1}` };
                    }
                    const start = chunkIndex * chunkSize;
                    const end = Math.min(start + chunkSize, totalLines);
                    const chunkLines = lines.slice(start, end);
                    return {
                        success: true,
                        filePath,
                        content: chunkLines.join('\n'),
                        chunkInfo: {
                            currentChunk: chunkIndex,
                            totalChunks,
                            linesInChunk: chunkLines.length,
                            lineRange: { start: start + 1, end: end }
                        },
                        totalLines,
                        totalChars: chunkLines.join('\n').length
                    };
                }

                // Check if content is too large for context window
                if (totalChars > maxContentChars) {
                    const totalChunks = Math.ceil(totalLines / chunkSize);
                    // Return file info and first chunk preview
                    const previewLines = lines.slice(0, Math.min(50, totalLines));
                    return {
                        success: true,
                        filePath,
                        warning: 'FILE_TOO_LARGE',
                        message: `File has ${totalLines} lines (~${estimatedTokens} tokens). Use chunkIndex parameter to read in parts.`,
                        preview: previewLines.join('\n') + (totalLines > 50 ? '\n... [truncated]' : ''),
                        fileInfo: {
                            totalLines,
                            totalChars,
                            estimatedTokens,
                            totalChunks,
                            chunkSize,
                            suggestedApproach: `Read with chunkIndex=0 through chunkIndex=${totalChunks - 1} to process entire file`
                        }
                    };
                }

                return {
                    success: true,
                    filePath: filePath,
                    content: content,
                    totalLines,
                    totalChars
                };
            }

            case 'delete_file': {
                const filePath = params.filePath;

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                // Check if file exists first
                try {
                    await fs.access(filePath);
                } catch (e) {
                    return { success: false, error: `File not found: ${filePath}` };
                }

                // Stop animation before showing confirmation prompt
                stopAnimation(true);

                // Prompt for confirmation before deleting
                log(colorize(`\n⚠️  DELETE FILE: ${filePath}`, 'yellow'));
                const confirmation = await promptConfirmation('Are you sure you want to delete this file?');

                if (confirmation === 'no') {
                    return {
                        success: false,
                        filePath: filePath,
                        error: 'Delete cancelled by user'
                    };
                } else if (confirmation === 'skip') {
                    return {
                        success: false,
                        filePath: filePath,
                        error: 'Delete skipped by user',
                        skipped: true
                    };
                }

                await fs.unlink(filePath);

                return {
                    success: true,
                    filePath: filePath,
                    message: `File deleted: ${filePath}`
                };
            }

            case 'create_directory': {
                const dirPath = params.dirPath;

                if (!dirPath) {
                    return { success: false, error: 'dirPath is required' };
                }

                // Create directory recursively
                await fs.mkdir(dirPath, { recursive: true });

                return {
                    success: true,
                    dirPath: dirPath,
                    message: `Directory created: ${dirPath}`
                };
            }

            case 'delete_directory': {
                const dirPath = params.dirPath;

                if (!dirPath) {
                    return { success: false, error: 'dirPath is required' };
                }

                // Check if path exists and is a directory
                let stats;
                try {
                    stats = await fs.stat(dirPath);
                } catch (e) {
                    return { success: false, error: `Directory not found: ${dirPath}` };
                }
                if (!stats.isDirectory()) {
                    return { success: false, error: `Path is a file, not a directory. Use delete_file instead: ${dirPath}` };
                }

                // Stop animation before showing confirmation prompt
                stopAnimation(true);

                // Prompt for confirmation before deleting
                log(colorize(`\n⚠️  DELETE DIRECTORY: ${dirPath}`, 'yellow'));
                log(colorize('This will recursively delete all contents!', 'red'));
                const confirmation = await promptConfirmation('Are you sure you want to delete this directory?');

                if (confirmation === 'no') {
                    return {
                        success: false,
                        dirPath: dirPath,
                        error: 'Delete cancelled by user'
                    };
                } else if (confirmation === 'skip') {
                    return {
                        success: false,
                        dirPath: dirPath,
                        error: 'Delete skipped by user',
                        skipped: true
                    };
                }

                // Delete directory recursively
                await fs.rm(dirPath, { recursive: true, force: true });

                return {
                    success: true,
                    dirPath: dirPath,
                    message: `Directory deleted: ${dirPath}`
                };
            }

            case 'list_directory': {
                const dirPath = params.dirPath;

                if (!dirPath) {
                    return { success: false, error: 'dirPath is required' };
                }

                // Accept truthy string / bool for recursive — the skill call
                // syntax sends params as strings, so "true"/"1"/"yes" all count.
                const recursive = (() => {
                    const v = params.recursive;
                    if (v === true) return true;
                    if (typeof v === 'string') return /^(true|1|yes|y)$/i.test(v.trim());
                    return false;
                })();

                if (!recursive) {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    const files = entries.map(entry => ({
                        name: entry.name,
                        isDirectory: entry.isDirectory(),
                        isFile: entry.isFile()
                    }));
                    return { success: true, dirPath, files, recursive: false };
                }

                // Recursive walk. Skip noisy dirs (node_modules, .git, venvs,
                // build outputs) so the model isn't drowning in irrelevant
                // paths. Cap the total entry count so we don't OOM on huge
                // trees — if we hit the cap the model still sees a clear
                // signal (`truncated: true`) and can narrow the scope.
                const SKIP_DIRS = new Set([
                    'node_modules', '.git', '.svn', '.hg', '.venv', 'venv',
                    '__pycache__', '.next', '.nuxt', 'dist', 'build',
                    'target', '.cache', '.pytest_cache', '.mypy_cache',
                    '.tox', '.idea', '.vscode', 'coverage'
                ]);
                const MAX_ENTRIES = 500;
                const walked = [];
                let truncated = false;

                async function walk(currentDir, relBase) {
                    if (truncated) return;
                    let entries;
                    try {
                        entries = await fs.readdir(currentDir, { withFileTypes: true });
                    } catch {
                        return;
                    }
                    for (const e of entries) {
                        if (walked.length >= MAX_ENTRIES) { truncated = true; return; }
                        const rel = relBase ? `${relBase}/${e.name}` : e.name;
                        if (e.isDirectory() && SKIP_DIRS.has(e.name)) {
                            walked.push({ name: rel, isDirectory: true, isFile: false, skipped: true });
                            continue;
                        }
                        walked.push({
                            name: rel,
                            isDirectory: e.isDirectory(),
                            isFile: e.isFile()
                        });
                        if (e.isDirectory()) {
                            await walk(path.join(currentDir, e.name), rel);
                            if (truncated) return;
                        }
                    }
                }

                await walk(dirPath, '');
                return {
                    success: true,
                    dirPath,
                    files: walked,
                    recursive: true,
                    truncated,
                    count: walked.length
                };
            }

            case 'move_file': {
                const sourcePath = params.sourcePath;
                const destPath = params.destPath;

                if (!sourcePath || !destPath) {
                    return { success: false, error: 'sourcePath and destPath are required' };
                }

                // Ensure destination directory exists
                const destDir = path.dirname(destPath);
                await fs.mkdir(destDir, { recursive: true });

                // Move file
                await fs.rename(sourcePath, destPath);

                return {
                    success: true,
                    sourcePath: sourcePath,
                    destPath: destPath,
                    message: `File moved from ${sourcePath} to ${destPath}`
                };
            }

            case 'append_to_file': {
                const filePath = params.filePath;
                const rawContent = params.content || '';
                const content = sanitizeContentForFile(filePath, rawContent);

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                // Append to file
                await fs.appendFile(filePath, content, 'utf8');

                return {
                    success: true,
                    filePath: filePath,
                    bytesAdded: content.length,
                    message: `Content appended to: ${filePath}`
                };
            }

            case 'tail_file': {
                const filePath = params.filePath;
                const numLines = params.lines || 10;

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                const content = await fs.readFile(filePath, 'utf8');
                const allLines = content.split('\n');
                const tailLines = allLines.slice(-numLines);

                return {
                    success: true,
                    filePath: filePath,
                    content: tailLines.join('\n'),
                    linesReturned: tailLines.length,
                    totalLines: allLines.length
                };
            }

            case 'head_file': {
                const filePath = params.filePath;
                const numLines = params.lines || 10;

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                const content = await fs.readFile(filePath, 'utf8');
                const allLines = content.split('\n');
                const headLines = allLines.slice(0, numLines);

                return {
                    success: true,
                    filePath: filePath,
                    content: headLines.join('\n'),
                    linesReturned: headLines.length,
                    totalLines: allLines.length
                };
            }

            default:
                return { success: false, error: `Unknown file operation skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute process management skills client-side
async function executeProcessSkill(skillName, params) {
    const platform = os.platform();
    const isWindows = platform === 'win32';

    try {
        switch (skillName) {
            case 'list_processes': {
                const sortBy = params.sort_by || 'pid';
                const limit = parseInt(params.limit) || 50;
                let processes = [];

                if (isWindows) {
                    // Windows: use tasklist
                    const { stdout } = await execPromise('tasklist /fo csv /nh', { timeout: 30000 });
                    const lines = stdout.trim().split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            const parts = line.trim().split('","');
                            if (parts.length >= 5) {
                                const name = parts[0].replace(/^"/, '');
                                const pid = parts[1].replace(/"/g, '');
                                const mem = parts[4].replace(/"/g, '').replace(' K', '').replace(/,/g, '');
                                try {
                                    processes.push({
                                        pid: parseInt(pid),
                                        name: name,
                                        cpu_percent: 0.0,
                                        memory_mb: Math.round(parseInt(mem) / 1024) || 0
                                    });
                                } catch (e) {}
                            }
                        }
                    }
                } else {
                    // Linux/macOS: use ps aux
                    const cmd = platform === 'linux' ? 'ps aux --no-headers' : 'ps aux';
                    const { stdout } = await execPromise(cmd, { timeout: 30000 });
                    const lines = stdout.trim().split('\n');
                    const startIdx = platform === 'darwin' ? 1 : 0;

                    for (let i = startIdx; i < lines.length; i++) {
                        const line = lines[i];
                        if (line.trim()) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 11) {
                                try {
                                    processes.push({
                                        pid: parseInt(parts[1]),
                                        name: parts.slice(10).join(' '),
                                        cpu_percent: parseFloat(parts[2]) || 0,
                                        memory_mb: Math.round(parseInt(parts[5]) / 1024) || 0
                                    });
                                } catch (e) {}
                            }
                        }
                    }
                }

                // Sort processes
                const sortKey = sortBy.toLowerCase();
                if (sortKey === 'cpu') {
                    processes.sort((a, b) => b.cpu_percent - a.cpu_percent);
                } else if (sortKey === 'memory' || sortKey === 'mem') {
                    processes.sort((a, b) => b.memory_mb - a.memory_mb);
                } else if (sortKey === 'name') {
                    processes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                } else {
                    processes.sort((a, b) => a.pid - b.pid);
                }

                // Limit results
                if (limit > 0) {
                    processes = processes.slice(0, limit);
                }

                return {
                    success: true,
                    platform: platform,
                    count: processes.length,
                    processes: processes
                };
            }

            case 'kill_process': {
                const pid = params.pid;
                const name = params.name;

                if (!pid && !name) {
                    return { success: false, error: 'Either pid or name parameter is required' };
                }

                const killed = [];

                if (pid) {
                    const pidNum = parseInt(pid);
                    if (isWindows) {
                        const { stderr } = await execPromise(`taskkill /PID ${pidNum} /F`, { timeout: 10000 }).catch(e => ({ stderr: e.message }));
                        if (!stderr || stderr.includes('SUCCESS')) {
                            killed.push({ pid: pidNum });
                        } else {
                            return { success: false, error: stderr.trim() };
                        }
                    } else {
                        try {
                            process.kill(pidNum, 'SIGTERM');
                            killed.push({ pid: pidNum });
                        } catch (e) {
                            return { success: false, error: e.message };
                        }
                    }
                }

                if (name) {
                    if (isWindows) {
                        const { stderr } = await execPromise(`taskkill /IM "${name}" /F`, { timeout: 10000 }).catch(e => ({ stderr: e.message }));
                        if (!stderr || stderr.includes('SUCCESS')) {
                            killed.push({ name: name });
                        }
                    } else {
                        try {
                            await execPromise(`pkill -f "${name}"`, { timeout: 10000 });
                            killed.push({ name: name });
                        } catch (e) {
                            // pkill returns non-zero if no processes matched, which is OK
                            if (e.code !== 1) {
                                return { success: false, error: e.message };
                            }
                        }
                    }
                }

                return killed.length > 0
                    ? { success: true, killed: killed }
                    : { success: false, error: 'No processes killed' };
            }

            case 'start_process': {
                const command = params.command;
                const args = params.args || [];

                if (!command) {
                    return { success: false, error: 'command parameter is required' };
                }

                const argsArray = Array.isArray(args) ? args.map(String) : [];

                try {
                    const options = {
                        detached: true,
                        stdio: 'ignore'
                    };

                    if (isWindows) {
                        options.windowsHide = true;
                    }

                    const child = spawn(command, argsArray, options);
                    child.unref();

                    return {
                        success: true,
                        pid: child.pid,
                        command: command,
                        args: argsArray
                    };
                } catch (e) {
                    if (e.code === 'ENOENT') {
                        return { success: false, error: `Command not found: ${command}` };
                    }
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown process skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute system info skills client-side
async function executeSystemSkill(skillName, params) {
    const platform = os.platform();

    try {
        switch (skillName) {
            case 'system_info': {
                const cpus = os.cpus();
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const usedMem = totalMem - freeMem;

                // Get disk usage
                let diskInfo = { total: 0, used: 0, free: 0, percent: 0 };
                try {
                    if (platform === 'win32') {
                        const { stdout } = await execPromise('wmic logicaldisk get size,freespace,caption', { timeout: 10000 });
                        const lines = stdout.trim().split('\n').slice(1);
                        for (const line of lines) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 3 && parts[0].includes(':')) {
                                diskInfo.free += parseInt(parts[1]) || 0;
                                diskInfo.total += parseInt(parts[2]) || 0;
                            }
                        }
                        diskInfo.used = diskInfo.total - diskInfo.free;
                        diskInfo.percent = diskInfo.total > 0 ? Math.round((diskInfo.used / diskInfo.total) * 100) : 0;
                    } else {
                        const { stdout } = await execPromise("df -k / | tail -1", { timeout: 10000 });
                        const parts = stdout.trim().split(/\s+/);
                        if (parts.length >= 4) {
                            diskInfo.total = parseInt(parts[1]) * 1024;
                            diskInfo.used = parseInt(parts[2]) * 1024;
                            diskInfo.free = parseInt(parts[3]) * 1024;
                            diskInfo.percent = parseInt(parts[4]) || 0;
                        }
                    }
                } catch (e) {
                    // Disk info unavailable
                }

                return {
                    success: true,
                    platform: platform,
                    platform_release: os.release(),
                    architecture: os.arch(),
                    hostname: os.hostname(),
                    cpu: {
                        model: cpus[0]?.model || 'Unknown',
                        cores: cpus.length,
                        speed: cpus[0]?.speed || 0
                    },
                    memory: {
                        total: totalMem,
                        used: usedMem,
                        free: freeMem,
                        percent: Math.round((usedMem / totalMem) * 100)
                    },
                    disk: diskInfo,
                    uptime: os.uptime()
                };
            }

            case 'disk_usage': {
                const targetPath = params.path || '/';
                let result = { success: false };

                if (platform === 'win32') {
                    const drive = targetPath.substring(0, 2) || 'C:';
                    const { stdout } = await execPromise(`wmic logicaldisk where "caption='${drive}'" get size,freespace`, { timeout: 10000 });
                    const lines = stdout.trim().split('\n').slice(1);
                    if (lines.length > 0) {
                        const parts = lines[0].trim().split(/\s+/);
                        if (parts.length >= 2) {
                            const free = parseInt(parts[0]) || 0;
                            const total = parseInt(parts[1]) || 0;
                            const used = total - free;
                            result = {
                                success: true,
                                path: drive,
                                total: total,
                                used: used,
                                free: free,
                                percent: total > 0 ? Math.round((used / total) * 100) : 0
                            };
                        }
                    }
                } else {
                    const { stdout } = await execPromise(`df -k "${targetPath}" | tail -1`, { timeout: 10000 });
                    const parts = stdout.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        result = {
                            success: true,
                            path: targetPath,
                            total: parseInt(parts[1]) * 1024,
                            used: parseInt(parts[2]) * 1024,
                            free: parseInt(parts[3]) * 1024,
                            percent: parseInt(parts[4]) || 0
                        };
                    }
                }

                return result.success ? result : { success: false, error: 'Could not get disk usage' };
            }

            case 'get_uptime': {
                const uptimeSeconds = os.uptime();
                const days = Math.floor(uptimeSeconds / 86400);
                const hours = Math.floor((uptimeSeconds % 86400) / 3600);
                const minutes = Math.floor((uptimeSeconds % 3600) / 60);
                const seconds = Math.floor(uptimeSeconds % 60);

                return {
                    success: true,
                    uptime_seconds: uptimeSeconds,
                    uptime_formatted: `${days}d ${hours}h ${minutes}m ${seconds}s`,
                    days, hours, minutes, seconds
                };
            }

            case 'list_ports': {
                let ports = [];

                if (platform === 'win32') {
                    const { stdout } = await execPromise('netstat -ano | findstr LISTENING', { timeout: 30000 });
                    const lines = stdout.trim().split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 5) {
                            const localAddr = parts[1];
                            const portMatch = localAddr.match(/:(\d+)$/);
                            if (portMatch) {
                                ports.push({
                                    port: parseInt(portMatch[1]),
                                    protocol: parts[0].toLowerCase(),
                                    pid: parseInt(parts[4]) || 0,
                                    address: localAddr
                                });
                            }
                        }
                    }
                } else {
                    try {
                        // Try ss first (modern Linux)
                        const { stdout } = await execPromise("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null", { timeout: 30000 });
                        const lines = stdout.trim().split('\n').slice(1);
                        for (const line of lines) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 4) {
                                const localAddr = parts[3] || parts[4];
                                const portMatch = localAddr.match(/:(\d+)$/);
                                if (portMatch) {
                                    ports.push({
                                        port: parseInt(portMatch[1]),
                                        protocol: 'tcp',
                                        address: localAddr
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // Fallback for macOS
                        const { stdout } = await execPromise("lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | tail -n +2", { timeout: 30000 });
                        const lines = stdout.trim().split('\n');
                        for (const line of lines) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 9) {
                                const addr = parts[8];
                                const portMatch = addr.match(/:(\d+)$/);
                                if (portMatch) {
                                    ports.push({
                                        port: parseInt(portMatch[1]),
                                        protocol: 'tcp',
                                        process: parts[0],
                                        pid: parseInt(parts[1]) || 0
                                    });
                                }
                            }
                        }
                    }
                }

                // Remove duplicates
                const uniquePorts = [...new Map(ports.map(p => [p.port, p])).values()];
                uniquePorts.sort((a, b) => a.port - b.port);

                return {
                    success: true,
                    count: uniquePorts.length,
                    ports: uniquePorts
                };
            }

            case 'list_services': {
                let services = [];

                if (platform === 'win32') {
                    const { stdout } = await execPromise('sc query state= all', { timeout: 30000 });
                    const blocks = stdout.split('SERVICE_NAME:').slice(1);
                    for (const block of blocks) {
                        const lines = block.trim().split('\n');
                        const name = lines[0]?.trim() || '';
                        let state = 'unknown';
                        for (const line of lines) {
                            if (line.includes('STATE')) {
                                if (line.includes('RUNNING')) state = 'running';
                                else if (line.includes('STOPPED')) state = 'stopped';
                                break;
                            }
                        }
                        if (name) {
                            services.push({ name, state });
                        }
                    }
                } else if (platform === 'linux') {
                    try {
                        const { stdout } = await execPromise("systemctl list-units --type=service --no-pager --no-legend 2>/dev/null | head -50", { timeout: 30000 });
                        const lines = stdout.trim().split('\n');
                        for (const line of lines) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 4) {
                                services.push({
                                    name: parts[0].replace('.service', ''),
                                    load: parts[1],
                                    active: parts[2],
                                    state: parts[3]
                                });
                            }
                        }
                    } catch (e) {
                        // Fallback to service command
                        const { stdout } = await execPromise("service --status-all 2>/dev/null", { timeout: 30000 });
                        const lines = stdout.trim().split('\n');
                        for (const line of lines) {
                            const match = line.match(/\[\s*([+-?])\s*\]\s+(.+)/);
                            if (match) {
                                services.push({
                                    name: match[2].trim(),
                                    state: match[1] === '+' ? 'running' : match[1] === '-' ? 'stopped' : 'unknown'
                                });
                            }
                        }
                    }
                } else if (platform === 'darwin') {
                    const { stdout } = await execPromise("launchctl list 2>/dev/null | head -50", { timeout: 30000 });
                    const lines = stdout.trim().split('\n').slice(1);
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 3) {
                            services.push({
                                name: parts[2],
                                pid: parts[0] !== '-' ? parseInt(parts[0]) : null,
                                state: parts[0] !== '-' ? 'running' : 'stopped'
                            });
                        }
                    }
                }

                return {
                    success: true,
                    platform: platform,
                    count: services.length,
                    services: services.slice(0, 50) // Limit to 50
                };
            }

            default:
                return { success: false, error: `Unknown system skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute git skills client-side
async function executeGitSkill(skillName, params) {
    const cwd = params.path || userWorkingDirectory;

    try {
        switch (skillName) {
            case 'git_status': {
                const { stdout } = await execPromise('git status --porcelain', { cwd, timeout: 30000 });
                const { stdout: branch } = await execPromise('git branch --show-current', { cwd, timeout: 10000 });

                const files = {
                    staged: [],
                    modified: [],
                    untracked: []
                };

                const lines = stdout.trim().split('\n').filter(l => l);
                for (const line of lines) {
                    const status = line.substring(0, 2);
                    const file = line.substring(3);

                    if (status[0] === 'A' || status[0] === 'M' || status[0] === 'D' || status[0] === 'R') {
                        files.staged.push({ status: status[0], file });
                    }
                    if (status[1] === 'M' || status[1] === 'D') {
                        files.modified.push({ status: status[1], file });
                    }
                    if (status === '??') {
                        files.untracked.push(file);
                    }
                }

                return {
                    success: true,
                    branch: branch.trim(),
                    staged: files.staged,
                    modified: files.modified,
                    untracked: files.untracked,
                    clean: lines.length === 0
                };
            }

            case 'git_diff': {
                const staged = params.staged === true || params.staged === 'true';
                const cmd = staged ? 'git diff --cached' : 'git diff';
                const { stdout } = await execPromise(cmd, { cwd, timeout: 30000 });

                return {
                    success: true,
                    staged: staged,
                    diff: stdout || '(no changes)',
                    hasChanges: stdout.trim().length > 0
                };
            }

            case 'git_log': {
                const limit = parseInt(params.limit) || 10;
                const { stdout } = await execPromise(`git log --oneline -${limit}`, { cwd, timeout: 30000 });

                const commits = stdout.trim().split('\n').filter(l => l).map(line => {
                    const spaceIdx = line.indexOf(' ');
                    return {
                        hash: line.substring(0, spaceIdx),
                        message: line.substring(spaceIdx + 1)
                    };
                });

                return {
                    success: true,
                    count: commits.length,
                    commits: commits
                };
            }

            case 'git_branch': {
                const { stdout: branchOutput } = await execPromise('git branch -a', { cwd, timeout: 30000 });
                const { stdout: currentBranch } = await execPromise('git branch --show-current', { cwd, timeout: 10000 });

                const branches = branchOutput.trim().split('\n').map(b => {
                    const name = b.replace(/^\*?\s+/, '').trim();
                    return {
                        name: name,
                        current: b.startsWith('*'),
                        remote: name.startsWith('remotes/')
                    };
                });

                return {
                    success: true,
                    current: currentBranch.trim(),
                    branches: branches
                };
            }

            default:
                return { success: false, error: `Unknown git skill: ${skillName}` };
        }
    } catch (error) {
        if (error.message.includes('not a git repository')) {
            return { success: false, error: 'Not a git repository' };
        }
        return { success: false, error: error.message };
    }
}

// Execute environment skills client-side
async function executeEnvSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'get_env_var': {
                const name = params.name;
                if (!name) {
                    return { success: false, error: 'name parameter is required' };
                }

                const value = process.env[name];
                return {
                    success: true,
                    name: name,
                    value: value || null,
                    exists: value !== undefined
                };
            }

            case 'set_env_var': {
                const name = params.name;
                const value = params.value;

                if (!name) {
                    return { success: false, error: 'name parameter is required' };
                }

                process.env[name] = value || '';
                return {
                    success: true,
                    name: name,
                    value: value || '',
                    message: `Environment variable ${name} set for this session`
                };
            }

            case 'which_command': {
                const command = params.command;
                if (!command) {
                    return { success: false, error: 'command parameter is required' };
                }

                const platform = os.platform();
                const cmd = platform === 'win32' ? `where ${command}` : `which ${command}`;

                try {
                    const { stdout } = await execPromise(cmd, { timeout: 10000 });
                    const paths = stdout.trim().split('\n').filter(p => p);
                    return {
                        success: true,
                        command: command,
                        found: true,
                        path: paths[0],
                        allPaths: paths
                    };
                } catch (e) {
                    return {
                        success: true,
                        command: command,
                        found: false,
                        path: null
                    };
                }
            }

            default:
                return { success: false, error: `Unknown environment skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Helper function to check if a host is local/safe for direct connections
function isLocalHost(hostOrUrl) {
    let host;
    try {
        // Handle URLs
        if (hostOrUrl.startsWith('http://') || hostOrUrl.startsWith('https://')) {
            const urlObj = new URL(hostOrUrl);
            host = urlObj.hostname;
        } else {
            host = hostOrUrl;
        }
    } catch {
        host = hostOrUrl;
    }

    // Localhost variants
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return true;
    }

    // IPv4 private ranges
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const [, a, b] = ipv4Match.map(Number);
        // 10.0.0.0/8 (private)
        if (a === 10) return true;
        // 172.16.0.0/12 (private)
        if (a === 172 && b >= 16 && b <= 31) return true;
        // 192.168.0.0/16 (private)
        if (a === 192 && b === 168) return true;
    }

    // Local hostname (no dots, not an IP)
    if (!host.includes('.') && !/^\d+$/.test(host)) {
        return true;
    }

    return false;
}

// Execute network skills client-side
async function executeNetworkSkill(skillName, params) {
    const https = require('https');
    const http = require('http');
    const dns = require('dns').promises;
    const net = require('net');

    // Security message for blocked external connections
    const EXTERNAL_BLOCKED_MSG = 'Direct connections to external IPs/URLs are blocked for security. Use web_search or playwright_fetch skill instead to safely gather information about external hosts.';

    try {
        switch (skillName) {
            case 'fetch_url': {
                const url = params.url;
                if (!url) return { success: false, error: 'url parameter is required' };

                // Block external URLs
                if (!isLocalHost(url)) {
                    return { success: false, error: EXTERNAL_BLOCKED_MSG };
                }

                return new Promise((resolve) => {
                    const client = url.startsWith('https') ? https : http;
                    const req = client.get(url, { timeout: 30000 }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            resolve({
                                success: true,
                                url: url,
                                statusCode: res.statusCode,
                                contentType: res.headers['content-type'],
                                content: data.substring(0, 50000) // Limit content size
                            });
                        });
                    });
                    req.on('error', (e) => resolve({ success: false, error: e.message }));
                    req.on('timeout', () => {
                        req.destroy();
                        resolve({ success: false, error: 'Request timeout' });
                    });
                });
            }

            case 'dns_lookup': {
                const hostname = params.hostname || params.domain;
                if (!hostname) return { success: false, error: 'hostname parameter is required' };

                try {
                    const addresses = await dns.resolve(hostname);
                    return { success: true, hostname, addresses };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'check_port': {
                const host = params.host || 'localhost';
                const port = parseInt(params.port);
                if (!port) return { success: false, error: 'port parameter is required' };

                // Block external hosts
                if (!isLocalHost(host)) {
                    return { success: false, error: EXTERNAL_BLOCKED_MSG };
                }

                return new Promise((resolve) => {
                    const socket = new net.Socket();
                    socket.setTimeout(5000);
                    socket.on('connect', () => {
                        socket.destroy();
                        resolve({ success: true, host, port, open: true });
                    });
                    socket.on('timeout', () => {
                        socket.destroy();
                        resolve({ success: true, host, port, open: false });
                    });
                    socket.on('error', () => {
                        resolve({ success: true, host, port, open: false });
                    });
                    socket.connect(port, host);
                });
            }

            case 'ping_host': {
                const host = params.host;
                if (!host) return { success: false, error: 'host parameter is required' };

                // Block external hosts
                if (!isLocalHost(host)) {
                    return { success: false, error: EXTERNAL_BLOCKED_MSG };
                }

                const platform = os.platform();
                const cmd = platform === 'win32' ? `ping -n 1 ${host}` : `ping -c 1 ${host}`;

                try {
                    const { stdout } = await execPromise(cmd, { timeout: 10000 });
                    const reachable = stdout.includes('1 received') || stdout.includes('Reply from') || stdout.includes('1 packets received');
                    return { success: true, host, reachable };
                } catch (e) {
                    return { success: true, host, reachable: false };
                }
            }

            case 'http_request': {
                const url = params.url;
                const method = (params.method || 'GET').toUpperCase();
                if (!url) return { success: false, error: 'url parameter is required' };

                // Block external URLs
                if (!isLocalHost(url)) {
                    return { success: false, error: EXTERNAL_BLOCKED_MSG };
                }

                return new Promise((resolve) => {
                    const urlObj = new URL(url);
                    const client = urlObj.protocol === 'https:' ? https : http;
                    const options = {
                        hostname: urlObj.hostname,
                        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                        path: urlObj.pathname + urlObj.search,
                        method: method,
                        timeout: 30000,
                        headers: params.headers || {}
                    };

                    const req = client.request(options, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            resolve({
                                success: true,
                                statusCode: res.statusCode,
                                headers: res.headers,
                                body: data.substring(0, 50000)
                            });
                        });
                    });

                    req.on('error', (e) => resolve({ success: false, error: e.message }));
                    req.on('timeout', () => {
                        req.destroy();
                        resolve({ success: false, error: 'Request timeout' });
                    });

                    if (params.body && (method === 'POST' || method === 'PUT')) {
                        req.write(typeof params.body === 'string' ? params.body : JSON.stringify(params.body));
                    }
                    req.end();
                });
            }

            case 'get_public_ip': {
                return new Promise((resolve) => {
                    https.get('https://api.ipify.org?format=json', { timeout: 10000 }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                const result = JSON.parse(data);
                                resolve({ success: true, ip: result.ip });
                            } catch (e) {
                                resolve({ success: false, error: 'Failed to parse response' });
                            }
                        });
                    }).on('error', (e) => resolve({ success: false, error: e.message }));
                });
            }

            case 'list_network_interfaces': {
                const interfaces = os.networkInterfaces();
                const result = [];
                for (const [name, addrs] of Object.entries(interfaces)) {
                    for (const addr of addrs) {
                        result.push({
                            name,
                            address: addr.address,
                            family: addr.family,
                            internal: addr.internal
                        });
                    }
                }
                return { success: true, interfaces: result };
            }

            case 'traceroute': {
                const host = params.host;
                if (!host) return { success: false, error: 'host parameter is required' };

                // Block external hosts
                if (!isLocalHost(host)) {
                    return { success: false, error: EXTERNAL_BLOCKED_MSG };
                }

                const platform = os.platform();
                const cmd = platform === 'win32' ? `tracert -d -h 15 ${host}` : `traceroute -n -m 15 ${host}`;

                try {
                    const { stdout } = await execPromise(cmd, { timeout: 60000 });
                    return { success: true, host, output: stdout };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'curl_request': {
                const url = params.url;
                if (!url) return { success: false, error: 'url parameter is required' };

                // Block external URLs
                if (!isLocalHost(url)) {
                    return { success: false, error: EXTERNAL_BLOCKED_MSG };
                }

                let cmd = `curl -s -w "\\n%{http_code}" "${url}"`;
                if (params.method) cmd = `curl -s -X ${params.method} -w "\\n%{http_code}" "${url}"`;
                if (params.headers) {
                    const headers = typeof params.headers === 'string' ? JSON.parse(params.headers) : params.headers;
                    for (const [k, v] of Object.entries(headers)) {
                        cmd += ` -H "${k}: ${v}"`;
                    }
                }
                if (params.data) cmd += ` -d '${params.data}'`;

                try {
                    const { stdout } = await execPromise(cmd, { timeout: 30000 });
                    const lines = stdout.trim().split('\n');
                    const statusCode = parseInt(lines.pop()) || 0;
                    const body = lines.join('\n');
                    return { success: true, statusCode, body };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown network skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute data processing skills client-side
async function executeDataSkill(skillName, params) {
    const crypto = require('crypto');
    const zlib = require('zlib');

    try {
        switch (skillName) {
            case 'parse_json': {
                const content = params.content || params.json;
                if (!content) return { success: false, error: 'content parameter is required' };
                try {
                    const parsed = JSON.parse(content);
                    return { success: true, data: parsed };
                } catch (e) {
                    return { success: false, error: 'Invalid JSON: ' + e.message };
                }
            }

            case 'parse_csv': {
                const content = params.content || params.csv || params.csvString;
                if (!content) return { success: false, error: 'content parameter is required (pass CSV data as string, not a file path)' };
                const delimiter = params.delimiter || ',';
                const lines = content.trim().split('\n');
                const headers = lines[0].split(delimiter).map(h => h.trim());
                const rows = lines.slice(1).map(line => {
                    const values = line.split(delimiter);
                    const row = {};
                    headers.forEach((h, i) => row[h] = values[i]?.trim() || '');
                    return row;
                });
                return { success: true, headers, rows, rowCount: rows.length };
            }

            case 'base64_encode': {
                const content = params.content || params.data;
                if (!content) return { success: false, error: 'content parameter is required' };
                const encoded = Buffer.from(content).toString('base64');
                return { success: true, encoded };
            }

            case 'base64_decode': {
                const content = params.content || params.data;
                if (!content) return { success: false, error: 'content parameter is required' };
                try {
                    const decoded = Buffer.from(content, 'base64').toString('utf8');
                    return { success: true, decoded };
                } catch (e) {
                    return { success: false, error: 'Invalid base64: ' + e.message };
                }
            }

            case 'hash_data': {
                const content = params.content || params.data;
                const algorithm = params.algorithm || 'sha256';
                if (!content) return { success: false, error: 'content parameter is required' };
                const hash = crypto.createHash(algorithm).update(content).digest('hex');
                return { success: true, algorithm, hash };
            }

            case 'generate_uuid': {
                const uuid = crypto.randomUUID();
                return { success: true, uuid };
            }

            case 'get_timestamp': {
                const format = params.format || 'iso';
                const now = new Date();
                let timestamp;
                switch (format.toLowerCase()) {
                    case 'unix': timestamp = Math.floor(now.getTime() / 1000); break;
                    case 'ms': timestamp = now.getTime(); break;
                    case 'iso': default: timestamp = now.toISOString(); break;
                }
                return { success: true, format, timestamp };
            }

            case 'count_words': {
                const content = params.content || params.text;
                if (!content) return { success: false, error: 'content parameter is required' };
                const words = content.trim().split(/\s+/).filter(w => w).length;
                const chars = content.length;
                const lines = content.split('\n').length;
                return { success: true, words, characters: chars, lines };
            }

            case 'find_patterns': {
                const content = params.content || params.text;
                const pattern = params.pattern;
                if (!content || !pattern) return { success: false, error: 'content (text string) and pattern (regex) parameters are required' };
                try {
                    const regex = new RegExp(pattern, 'g');
                    const matches = content.match(regex) || [];
                    return { success: true, pattern, matchCount: matches.length, matches };
                } catch (e) {
                    return { success: false, error: 'Invalid regex: ' + e.message };
                }
            }

            case 'analyze_code': {
                const content = params.content || params.code;
                if (!content) return { success: false, error: 'content parameter is required (pass code as string, not a file path)' };
                const lines = content.split('\n');
                const totalLines = lines.length;
                const codeLines = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
                const commentLines = lines.filter(l => l.trim().startsWith('//')).length;
                const blankLines = lines.filter(l => !l.trim()).length;
                return { success: true, totalLines, codeLines, commentLines, blankLines };
            }

            case 'compress_data': {
                const content = params.content || params.data;
                if (!content) return { success: false, error: 'content parameter is required' };
                return new Promise((resolve) => {
                    zlib.gzip(Buffer.from(content), (err, result) => {
                        if (err) resolve({ success: false, error: err.message });
                        else resolve({ success: true, compressed: result.toString('base64'), originalSize: content.length, compressedSize: result.length });
                    });
                });
            }

            case 'decompress_data': {
                const content = params.content || params.data;
                if (!content) return { success: false, error: 'content parameter is required' };
                return new Promise((resolve) => {
                    zlib.gunzip(Buffer.from(content, 'base64'), (err, result) => {
                        if (err) resolve({ success: false, error: err.message });
                        else resolve({ success: true, decompressed: result.toString('utf8') });
                    });
                });
            }

            case 'json_get': {
                const filePath = params.filePath;
                const jsonPath = params.path || params.jsonPath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const data = JSON.parse(content);
                    if (!jsonPath) return { success: true, data };
                    const keys = jsonPath.replace(/^\$\.?/, '').split('.');
                    let value = data;
                    for (const key of keys) {
                        if (value === undefined) break;
                        value = value[key];
                    }
                    return { success: true, path: jsonPath, value };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'json_set': {
                const filePath = params.filePath;
                const jsonPath = params.path || params.jsonPath;
                const value = params.value;
                if (!filePath || !jsonPath) return { success: false, error: 'filePath and path parameters are required' };
                try {
                    let data = {};
                    try {
                        const content = await fs.readFile(filePath, 'utf8');
                        data = JSON.parse(content);
                    } catch (e) { /* File doesn't exist, start fresh */ }
                    const keys = jsonPath.replace(/^\$\.?/, '').split('.');
                    let obj = data;
                    for (let i = 0; i < keys.length - 1; i++) {
                        if (!obj[keys[i]]) obj[keys[i]] = {};
                        obj = obj[keys[i]];
                    }
                    obj[keys[keys.length - 1]] = value;
                    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
                    return { success: true, path: jsonPath, value };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'yaml_parse': {
                const filePath = params.filePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    // Simple YAML parser for basic structures
                    const lines = content.split('\n');
                    const result = {};
                    let currentKey = null;
                    for (const line of lines) {
                        if (line.trim().startsWith('#') || !line.trim()) continue;
                        const match = line.match(/^(\s*)([^:]+):\s*(.*)$/);
                        if (match) {
                            const [, indent, key, value] = match;
                            if (value) {
                                result[key.trim()] = value.trim();
                            }
                        }
                    }
                    return { success: true, data: result };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'ini_parse': {
                const filePath = params.filePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const result = {};
                    let section = 'default';
                    for (const line of content.split('\n')) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
                        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
                        if (sectionMatch) {
                            section = sectionMatch[1];
                            result[section] = result[section] || {};
                        } else {
                            const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
                            if (kvMatch) {
                                result[section] = result[section] || {};
                                result[section][kvMatch[1].trim()] = kvMatch[2].trim();
                            }
                        }
                    }
                    return { success: true, data: result };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown data skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute archive skills client-side
async function executeArchiveSkill(skillName, params) {
    const zlib = require('zlib');
    const { pipeline } = require('stream/promises');

    try {
        switch (skillName) {
            case 'unzip_file': {
                const filePath = params.filePath || params.zipPath;
                const destPath = params.destPath || params.destination || params.outputDir || params.extractPath || '.';
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

                try {
                    await execPromise(`unzip -o "${filePath}" -d "${destPath}"`, { timeout: 120000 });
                    return { success: true, filePath, destination: destPath };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'zip_files': {
                const files = params.files;
                const outputPath = params.outputPath || params.zipPath;
                if (!files || !outputPath) return { success: false, error: 'files and outputPath parameters are required' };

                const fileList = Array.isArray(files) ? files.join(' ') : files;
                try {
                    await execPromise(`zip -r "${outputPath}" ${fileList}`, { timeout: 120000 });
                    return { success: true, outputPath, files };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'tar_extract': {
                const filePath = params.filePath || params.tarPath;
                const destPath = params.destPath || params.destination || params.outputDir || params.extractPath || '.';
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

                let cmd = `tar -xf "${filePath}" -C "${destPath}"`;
                if (filePath.endsWith('.gz') || filePath.endsWith('.tgz')) cmd = `tar -xzf "${filePath}" -C "${destPath}"`;
                else if (filePath.endsWith('.bz2')) cmd = `tar -xjf "${filePath}" -C "${destPath}"`;

                try {
                    await fs.mkdir(destPath, { recursive: true });
                    await execPromise(cmd, { timeout: 120000 });
                    return { success: true, filePath, destination: destPath };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'tar_create': {
                const files = params.files || params.sourcePath || params.sourcePaths;
                const outputPath = params.outputPath || params.tarPath;
                const compress = params.compress || 'none';
                if (!files || !outputPath) return { success: false, error: 'files and outputPath parameters are required' };

                const fileList = Array.isArray(files) ? files.join(' ') : files;
                let cmd = `tar -cf "${outputPath}" ${fileList}`;
                if (compress === 'gzip' || compress === 'gz') cmd = `tar -czf "${outputPath}" ${fileList}`;
                else if (compress === 'bzip2' || compress === 'bz2') cmd = `tar -cjf "${outputPath}" ${fileList}`;

                try {
                    await execPromise(cmd, { timeout: 120000 });
                    return { success: true, outputPath, files, compression: compress };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'extract_archive': {
                const filePath = params.filePath;
                const destPath = params.destPath || '.';
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

                let cmd;
                if (filePath.endsWith('.zip')) cmd = `unzip -o "${filePath}" -d "${destPath}"`;
                else if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) cmd = `tar -xzf "${filePath}" -C "${destPath}"`;
                else if (filePath.endsWith('.tar.bz2')) cmd = `tar -xjf "${filePath}" -C "${destPath}"`;
                else if (filePath.endsWith('.tar')) cmd = `tar -xf "${filePath}" -C "${destPath}"`;
                else if (filePath.endsWith('.gz')) cmd = `gunzip -c "${filePath}" > "${destPath}/$(basename "${filePath}" .gz)"`;
                else return { success: false, error: 'Unsupported archive format' };

                try {
                    await fs.mkdir(destPath, { recursive: true });
                    await execPromise(cmd, { timeout: 120000 });
                    return { success: true, filePath, destination: destPath };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown archive skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute command skills client-side
async function executeCommandSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'run_bash': {
                const command = params.command;
                if (!command) return { success: false, error: 'command parameter is required' };
                try {
                    const { stdout, stderr } = await execPromise(command, { timeout: 60000 });
                    return { success: true, stdout, stderr };
                } catch (e) {
                    return { success: false, error: e.message, stderr: e.stderr };
                }
            }

            case 'run_python': {
                const code = params.code;
                if (!code) return { success: false, error: 'code parameter is required' };
                try {
                    const { stdout, stderr } = await execPromise(`python3 -c "${code.replace(/"/g, '\\"')}"`, { timeout: 60000 });
                    return { success: true, stdout, stderr };
                } catch (e) {
                    return { success: false, error: e.message, stderr: e.stderr };
                }
            }

            case 'run_powershell': {
                if (os.platform() !== 'win32') return { success: false, error: 'PowerShell is only available on Windows' };
                const command = params.command;
                if (!command) return { success: false, error: 'command parameter is required' };
                try {
                    const { stdout, stderr } = await execPromise(`powershell -Command "${command}"`, { timeout: 60000 });
                    return { success: true, stdout, stderr };
                } catch (e) {
                    return { success: false, error: e.message, stderr: e.stderr };
                }
            }

            case 'run_cmd': {
                if (os.platform() !== 'win32') return { success: false, error: 'cmd is only available on Windows' };
                const command = params.command;
                if (!command) return { success: false, error: 'command parameter is required' };
                try {
                    const { stdout, stderr } = await execPromise(`cmd /c "${command}"`, { timeout: 60000 });
                    return { success: true, stdout, stderr };
                } catch (e) {
                    return { success: false, error: e.message, stderr: e.stderr };
                }
            }

            default:
                return { success: false, error: `Unknown command skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute extra file skills client-side
async function executeFileExtraSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'copy_file': {
                const sourcePath = params.sourcePath || params.source;
                const destPath = params.destPath || params.destination;
                if (!sourcePath || !destPath) return { success: false, error: 'sourcePath and destPath parameters are required' };
                await fs.copyFile(sourcePath, destPath);
                return { success: true, sourcePath, destPath };
            }

            case 'get_file_metadata': {
                const filePath = params.filePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };
                const stat = await fs.stat(filePath);
                return {
                    success: true,
                    filePath,
                    size: stat.size,
                    created: stat.birthtime,
                    modified: stat.mtime,
                    accessed: stat.atime,
                    isDirectory: stat.isDirectory(),
                    isFile: stat.isFile(),
                    permissions: stat.mode.toString(8)
                };
            }

            case 'search_files': {
                const pattern = params.pattern;
                const directory = params.directory || params.dirPath || '.';
                if (!pattern) return { success: false, error: 'pattern parameter is required' };

                try {
                    const { stdout } = await execPromise(`find "${directory}" -name "${pattern}" 2>/dev/null | head -100`, { timeout: 30000 });
                    const files = stdout.trim().split('\n').filter(f => f);
                    return { success: true, pattern, directory, files, count: files.length };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'download_file': {
                const url = params.url;
                const destPath = params.destPath || params.destination || params.outputPath || params.savePath;
                if (!url || !destPath) return { success: false, error: 'url and destPath parameters are required' };

                try {
                    await execPromise(`curl -sL -o "${destPath}" "${url}"`, { timeout: 120000 });
                    const stat = await fs.stat(destPath);
                    return { success: true, url, destPath, size: stat.size };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'search_replace_file': {
                const filePath = params.filePath;
                const search = params.search;
                const replace = params.replace;
                // Opt-in regex mode — accepts a few aliases because the model
                // sometimes emits "regex", "useRegex", "isRegex". Anything
                // truthy (true / "true" / "1" / "yes") turns it on.
                const regexParam = params.regex ?? params.useRegex ?? params.isRegex ?? false;
                const useRegex = regexParam === true || /^(true|1|yes)$/i.test(String(regexParam));
                if (!filePath || search === undefined) return { success: false, error: 'filePath and search parameters are required' };

                const content = await fs.readFile(filePath, 'utf8');
                let newContent;
                let count;
                if (useRegex) {
                    let regex;
                    try {
                        regex = new RegExp(search, 'g');
                    } catch (e) {
                        return { success: false, error: `Invalid regex in search param: ${e.message}. If you meant to match literal text (including characters like ( ) { } . [ ] * + ? ), omit regex=true so the skill does plain-string matching.` };
                    }
                    newContent = content.replace(regex, replace || '');
                    count = (content.match(regex) || []).length;
                } else {
                    // Literal substring matching — default, matches how
                    // Claude Code / Gemini CLI handle edits so the model
                    // doesn't have to escape regex metacharacters in code.
                    count = 0;
                    let idx = 0;
                    const out = [];
                    while (true) {
                        const hit = content.indexOf(search, idx);
                        if (hit === -1) { out.push(content.substring(idx)); break; }
                        out.push(content.substring(idx, hit));
                        out.push(replace || '');
                        idx = hit + search.length;
                        count++;
                    }
                    newContent = out.join('');
                }

                if (count === 0) {
                    // Common words we strip from hint tokens — otherwise
                    // a search containing `let`, `if`, or `<head>` scores
                    // every line that has those keywords (noisy hints).
                    const STOP = new Set([
                        'let','const','var','function','return','else','true','false','null','undefined',
                        'this','new','class','import','export','from','default','async','await','for','while',
                        'head','body','div','span','html','style','script','link','meta','title','input','button',
                        'label','form','canvas','main','nav','section','article','aside','footer','header',
                    ]);
                    // Prefer identifiers from the whole search (not just
                    // the first line) and require length ≥ 4 so generic
                    // 3-letter words don't dominate.
                    const rawTokens = String(search).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || [];
                    const hintTokens = [...new Set(rawTokens.filter(t => !STOP.has(t.toLowerCase())))];
                    const hintsByLine = [];
                    let topContextBlock = '';
                    if (hintTokens.length > 0 && !useRegex) {
                        const fileLines = content.split('\n');
                        const minScore = Math.max(1, Math.ceil(hintTokens.length * 0.5));
                        const scored = fileLines.map((line, i) => {
                            let score = 0;
                            for (const tok of hintTokens) {
                                if (line.includes(tok)) score++;
                            }
                            return { line, lineNum: i + 1, score };
                        }).filter(r => r.score >= minScore)
                          .sort((a, b) => b.score - a.score || a.lineNum - b.lineNum)
                          .slice(0, 3);
                        for (const r of scored) {
                            const trimmed = r.line.trim();
                            hintsByLine.push(`  line ${r.lineNum}: ${trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed}`);
                        }
                        // For the single best match, also include the actual
                        // surrounding lines exactly as they appear in the
                        // file — this is what the model needs to build a
                        // correct search value without a separate read_file.
                        if (scored.length > 0) {
                            const top = scored[0];
                            const start = Math.max(0, top.lineNum - 3);
                            const end = Math.min(fileLines.length, top.lineNum + 6);
                            const blockLines = [];
                            for (let i = start; i < end; i++) {
                                blockLines.push(`  ${String(i + 1).padStart(4)}: ${fileLines[i]}`);
                            }
                            topContextBlock = `\nActual file content around line ${top.lineNum} (copy EXACTLY from here — whitespace matters):\n${blockLines.join('\n')}\n`;
                        }
                    }

                    // Fallback: when no strong identifier match exists, the
                    // model is probably using variable names that don't
                    // exist in the file at all. Show the file's actual
                    // top-level function / const / let / var declarations
                    // so it can see the real identifier names.
                    let declHint = '';
                    if (hintsByLine.length === 0) {
                        const decls = [];
                        const lines = content.split('\n');
                        const declRe = /^\s*(?:(?:async\s+)?function\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_][A-Za-z0-9_]*)/;
                        for (let i = 0; i < lines.length; i++) {
                            const m = lines[i].match(declRe);
                            if (m) {
                                decls.push(`  line ${i + 1}: ${lines[i].trim().slice(0, 100)}`);
                                if (decls.length >= 6) break;
                            }
                        }
                        if (decls.length > 0) {
                            declHint = `\nIdentifiers/declarations that DO exist in this file:\n${decls.join('\n')}\n`;
                        }
                    }

                    const preview = String(search).replace(/\n/g, '\\n').slice(0, 100);
                    let err = `No matches for search="${preview}${String(search).length > 100 ? '…' : ''}" in ${filePath}.\n`;
                    if (hintsByLine.length > 0) {
                        err += `Closest matches in the file (by shared identifiers):\n${hintsByLine.join('\n')}\n`;
                        err += topContextBlock;
                        err += `Rebuild your search using the EXACT text from the block above (whitespace, quotes, identifiers must match byte-for-byte).`;
                    } else if (declHint) {
                        err += `The file does not contain any identifier from your search.${declHint}`;
                        err += `Read the file with read_file(filePath) and use the ACTUAL names shown above — do not guess.`;
                    } else {
                        err += `The file does not contain that snippet. Re-read the file with read_file(filePath, startLine=1, endLine=<total>) to see the actual contents before trying again — do not guess.`;
                    }
                    return { success: false, error: err };
                }

                await fs.writeFile(filePath, newContent);
                return { success: true, filePath, replacements: count, message: `Replaced ${count} occurrence${count === 1 ? '' : 's'}` };
            }

            case 'diff_files': {
                const file1 = params.file1 || params.filePath1;
                const file2 = params.file2 || params.filePath2;
                if (!file1 || !file2) return { success: false, error: 'file1 and file2 parameters are required' };

                try {
                    const { stdout } = await execPromise(`diff "${file1}" "${file2}"`, { timeout: 30000 });
                    return { success: true, file1, file2, diff: stdout || '(no differences)', hasDifferences: false };
                } catch (e) {
                    if (e.code === 1) {
                        return { success: true, file1, file2, diff: e.stdout, hasDifferences: true };
                    }
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown file skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute clipboard skills client-side
async function executeClipboardSkill(skillName, params) {
    const platform = os.platform();

    try {
        switch (skillName) {
            case 'clipboard_read': {
                let cmd;
                if (platform === 'darwin') cmd = 'pbpaste';
                else if (platform === 'win32') cmd = 'powershell -command "Get-Clipboard"';
                else cmd = 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null';

                try {
                    const { stdout } = await execPromise(cmd, { timeout: 5000 });
                    return { success: true, content: stdout };
                } catch (e) {
                    return { success: false, error: 'Clipboard access failed: ' + e.message };
                }
            }

            case 'clipboard_write': {
                const content = params.content;
                if (!content) return { success: false, error: 'content parameter is required' };

                let cmd;
                if (platform === 'darwin') cmd = `echo "${content.replace(/"/g, '\\"')}" | pbcopy`;
                else if (platform === 'win32') cmd = `powershell -command "Set-Clipboard -Value '${content.replace(/'/g, "''")}'"`;
                else cmd = `echo "${content.replace(/"/g, '\\"')}" | xclip -selection clipboard 2>/dev/null || echo "${content.replace(/"/g, '\\"')}" | xsel --clipboard --input 2>/dev/null`;

                try {
                    await execPromise(cmd, { timeout: 5000 });
                    return { success: true, message: 'Content copied to clipboard' };
                } catch (e) {
                    return { success: false, error: 'Clipboard access failed: ' + e.message };
                }
            }

            default:
                return { success: false, error: `Unknown clipboard skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute database skills client-side
async function executeDatabaseSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'sqlite_query': {
                const database = params.database || params.dbPath;
                const query = params.query;
                if (!database || !query) return { success: false, error: 'database and query parameters are required' };

                try {
                    const { stdout } = await execPromise(`sqlite3 -json "${database}" "${query.replace(/"/g, '\\"')}"`, { timeout: 30000 });
                    const results = stdout.trim() ? JSON.parse(stdout) : [];
                    return { success: true, database, query, results, rowCount: results.length };
                } catch (e) {
                    // Try without -json flag for older sqlite versions
                    try {
                        const { stdout } = await execPromise(`sqlite3 -header -separator '|' "${database}" "${query.replace(/"/g, '\\"')}"`, { timeout: 30000 });
                        return { success: true, database, query, output: stdout };
                    } catch (e2) {
                        return { success: false, error: e2.message };
                    }
                }
            }

            case 'sqlite_list_tables': {
                const database = params.database || params.dbPath;
                if (!database) return { success: false, error: 'database parameter is required' };

                try {
                    const { stdout } = await execPromise(`sqlite3 "${database}" ".tables"`, { timeout: 10000 });
                    const tables = stdout.trim().split(/\s+/).filter(t => t);
                    return { success: true, database, tables, count: tables.length };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown database skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute PDF skills client-side
async function executePdfSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'read_pdf': {
                const filePath = params.filePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

                try {
                    const { stdout } = await execPromise(`pdftotext "${filePath}" - 2>/dev/null || python3 -c "import PyPDF2; f=open('${filePath}','rb'); r=PyPDF2.PdfReader(f); print(''.join(p.extract_text() for p in r.pages))"`, { timeout: 60000 });
                    return { success: true, filePath, text: stdout };
                } catch (e) {
                    return { success: false, error: 'PDF extraction failed. Install pdftotext or PyPDF2: ' + e.message };
                }
            }

            case 'pdf_page_count': {
                const filePath = params.filePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

                try {
                    const { stdout } = await execPromise(`pdfinfo "${filePath}" 2>/dev/null | grep Pages | awk '{print $2}' || python3 -c "import PyPDF2; f=open('${filePath}','rb'); print(len(PyPDF2.PdfReader(f).pages))"`, { timeout: 30000 });
                    return { success: true, filePath, pageCount: parseInt(stdout.trim()) || 0 };
                } catch (e) {
                    return { success: false, error: 'PDF page count failed: ' + e.message };
                }
            }

            case 'pdf_to_images': {
                const filePath = params.filePath;
                const outputDir = params.outputDir || '.';
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

                try {
                    await fs.mkdir(outputDir, { recursive: true });
                    await execPromise(`pdftoppm -png "${filePath}" "${outputDir}/page"`, { timeout: 120000 });
                    const files = await fs.readdir(outputDir);
                    const images = files.filter(f => f.startsWith('page') && f.endsWith('.png'));
                    return { success: true, filePath, outputDir, images, count: images.length };
                } catch (e) {
                    return { success: false, error: 'PDF to images failed. Install poppler-utils: ' + e.message };
                }
            }

            case 'create_pdf': {
                const outputPath = params.outputPath || params.filePath;
                // Strip markdown fences if the model wrapped the content in
                // them — otherwise the backticks and language tag end up
                // rendered verbatim inside the PDF.
                const content = sanitizeContentForFile(outputPath || 'out.pdf', params.content || '');
                const title = params.title || 'Document';
                if (!outputPath) return { success: false, error: 'outputPath parameter is required' };
                if (!content) return { success: false, error: 'content parameter is required' };

                // Ensure directory exists
                const dir = path.dirname(outputPath);
                await fs.mkdir(dir, { recursive: true });

                // Track temp files for cleanup
                const tempFiles = [];
                const cleanupTempFiles = async () => {
                    for (const tempFile of tempFiles) {
                        await fs.unlink(tempFile).catch(() => {});
                    }
                };

                // Try multiple PDF generation methods
                const escapedContent = content.replace(/'/g, "'\\''").replace(/\n/g, '\\n');
                const escapedTitle = title.replace(/'/g, "'\\''");

                // Method 1: Use Python with reportlab
                const pythonScript = `
import sys
try:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas
    from reportlab.lib.units import inch
    c = canvas.Canvas('${outputPath}', pagesize=letter)
    c.setTitle('${escapedTitle}')
    text = '''${escapedContent}'''
    y = 750
    for line in text.split('\\n'):
        if y < 50:
            c.showPage()
            y = 750
        c.drawString(50, y, line[:100])
        y -= 14
    c.save()
    print('OK')
except ImportError:
    sys.exit(1)
`;
                try {
                    const { stdout } = await execPromise(`python3 -c "${pythonScript.replace(/"/g, '\\"')}"`, { timeout: 30000 });
                    if (stdout.includes('OK')) {
                        await cleanupTempFiles();
                        return { success: true, outputPath, message: `PDF created: ${outputPath}` };
                    }
                } catch (e) { /* Try next method */ }

                // Method 2: Use wkhtmltopdf with HTML wrapper
                const tempHtml = outputPath.replace('.pdf', '.tmp.html');
                try {
                    const htmlContent = `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:40px;}</style></head><body><h1>${title}</h1><pre style="white-space:pre-wrap;">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
                    tempFiles.push(tempHtml);
                    await fs.writeFile(tempHtml, htmlContent, 'utf8');
                    await execPromise(`wkhtmltopdf --quiet "${tempHtml}" "${outputPath}"`, { timeout: 60000 });
                    await cleanupTempFiles();
                    return { success: true, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* Try next method */ }

                // Method 3: Use enscript + ps2pdf for plain text
                const tempTxt = outputPath.replace('.pdf', '.tmp.txt');
                try {
                    tempFiles.push(tempTxt);
                    await fs.writeFile(tempTxt, `${title}\n${'='.repeat(title.length)}\n\n${content}`, 'utf8');
                    await execPromise(`enscript -B -p - "${tempTxt}" | ps2pdf - "${outputPath}"`, { timeout: 30000 });
                    await cleanupTempFiles();
                    return { success: true, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* Try next method */ }

                // Method 4: Fallback - create HTML file instead (PDF converters not installed)
                // Clean up any temp files before creating fallback
                await cleanupTempFiles();
                const htmlPath = outputPath.replace('.pdf', '.html');
                const htmlContent = `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:40px;line-height:1.6;}h1{color:#333;}ul{margin:20px 0;}li{margin:10px 0;}</style></head><body><h1>${title}</h1><div>${content.replace(/\n/g, '<br>')}</div><p style="margin-top:40px;color:#666;font-size:12px;">Generated by Koda</p></body></html>`;
                await fs.writeFile(htmlPath, htmlContent, 'utf8');
                return {
                    success: true,
                    outputPath: htmlPath,
                    message: `Created HTML report (PDF converters not installed on system): ${htmlPath}`,
                    fallback: true
                };
            }

            case 'html_to_pdf': {
                const htmlPath = params.htmlPath || params.inputPath;
                const outputPath = params.outputPath || params.pdfPath || htmlPath.replace(/\.html?$/i, '.pdf');
                if (!htmlPath) return { success: false, error: 'htmlPath parameter is required' };

                // Ensure output directory exists
                const dir = path.dirname(outputPath);
                await fs.mkdir(dir, { recursive: true });

                // Try multiple conversion methods
                // Method 1: wkhtmltopdf (most common)
                try {
                    await execPromise(`wkhtmltopdf --quiet "${htmlPath}" "${outputPath}"`, { timeout: 60000 });
                    return { success: true, htmlPath, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* Try next method */ }

                // Method 2: WeasyPrint (Python)
                try {
                    await execPromise(`weasyprint "${htmlPath}" "${outputPath}"`, { timeout: 60000 });
                    return { success: true, htmlPath, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* Try next method */ }

                // Method 3: Chrome/Chromium headless
                try {
                    const absHtml = path.resolve(htmlPath);
                    const absPdf = path.resolve(outputPath);
                    await execPromise(`chromium --headless --disable-gpu --print-to-pdf="${absPdf}" "file://${absHtml}" 2>/dev/null || google-chrome --headless --disable-gpu --print-to-pdf="${absPdf}" "file://${absHtml}" 2>/dev/null`, { timeout: 60000 });
                    return { success: true, htmlPath, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* All methods failed */ }

                return {
                    success: false,
                    error: 'No PDF conversion tools available. Install wkhtmltopdf, weasyprint, or chromium.'
                };
            }

            case 'markdown_to_html': {
                const mdPath = params.mdPath || params.inputPath;
                const outputPath = params.outputPath || params.htmlPath || mdPath.replace(/\.md$/i, '.html');
                const title = params.title || 'Document';
                if (!mdPath) return { success: false, error: 'mdPath parameter is required' };

                // Ensure output directory exists
                const dir = path.dirname(outputPath);
                await fs.mkdir(dir, { recursive: true });

                // Read markdown content
                let mdContent;
                try {
                    mdContent = await fs.readFile(mdPath, 'utf8');
                } catch (e) {
                    return { success: false, error: `Cannot read markdown file: ${e.message}` };
                }

                // Try using pandoc first
                try {
                    await execPromise(`pandoc -f markdown -t html -s --metadata title="${title}" -o "${outputPath}" "${mdPath}"`, { timeout: 30000 });
                    return { success: true, mdPath, outputPath, message: `HTML created: ${outputPath}` };
                } catch (e) { /* Try fallback */ }

                // Fallback: Simple markdown conversion
                let html = mdContent
                    // Headers
                    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                    // Bold and italic
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>')
                    // Links
                    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
                    // Code blocks
                    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
                    .replace(/`(.+?)`/g, '<code>$1</code>')
                    // Lists
                    .replace(/^\* (.+)$/gm, '<li>$1</li>')
                    .replace(/^- (.+)$/gm, '<li>$1</li>')
                    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
                    // Paragraphs
                    .replace(/\n\n/g, '</p><p>')
                    .replace(/\n/g, '<br>');

                const fullHtml = `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;}
code{background:#f4f4f4;padding:2px 5px;border-radius:3px;}
pre{background:#f4f4f4;padding:15px;overflow-x:auto;border-radius:5px;}
ul{margin:15px 0;}li{margin:5px 0;}</style>
</head><body><p>${html}</p></body></html>`;

                await fs.writeFile(outputPath, fullHtml, 'utf8');
                return { success: true, mdPath, outputPath, message: `HTML created: ${outputPath}` };
            }

            default:
                return { success: false, error: `Unknown PDF skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute image skills client-side
async function executeImageSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'ocr_image': {
                // Support both imagePath (skill definition) and filePath (legacy)
                const filePath = params.imagePath || params.filePath;
                if (!filePath) return { success: false, error: 'imagePath parameter is required' };

                try {
                    const { stdout } = await execPromise(`tesseract "${filePath}" stdout 2>/dev/null`, { timeout: 60000 });
                    return { success: true, filePath, text: stdout.trim() };
                } catch (e) {
                    return { success: false, error: 'OCR failed. Install tesseract-ocr: ' + e.message };
                }
            }

            case 'screenshot': {
                const outputPath = params.outputPath || params.savePath || 'screenshot.png';
                const platform = os.platform();

                let cmd;
                if (platform === 'darwin') cmd = `screencapture -x "${outputPath}"`;
                else if (platform === 'win32') cmd = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bitmap.Save('${outputPath}') }"`;
                else cmd = `import -window root "${outputPath}" 2>/dev/null || gnome-screenshot -f "${outputPath}" 2>/dev/null || scrot "${outputPath}" 2>/dev/null`;

                try {
                    await execPromise(cmd, { timeout: 10000 });
                    return { success: true, outputPath };
                } catch (e) {
                    return { success: false, error: 'Screenshot failed: ' + e.message };
                }
            }

            case 'convert_image': {
                const inputPath = params.inputPath;
                const outputPath = params.outputPath;
                if (!inputPath || !outputPath) return { success: false, error: 'inputPath and outputPath parameters are required' };

                try {
                    await execPromise(`convert "${inputPath}" "${outputPath}"`, { timeout: 30000 });
                    return { success: true, inputPath, outputPath };
                } catch (e) {
                    return { success: false, error: 'Image conversion failed. Install ImageMagick: ' + e.message };
                }
            }

            default:
                return { success: false, error: `Unknown image skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute Windows-specific skills client-side
async function executeWindowsSkill(skillName, params) {
    if (os.platform() !== 'win32') {
        return { success: false, error: 'This skill is only available on Windows' };
    }

    try {
        switch (skillName) {
            case 'get_windows_services': {
                try {
                    const { stdout } = await execPromise('powershell -command "Get-Service | Select-Object Name, Status | ConvertTo-Json"', { timeout: 30000 });
                    const services = JSON.parse(stdout);
                    return { success: true, services, count: services.length };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_registry_value': {
                const path = params.path;
                const name = params.name;
                if (!path) return { success: false, error: 'path parameter is required' };

                try {
                    const cmd = name
                        ? `powershell -command "(Get-ItemProperty -Path '${path}').'${name}'"`
                        : `powershell -command "Get-ItemProperty -Path '${path}' | ConvertTo-Json"`;
                    const { stdout } = await execPromise(cmd, { timeout: 10000 });
                    return { success: true, path, name, value: stdout.trim() };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'set_registry_value': {
                const path = params.path;
                const name = params.name;
                const value = params.value;
                if (!path || !name || value === undefined) return { success: false, error: 'path, name, and value parameters are required' };

                try {
                    await execPromise(`powershell -command "Set-ItemProperty -Path '${path}' -Name '${name}' -Value '${value}'"`, { timeout: 10000 });
                    return { success: true, path, name, value };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            default:
                return { success: false, error: `Unknown Windows skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute email skills client-side
async function executeEmailSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'read_email_file': {
                // Support both emailPath (skill definition) and filePath (legacy)
                const filePath = params.emailPath || params.filePath;
                if (!filePath) return { success: false, error: 'emailPath or filePath parameter is required' };

                const content = await fs.readFile(filePath, 'utf8');
                const headers = {};
                const lines = content.split('\n');
                let bodyStart = 0;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.trim() === '') {
                        bodyStart = i + 1;
                        break;
                    }
                    const match = line.match(/^([^:]+):\s*(.*)$/);
                    if (match) {
                        headers[match[1].toLowerCase()] = match[2];
                    }
                }

                const body = lines.slice(bodyStart).join('\n');

                return {
                    success: true,
                    filePath,
                    from: headers.from || '',
                    to: headers.to || '',
                    subject: headers.subject || '',
                    date: headers.date || '',
                    body: body.substring(0, 10000)
                };
            }

            default:
                return { success: false, error: `Unknown email skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute Playwright-based skills (via API for browser automation)
async function executePlaywrightSkill(api, skillName, params) {
    try {
        switch (skillName) {
            case 'playwright_fetch': {
                const body = {
                    url: params.url,
                    urls: params.urls,
                    timeout: params.timeout || 15000,
                    waitForJS: params.waitForJS !== false,
                    includeLinks: params.includeLinks || false,
                    maxLength: params.maxLength || 8000
                };

                const result = await api.request('POST', '/api/playwright/fetch', body);
                return { success: true, ...result };
            }

            case 'playwright_interact': {
                const body = {
                    url: params.url,
                    actions: params.actions || [],
                    timeout: params.timeout || 30000,
                    maxLength: params.maxLength || 8000
                };

                const result = await api.request('POST', '/api/playwright/interact', body);
                return { success: true, ...result };
            }

            case 'web_search': {
                const query = params.query;
                if (!query) return { success: false, error: 'query parameter is required' };

                const limit = params.limit || 8;
                const fetchContent = params.fetchContent !== false;
                const contentLimit = params.contentLimit || 5;
                const timeRange = params.timeRange || '';

                let url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
                if (fetchContent) {
                    url += `&fetchContent=true&contentLimit=${contentLimit}`;
                }
                if (timeRange) {
                    url += `&timeRange=${timeRange}`;
                }

                const result = await api.request('GET', url);
                return { success: true, ...result };
            }

            default:
                return { success: false, error: `Unknown playwright skill: ${skillName}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Execute skills and return results
async function executeSkillCalls(api, skillCalls, agentId = null) {
    const results = [];
    const fileModifyingSkills = ['create_file', 'update_file'];

    // Fetch enabled skills from API to verify before execution
    // If fetch fails, fall back to cached skills, then fail open (null = allow all)
    let enabledSkillNames = null; // null = allow all (fail open for client-side skills)
    try {
        const skillsResult = await api.getSkills();
        if (skillsResult.success && skillsResult.data) {
            enabledSkillNames = new Set(
                skillsResult.data
                    .filter(s => s.enabled)
                    .map(s => s.name)
            );
            cachedSkills = skillsResult.data; // Update cache
        } else if (cachedSkills.length > 0) {
            // API failed but we have cached skills - use those
            enabledSkillNames = new Set(
                cachedSkills
                    .filter(s => s.enabled)
                    .map(s => s.name)
            );
        }
        // If both fail, enabledSkillNames stays null (allow all client-side skills)
    } catch (error) {
        // If we can't fetch skills, try cache, then fail open for client-side
        if (cachedSkills.length > 0) {
            enabledSkillNames = new Set(
                cachedSkills
                    .filter(s => s.enabled)
                    .map(s => s.name)
            );
        }
        // else stays null = allow all
    }

    // Web-dependent skills that require websearchMode to be enabled
    const webDependentSkills = ['playwright_fetch', 'playwright_interact', 'web_search'];

    for (const call of skillCalls) {
        // Check if skill is enabled before execution
        if (enabledSkillNames && !enabledSkillNames.has(call.skillName)) {
            const denial = { success: false, error: `Skill '${call.skillName}' is disabled` };
            results.push({ skill: call.skillName, success: false, error: denial.error });
            recordToolCall(call.skillName, call.params, denial);
            continue;
        }

        // Block web-dependent skills when websearch mode is not enabled
        if (webDependentSkills.includes(call.skillName) && !websearchMode) {
            const denial = { success: false, error: `requires /web mode` };
            results.push({ skill: call.skillName, success: false, error: `Skill '${call.skillName}' requires web search mode. Use /web to enable it.` });
            recordToolCall(call.skillName, call.params, denial);
            continue;
        }

        // Check if this is a file-modifying skill that needs diff preview
        const needsDiffPreview = fileModifyingSkills.includes(call.skillName) && call.params.filePath;

        if (needsDiffPreview) {
            // Read current file content (if exists)
            let oldContent = '';
            const filePath = call.params.filePath;

            try {
                if (fsSync.existsSync(filePath)) {
                    oldContent = fsSync.readFileSync(filePath, 'utf8');
                }
            } catch (error) {
                // File doesn't exist or can't be read - that's OK for create_file
            }

            const newContent = call.params.content || '';

            // Show diff preview
            const relativePath = filePath.replace(userWorkingDirectory, '.');
            const operation = call.skillName === 'create_file' ? 'Create' : 'Update';

            displayDiff(oldContent, newContent, relativePath);

            // Prompt for confirmation
            const confirmation = await promptConfirmation(`${operation} ${relativePath}?`);

            if (confirmation === 'no') {
                addToHistory('system', `✗ ${operation} cancelled by user: ${relativePath}`);
                results.push({
                    skill: call.skillName,
                    success: false,
                    error: 'Cancelled by user',
                    skipped: false
                });
                displayChatHistory();
                continue;
            } else if (confirmation === 'skip') {
                addToHistory('system', `⊘ ${operation} skipped: ${relativePath}`);
                results.push({
                    skill: call.skillName,
                    success: false,
                    error: `${operation} skipped by user`,
                    skipped: true
                });
                displayChatHistory();
                continue;
            }
            // If 'yes', continue with execution below
        }

        // Begin a live tool-call render so the user sees what koda is
        // doing in real time (action header + animated ⎿ spinner, which
        // gets overwritten with the real summary once the skill returns).
        const toolHandle = beginToolCall(call.skillName, call.params);

        let result;

        // ALL skills execute client-side - Koda is a standalone CLI tool like Claude Code
        const fileOperationSkills = ['create_file', 'update_file', 'read_file', 'delete_file', 'delete_directory', 'list_directory', 'move_file', 'create_directory', 'append_to_file', 'tail_file', 'head_file'];
        const fileExtraSkills = ['copy_file', 'get_file_metadata', 'search_files', 'download_file', 'search_replace_file', 'diff_files'];
        const processSkills = ['list_processes', 'kill_process', 'start_process'];
        const systemSkills = ['system_info', 'disk_usage', 'get_uptime', 'list_ports', 'list_services'];
        const gitSkills = ['git_status', 'git_diff', 'git_log', 'git_branch'];
        const envSkills = ['get_env_var', 'set_env_var', 'which_command'];
        const networkSkills = ['fetch_url', 'dns_lookup', 'check_port', 'ping_host', 'http_request', 'get_public_ip', 'list_network_interfaces', 'traceroute', 'curl_request'];
        const dataSkills = ['parse_json', 'parse_csv', 'base64_encode', 'base64_decode', 'hash_data', 'generate_uuid', 'get_timestamp', 'count_words', 'find_patterns', 'analyze_code', 'compress_data', 'decompress_data', 'json_get', 'json_set', 'yaml_parse', 'ini_parse'];
        const archiveSkills = ['unzip_file', 'zip_files', 'tar_extract', 'tar_create', 'extract_archive'];
        const commandSkills = ['run_bash', 'run_python', 'run_powershell', 'run_cmd'];
        const clipboardSkills = ['clipboard_read', 'clipboard_write'];
        const databaseSkills = ['sqlite_query', 'sqlite_list_tables'];
        const pdfSkills = ['read_pdf', 'pdf_page_count', 'pdf_to_images', 'create_pdf', 'html_to_pdf', 'markdown_to_html'];
        const imageSkills = ['ocr_image', 'screenshot', 'convert_image'];
        const windowsSkills = ['get_windows_services', 'get_registry_value', 'set_registry_value'];
        const emailSkills = ['read_email_file'];
        const playwrightSkills = ['playwright_fetch', 'playwright_interact', 'web_search'];

        if (fileOperationSkills.includes(call.skillName)) {
            result = await executeFileOperationSkill(call.skillName, call.params);
        } else if (fileExtraSkills.includes(call.skillName)) {
            result = await executeFileExtraSkill(call.skillName, call.params);
        } else if (processSkills.includes(call.skillName)) {
            result = await executeProcessSkill(call.skillName, call.params);
        } else if (systemSkills.includes(call.skillName)) {
            result = await executeSystemSkill(call.skillName, call.params);
        } else if (gitSkills.includes(call.skillName)) {
            result = await executeGitSkill(call.skillName, call.params);
        } else if (envSkills.includes(call.skillName)) {
            result = await executeEnvSkill(call.skillName, call.params);
        } else if (networkSkills.includes(call.skillName)) {
            result = await executeNetworkSkill(call.skillName, call.params);
        } else if (dataSkills.includes(call.skillName)) {
            result = await executeDataSkill(call.skillName, call.params);
        } else if (archiveSkills.includes(call.skillName)) {
            result = await executeArchiveSkill(call.skillName, call.params);
        } else if (commandSkills.includes(call.skillName)) {
            result = await executeCommandSkill(call.skillName, call.params);
        } else if (clipboardSkills.includes(call.skillName)) {
            result = await executeClipboardSkill(call.skillName, call.params);
        } else if (databaseSkills.includes(call.skillName)) {
            result = await executeDatabaseSkill(call.skillName, call.params);
        } else if (pdfSkills.includes(call.skillName)) {
            result = await executePdfSkill(call.skillName, call.params);
        } else if (imageSkills.includes(call.skillName)) {
            result = await executeImageSkill(call.skillName, call.params);
        } else if (windowsSkills.includes(call.skillName)) {
            result = await executeWindowsSkill(call.skillName, call.params);
        } else if (emailSkills.includes(call.skillName)) {
            result = await executeEmailSkill(call.skillName, call.params);
        } else if (playwrightSkills.includes(call.skillName)) {
            result = await executePlaywrightSkill(api, call.skillName, call.params);
        } else {
            // Unknown skill - return error
            result = { success: false, error: `Unknown skill: ${call.skillName}. All skills must execute client-side.` };
        }

        // Finalize the live tool-call entry (stops the spinner and rewrites
        // the ⎿ line with the real summary). This also pushes the entry
        // onto chatHistory so redraws replay it.
        toolHandle.finish(result);

        if (result.success) {
            results.push({
                skill: call.skillName,
                success: true,
                result: result.data || result
            });

            // Track working-set side effects (unchanged behaviour)
            if (call.skillName === 'create_file' && (result.data?.filePath || result.filePath)) {
                addToWorkingSet(result.data?.filePath || result.filePath, call.params.content);
            } else if (call.skillName === 'read_file') {
                const filePath = result.data?.filePath || result.filePath || call.params.filePath;
                const content = result.data?.content || result.content;
                if (filePath && content) addToWorkingSet(filePath, content);
            } else if (call.skillName === 'update_file' && (result.data?.filePath || result.filePath)) {
                addToWorkingSet(result.data?.filePath || result.filePath);
            }
        } else {
            results.push({
                skill: call.skillName,
                success: false,
                error: result.error
            });
        }
    }

    // Only do a full display refresh at the end of all skills
    return results;
}

// Build feedback message with skill results for AI
function buildSkillResultsMessage(results) {
    if (results.length === 0) return '';

    let message = '\n\n[SKILL RESULTS]\n';
    let allSucceeded = true;
    let hasFailures = false;
    let failureMessages = [];

    for (const r of results) {
        if (r.success) {
            // Provide concise, clean feedback without verbose JSON
            const skillName = r.skill;
            const result = r.result;

            // Extract key information based on skill type
            if (skillName === 'create_file' || skillName === 'update_file') {
                const path = result.filePath || result.data?.filePath || 'unknown';
                message += `✓ ${skillName}: ${path}\n`;
            } else if (skillName === 'delete_file') {
                const path = result.filePath || result.data?.filePath || 'file deleted';
                message += `✓ File deleted: ${path}\n`;
            } else if (skillName === 'create_directory') {
                const path = result.dirPath || result.data?.dirPath || 'directory created';
                message += `✓ Directory created: ${path}\n`;
            } else if (skillName === 'delete_directory') {
                const path = result.dirPath || result.data?.dirPath || 'directory deleted';
                message += `✓ Directory deleted: ${path}\n`;
            } else if (skillName === 'read_file') {
                const filePath = result.filePath || result.data?.filePath || 'file';
                const content = result.content || result.data?.content || '';
                // Include actual content so AI knows what's in the file
                const truncatedContent = content.length > 4000 ? content.substring(0, 4000) + '\n... (truncated)' : content;
                message += `✓ File read: ${filePath}\nContent:\n${truncatedContent}\n`;
            } else if (skillName === 'list_directory') {
                const dirPath = result.dirPath || result.data?.dirPath || 'directory';
                const files = result.files || result.data?.files || [];
                const recursive = result.recursive || result.data?.recursive;
                const truncated = result.truncated || result.data?.truncated;
                // Include actual file names so AI knows what's in the directory.
                // Recursive trees get newlines (not commas) so the model can
                // reason about paths — and we cap the payload at ~4 KB to stay
                // under the chunking threshold on big repos.
                const rendered = files.map(f => f.isDirectory ? `${f.name}/` : f.name);
                const joiner = recursive ? '\n' : ', ';
                let body = rendered.join(joiner);
                if (body.length > 4000) body = body.slice(0, 4000) + '\n... (truncated for prompt size)';
                const scope = recursive ? ' (recursive)' : '';
                message += `✓ Directory listed${scope}: ${dirPath}\nFiles (${files.length}):\n${body || '(empty)'}\n`;
                if (truncated) message += `[tree walk stopped at the entry cap — ask the user to narrow scope if they need more]\n`;
            } else if (skillName === 'move_file') {
                const newPath = result.newPath || result.data?.newPath || 'moved';
                message += `✓ File moved to: ${newPath}\n`;
            } else if (skillName === 'append_to_file') {
                const path = result.filePath || result.data?.filePath || 'file';
                const bytes = result.bytesAdded || result.data?.bytesAdded || 0;
                message += `✓ Appended ${bytes} bytes to: ${path}\n`;
            } else if (skillName === 'tail_file' || skillName === 'head_file') {
                const filePath = result.filePath || result.data?.filePath || 'file';
                const content = result.content || result.data?.content || '';
                const lines = result.linesReturned || result.data?.linesReturned || 0;
                // Include actual content so AI knows what's in the file
                const truncatedContent = content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content;
                message += `✓ ${skillName}: ${filePath} (${lines} lines)\nContent:\n${truncatedContent}\n`;
            } else if (skillName === 'list_processes') {
                const count = result.count || result.data?.count || 0;
                const platform = result.platform || result.data?.platform || 'system';
                const procs = result.processes || result.data?.processes || [];
                // Include top processes so AI can analyze them
                const topProcs = procs.slice(0, 30).map(p =>
                    `PID:${p.pid} | ${p.name} | CPU:${p.cpu_percent}% | Mem:${p.memory_mb}MB`
                ).join('\n');
                message += `✓ Listed ${count} processes on ${platform}\n${topProcs}\n`;
            } else if (skillName === 'kill_process') {
                const killed = result.killed || result.data?.killed || [];
                const desc = killed.map(k => k.pid ? `PID ${k.pid}` : k.name).join(', ');
                message += `✓ Killed process: ${desc}\n`;
            } else if (skillName === 'start_process') {
                const pid = result.pid || result.data?.pid;
                const command = result.command || result.data?.command || '';
                message += `✓ Started process: ${command} (PID: ${pid})\n`;
            } else if (skillName === 'system_info') {
                const platform = result.platform || result.data?.platform || 'system';
                const memPercent = result.memory?.percent || result.data?.memory?.percent || 0;
                message += `✓ System info: ${platform}, memory ${memPercent}% used\n`;
            } else if (skillName === 'disk_usage') {
                const path = result.path || result.data?.path || '/';
                const percent = result.percent || result.data?.percent || 0;
                message += `✓ Disk usage: ${path} at ${percent}%\n`;
            } else if (skillName === 'get_uptime') {
                const formatted = result.uptime_formatted || result.data?.uptime_formatted || '';
                message += `✓ Uptime: ${formatted}\n`;
            } else if (skillName === 'list_ports') {
                const count = result.count || result.data?.count || 0;
                message += `✓ Listed ${count} open ports\n`;
            } else if (skillName === 'list_services') {
                const count = result.count || result.data?.count || 0;
                message += `✓ Listed ${count} services\n`;
            } else if (skillName === 'git_status') {
                const branch = result.branch || result.data?.branch || '';
                const clean = result.clean || result.data?.clean;
                message += `✓ Git status: ${branch} (${clean ? 'clean' : 'has changes'})\n`;
            } else if (skillName === 'git_diff') {
                const hasChanges = result.hasChanges || result.data?.hasChanges;
                const diff = result.diff || result.data?.diff || '';
                // Include actual diff so AI knows what changed
                const truncatedDiff = diff.length > 3000 ? diff.substring(0, 3000) + '\n... (truncated)' : diff;
                message += `✓ Git diff: ${hasChanges ? 'changes found' : 'no changes'}\n${truncatedDiff}\n`;
            } else if (skillName === 'git_log') {
                const commits = result.commits || result.data?.commits || [];
                // Include actual commit info
                const commitList = commits.slice(0, 20).map(c => `${c.hash} ${c.message}`).join('\n');
                message += `✓ Git log: ${commits.length} commits\n${commitList}\n`;
            } else if (skillName === 'git_branch') {
                const current = result.current || result.data?.current || '';
                message += `✓ Git branch: ${current}\n`;
            } else if (skillName === 'get_env_var') {
                const name = result.name || result.data?.name || '';
                const exists = result.exists || result.data?.exists;
                message += `✓ Env var ${name}: ${exists ? 'found' : 'not set'}\n`;
            } else if (skillName === 'set_env_var') {
                const name = result.name || result.data?.name || '';
                message += `✓ Set env var: ${name}\n`;
            } else if (skillName === 'which_command') {
                const command = result.command || result.data?.command || '';
                const found = result.found || result.data?.found;
                message += `✓ which ${command}: ${found ? 'found' : 'not found'}\n`;
            } else if (skillName === 'create_pdf') {
                const path = result.outputPath || result.data?.outputPath || 'document.pdf';
                const fallback = result.fallback || result.data?.fallback;
                if (fallback) {
                    message += `✓ Created HTML report (PDF converters not installed on system): ${path}\n`;
                } else {
                    message += `✓ PDF created: ${path}\n`;
                }
            } else if (skillName === 'html_to_pdf') {
                const path = result.outputPath || result.data?.outputPath || 'output.pdf';
                message += `✓ HTML converted to PDF: ${path}\n`;
            } else if (skillName === 'markdown_to_html') {
                const path = result.outputPath || result.data?.outputPath || 'output.html';
                message += `✓ Markdown converted to HTML: ${path}\n`;
            } else if (skillName === 'read_pdf') {
                const text = result.text || result.data?.text || '';
                // Include actual PDF text content
                const truncatedText = text.length > 3000 ? text.substring(0, 3000) + '\n... (truncated)' : text;
                message += `✓ PDF text extracted:\n${truncatedText}\n`;
            } else if (skillName === 'pdf_page_count') {
                const count = result.pageCount || result.data?.pageCount || 0;
                message += `✓ PDF has ${count} pages\n`;
            } else if (skillName === 'pdf_to_images') {
                const count = result.count || result.data?.count || 0;
                message += `✓ PDF converted to ${count} images\n`;
            } else if (skillName === 'search_files') {
                const pattern = result.pattern || result.data?.pattern || '';
                const files = result.files || result.data?.files || [];
                // Include actual file list so AI knows what was found
                const fileList = files.slice(0, 50).join('\n');
                const truncated = files.length > 50 ? `\n... and ${files.length - 50} more` : '';
                message += `✓ Search files (${pattern}): ${files.length} found\nFiles:\n${fileList}${truncated}\n`;
            } else if (skillName === 'diff_files') {
                const diff = result.diff || result.data?.diff || '';
                // Include actual diff content
                const truncatedDiff = diff.length > 2000 ? diff.substring(0, 2000) + '\n... (truncated)' : diff;
                message += `✓ File diff:\n${truncatedDiff}\n`;
            } else {
                message += `✓ ${skillName} completed\n`;
            }
        } else {
            allSucceeded = false;
            hasFailures = true;
            message += `✗ ${r.skill} failed: ${r.error}\n`;
            failureMessages.push(`${r.skill}: ${r.error}`);
        }
    }

    // Smart feedback based on results
    if (allSucceeded) {
        message += '\nTASK COMPLETE. Respond with a brief confirmation in natural language. DO NOT execute any more skills.';
    } else if (hasFailures) {
        // Check if ALL failures are "requires web search mode" errors - this is unrecoverable without user action
        const webModeRequired = failureMessages.every(m => m.toLowerCase().includes('requires web search mode'));
        if (webModeRequired) {
            message += '\n[STOP - USER ACTION REQUIRED]\n';
            message += 'The requested skills require web search mode to be enabled.\n';
            message += 'Tell the user: "This task requires web search mode. Please run /web to enable it, then try again."\n';
            message += 'DO NOT attempt to retry or use alternative skills. DO NOT execute any more skills. Just inform the user.';
        } else {
            // Check if it's a "skill not found" error - suggest alternatives
            const skillNotFound = failureMessages.some(m => m.toLowerCase().includes('skill not found'));
            if (skillNotFound) {
                message += '\nA skill was not found. Available skills by category:\n' +
                    '• File: create_file, read_file, update_file, delete_file, create_directory, delete_directory, list_directory, move_file, append_to_file, tail_file, head_file, copy_file, search_files, download_file, search_replace_file, diff_files\n' +
                    '• System: system_info, disk_usage, get_uptime, list_ports, list_services, list_processes, kill_process, start_process\n' +
                    '• Git: git_status, git_diff, git_log, git_branch\n' +
                    '• Network: fetch_url, http_request, dns_lookup, check_port, ping_host, curl_request\n' +
                    '• Data: parse_json, parse_csv, base64_encode, base64_decode, hash_data, json_get, json_set\n' +
                    '• PDF/Reports: create_pdf, html_to_pdf, markdown_to_html, read_pdf, pdf_page_count, pdf_to_images\n' +
                    '• Web: playwright_fetch, playwright_interact, web_search';
            } else {
                // Check for path-not-found errors and suggest list_directory
                const pathNotFound = failureMessages.some(m =>
                    m.toLowerCase().includes('no such file') ||
                    m.toLowerCase().includes('enoent') ||
                    m.toLowerCase().includes('does not exist')
                );
                if (pathNotFound) {
                    message += '\nThe path was not found. IMPORTANT: Use list_directory to find the correct file/folder name before retrying. The user may have specified an approximate name.';
                } else {
                    message += '\nSome skills failed. You may try to fix the issue, or explain the error to the user.';
                }
            }
        }
    }

    return message;
}

// Build user-visible skill results (shown in chat history)
function buildUserVisibleSkillResults(results) {
    if (!results || results.length === 0) return '';

    // Filter for skills that have meaningful data to show
    const meaningfulResults = results.filter(r => {
        if (!r.success) return true; // Show failures
        const skillName = r.skill;
        // Skills that produce meaningful output worth showing to user
        return ['read_file', 'list_directory', 'git_diff', 'git_log',
                'search_files', 'diff_files', 'read_pdf', 'web_search', 'dns_lookup',
                'system_info', 'list_processes', 'list_ports', 'list_services',
                'tail_file', 'head_file', 'git_status', 'git_branch'].includes(skillName);
    });

    if (meaningfulResults.length === 0) return '';

    let output = '';

    for (const r of meaningfulResults) {
        if (!r.success) {
            output += `Error: ${r.skill} - ${r.error}\n`;
            continue;
        }

        const skillName = r.skill;
        const result = r.result;

        if (skillName === 'read_file') {
            const filePath = result.filePath || result.data?.filePath || 'file';
            const content = result.content || result.data?.content || '';
            output += `\n📄 File: ${filePath}\n`;
            output += '─'.repeat(40) + '\n';
            // Show first 2000 chars
            output += content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content;
            output += '\n';
        } else if (skillName === 'list_directory') {
            const dirPath = result.dirPath || result.data?.dirPath || 'directory';
            const files = result.files || result.data?.files || [];
            const recursive = result.recursive || result.data?.recursive;
            const truncated = result.truncated || result.data?.truncated;
            const scope = recursive ? ' (recursive)' : '';
            output += `\n📁 Directory: ${dirPath} (${files.length} items${scope})\n`;
            output += '─'.repeat(40) + '\n';
            // Recursive trees get a bigger default cut — a 2-item top-level
            // listing shouldn't truncate to 30 when the tree has hundreds.
            const maxShown = recursive ? 100 : 30;
            const fileList = files.slice(0, maxShown)
                .map(f => f.isDirectory ? `${f.name}/` : f.name)
                .join('\n');
            output += fileList || '(empty)';
            if (files.length > maxShown) output += `\n... and ${files.length - maxShown} more`;
            if (truncated) output += `\n(tree truncated at ${files.length} entries — narrow the scope to see more)`;
            output += '\n';
        } else if (skillName === 'git_diff') {
            const diff = result.diff || result.data?.diff || '';
            if (diff) {
                output += '\n📝 Git Diff:\n';
                output += '─'.repeat(40) + '\n';
                output += diff.length > 2000 ? diff.substring(0, 2000) + '\n... (truncated)' : diff;
                output += '\n';
            }
        } else if (skillName === 'git_log') {
            const commits = result.commits || result.data?.commits || [];
            output += `\n📜 Git Log (${commits.length} commits):\n`;
            output += '─'.repeat(40) + '\n';
            const commitList = commits.slice(0, 10).map(c => `${c.hash?.substring(0, 7) || ''} ${c.message || ''}`).join('\n');
            output += commitList || '(no commits)';
            output += '\n';
        } else if (skillName === 'search_files') {
            const pattern = result.pattern || result.data?.pattern || '';
            const files = result.files || result.data?.files || [];
            output += `\n🔍 Search: "${pattern}" (${files.length} results)\n`;
            output += '─'.repeat(40) + '\n';
            const fileList = files.slice(0, 20).join('\n');
            output += fileList || '(no matches)';
            if (files.length > 20) output += `\n... and ${files.length - 20} more`;
            output += '\n';
        } else if (skillName === 'dns_lookup') {
            const domain = result.domain || result.data?.domain || '';
            const addresses = result.addresses || result.data?.addresses || [];
            output += `\n🌐 DNS Lookup: ${domain}\n`;
            output += '─'.repeat(40) + '\n';
            output += `Addresses: ${addresses.join(', ') || 'none'}\n`;
        } else if (skillName === 'web_search') {
            const query = result.query || result.data?.query || '';
            const searchResults = result.results || result.data?.results || [];
            const termWidth = getTerminalWidth();
            const width = Math.max(50, Math.min(termWidth - 4, 110));

            output += `\n🔎 Web Search  ${colorize('"' + query + '"', 'cyan')}  ${colorize(`(${searchResults.length} results)`, 'dim')}\n`;
            output += colorize('─'.repeat(width), 'dim') + '\n';

            const top = searchResults.slice(0, 5);
            top.forEach((sr, idx) => {
                const num = String(idx + 1).padStart(2);
                const title = (sr.title || 'No title').trim();
                // Header line: number + title wrapped to full width
                output += colorize(num + '. ', 'cyan') +
                    wrapAnsiLine(colorize(title, 'white'), width, '', '    ') + '\n';

                // Snippet: show up to ~280 chars, wrapped with hanging indent.
                // The previous cap of 150 chars was cutting off right when
                // the interesting bit started; 2-3 wrapped lines is about
                // right in a terminal.
                const snippetRaw = (sr.snippet || sr.description || '').trim();
                if (snippetRaw) {
                    const snippet = snippetRaw.length > 280
                        ? snippetRaw.substring(0, 277).replace(/\s+\S*$/, '') + '…'
                        : snippetRaw;
                    output += wrapAnsiLine(colorize(snippet, 'dim'), width, '    ', '    ') + '\n';
                }

                // URL — underlined dim so it's clearly a link but doesn't
                // steal the eye from the title.
                const url = sr.url || sr.link || '';
                if (url) {
                    output += colorize('    \x1b[4m' + url + '\x1b[24m', 'dim') + '\n';
                }
                if (idx < top.length - 1) output += '\n';
            });

            output += colorize('─'.repeat(width), 'dim') + '\n';
            if (searchResults.length > top.length) {
                output += colorize(`    … and ${searchResults.length - top.length} more result${searchResults.length - top.length === 1 ? '' : 's'}\n`, 'dim');
            }
        } else if (skillName === 'list_processes') {
            const procs = result.processes || result.data?.processes || [];
            const count = result.count || result.data?.count || procs.length;
            const platform = result.platform || result.data?.platform || 'system';
            output += `\n⚙️  Process List (${count} processes on ${platform})\n`;
            output += '━'.repeat(72) + '\n';
            // Table header
            output += `  ${'PID'.padEnd(8)} ${'PROCESS'.padEnd(30)} ${'CPU %'.padStart(7)} ${'MEMORY'.padStart(10)}\n`;
            output += '─'.repeat(72) + '\n';
            // Process rows with visual indicators
            const displayProcs = procs.slice(0, 30);
            for (const p of displayProcs) {
                const cpuStr = (p.cpu_percent || 0).toFixed(1).padStart(6);
                const memStr = (p.memory_mb >= 1024
                    ? `${(p.memory_mb / 1024).toFixed(1)} GB`
                    : `${p.memory_mb} MB`).padStart(9);
                const name = (p.name || 'unknown').substring(0, 29).padEnd(30);
                const pid = String(p.pid || 0).padEnd(8);
                // Highlight high CPU/memory
                const cpuHigh = (p.cpu_percent || 0) > 50;
                const memHigh = (p.memory_mb || 0) > 1024;
                const marker = cpuHigh || memHigh ? '▸' : ' ';
                output += `${marker} ${pid} ${name} ${cpuStr}% ${memStr}\n`;
            }
            if (count > 30) {
                output += `  ... and ${count - 30} more processes\n`;
            }
            output += '━'.repeat(72) + '\n';
            // Summary stats
            const totalMem = procs.reduce((sum, p) => sum + (p.memory_mb || 0), 0);
            const totalCpu = procs.reduce((sum, p) => sum + (p.cpu_percent || 0), 0);
            output += `  Total: ${count} processes | CPU: ${totalCpu.toFixed(1)}% | Memory: ${totalMem >= 1024 ? (totalMem / 1024).toFixed(1) + ' GB' : totalMem + ' MB'}\n`;
        } else if (skillName === 'system_info') {
            const plat = result.platform || result.data?.platform || os.platform();
            const hostname = result.hostname || result.data?.hostname || os.hostname();
            const cpuModel = result.cpu?.model || result.data?.cpu?.model || '';
            const cpuCores = result.cpu?.cores || result.data?.cpu?.cores || os.cpus().length;
            const memTotal = result.memory?.total_mb || result.data?.memory?.total_mb || 0;
            const memUsed = result.memory?.used_mb || result.data?.memory?.used_mb || 0;
            const memPercent = result.memory?.percent || result.data?.memory?.percent || 0;
            output += `\n💻 System Information\n`;
            output += '━'.repeat(50) + '\n';
            output += `  Hostname:  ${hostname}\n`;
            output += `  Platform:  ${plat}\n`;
            if (cpuModel) output += `  CPU:       ${cpuModel}\n`;
            output += `  Cores:     ${cpuCores}\n`;
            output += `  Memory:    ${memUsed >= 1024 ? (memUsed/1024).toFixed(1) + ' GB' : memUsed + ' MB'} / ${memTotal >= 1024 ? (memTotal/1024).toFixed(1) + ' GB' : memTotal + ' MB'} (${memPercent}%)\n`;
            output += '━'.repeat(50) + '\n';
        } else if (skillName === 'list_ports') {
            const ports = result.ports || result.data?.ports || [];
            const count = result.count || result.data?.count || ports.length;
            output += `\n🔌 Open Ports (${count})\n`;
            output += '━'.repeat(60) + '\n';
            output += `  ${'PORT'.padEnd(8)} ${'PROTO'.padEnd(6)} ${'STATE'.padEnd(12)} ${'PROCESS'.padEnd(20)}\n`;
            output += '─'.repeat(60) + '\n';
            for (const p of ports.slice(0, 30)) {
                const port = String(p.port || p.localPort || '').padEnd(8);
                const proto = (p.protocol || p.proto || 'tcp').padEnd(6);
                const state = (p.state || 'LISTEN').padEnd(12);
                const proc = (p.process || p.program || '-').substring(0, 19).padEnd(20);
                output += `  ${port} ${proto} ${state} ${proc}\n`;
            }
            if (count > 30) output += `  ... and ${count - 30} more\n`;
            output += '━'.repeat(60) + '\n';
        } else if (skillName === 'list_services') {
            const services = result.services || result.data?.services || [];
            const count = result.count || result.data?.count || services.length;
            output += `\n🔧 Services (${count})\n`;
            output += '━'.repeat(60) + '\n';
            output += `  ${'SERVICE'.padEnd(30)} ${'STATUS'.padEnd(12)} ${'PID'.padEnd(8)}\n`;
            output += '─'.repeat(60) + '\n';
            for (const s of services.slice(0, 25)) {
                const name = (s.name || s.service || '').substring(0, 29).padEnd(30);
                const status = (s.status || s.state || '-').padEnd(12);
                const pid = String(s.pid || '-').padEnd(8);
                output += `  ${name} ${status} ${pid}\n`;
            }
            if (count > 25) output += `  ... and ${count - 25} more\n`;
            output += '━'.repeat(60) + '\n';
        } else if (skillName === 'git_status') {
            const branch = result.branch || result.data?.branch || '';
            const clean = result.clean || result.data?.clean;
            const staged = result.staged || result.data?.staged || [];
            const modified = result.modified || result.data?.modified || [];
            const untracked = result.untracked || result.data?.untracked || [];
            output += `\n📋 Git Status: ${branch}\n`;
            output += '─'.repeat(40) + '\n';
            if (clean) {
                output += '  Working tree clean\n';
            } else {
                if (staged.length) output += `  Staged:    ${staged.join(', ')}\n`;
                if (modified.length) output += `  Modified:  ${modified.join(', ')}\n`;
                if (untracked.length) output += `  Untracked: ${untracked.join(', ')}\n`;
            }
        } else if (skillName === 'git_branch') {
            const current = result.current || result.data?.current || '';
            const branches = result.branches || result.data?.branches || [];
            output += `\n🌿 Git Branches (current: ${current})\n`;
            output += '─'.repeat(40) + '\n';
            for (const b of branches.slice(0, 15)) {
                const marker = b === current ? '▸ ' : '  ';
                output += `${marker}${b}\n`;
            }
        } else if (skillName === 'tail_file' || skillName === 'head_file') {
            const filePath = result.filePath || result.data?.filePath || 'file';
            const content = result.content || result.data?.content || '';
            const lines = result.linesReturned || result.data?.linesReturned || 0;
            const label = skillName === 'tail_file' ? 'Tail' : 'Head';
            output += `\n📄 ${label}: ${filePath} (${lines} lines)\n`;
            output += '─'.repeat(40) + '\n';
            output += content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content;
            output += '\n';
        }
    }

    return output.trim();
}

// Check if response contains only skill calls (no substantial text)
function isOnlySkillCalls(response) {
    // Remove skill calls from response
    let cleaned = response
        .replace(/\[SKILL:\w+\([^\]]*\)\]/g, '')
        .replace(/```json\s*\n?\s*\{[\s\S]*?"skill"[\s\S]*?\}\s*\n?```/g, '')
        .replace(/\{"skill"\s*:\s*"\w+"\s*,\s*"params"\s*:\s*\{[^}]+\}\}/g, '')
        .trim();

    // If what remains is very short or just punctuation/whitespace, it's primarily skill calls
    return cleaned.length < 50;
}

// ============================================================================
// END SKILL CALLING FRAMEWORK
// ============================================================================

// File system helpers
function scanDirectory(dir, maxDepth = 2, currentDepth = 0) {
    const files = [];
    if (currentDepth >= maxDepth) return files;

    try {
        const items = fsSync.readdirSync(dir);
        for (const item of items) {
            // Skip common ignore patterns
            if (item.startsWith('.') || item === 'node_modules' || item === 'dist' || item === 'build') {
                continue;
            }

            const fullPath = path.join(dir, item);
            const stat = fsSync.statSync(fullPath);

            if (stat.isDirectory()) {
                files.push({ path: fullPath, type: 'directory', name: item });
                files.push(...scanDirectory(fullPath, maxDepth, currentDepth + 1));
            } else {
                files.push({ path: fullPath, type: 'file', name: item, size: stat.size });
            }
        }
    } catch (error) {
        // Silently skip inaccessible directories
    }

    return files;
}

function readProjectFiles(cwd) {
    const projectInfo = {
        files: [],
        structure: {},
        keyFiles: []
    };

    // Standard project-root markers. Deliberately excludes koda.md —
    // that's our *own* output from a prior /init, and treating it as a
    // marker made /init analyze its own previous analysis (endless
    // tautology: "this project is a documentation file containing an
    // automated analysis report of a web-based prototype…").
    const keyFileNames = [
        'README.md', 'README', 'README.txt',
        'AGENTS.md', 'CLAUDE.md',
        'package.json', 'requirements.txt', 'pyproject.toml',
        'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
        'Makefile', 'makefile',
        'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
        '.gitignore', 'tsconfig.json'
    ];
    // Files that /init must ignore entirely — both when deciding what
    // to feed the AI *and* when tallying the file counts in koda.md,
    // so a second run doesn't list koda.md as "1 file" of the project.
    const IGNORED_FILES = new Set(['koda.md']);
    const MAX_KEY_FILE_CHARS = 5000;
    const MAX_SOURCE_FALLBACK = 5;         // files to pull in when no markers
    const MAX_SOURCE_CHARS = 4000;         // per source file
    // Source extensions we'll read as fallback when the project has no
    // standard marker files — covers single-file scripts / static pages
    // where the "project" is literally just main.py, snake.html, etc.
    const SOURCE_EXTS = new Set([
        '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
        '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp',
        '.h', '.hpp', '.cs', '.php', '.sh', '.bash', '.ps1',
        '.css', '.scss', '.sass',
        '.sql', '.yaml', '.yml', '.toml', '.ini',
        '.md', '.mdx'
    ]);

    // Filter out koda.md etc. from every file-facing path so /init
    // doesn't count, describe, or re-analyze its own prior output.
    const allFiles = scanDirectory(cwd).filter(f => !IGNORED_FILES.has(f.name));
    projectInfo.files = allFiles;

    // Pass 1: named key files in the project root.
    for (const fileName of keyFileNames) {
        const filePath = path.join(cwd, fileName);
        if (fsSync.existsSync(filePath)) {
            try {
                const content = fsSync.readFileSync(filePath, 'utf8');
                projectInfo.keyFiles.push({
                    name: fileName,
                    path: filePath,
                    content: content.substring(0, MAX_KEY_FILE_CHARS)
                });
            } catch { /* skip unreadable */ }
        }
    }

    // Pass 2: always pull in a handful of actual source files too, so
    // the AI sees project *contents* — not just a one-line README that
    // says "hello world". Previously this ran only when no markers
    // existed, which meant a repo with just a README got analysed with
    // zero source context and produced generic descriptions.
    const sourceFiles = allFiles
        .filter(f => f.type === 'file' && SOURCE_EXTS.has(path.extname(f.name).toLowerCase()))
        .sort((a, b) => (b.size || 0) - (a.size || 0))
        .slice(0, MAX_SOURCE_FALLBACK);

    const alreadyLoaded = new Set(projectInfo.keyFiles.map(f => f.path));
    for (const f of sourceFiles) {
        if (alreadyLoaded.has(f.path)) continue;
        try {
            const content = fsSync.readFileSync(f.path, 'utf8');
            projectInfo.keyFiles.push({
                name: path.relative(cwd, f.path),
                path: f.path,
                content: content.substring(0, MAX_SOURCE_CHARS),
                isSource: true
            });
        } catch { /* skip unreadable */ }
    }

    return projectInfo;
}

// Command handlers
async function handleAuth() {
    log('\nAuthentication Setup\n', 'cyan');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const question = (prompt) => new Promise((resolve) => {
        rl.question(prompt, resolve);
    });

    try {
        const apiUrl = await question('API URL (default: https://localhost:3001): ');
        const apiKey = await question('API Key: ');
        const apiSecret = await question('API Secret: ');

        const config = {
            apiUrl: (apiUrl.trim() || 'https://localhost:3001'),
            apiKey: apiKey.trim(),
            apiSecret: apiSecret.trim()
        };

        // Test connection (quietly)
        logDim('Testing connection...');
        const api = new AgentAPI(config.apiUrl, config.apiKey, config.apiSecret);
        const result = await api.getAgents();

        if (result.success) {
            saveConfig(config);
            logSuccess('Authentication configured successfully');
            logDim(`Config saved to ${CONFIG_FILE}\n`);
        } else {
            logError(`Connection failed: ${result.error}`);
            logDim('Configuration not saved.\n');
        }
    } finally {
        rl.close();
    }
}

async function handleInit(api) {
    log('\nInitializing project understanding...\n', 'cyan');

    const cwd = process.cwd();
    const projectName = path.basename(cwd);

    // Scan project
    logInfo('Scanning project files...');
    const projectInfo = readProjectFiles(cwd);

    logInfo(`Found ${projectInfo.files.length} files`);
    logInfo(`Found ${projectInfo.keyFiles.length} key files\n`);

    // Generate koda.md content
    let kodaContent = `# ${projectName}\n\n`;
    kodaContent += `Project analyzed on ${new Date().toISOString()}\n\n`;

    // Key files list (no content dump — the model can read_file on demand).
    // Dumping 5 KB of every key file blew past small-context models and got
    // re-injected every turn via the working-set. Keep koda.md as a
    // structured summary only.
    if (projectInfo.keyFiles.length > 0) {
        kodaContent += `## Key Files\n\n`;
        for (const file of projectInfo.keyFiles) {
            const lineCount = (file.content.match(/\n/g) || []).length + 1;
            kodaContent += `- \`${file.name}\` (${file.content.length} chars, ${lineCount} lines)\n`;
        }
        kodaContent += `\n`;
    }

    // Add file structure
    kodaContent += `## Project Structure\n\n`;
    const directories = projectInfo.files.filter(f => f.type === 'directory');
    const files = projectInfo.files.filter(f => f.type === 'file');

    kodaContent += `- Directories: ${directories.length}\n`;
    kodaContent += `- Files: ${files.length}\n\n`;

    // Group files by extension
    const filesByExt = {};
    for (const file of files) {
        const ext = path.extname(file.name) || 'no extension';
        if (!filesByExt[ext]) filesByExt[ext] = [];
        filesByExt[ext].push(file.name);
    }

    kodaContent += `### Files by Type\n\n`;
    for (const [ext, fileList] of Object.entries(filesByExt)) {
        kodaContent += `**${ext}** (${fileList.length} files)\n`;
    }

    // Ask AI for analysis if configured. Include the *content* of the
    // key / source files (truncated) so the model can actually see what
    // the project does, not just its filenames — on a single-file project
    // like a snake.html game, names alone leave the model guessing.
    if (api) {
        logInfo('Analyzing project with AI...');

        const fileNameList = projectInfo.keyFiles.map(f => `- ${f.name}`).join('\n') || '(none)';
        // Budget ~10 KB total across files so we don't blow past context
        // on big readmes. Each file is already capped in readProjectFiles.
        const CONTENT_BUDGET = 10000;
        let used = 0;
        const contentParts = [];
        for (const f of projectInfo.keyFiles) {
            if (used >= CONTENT_BUDGET) break;
            const slice = f.content.slice(0, Math.max(400, CONTENT_BUDGET - used));
            const ext = path.extname(f.name).slice(1) || '';
            contentParts.push(`### ${f.name}\n\`\`\`${ext}\n${slice}${f.content.length > slice.length ? '\n… (truncated)' : ''}\n\`\`\``);
            used += slice.length;
        }
        const fileContents = contentParts.length > 0
            ? `\n\nFile contents:\n\n${contentParts.join('\n\n')}`
            : '';

        const analysisPrompt =
            `I'm analyzing a project called "${projectName}". Here's what I found:\n\n` +
            `Files (${projectInfo.files.filter(f => f.type === 'file').length} total, ` +
            `${projectInfo.files.filter(f => f.type === 'directory').length} directories):\n${fileNameList}\n\n` +
            `File types: ${Object.keys(filesByExt).join(', ')}` +
            fileContents +
            `\n\nBased on the files above (names AND contents), write a 2–4 sentence summary describing what this project actually is and does. Be concrete: mention the tech stack, the entry point, and the user-facing purpose. Do NOT hedge with phrases like "appears to be" — just describe it from what you can see.`;

        try {
            const result = await api.chat(analysisPrompt);

            if (result.success) {
                kodaContent += `\n## AI Analysis\n\n${result.data.response}\n`;
                log('\n' + result.data.response + '\n', 'white');
            } else {
                // Surface the real error instead of the "no models loaded"
                // boilerplate — half the time it's actually an auth or
                // routing issue, and the blanket message hid that.
                logDim(`AI analysis skipped: ${result.error || 'unknown error'}\n`);
            }
        } catch (error) {
            logDim(`AI analysis failed: ${error.message || 'timeout'}\n`);
        }
    }

    // Write koda.md and seed the working set so this turn's analysis
    // is available to every follow-up query without needing /add-file.
    const kodaPath = path.join(cwd, 'koda.md');
    fsSync.writeFileSync(kodaPath, kodaContent);
    addToWorkingSet(kodaPath, kodaContent);

    // Also seed the actual source files. Working-files context emits a
    // peek manifest (first 20 lines + line count), so this is cheap and
    // lets the model act on "the snake game" without inventing a new one.
    // Keep headroom in MAX_WORKING_FILES for files the user /add-files later.
    const SEED_LIMIT = 10;
    let seeded = 0;
    for (const f of projectInfo.keyFiles) {
        if (seeded >= SEED_LIMIT) break;
        if (f.path === kodaPath) continue;
        if (addToWorkingSet(f.path)) seeded++;
    }

    logSuccess(`Project understanding saved to koda.md`);
    logDim(`File: ${kodaPath}\n`);

    // Persist a marker in chat history so the context remains visible
    // after the next displayChatHistory() redraw.
    addToHistory('system', `/init complete — wrote koda.md (${files.length} files, ${directories.length} dirs), seeded ${seeded} source file${seeded === 1 ? '' : 's'} into the working set`);
}

async function handleHelp() {
    addToHistory('system', '━━━ Available Commands ━━━');
    addToHistory('system', '');
    addToHistory('system', colorize('Setup & Configuration:', 'yellow'));
    addToHistory('system', '  /auth              Authenticate with API credentials');
    addToHistory('system', '  /init              Analyze project and create koda.md context');
    addToHistory('system', '  /project <name>    Create a project directory structure');
    addToHistory('system', '  /cwd               Show current working directory');
    addToHistory('system', '');
    addToHistory('system', colorize('Search:', 'yellow'));
    addToHistory('system', '  /web               Toggle web search on/off ' + (websearchMode ? colorize('(ON)', 'green') : colorize('(off)', 'dim')));
    addToHistory('system', '');
    addToHistory('system', colorize('Session Management:', 'yellow'));
    addToHistory('system', '  /clear             Clear chat history');
    addToHistory('system', '  /clearsession      Clear session context (keeps history visible)');
    addToHistory('system', '  /quit              Exit koda');
    addToHistory('system', '');
    addToHistory('system', colorize('Tips:', 'cyan'));
    addToHistory('system', colorize('  • Type / and press Tab to cycle through commands', 'dim'));
    addToHistory('system', colorize('  • Commands show grayed suggestions as you type', 'dim'));
    addToHistory('system', colorize('  • Koda has tools for files, code, web search - just ask!', 'dim'));
    displayChatHistory();
}

async function handleProject(args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /project <name>');
        addToHistory('system', 'Examples: /project my_app, /project data_analysis, /project website');
        displayChatHistory();
        return;
    }

    const projectName = args.join('_').replace(/[^a-zA-Z0-9_-]/g, '');
    const projectPath = path.join(userWorkingDirectory, projectName);

    try {
        // Create project directory
        if (!fsSync.existsSync(projectPath)) {
            fsSync.mkdirSync(projectPath, { recursive: true });
            addToHistory('system', `✓ Project directory created: ${colorize('./' + projectName, 'green')}`);
            addToHistory('system', `  Full path: ${projectPath}`);
            addToHistory('system', '');
            addToHistory('system', 'Koda will create files in this directory when you ask.');
        } else {
            addToHistory('system', `Project directory already exists: ${colorize('./' + projectName, 'yellow')}`);
        }
    } catch (error) {
        addToHistory('system', `✗ Failed to create project directory: ${error.message}`);
    }

    displayChatHistory();
}

async function handleCwd() {
    addToHistory('system', `Current working directory: ${colorize(userWorkingDirectory, 'cyan')}`);
    const files = fsSync.readdirSync(userWorkingDirectory).slice(0, 10);
    if (files.length > 0) {
        addToHistory('system', '');
        addToHistory('system', 'Contents (first 10 items):');
        files.forEach(file => {
            const fullPath = path.join(userWorkingDirectory, file);
            const isDir = fsSync.statSync(fullPath).isDirectory();
            const icon = isDir ? '📁' : '📄';
            addToHistory('system', `  ${icon} ${file}`);
        });
    }
    displayChatHistory();
}

// Handle /files command - show working set
async function handleFiles() {
    addToHistory('system', '━━━ Working Files ━━━');
    if (workingFiles.size === 0) {
        addToHistory('system', 'No files in working set');
        addToHistory('system', 'Use /add-file <path> to add files to context');
    } else {
        addToHistory('system', `${workingFiles.size}/${MAX_WORKING_FILES} files in working set:`);
        addToHistory('system', '');
        addToHistory('system', getWorkingSetSummary());

        if (focusMode) {
            addToHistory('system', '');
            addToHistory('system', colorize('🎯 Focus mode enabled - only focused files in context', 'yellow'));
        }

        // Calculate total context size
        const totalSize = Array.from(workingFiles.values()).reduce((sum, info) => sum + info.size, 0);
        const totalKB = (totalSize / 1024).toFixed(1);
        addToHistory('system', '');
        addToHistory('system', `Total size: ${totalKB} KB (~${Math.ceil(totalSize / 4)} tokens)`);
    }
    displayChatHistory();
}

// Handle /add-file command
async function handleAddFile(args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /add-file <path>');
        addToHistory('system', 'Example: /add-file ./src/index.js');
        displayChatHistory();
        return;
    }

    const filePath = args.join(' ');
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    if (!fsSync.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const success = addToWorkingSet(absolutePath);
    if (success) {
        const relativePath = absolutePath.replace(userWorkingDirectory, '.');
        const fileInfo = workingFiles.get(absolutePath);
        const sizeKB = (fileInfo.size / 1024).toFixed(1);

        addToHistory('system', `✓ Added to working set: ${colorize(relativePath, 'green')} (${sizeKB} KB)`);

        // Detect imports and suggest related files
        const imports = detectImports(fileInfo.content, absolutePath);
        if (imports.length > 0) {
            addToHistory('system', '');
            addToHistory('system', 'Detected imports:');
            const notInWorkingSet = imports.filter(imp => !workingFiles.has(imp));
            if (notInWorkingSet.length > 0) {
                for (const imp of notInWorkingSet.slice(0, 5)) {
                    const relImp = imp.replace(userWorkingDirectory, '.');
                    addToHistory('system', `  ${relImp} (not in working set)`);
                }
                if (notInWorkingSet.length > 5) {
                    addToHistory('system', `  ... and ${notInWorkingSet.length - 5} more`);
                }
                addToHistory('system', '');
                addToHistory('system', 'Tip: Use /add-imports to add all detected imports');
            }
        }
    } else {
        addToHistory('system', `✗ Failed to add file: ${filePath}`);
    }

    displayChatHistory();
}

// Handle /remove-file command
async function handleRemoveFile(args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /remove-file <path>');
        displayChatHistory();
        return;
    }

    const filePath = args.join(' ');
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    if (workingFiles.has(absolutePath)) {
        removeFromWorkingSet(absolutePath);
        const relativePath = absolutePath.replace(userWorkingDirectory, '.');
        addToHistory('system', `✓ Removed from working set: ${relativePath}`);
    } else {
        addToHistory('system', `File not in working set: ${filePath}`);
    }

    displayChatHistory();
}

// Handle /focus command
async function handleFocus(args) {
    if (!args || args.length === 0) {
        // Toggle focus mode
        focusMode = !focusMode;
        if (focusMode) {
            if (focusFiles.size === 0) {
                addToHistory('system', '🎯 Focus mode enabled, but no files are focused');
                addToHistory('system', 'Use /focus <file> to focus on specific files');
            } else {
                addToHistory('system', `🎯 Focus mode enabled - only ${focusFiles.size} focused file(s) in context`);
            }
        } else {
            addToHistory('system', '✓ Focus mode disabled - all working files in context');
        }
        displayChatHistory();
        return;
    }

    // Add file to focus set
    const filePath = args.join(' ');
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    // Add to working set if not already there
    if (!workingFiles.has(absolutePath)) {
        if (fsSync.existsSync(absolutePath)) {
            addToWorkingSet(absolutePath);
        } else {
            addToHistory('system', `✗ File not found: ${filePath}`);
            displayChatHistory();
            return;
        }
    }

    focusFiles.add(absolutePath);
    const relativePath = absolutePath.replace(userWorkingDirectory, '.');
    addToHistory('system', `🎯 Focused on: ${colorize(relativePath, 'yellow')}`);

    // Update inFocus flag
    const fileInfo = workingFiles.get(absolutePath);
    if (fileInfo) {
        fileInfo.inFocus = true;
    }

    if (!focusMode) {
        addToHistory('system', 'Tip: Use /focus (no args) to enable focus mode');
// Handle /refactor command
async function handleRefactor(args) {
    if (!args || args.length === 0) {
        addToHistory('system', '━━━ Refactoring Tools ━━━');
        addToHistory('system', '');
        addToHistory('system', colorize('Available Commands:', 'yellow'));
        addToHistory('system', '/refactor extract <file> <start> <end> <funcName> - Extract code to function');
        addToHistory('system', '/refactor rename <file> <oldName> <newName> - Rename symbol across file');
        addToHistory('system', '/refactor move <source> <dest> <symbolName> - Move code between files');
        addToHistory('system', '');
        addToHistory('system', colorize('Examples:', 'cyan'));
        addToHistory('system', '/refactor extract app.js 10 20 handleClick');
        addToHistory('system', '/refactor rename utils.js oldFunc newFunc');
        addToHistory('system', '/refactor move app.js utils.js helperFunction');
        displayChatHistory();
        return;
    }

    const subCommand = args[0];

    try {
        switch (subCommand) {
            case 'extract':
                await handleRefactorExtract(args.slice(1));
                break;

            case 'rename':
                await handleRefactorRename(args.slice(1));
                break;

            case 'move':
                await handleRefactorMove(args.slice(1));
                break;

            default:
                addToHistory('system', `Unknown refactor command: ${subCommand}`);
                addToHistory('system', 'Use /refactor for help');
                displayChatHistory();
        }
    } catch (error) {
        addToHistory('system', colorize(`✗ Refactoring failed: ${error.message}`, 'red'));
        displayChatHistory();
    }
}

// Handle extract function refactoring
async function handleRefactorExtract(args) {
    if (args.length < 4) {
        addToHistory('system', 'Usage: /refactor extract <file> <start> <end> <funcName>');
        addToHistory('system', 'Example: /refactor extract app.js 10 20 handleClick');
        displayChatHistory();
        return;
    }

    const [filePath, startStr, endStr, functionName] = args;
    const startLine = parseInt(startStr);
    const endLine = parseInt(endStr);

    if (isNaN(startLine) || isNaN(endLine)) {
        addToHistory('system', '✗ Start and end must be line numbers');
        displayChatHistory();
        return;
    }

    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    if (!fsSync.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const content = fsSync.readFileSync(absolutePath, 'utf8');
    const result = extractFunction(content, absolutePath, startLine, endLine, functionName);

    // Show diff preview
    addToHistory('system', '━━━ Extract Function Preview ━━━');
    addToHistory('system', '');
    addToHistory('system', colorize('Function created:', 'green'));
    addToHistory('system', result.functionCode);
    addToHistory('system', '');
    addToHistory('system', colorize(`Parameters detected: ${result.parameters.length > 0 ? result.parameters.join(', ') : 'none'}`, 'cyan'));
    addToHistory('system', colorize(`Has return: ${result.hasReturn ? 'yes' : 'no'}`, 'cyan'));
    addToHistory('system', '');
    displayChatHistory();

    // Show full diff
    displayDiff(content, result.newContent, absolutePath);

    // Ask for confirmation
    const confirmed = await promptConfirmation('Apply this refactoring?');

    if (confirmed) {
        fsSync.writeFileSync(absolutePath, result.newContent, 'utf8');
        addToHistory('system', colorize(`✓ Function extracted to ${functionName}`, 'green'));

        // Add to working set if not already there
        addToWorkingSet(absolutePath, result.newContent);
    } else {
        addToHistory('system', 'Refactoring cancelled');
    }

    displayChatHistory();
}

// Handle rename symbol refactoring
async function handleRefactorRename(args) {
    if (args.length < 3) {
        addToHistory('system', 'Usage: /refactor rename <file> <oldName> <newName>');
        addToHistory('system', 'Example: /refactor rename utils.js oldFunc newFunc');
        displayChatHistory();
        return;
    }

    const [filePath, oldName, newName] = args;
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    if (!fsSync.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const content = fsSync.readFileSync(absolutePath, 'utf8');
    const result = renameSymbol(content, absolutePath, oldName, newName);

    // Show preview
    addToHistory('system', '━━━ Rename Symbol Preview ━━━');
    addToHistory('system', '');
    addToHistory('system', colorize(`Renaming: ${oldName} → ${newName}`, 'cyan'));
    addToHistory('system', colorize(`Found ${result.replacements} occurrence(s)`, 'yellow'));
    addToHistory('system', '');
    addToHistory('system', 'Locations:');
    result.locations.forEach(loc => {
        addToHistory('system', `  Line ${loc.line}, Column ${loc.column}`);
    });
    addToHistory('system', '');
    displayChatHistory();

    // Show diff
    displayDiff(content, result.newContent, absolutePath);

    // Ask for confirmation
    const confirmed = await promptConfirmation('Apply this refactoring?');

    if (confirmed) {
        fsSync.writeFileSync(absolutePath, result.newContent, 'utf8');
        addToHistory('system', colorize(`✓ Renamed ${result.replacements} occurrence(s) of ${oldName} to ${newName}`, 'green'));

        // Update working set
        addToWorkingSet(absolutePath, result.newContent);
    } else {
        addToHistory('system', 'Refactoring cancelled');
    }

    displayChatHistory();
}

// Handle move code refactoring
async function handleRefactorMove(args) {
    if (args.length < 3) {
        addToHistory('system', 'Usage: /refactor move <source> <dest> <symbolName>');
        addToHistory('system', 'Example: /refactor move app.js utils.js helperFunction');
        displayChatHistory();
        return;
    }

    const [sourcePath, destPath, symbolName] = args;
    const absoluteSourcePath = path.isAbsolute(sourcePath) ? sourcePath : path.join(userWorkingDirectory, sourcePath);
    const absoluteDestPath = path.isAbsolute(destPath) ? destPath : path.join(userWorkingDirectory, destPath);

    if (!fsSync.existsSync(absoluteSourcePath)) {
        addToHistory('system', `✗ Source file not found: ${sourcePath}`);
        displayChatHistory();
        return;
    }

    const sourceContent = fsSync.readFileSync(absoluteSourcePath, 'utf8');
    const result = moveCode(sourceContent, absoluteSourcePath, absoluteDestPath, symbolName);

    // Show preview
    addToHistory('system', '━━━ Move Code Preview ━━━');
    addToHistory('system', '');
    addToHistory('system', colorize(`Moving ${result.type}: ${symbolName}`, 'cyan'));
    addToHistory('system', colorize(`From: ${sourcePath} (lines ${result.startLine}-${result.endLine})`, 'yellow'));
    addToHistory('system', colorize(`To: ${destPath}`, 'yellow'));
    addToHistory('system', '');
    addToHistory('system', 'Code to move:');
    addToHistory('system', result.codeToMove);
    addToHistory('system', '');
    addToHistory('system', colorize('Import to add in source file:', 'cyan'));
    addToHistory('system', result.importLine);
    addToHistory('system', '');
    displayChatHistory();

    // Show source diff
    addToHistory('system', colorize('Changes to source file:', 'yellow'));
    displayDiff(sourceContent, result.newSourceContent, absoluteSourcePath);

    // Ask for confirmation
    const confirmed = await promptConfirmation('Apply this refactoring?');

    if (confirmed) {
        // Write both files
        fsSync.writeFileSync(absoluteSourcePath, result.newSourceContent, 'utf8');
        fsSync.writeFileSync(absoluteDestPath, result.newDestContent, 'utf8');

        addToHistory('system', colorize(`✓ Moved ${symbolName} to ${destPath}`, 'green'));
        addToHistory('system', colorize(`  Import added: ${result.importLine}`, 'dim'));

        // Update working sets
        addToWorkingSet(absoluteSourcePath, result.newSourceContent);
        addToWorkingSet(absoluteDestPath, result.newDestContent);
    } else {
        addToHistory('system', 'Refactoring cancelled');
    }

    displayChatHistory();
}
    }

    displayChatHistory();
}

// Handle /clear-focus command
async function handleClearFocus() {
    focusFiles.clear();
    focusMode = false;

    // Update all files
    for (const [filePath, info] of workingFiles.entries()) {
        info.inFocus = false;
    }

    addToHistory('system', '✓ Cleared all focused files and disabled focus mode');
    displayChatHistory();
}

// Handle /quality command - code quality analysis
async function handleQuality(args) {
    if (!args || args.length === 0) {
        // Analyze all files in working set
        if (workingFiles.size === 0) {
            addToHistory('system', 'No files in working set');
            addToHistory('system', 'Use /add-file <path> to add files, or /quality <file>');
            displayChatHistory();
            return;
        }

        addToHistory('system', '━━━ Code Quality Report ━━━');
        addToHistory('system', '');

        let totalIssues = 0;
        let totalTodos = 0;

        for (const [filePath, info] of workingFiles.entries()) {
            const relativePath = filePath.replace(userWorkingDirectory, '.');
            const metrics = analyzeCodeQuality(info.content, filePath);

            addToHistory('system', colorize(`📄 ${relativePath}`, 'cyan'));
            addToHistory('system', `  Lines: ${metrics.totalLines} (${metrics.codeLines} code, ${metrics.commentLines} comments, ${metrics.blankLines} blank)`);
            addToHistory('system', `  Functions: ${metrics.functions} | Classes: ${metrics.classes}`);
            addToHistory('system', `  Complexity: ${metrics.complexityScore}%`);

            if (metrics.todos.length > 0) {
                addToHistory('system', `  TODOs: ${metrics.todos.length}`);
                totalTodos += metrics.todos.length;
            }

            if (metrics.issues.length > 0) {
                addToHistory('system', colorize(`  ⚠️  Issues: ${metrics.issues.length}`, 'yellow'));
                for (const issue of metrics.issues) {
                    addToHistory('system', `     - ${issue}`);
                }
                totalIssues += metrics.issues.length;
            } else {
                addToHistory('system', colorize('  ✓ No issues found', 'green'));
            }

            addToHistory('system', '');
        }

        addToHistory('system', colorize('━━━ Summary ━━━', 'cyan'));
        addToHistory('system', `Total files analyzed: ${workingFiles.size}`);
        addToHistory('system', `Total issues: ${totalIssues}`);
        addToHistory('system', `Total TODOs: ${totalTodos}`);

        displayChatHistory();
        return;
    }

    // Analyze specific file
    const filePath = args.join(' ');
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(userWorkingDirectory, filePath);

    if (!fsSync.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const content = fsSync.readFileSync(absolutePath, 'utf8');
    const metrics = analyzeCodeQuality(content, absolutePath);
    const relativePath = absolutePath.replace(userWorkingDirectory, '.');

    addToHistory('system', '━━━ Code Quality Report ━━━');
    addToHistory('system', '');
    addToHistory('system', colorize(`📄 ${relativePath}`, 'cyan'));
    addToHistory('system', '');
    addToHistory('system', colorize('Metrics:', 'yellow'));
    addToHistory('system', `  Total lines: ${metrics.totalLines}`);
    addToHistory('system', `  Code lines: ${metrics.codeLines} (${(metrics.codeLines / metrics.totalLines * 100).toFixed(1)}%)`);
    addToHistory('system', `  Comment lines: ${metrics.commentLines} (${(metrics.commentLines / metrics.totalLines * 100).toFixed(1)}%)`);
    addToHistory('system', `  Blank lines: ${metrics.blankLines}`);
    addToHistory('system', `  Functions: ${metrics.functions}`);
    addToHistory('system', `  Classes: ${metrics.classes}`);
    addToHistory('system', `  Complexity score: ${metrics.complexityScore}%`);

    if (metrics.todos.length > 0) {
        addToHistory('system', '');
        addToHistory('system', colorize(`TODOs (${metrics.todos.length}):`, 'yellow'));
        for (const todo of metrics.todos.slice(0, 10)) {
            addToHistory('system', `  Line ${todo.line}: ${todo.text}`);
        }
        if (metrics.todos.length > 10) {
            addToHistory('system', `  ... and ${metrics.todos.length - 10} more`);
        }
    }

    if (metrics.longFunctions.length > 0) {
        addToHistory('system', '');
        addToHistory('system', colorize(`Long Functions (${metrics.longFunctions.length}):`, 'yellow'));
        for (const func of metrics.longFunctions) {
            addToHistory('system', `  ${func.name} (line ${func.startLine}, ${func.length} lines)`);
        }
    }

    if (metrics.issues.length > 0) {
        addToHistory('system', '');
        addToHistory('system', colorize(`⚠️  Issues (${metrics.issues.length}):`, 'red'));
        for (const issue of metrics.issues) {
            addToHistory('system', `  - ${issue}`);
        }
    } else {
        addToHistory('system', '');
        addToHistory('system', colorize('✓ No issues found!', 'green'));
    }

    displayChatHistory();
}

// ============================================================================
// WEB SEARCH & DOCUMENTATION HANDLERS
// ============================================================================

// Handle /search command - web search
async function handleSearch(api, args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /search <query>');
        addToHistory('system', 'Example: /search react hooks best practices');
        displayChatHistory();
        return;
    }

    const query = args.join(' ');
    addToHistory('system', `Searching for: ${colorize(query, 'cyan')}`);
    displayChatHistory();

    try {
        const response = await api.get('/api/search', {
            params: { q: query, limit: 5 }
        });

        const data = response.data;

        if (data.results && data.results.length > 0) {
            addToHistory('system', '');
            addToHistory('system', colorize(`━━━ Search Results (${data.count}) ━━━`, 'green'));
            addToHistory('system', '');

            data.results.forEach((result, index) => {
                addToHistory('system', colorize(`${index + 1}. ${result.title}`, 'yellow'));
                addToHistory('system', `   ${colorize(result.url, 'blue')}`);
                if (result.snippet) {
                    const snippet = result.snippet.substring(0, 150);
                    addToHistory('system', `   ${snippet}${result.snippet.length > 150 ? '...' : ''}`);
                }
                addToHistory('system', '');
            });

            if (data.cached) {
                addToHistory('system', colorize('(Cached results)', 'dim'));
            }
        } else {
            addToHistory('system', colorize('No results found', 'yellow'));
        }
    } catch (error) {
        addToHistory('system', colorize(`Search failed: ${error.message}`, 'red'));
    }

    displayChatHistory();
}

// Handle /docs command - documentation lookup
async function handleDocs(api, args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /docs <library> [query]');
        addToHistory('system', '');
        addToHistory('system', 'Supported libraries:');
        addToHistory('system', '  javascript, js, node, nodejs, python, py');
        addToHistory('system', '  react, vue, angular, express, django, flask');
        addToHistory('system', '  typescript, ts, docker, git, bash, css, html');
        addToHistory('system', '');
        addToHistory('system', 'Examples:');
        addToHistory('system', '  /docs react          - Show React documentation index');
        addToHistory('system', '  /docs react hooks    - Search for "hooks" in React docs');
        addToHistory('system', '  /docs python dict    - Search for "dict" in Python docs');
        displayChatHistory();
        return;
    }

    const library = args[0];
    const query = args.slice(1).join(' ');

    if (query) {
        addToHistory('system', `Searching ${colorize(library, 'cyan')} docs for: ${colorize(query, 'yellow')}`);
    } else {
        addToHistory('system', `Fetching ${colorize(library, 'cyan')} documentation index...`);
    }
    displayChatHistory();

    try {
        const params = { library };
        if (query) {
            params.query = query;
        }

        const response = await api.get('/api/docs', { params });
        const data = response.data;

        if (data.type === 'index') {
            // Show index entries
            addToHistory('system', '');
            addToHistory('system', colorize(`━━━ ${data.library} Documentation Index ━━━`, 'green'));
            addToHistory('system', `Showing ${data.count} of ${data.total} entries`);
            addToHistory('system', '');

            data.entries.forEach((entry, index) => {
                const typeLabel = entry.type ? colorize(`[${entry.type}]`, 'dim') : '';
                addToHistory('system', `${index + 1}. ${entry.name} ${typeLabel}`);
                addToHistory('system', `   ${colorize(`https://devdocs.io/${data.library}/${entry.path}`, 'blue')}`);
                addToHistory('system', '');
            });

            addToHistory('system', colorize(`Tip: Use "/docs ${library} <query>" to search specific topics`, 'dim'));
        } else if (data.type === 'search') {
            // Show search results
            addToHistory('system', '');
            addToHistory('system', colorize(`━━━ ${data.library} Documentation: "${data.query}" (${data.count} results) ━━━`, 'green'));
            addToHistory('system', '');

            if (data.results.length > 0) {
                data.results.forEach((result, index) => {
                    const typeLabel = result.type ? colorize(`[${result.type}]`, 'dim') : '';
                    addToHistory('system', `${index + 1}. ${result.name} ${typeLabel}`);
                    addToHistory('system', `   ${colorize(result.url, 'blue')}`);
                    addToHistory('system', '');
                });
            } else {
                addToHistory('system', colorize('No matching documentation found', 'yellow'));
                addToHistory('system', `Try: /docs ${library} (without search term for index)`);
            }
        }

        if (data.cached) {
            addToHistory('system', colorize('(Cached results)', 'dim'));
        }
    } catch (error) {
        if (error.response && error.response.status === 500) {
            addToHistory('system', colorize(`Documentation not found for "${library}"`, 'red'));
            addToHistory('system', 'Supported libraries: javascript, node, python, react, vue, angular, express, django, flask, typescript, docker, git, bash, css, html');
        } else {
            addToHistory('system', colorize(`Failed to fetch documentation: ${error.message}`, 'red'));
        }
    }

    displayChatHistory();
}

// Display interactive command menu
async function showCommandMenu() {
    addToHistory('system', '━━━ Interactive Command Menu ━━━');
    addToHistory('system', '/auth           - Authenticate with API credentials');
    addToHistory('system', '/init           - Analyze project and create koda.md');
    addToHistory('system', '/project <name> - Create a project directory structure');
    addToHistory('system', '/cwd            - Show current working directory');
    addToHistory('system', '/mode           - Switch between standalone, agent, or agent collab modes');
    addToHistory('system', '/help           - Show all available commands');
    addToHistory('system', '/clear          - Clear chat history');
    addToHistory('system', '/clearsession   - Clear session context (keeps history visible)');
    addToHistory('system', '/quit           - Exit koda');
    addToHistory('system', '');
    addToHistory('system', 'Tip: Type /mode and press TAB to see mode options');
    displayChatHistory();
}

async function handleCreateAgent(api, rl) {
    addToHistory('system', 'Creating new agent...');
    displayChatHistory();

    const question = (prompt) => new Promise((resolve) => {
        rl.question(colorize(prompt, 'yellow'), resolve);
    });

    try {
        const name = await question('Agent name: ');
        const description = await question('Description: ');
        const modelName = await question('Model name (optional): ');

        const result = await api.createAgent({
            name: name.trim(),
            description: description.trim(),
            modelName: modelName.trim() || null,
            skills: []
        });

        if (result.success) {
            addToHistory('system', `✓ Agent created: ${result.data.name} (ID: ${result.data.id})`);
            addToHistory('system', `API Key: ${result.data.apiKey}`);
        } else {
            addToHistory('system', `Error: ${result.error}`);
        }
    } catch (error) {
        addToHistory('system', `Error: ${error.message}`);
    }

    displayChatHistory();
}

async function handleSkills(api) {
    const result = await api.getSkills();

    if (!result.success) {
        addToHistory('system', `Error: ${result.error}`);
        displayChatHistory();
        return;
    }

    addToHistory('system', '━━━ Available Tools ━━━');
    if (result.data.length === 0) {
        addToHistory('system', 'No tools found.');
    } else {
        // Group by type
        const byType = { tool: [], function: [], command: [] };
        result.data.forEach(skill => {
            if (byType[skill.type]) {
                byType[skill.type].push(skill);
            }
        });

        for (const [type, skills] of Object.entries(byType)) {
            if (skills.length > 0) {
                addToHistory('system', `${type.toUpperCase()}S:`);
                skills.forEach(skill => {
                    const status = skill.enabled ? '✓' : '✗';
                    addToHistory('system', `  ${status} ${skill.name} - ${skill.description || 'No description'}`);
                });
            }
        }
    }
    displayChatHistory();
}

// File operation handlers
async function handleFileRead(api, args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /file-read <path>');
        displayChatHistory();
        return;
    }

    const result = await api.fileRead(args.join(' '));
    if (result.success) {
        addToHistory('system', `✓ File read: ${result.data.filePath}`);
        addToHistory('assistant', result.data.content);
    } else {
        addToHistory('system', `Error: ${result.error}`);
    }
    displayChatHistory();
}

async function handleFileWrite(api, args) {
    if (!args || args.length < 2) {
        addToHistory('system', 'Usage: /file-write <path> <content>');
        displayChatHistory();
        return;
    }

    const filePath = args[0];
    const content = args.slice(1).join(' ');

    const result = await api.fileWrite(filePath, content);
    if (result.success) {
        addToHistory('system', `✓ File written: ${filePath}`);
    } else {
        addToHistory('system', `Error: ${result.error}`);
    }
    displayChatHistory();
}

async function handleFileDelete(api, args) {
    if (!args || args.length === 0) {
        addToHistory('system', 'Usage: /file-delete <path>');
        displayChatHistory();
        return;
    }

    const result = await api.fileDelete(args.join(' '));
    if (result.success) {
        addToHistory('system', `✓ File deleted: ${result.data.filePath}`);
    } else {
        addToHistory('system', `Error: ${result.error}`);
    }
    displayChatHistory();
}

function handleClear() {
    chatHistory.length = 0;
    addToHistory('system', 'Chat cleared! Type a message or use /help for commands.');
    displayChatHistory();
}

function handleClearSession() {
    conversationContext.length = 0;
    lastTokenUsage = { prompt: 0, completion: 0, total: 0 };
    totalTokensUsed = 0;
    contextWindowUsed = 0;
    addToHistory('system', 'Session context cleared');
    addToHistory('system', 'Conversation will start fresh (chat history still visible)');
    addToHistory('system', 'Note: API key daily usage is tracked server-side and not reset');
    displayChatHistory();
}


// Handle natural language chat with session awareness and skill execution (with streaming)
async function handleChat(api, message) {
    // Preserve original message for false completion detection
    const originalMessage = message;

    // Add user message to history
    addToHistory('user', message);

    // Add to conversation context for session awareness
    conversationContext.push({ role: 'user', content: message });

    // Fetch skills for skill execution capability (with cache fallback)
    const skillsResult = await api.getSkills();
    let skills;
    if (skillsResult.success && skillsResult.data) {
        skills = skillsResult.data;
        cachedSkills = skills; // Update cache on success
    } else {
        skills = cachedSkills; // Use cached skills if API fails
        if (skills.length === 0) {
            addToHistory('system', 'Warning: Could not load tools from server. File operations may not work.');
        }
    }

    // ---- Decide whether this query actually needs the full skill catalog ----
    // A trivial question like "10+10" or "hi" gets a lean system prompt; a
    // file operation or git command gets the full skill catalog. This cuts
    // the prompt length by 90%+ for casual queries and eliminates the model
    // confusion bugs (the infamous "20 words" hallucination).
    const queryType = classifyQuery(message, websearchMode);
    // If the user has files in the working set OR has a pronoun that likely
    // refers to one ("edit it", "fix this", "add X to that"), use the full
    // skill catalog so the model can actually act on them. Otherwise the
    // follow-up gets the lean prompt and the model insists it can't touch
    // the file it just created.
    const pronounRefersToFile = workingFiles.size > 0 &&
        /\b(it|this|that|them|those|these)\b/i.test(message);
    // If the user's message names a file (or filename stem) that's already
    // in the working set, or expresses any "modify / change / add to"
    // intent while files are loaded, route through the full catalog.
    // Without this, "Make the snake game bigger" hits the lean prompt,
    // the model ignores the peeked snake.html and writes fresh pygame
    // from scratch — exactly the bug the working-set was supposed to prevent.
    const msgLower = message.toLowerCase();
    const mentionsWorkingFile = workingFiles.size > 0 &&
        Array.from(workingFiles.keys()).some(fp => {
            const base = path.basename(fp).toLowerCase();
            if (base === 'koda.md') return false;
            const stem = base.replace(/\.[^.]+$/, '');
            return (base && msgLower.includes(base)) ||
                   (stem && stem.length >= 3 && new RegExp(`\\b${stem.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(msgLower));
        });
    const modifyIntent = workingFiles.size > 0 &&
        /\b(make|add|change|update|modify|fix|adjust|tweak|edit|refactor|rename|rewrite|enlarge|shrink|resize|convert|remove|delete|insert|replace|improve|optimize|extend|support|enable|disable|set|turn)\b/i.test(message);
    const useFullSkillCatalog =
        queryType === 'skill' ||
        websearchMode ||
        pronounRefersToFile ||
        mentionsWorkingFile ||
        modifyIntent;

    let systemPrefix = '';
    if (useFullSkillCatalog) {
        systemPrefix = buildSkillSystemPrompt(skills, websearchMode, message) + '\n\n';
    } else {
        systemPrefix = buildLeanSystemPrompt(queryType, websearchMode) + '\n\n';
    }

    // Build context-aware message for the API
    let userMessage = message;

    // If websearch mode is enabled, perform search with content fetching
    // Skip search for simple file save requests (use existing conversation context instead)
    let searchResults = null;
    const skipSearchForFileSave = isFileSaveRequest(message);
    if (websearchMode && !skipSearchForFileSave) {
        try {
            // Display chat history first to show user's message, then start animation
            displayChatHistory();
            startAnimation('Searching the web', 'dots');

            // Search with content fetching enabled (8 results, fetch content from top 5)
            const searchResponse = await api.webSearch(message, 8, true, 5);

            // Stop animation
            stopAnimation(true);

            if (!searchResponse.success) {
                throw new Error(searchResponse.error || 'Search API returned unsuccessful response');
            }

            if (searchResponse.data && searchResponse.data.results && searchResponse.data.results.length > 0) {
                searchResults = searchResponse.data.results;
                const contentCount = searchResponse.data.contentFetchedCount || 0;

                // Add search results to system prefix with actual content
                systemPrefix += '=== WEB SEARCH RESULTS ===\n';
                systemPrefix += `Query: "${message}"`;
                if (searchResponse.data.enhancedQuery) {
                    systemPrefix += ` (enhanced: "${searchResponse.data.enhancedQuery}")`;
                }
                systemPrefix += `\nFound ${searchResults.length} results (${contentCount} with full content):\n\n`;

                searchResults.forEach((result, idx) => {
                    systemPrefix += `━━━ SOURCE [${idx + 1}] ━━━\n`;
                    systemPrefix += `Title: ${result.title}\n`;
                    systemPrefix += `URL: ${result.url}\n`;

                    if (result.content && result.contentFetched) {
                        // Include actual fetched content
                        systemPrefix += `\nCONTENT:\n${result.content}\n`;
                    } else if (result.snippet) {
                        // Fall back to snippet if content wasn't fetched
                        systemPrefix += `\nSnippet: ${result.snippet}\n`;
                    }
                    systemPrefix += '\n';
                });
                systemPrefix += '=== END OF SEARCH RESULTS ===\n\n';
                systemPrefix += `CRITICAL - WEB SEARCH CONTENT ALREADY FETCHED:
The search results above contain ACTUAL PAGE CONTENT that has already been fetched for you.

YOU MUST:
1. Use the content above IMMEDIATELY to answer the question - do NOT fetch again
2. If asked to summarize an article, write the summary NOW using the content provided
3. If asked to save to PDF/TXT, create the files NOW using create_pdf and create_file skills
4. Extract specific facts, quotes, and data from the content provided
5. Do NOT say "I need you to provide a link" or "I can fetch the article" - the content IS ALREADY HERE

YOU MUST NOT:
- Ask the user for a URL (you already have URLs and content above)
- Say "I found results" and then ask what to do (just DO IT)
- Use playwright_fetch or fetch_url (content is already fetched)
- Loop asking for clarification (pick the first relevant article and proceed)\n\n`;

                // Show compact results flash
                showCompletionFlash(`Found ${searchResults.length} results (${contentCount} with content)`, true);
            } else {
                const noResultsMsg = searchResponse.data && searchResponse.data.results
                    ? 'No search results found'
                    : 'Search returned empty response';
                showCompletionFlash(noResultsMsg, false);
            }
        } catch (error) {
            // Stop animation on error
            stopAnimation(true);

            // Handle improved error responses from backend
            let errorMsg = 'Web search failed';
            if (error.response?.data?.error) {
                errorMsg = error.response.data.error;
            } else if (error.message) {
                errorMsg = error.message;
            }

            showCompletionFlash(errorMsg, false);

            // Show retry suggestion if error is retryable
            if (error.response?.data?.retryable) {
                process.stdout.write(colorize('  Try again in a few seconds\n', 'yellow'));
            }
        }
    }


    // Build the SYSTEM message content: system prefix + working files. Web
    // search results and agent task state were already appended into
    // systemPrefix above. This stays in its own message so the model sees a
    // real system role instead of having all of it stuffed into the user
    // turn (which is what caused most of the legacy response-quality bugs).
    let systemContent = systemPrefix.trimEnd();
    const workingFilesContext = buildWorkingFilesContext();
    if (workingFilesContext) {
        systemContent += '\n\n' + workingFilesContext.trimEnd();
    }

    // Convert the last few conversation turns into proper message objects.
    // Filter out 'system' entries — those are skill outputs and UI notices
    // which are stale noise on unrelated follow-up questions.
    const historyMessages = [];
    if (conversationContext.length > 1) {
        const recentContext = conversationContext.slice(-11, -1)
            .filter(msg => msg.role === 'user' || msg.role === 'assistant');
        for (const msg of recentContext) {
            historyMessages.push({ role: msg.role, content: msg.content });
        }
    }

    // Base messages array for this user turn. Skill feedback iterations
    // append to a copy of this; the original is preserved so each iteration
    // starts from the same known-good baseline.
    const baseMessages = [
        { role: 'system', content: systemContent },
        ...historyMessages,
        { role: 'user', content: userMessage }
    ];

    // Skill execution loop
    let iteration = 0;
    let currentMessages = baseMessages.slice();
    let finalResponse = '';

    // Helper: produce a fresh messages array that represents
    //   baseMessages + assistant(lastResponse) + user(feedback)
    // This is how we continue the conversation after a skill call without
    // blowing up the previous turn's content.
    const buildFeedbackMessages = (lastResponse, feedback) => {
        const next = baseMessages.slice();
        if (lastResponse && lastResponse.length > 0) {
            next.push({ role: 'assistant', content: lastResponse });
        }
        next.push({ role: 'user', content: feedback });
        return next;
    };

    // Track successfully executed file operation skills across iterations
    // This prevents false completion detection from triggering after delete/move/copy operations complete
    const executedFileOpSkills = new Set();

    // Track every successfully executed skill name this turn so the
    // continuation/retry feedback can name them and forbid re-running.
    const executedSkillsThisTurn = new Set();

    // Track retries triggered by the "announced intent, no skill call"
    // detector. Capped independently of the overall loop counter so a
    // multi-step task (read → search_replace → search_replace → …) can
    // chain across many iterations while a stuck "I'll now do X" narration
    // loop is still bounded.
    let intentWithoutActionRetries = 0;
    const MAX_INTENT_RETRIES = 3;

    // Cap for the [SKILL SYNTAX ERROR] retry loop. Without a cap the
    // model can burn all 10 iterations emitting malformed calls back to
    // back — common with small models whose output gets truncated mid-arg.
    let syntaxErrorRetries = 0;
    const MAX_SYNTAX_RETRIES = 2;

    // Loop-detection: if the model re-emits the same skill call (or same
    // truncated response) across iterations, we're wedged in a retry spiral
    // — typically the model can't produce a working search_replace_file
    // because the output got truncated. Track the last few response
    // signatures and bail early rather than wasting the full 10 iterations.
    const recentSignatures = [];
    const sigFor = (txt, calls) => {
        const head = (txt || '').slice(0, 400).replace(/\s+/g, ' ');
        const callSig = calls.map(c => `${c.skillName}:${Object.keys(c.params || {}).sort().join(',')}`).sort().join('|');
        return `${callSig}##${head}`;
    };

    while (iteration < MAX_SKILL_ITERATIONS) {
        iteration++;

        // Show animated indicator for each iteration
        displayChatHistory();
        if (iteration === 1) {
            startAnimation(getRandomThinkingMessage(), 'dots');
        } else {
            // Show more informative retry animation based on context
            const retryMessages = [
                'Refining response',
                'Adjusting approach',
                'Processing results',
                'Continuing task'
            ];
            const retryMsg = retryMessages[Math.min(iteration - 2, retryMessages.length - 1)];
            startAnimation(retryMsg, 'arc');
        }

        // Use streaming API
        let streamingResponse = '';
        let tokenCount = 0;
        let hasStoppedAnimation = false;

        // Reset and enable streaming mode
        resetStreamingState();
        isStreaming = true;

        let isInThinkBlock = false;
        let thinkingIndicatorShown = false;

        const result = await api.chatStream(
            // Proper OpenAI-style messages array with a real `system` role.
            // The backend routes this through /api/chat/stream which clamps
            // max_tokens against input size server-side.
            { messages: currentMessages, temperature: 0.7 },
            null,
            4000,
            // onToken callback - display tokens in real-time
            (token) => {
                streamingResponse += token;
                tokenCount++;

                // Track thinking state for <think> tags
                if (streamingResponse.includes('<think>') && !streamingResponse.includes('</think>')) {
                    if (!isInThinkBlock) {
                        isInThinkBlock = true;
                        // Show thinking indicator instead of leaving screen blank
                        if (!thinkingIndicatorShown) {
                            if (!hasStoppedAnimation) {
                                stopAnimation(true);
                                hasStoppedAnimation = true;
                            }
                            startAnimation('Thinking', 'dots');
                            thinkingIndicatorShown = true;
                        }
                    }
                    return; // Don't process display during thinking
                } else if (isInThinkBlock && streamingResponse.includes('</think>')) {
                    isInThinkBlock = false;
                    // Stop thinking animation when think block ends
                    if (thinkingIndicatorShown) {
                        stopAnimation(true);
                    }
                }

                // Stop animation on first visible token and clear the line
                if (!hasStoppedAnimation) {
                    stopAnimation(true);
                    hasStoppedAnimation = true;
                }

                // Update or add assistant message in history
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant-streaming') {
                    lastMsg.content = streamingResponse;
                } else {
                    addToHistory('assistant-streaming', streamingResponse);
                }

                // Update display in real-time during streaming (no full refresh)
                // Show first token immediately, then update periodically
                if (tokenCount === 1 || tokenCount % 3 === 0 || token.includes('\n')) {
                    updateStreamingMessage(streamingResponse);
                }
            },
            // onComplete callback
            (fullResponse, tokens) => {
                // Ensure streaming output ends with newline before screen refresh
                if (lastStreamedMessage !== '' && !fullResponse.endsWith('\n')) {
                    process.stdout.write('\n');
                }

                // Disable streaming mode
                isStreaming = false;
                lastStreamedMessage = '';
                lastCleanedMessage = '';

                // Remove streaming cursor and strip thinking tags from final content
                const cleanedFinalResponse = fullResponse
                    .replace(/<think>[\s\S]*?<\/think>/g, '')
                    .replace(/<think>[\s\S]*$/g, '')
                    .replace(/<\/think>/g, '')
                    .trim();
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant-streaming') {
                    lastMsg.role = 'assistant';
                    lastMsg.content = cleanedFinalResponse;
                }

                // Update token usage stats
                if (tokens) {
                    lastTokenUsage = {
                        prompt: tokens.prompt_tokens || 0,
                        completion: tokens.completion_tokens || 0,
                        total: tokens.total_tokens || 0
                    };
                    totalTokensUsed += lastTokenUsage.total;

                    // Update context window tracking
                    contextWindowUsed = conversationContext.length > 0 ?
                        conversationContext.reduce((sum, msg) => sum + Math.ceil(msg.content.length / 4), 0) : 0;
                }

                // Don't call displayChatHistory() here - let the skill processing flow handle it
                // This prevents duplicate display when skills need to be executed
            }
        );

        if (!result.success) {
            addToHistory('system', `Error: ${result.error}`);
            displayChatHistory();
            return;
        }

        // Strip thinking tags from response before processing
        let response = result.data.response;
        response = response.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').replace(/<\/think>/g, '').trim();
        finalResponse = response;

        // Check for skill calls in the response
        const skillCalls = parseSkillCalls(response);

        if (skillCalls.length === 0) {
            // No valid skill calls found - check if there were malformed attempts
            const malformedCalls = detectMalformedSkillCalls(response);

            if (malformedCalls.length > 0) {
                // Was the truncated call specifically a full-file rewrite?
                // If so, the retry is almost never going to succeed with
                // the same call shape — the fix is to push the model at
                // search_replace_file hard on the first retry.
                const truncatedUpdateFile = malformedCalls.some(c =>
                    c.type === 'incomplete_bracket' &&
                    (c.skillName === 'update_file' || c.skillName === 'write_file'));

                // Cap the retry loop — without this a small model that
                // keeps producing truncated calls will burn every
                // iteration re-failing the same way. When the cap trips,
                // also scrub the model's misleading "I have updated …"
                // narration from the transcript so the user isn't left
                // looking at a completion summary for work that never ran.
                if (syntaxErrorRetries >= MAX_SYNTAX_RETRIES) {
                    const lastMsg = chatHistory[chatHistory.length - 1];
                    if (lastMsg && lastMsg.role === 'assistant') {
                        chatHistory.pop();
                    }
                    addToHistory('system',
                        'FAILED — the file was NOT modified.\n' +
                        '  Cause: the model emitted a skill call whose argument was truncated mid-string (usually update_file with the entire new file content exceeding max_tokens).\n' +
                        '  Fix:   (a) ask for a smaller, targeted edit so the model can use search_replace_file, or (b) raise the model\'s max_tokens and reload.');
                    displayChatHistory();
                    break;
                }
                syntaxErrorRetries++;

                // AI tried to use skills but syntax was wrong
                // Clean the display and provide feedback
                const cleanedResponse = cleanSkillSyntax(response);
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    if (cleanedResponse && cleanedResponse.length > 0) {
                        lastMsg.content = cleanedResponse;
                    } else {
                        chatHistory.pop();
                    }
                }

                // Build error feedback for the AI
                let errorFeedback = '\n\n[SKILL SYNTAX ERROR — NOTHING WAS APPLIED]\n';
                errorFeedback += 'Your previous skill call was truncated mid-argument. The file was NOT modified. Do NOT claim "I have updated" or "changes implemented" — nothing happened yet.\n\n';
                if (truncatedUpdateFile) {
                    errorFeedback += 'Your update_file call was cut off because its content is too long for a single response. Do NOT retry update_file — use multiple search_replace_file calls instead, one per change:\n';
                    errorFeedback += '  [SKILL:search_replace_file(filePath="/path/to/file", search="<small exact snippet>", replace="<replacement>")]\n';
                    errorFeedback += 'Emit several of these in this response, each small enough to fit.\n\n';
                } else {
                    errorFeedback += 'Correct format:\n  [SKILL:skill_name(param1="value1", param2="value2")]\n  or: call:skill_name(param1="value1", param2="value2")\n\n';
                }
                errorFeedback += 'Issues detected:\n';
                for (const issue of malformedCalls) {
                    if (issue.type === 'incomplete_bracket') {
                        errorFeedback += `- Skill "${issue.skillName}" was not completed (missing closing ")").\n`;
                    } else if (issue.type === 'malformed_params') {
                        errorFeedback += `- "${issue.skillName}" parameters must use key="value" format\n`;
                    }
                }
                errorFeedback += '\nRetry now. If your edit is large, prefer multiple small search_replace_file calls over one update_file.\n';

                // Show error to user
                addToHistory('system', `Tool syntax error detected - asking AI to retry (${syntaxErrorRetries}/${MAX_SYNTAX_RETRIES})...`);
                displayChatHistory();

                // Continue the conversation with error feedback
                currentMessages = buildFeedbackMessages(response, errorFeedback);
                continue;
            }

            // Check if AI claims to have performed file operations without actually executing skills
            // This catches cases where the AI hallucinates "I saved the file" without calling skills
            // IMPORTANT: Run this check on ALL iterations, not just iteration 0
            // Because after running a skill like web_search, AI might claim to have saved results
            // to a file without actually calling create_file
            //
            // HOWEVER: Skip this check if relevant file operation skills already executed successfully
            // This prevents infinite loops when delete/move/copy operations complete but AI's response
            // still triggers the false completion patterns (e.g., "files have been deleted" after delete_file ran)
            const claimsFileOperation = detectFalseCompletionClaim(response, originalMessage);

            // Determine if the claimed operation type was already executed
            const messageContainsDelete = /\b(delete|remove|rm|erase|clear|wipe)\b/i.test(originalMessage);
            const messageContainsCreate = /\b(create|save|write|export|make|new)\b.*\b(file|folder|directory|dir|pdf|txt)\b/i.test(originalMessage) ||
                /\b(file|folder|directory)\b.*\b(called|named)\b/i.test(originalMessage);
            const messageContainsMove = /\b(move|rename)\b/i.test(originalMessage);
            const messageContainsCopy = /\bcopy\b/i.test(originalMessage);

            const deleteOpsExecuted = executedFileOpSkills.has('delete_file') || executedFileOpSkills.has('delete_directory');
            const createOpsExecuted = executedFileOpSkills.has('create_file') || executedFileOpSkills.has('create_directory') ||
                                       executedFileOpSkills.has('update_file') || executedFileOpSkills.has('write_file') ||
                                       executedFileOpSkills.has('append_to_file');
            const moveOpsExecuted = executedFileOpSkills.has('move_file');
            const copyOpsExecuted = executedFileOpSkills.has('copy_file');

            // Skip false completion check if the operation type the user requested was already performed
            const operationAlreadyCompleted =
                (messageContainsDelete && deleteOpsExecuted) ||
                (messageContainsCreate && createOpsExecuted) ||
                (messageContainsMove && moveOpsExecuted) ||
                (messageContainsCopy && copyOpsExecuted);

            if (claimsFileOperation && !operationAlreadyCompleted && iteration <= 2) {
                // AI claimed to do file operations but didn't execute any skills
                // Only retry up to 2 times to prevent infinite loops
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    chatHistory.pop();
                }

                // Force the AI to actually execute skills
                let correctionFeedback = '\n\n[EXECUTION REQUIRED]\n';
                correctionFeedback += 'You claimed to have performed a file operation but did not execute a skill.\n';
                correctionFeedback += 'You MUST use skills to perform actual file/directory operations. Do not claim completion without execution.\n\n';
                correctionFeedback += 'Use the appropriate skill:\n';
                correctionFeedback += `- To create a file: [SKILL:create_file(filePath="${userWorkingDirectory}/filename", content="content")]\n`;
                correctionFeedback += `- To create a directory: [SKILL:create_directory(dirPath="${userWorkingDirectory}/dirname")]\n`;
                correctionFeedback += `- To delete a file: [SKILL:delete_file(filePath="${userWorkingDirectory}/filename")]\n\n`;
                correctionFeedback += 'Execute the appropriate skill NOW.\n';

                addToHistory('system', 'No file operation executed - asking AI to actually save the file...');
                displayChatHistory();

                currentMessages = buildFeedbackMessages(response, correctionFeedback);
                continue;
            }

            // Check if AI gave shell commands/instructions instead of using skills for file/directory operations
            // This catches cases where the AI says "run mkdir test" instead of calling create_directory
            const userRequestsFileOp = /\b(create|make|new|delete|remove|move|rename|copy|read|list)\b.*\b(file|folder|directory|dir)\b/i.test(originalMessage) ||
                /\bcreate\b.*\b(called|named)\b.*\.\w{1,5}\b/i.test(originalMessage);
            const givesShellCommands = /\b(mkdir|touch|echo\s*>|rm\s|mv\s|cp\s|cat\s|New-Item|Remove-Item)\b/i.test(response);
            const hasNoSkillCalls = !response.includes('[SKILL:');

            if (userRequestsFileOp && givesShellCommands && hasNoSkillCalls && !operationAlreadyCompleted && iteration <= 2) {
                // AI gave shell instructions instead of using skills - force retry
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    chatHistory.pop();
                }

                let correctionFeedback = '\n\n[SKILL EXECUTION REQUIRED]\n';
                correctionFeedback += 'You gave shell commands/instructions, but you have skills to do this directly. Do NOT tell the user to run commands.\n';
                correctionFeedback += 'You MUST execute the appropriate skill NOW. Available skills:\n';
                correctionFeedback += `- [SKILL:create_file(filePath="${userWorkingDirectory}/filename", content="content")]\n`;
                correctionFeedback += `- [SKILL:create_directory(dirPath="${userWorkingDirectory}/dirname")]\n`;
                correctionFeedback += `- [SKILL:delete_file(filePath="/path/to/file")]\n`;
                correctionFeedback += `- [SKILL:list_directory(dirPath="${userWorkingDirectory}")]\n\n`;
                correctionFeedback += 'Execute the skill NOW - do not explain, just call the skill.\n';

                addToHistory('system', 'Redirecting to use tools instead of shell commands...');
                displayChatHistory();

                currentMessages = buildFeedbackMessages(response, correctionFeedback);
                continue;
            }

            // INTENT-OR-DIAGNOSIS WITHOUT ACTION: the user asked for a fix
            // and the model responded with *either* (a) future-intent
            // phrasing ("I'll now rewrite…") or (b) pure diagnosis ("the
            // bug is X, the fix is Y") but never called a skill. Without
            // this check the loop exits and the user has to manually
            // prompt "ok, do it" for every step. We also look back in
            // recent conversation for action intent so short follow-ups
            // like "proceed" / "ok do it" still inherit the original fix
            // request. An explicit clarifying question ("which file?"…)
            // is left alone so the user can answer.
            const actionIntentRegex = /\b(fix|debug|rewrite|refactor|modify|update|change|tweak|adjust|improve|implement|build|add|remove|insert|rename|enable|disable|make.*(bigger|larger|smaller|better|playable|work)|go\s+through|apply|write|create|edit)\b/i;
            const userRequestedAction = actionIntentRegex.test(originalMessage);
            const continuationPhrase = /^\s*(ok|okay|yes|yeah|sure|do it|go|go ahead|proceed|continue|keep going|please|run it)\b/i.test(originalMessage.trim());
            // For continuation phrases inherit action intent from the last
            // few user messages in chatHistory.
            const inheritsAction = continuationPhrase && [...chatHistory].reverse()
                .filter(m => m.role === 'user').slice(0, 3)
                .some(m => actionIntentRegex.test(m.content || ''));
            const responseAsksClarifyingQuestion = /\?\s*$/.test(response.trim()) ||
                /\b(which\s+file|could you (clarify|specify|confirm)|please (clarify|confirm|specify)|can you tell me|where (should|is)|what (do you mean|would you like))\b/i.test(response);
            const saidWillFix = (userRequestedAction || inheritsAction) && !responseAsksClarifyingQuestion;

            if (saidWillFix && intentWithoutActionRetries < MAX_INTENT_RETRIES) {
                intentWithoutActionRetries++;
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    chatHistory.pop();
                }

                let correctionFeedback = '\n\n[CONTINUE — DO NOT STOP]\n';
                correctionFeedback += 'You identified what needs to change but never called a skill. Do not describe the fix — apply it.\n';

                // Name the skills already executed this turn so the model
                // doesn't just repeat list_directory / read_file on every
                // continuation. For discovery-heavy models this is the
                // difference between making progress and spinning.
                const discoverySkills = ['list_directory', 'read_file', 'get_file_metadata', 'search_files', 'head_file', 'tail_file'];
                const alreadyRanDiscovery = [...executedSkillsThisTurn].filter(s => discoverySkills.includes(s));
                if (alreadyRanDiscovery.length > 0) {
                    correctionFeedback += `You already ran ${alreadyRanDiscovery.join(', ')} this turn. DO NOT call those again — you already have the info. `;
                    correctionFeedback += 'Move directly to the edit: emit one or more search_replace_file calls right now.\n';
                } else {
                    correctionFeedback += 'Call the next skill right now (search_replace_file for targeted edits; read_file ONLY if you have not already read the relevant region).\n';
                }
                correctionFeedback += 'Do NOT claim "I have applied" or "fixes are in place" unless you actually emit a [SKILL:...] call in this same response.\n';
                correctionFeedback += 'If the task is multi-step, chain the skill calls in this same response — do not wait to be prompted again.\n';

                addToHistory('system', 'Model announced intent without acting — asking it to continue...');
                displayChatHistory();

                currentMessages = buildFeedbackMessages(response, correctionFeedback);
                continue;
            }

            // No skill calls and no malformed attempts - we're done
            // Display final response now that streaming is complete
            displayChatHistory();
            break;
        }

        // When skills are about to execute, DON'T show the AI's preliminary response.
        // The AI often claims success/failure before skills actually run (e.g., "folder deleted successfully").
        // This causes confusion when the skill then fails or succeeds differently.
        // Instead: remove the message, show skill animations, and let the AI respond after seeing actual results.
        const lastMsg = chatHistory[chatHistory.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
            // Remove the preliminary message - skills will show their own status via animations
            chatHistory.pop();
            // Clear the streamed output from screen
            displayChatHistory();
        }

        // Loop-detection: if the same response + same skill-call signature
        // has appeared 2+ times already, the model is spiraling (typically
        // because it can't close a search_replace_file call that got
        // truncated mid-arg). Execute once more then bail, don't keep
        // burning iterations.
        const currentSig = sigFor(response, skillCalls);
        const repeats = recentSignatures.filter(s => s === currentSig).length;
        recentSignatures.push(currentSig);
        if (recentSignatures.length > 5) recentSignatures.shift();
        if (repeats >= 2) {
            addToHistory('system', 'Detected repeated tool-call pattern — stopping to avoid a loop. The model may have truncated its output mid-argument; try a smaller edit or increase the model\'s max_tokens.');
            displayChatHistory();
            break;
        }

        // Execute the skills
        const skillResults = await executeSkillCalls(api, skillCalls);

        // Check if ALL skills failed due to web mode requirement - this is unrecoverable without user action
        const allFailedDueToWebMode = skillResults.length > 0 &&
            skillResults.every(r => !r.success && r.error && r.error.toLowerCase().includes('requires web search mode'));

        if (allFailedDueToWebMode) {
            // Don't loop - inform the user and stop
            lastWebModeError = true; // Track this for handling "y" input
            addToHistory('system', 'Web search mode is required for this task. Use /web to enable it.');
            displayChatHistory();
            break;
        }

        // Track successfully executed file operation skills to prevent false completion detection loops
        const fileOpSkillNames = ['delete_file', 'delete_directory', 'create_file', 'create_directory',
                                   'move_file', 'copy_file', 'update_file', 'write_file', 'append_to_file'];
        for (const result of skillResults) {
            if (result.success && fileOpSkillNames.includes(result.skill)) {
                executedFileOpSkills.add(result.skill);
            }
        }

        // Track ALL successfully executed skills this turn (not just file
        // ops) so the continuation feedback can remind the model not to
        // re-run the same discovery skills. Without this, the model
        // responds to every "CONTINUE" prompt by calling list_directory
        // or read_file yet again instead of moving on to the actual edit.
        for (const result of skillResults) {
            if (result.success) {
                executedSkillsThisTurn.add(result.skill);
            }
        }

        // Build feedback message for the AI
        let feedbackMessage = buildSkillResultsMessage(skillResults);

        // Check if the AI claimed to save/create a file but didn't execute a file-creating skill
        // This catches: AI calls web_search + says "saved to file.txt" without calling create_file
        // NOTE: Skip this check for:
        // 1. Delete operations - they don't need file-creating skills
        // 2. Data-gathering skills (web_search, etc.) - these are multi-step operations
        //    where the AI gathers data first, then saves it in the next iteration
        const fileCreatingSkills = ['create_file', 'update_file', 'write_file'];
        const dataGatheringSkills = ['web_search', 'fetch_url', 'playwright_fetch', 'read_file'];
        const executedFileSkills = skillResults.filter(r => fileCreatingSkills.includes(r.skill) && r.success);
        const executedDeleteSkills = skillResults.filter(r =>
            (r.skill === 'delete_file' || r.skill === 'delete_directory') && r.success);
        const executedDataGatheringSkills = skillResults.filter(r =>
            dataGatheringSkills.includes(r.skill) && r.success);
        const claimsFileSave = detectFalseCompletionClaim(response, originalMessage);
        const isDeleteOnlyOperation = /\b(delete|remove|rm|erase|clear|wipe)\b/i.test(originalMessage) &&
                                       !/\b(create|save|write|export)\b.*\b(file|pdf|txt)\b/i.test(originalMessage);

        // Skip false completion check if:
        // 1. Delete skills ran successfully
        // 2. Data-gathering skills ran (AI is in multi-step operation, will save in next iteration)
        const skipFileSaveReminder = isDeleteOnlyOperation ||
                                     executedDeleteSkills.length > 0 ||
                                     executedDataGatheringSkills.length > 0;

        if (claimsFileSave && executedFileSkills.length === 0 && !skipFileSaveReminder) {
            // AI claimed to save a file but no file-creating skill was executed
            // (and this isn't a delete-only operation or data-gathering operation)
            // Add reminder to the feedback so AI knows to actually call create_file
            feedbackMessage += '\n\n[IMPORTANT: FILE NOT SAVED]\n';
            feedbackMessage += 'The user asked to save content to a file, but you did not execute create_file.\n';
            feedbackMessage += 'You MUST execute the create_file skill to actually save the file.\n';
            feedbackMessage += 'Format: [SKILL:create_file(filePath="/path/to/file.txt", content="your content")]\n';
        }

        // Build user-visible skill results summary
        const userVisibleResults = buildUserVisibleSkillResults(skillResults);
        if (userVisibleResults) {
            // Add skill results to chat history so user can see them
            addToHistory('system', userVisibleResults);
            // Store skill results in conversation context so follow-up queries have context
            conversationContext.push({ role: 'system', content: userVisibleResults });
        }

        // Check if the user's specifically requested operation completed successfully
        // This prevents the model from looping with unnecessary verification skills
        // (e.g., delete succeeds → model calls list_directory to "verify" → loops)
        // Only break for simple single-purpose operations, not multi-step ones
        const requestedDeleteDone = /\b(delete|remove)\b.*\b(file|folder|directory|dir)\b/i.test(originalMessage) &&
            skillResults.some(r => r.success && (r.skill === 'delete_file' || r.skill === 'delete_directory'));
        const requestedCreateDirDone = /\b(create|make|new)\b.*\b(folder|directory|dir)\b/i.test(originalMessage) &&
            !/\b(file|\.txt|\.pdf|\.json|\.csv|\.md)\b/i.test(originalMessage) &&
            skillResults.some(r => r.success && r.skill === 'create_directory');
        const requestedCreateFileDone = /\b(create|make|write|save|put|place|store|output|export|dump|record|log|append)\b.*\b(file|\.txt|\.pdf|\.json|\.csv|\.md|into\s+a\s+\w+|to\s+a\s+\w+\s+file)\b/i.test(originalMessage) &&
            !/\b(search|find|web|browse|fetch)\b/i.test(originalMessage) &&
            skillResults.some(r => r.success && (r.skill === 'create_file' || r.skill === 'update_file' || r.skill === 'write_file' || r.skill === 'append_to_file'));

        // Catch-all: any successful file-writing skill in a multi-skill iteration
        // means the user got what they asked for (e.g. "list processes and put
        // into a file" — list_processes + create_file). Without this, a second
        // model turn runs and often hallucinates a refusal ("I cannot access
        // your OS…") that directly contradicts the first success narrative.
        const multiSkillWriteDone = skillResults.length >= 2 &&
            skillResults.some(r => r.success &&
                (r.skill === 'create_file' || r.skill === 'update_file' ||
                 r.skill === 'write_file' || r.skill === 'append_to_file'));

        if (requestedDeleteDone || requestedCreateDirDone || requestedCreateFileDone || multiSkillWriteDone) {
            // Simple file operation completed - show results and stop looping
            displayChatHistory();
            break;
        }

        // Continue the conversation with skill results
        currentMessages = buildFeedbackMessages(response, feedbackMessage);

        // Show animated processing indicator for next iteration (animation starts before next API call)
    }

    if (iteration >= MAX_SKILL_ITERATIONS) {
        addToHistory('system', `Warning: Maximum tool execution iterations (${MAX_SKILL_ITERATIONS}) reached`);
    }

    // Add assistant response to context
    conversationContext.push({ role: 'assistant', content: finalResponse });

    // Keep context manageable (last 20 messages)
    if (conversationContext.length > 20) {
        conversationContext.splice(0, conversationContext.length - 20);
    }

    // Update API key usage stats after chat
    await updateApiKeyUsage(api);

    displayChatHistory();
}

// Main interactive shell
async function startShell() {
    // Prefer KODA_API_KEY / KODA_API_SECRET env vars over the saved config
    // so CI, tests, and ad-hoc "try it" flows don't need /auth. Config is
    // still the default for day-to-day use.
    const envKey = process.env.KODA_API_KEY;
    const envSecret = process.env.KODA_API_SECRET;
    const envUrl = process.env.KODA_API_URL;
    let config = loadConfig();
    if (envKey && envSecret) {
        config = {
            apiUrl: envUrl || (config && config.apiUrl) || 'https://localhost:3001',
            apiKey: envKey,
            apiSecret: envSecret
        };
    }

    let api = config ? new AgentAPI(config.apiUrl, config.apiKey, config.apiSecret) : null;

    if (!config) {
        addToHistory('system', 'Welcome to koda! Run /auth to get started.');
        addToHistory('system', 'Commands: /auth | /help');
    } else {
        // Fetch API key usage stats on startup
        await updateApiKeyUsage(api);
        addToHistory('system', 'Connected.');
        if (apiKeyUsage.name) {
            addToHistory('system', `API Key: ${apiKeyUsage.name}`);
        }
        // Seed the working set with project-level context files so the
        // first query already knows what the project is.
        const loaded = autoLoadProjectContext();
        if (loaded.length > 0) {
            addToHistory('system', `Loaded project context: ${loaded.join(', ')}`);
        }
        addToHistory('system', 'Type a message to chat or /help for commands.');
    }

    // Auth state for inline authentication
    let authState = null;
    let authData = {};

    // Display initial screen
    displayChatHistory();

    // Command definitions with descriptions for live suggestions
    const commandDefs = [
        { cmd: '/auth', desc: 'authenticate with API' },
        { cmd: '/web', desc: 'toggle web search' },
        { cmd: '/init', desc: 'analyze project' },
        { cmd: '/project', desc: 'create project' },
        { cmd: '/cwd', desc: 'show directory' },
        { cmd: '/files', desc: 'show working files' },
        { cmd: '/add-file', desc: 'add file to context' },
        { cmd: '/remove-file', desc: 'remove file from context' },
        { cmd: '/focus', desc: 'focus on specific files' },
        { cmd: '/clear-focus', desc: 'clear file focus' },
        { cmd: '/quality', desc: 'analyze code quality' },
        { cmd: '/refactor', desc: 'refactor code' },
        { cmd: '/search', desc: 'web search query' },
        { cmd: '/docs', desc: 'show docs' },
        { cmd: '/help', desc: 'show commands' },
        { cmd: '/clear', desc: 'clear history' },
        { cmd: '/clearsession', desc: 'clear session' },
        { cmd: '/quit', desc: 'exit koda' },
        { cmd: '/exit', desc: 'exit koda' }
    ];
    const availableCommands = commandDefs.map(c => c.cmd);

    function completer(line) {
        return [[], line];
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colorize('> ', 'cyan'),
        completer: completer
    });
    // Expose the main readline instance so promptConfirmation can pause
    // it while waiting on y/n/s input — otherwise both the readline and
    // our stdin listener race to consume the same keystrokes.
    global.__kodaMainRl = rl;

    // Live suggestion state
    let currentSuggestion = '';
    let suggestionVisible = false;
    let tabCycleIndex = -1;
    let tabCycleOptions = [];
    let lastTabLine = '';

    // Clear the inline suggestion from display
    function clearSuggestion() {
        if (suggestionVisible && currentSuggestion) {
            // Move cursor forward past suggestion, then clear back
            const len = currentSuggestion.length;
            process.stdout.write('\x1b[' + len + 'C'); // Move right
            process.stdout.write('\x1b[' + len + 'D'); // Move back
            process.stdout.write('\x1b[K'); // Clear to end of line
            suggestionVisible = false;
            currentSuggestion = '';
        }
    }

    // Show inline suggestion (grayed out text after cursor)
    function showSuggestion(suggestion) {
        clearSuggestion();
        if (suggestion) {
            currentSuggestion = suggestion;
            suggestionVisible = true;
            // Write suggestion in gray, then move cursor back
            process.stdout.write(colors.gray + suggestion + colors.reset);
            process.stdout.write('\x1b[' + suggestion.length + 'D'); // Move cursor back
        }
    }

    // Get best command suggestion for current input. Returns the "rest" of
    // the first matching command so the ghost-completion renderer can draw
    // it in grey after the cursor.
    function getSuggestion(line) {
        if (!line || !line.startsWith('/')) return null;

        const trimmed = line.trim();
        if (trimmed === '/') {
            return availableCommands[0].substring(1);
        }

        if (trimmed.length <= 1) return null;

        const matches = availableCommands.filter(cmd => cmd.startsWith(trimmed));
        if (matches.length === 0) return null;
        if (matches.length === 1) {
            return matches[0] !== trimmed
                ? matches[0].substring(trimmed.length)
                : null;
        }

        // Multiple matches: return common prefix beyond what's typed
        const first = matches[0];
        let commonLen = trimmed.length;
        for (let i = trimmed.length; i < first.length; i++) {
            if (matches.every(m => m[i] === first[i])) commonLen++;
            else break;
        }
        return commonLen > trimmed.length
            ? first.substring(trimmed.length, commonLen)
            : null;
    }

    // Custom TAB handler - complete the suggestion or cycle options
    const originalTabComplete = rl._tabComplete.bind(rl);
    rl._tabComplete = function() {
        const currentLine = rl.line || '';
        const trimmed = currentLine.trim();

        // If there's a visible suggestion, complete it
        if (suggestionVisible && currentSuggestion) {
            rl.line = currentLine + currentSuggestion;
            rl.cursor = rl.line.length;
            clearSuggestion();
            rl._refreshLine();

            // Show next suggestion if available
            const nextSuggestion = getSuggestion(rl.line);
            if (nextSuggestion) {
                showSuggestion(nextSuggestion);
            }
            return;
        }

        // Handle "/" - cycle through all commands
        if (trimmed === '/') {
            if (lastTabLine !== currentLine) {
                tabCycleIndex = -1;
                tabCycleOptions = availableCommands;
            }
            tabCycleIndex = (tabCycleIndex + 1) % tabCycleOptions.length;
            rl.line = tabCycleOptions[tabCycleIndex];
            rl.cursor = rl.line.length;
            rl._refreshLine();
            lastTabLine = rl.line;
            return;
        }

        // Handle partial commands - cycle through matches
        if (trimmed.startsWith('/') && trimmed.length > 1) {
            const hits = availableCommands.filter(cmd => cmd.startsWith(trimmed));
            if (hits.length === 1) {
                rl.line = hits[0];
                rl.cursor = hits[0].length;
                rl._refreshLine();
            } else if (hits.length > 1) {
                if (lastTabLine !== currentLine) {
                    tabCycleIndex = -1;
                    tabCycleOptions = hits;
                }
                tabCycleIndex = (tabCycleIndex + 1) % tabCycleOptions.length;
                rl.line = tabCycleOptions[tabCycleIndex];
                rl.cursor = rl.line.length;
                rl._refreshLine();
                lastTabLine = rl.line;
            }
            return;
        }

        // Reset for non-commands
        lastTabLine = '';
        tabCycleIndex = -1;
        tabCycleOptions = [];
    };

    // Hook into _ttyWrite to show live suggestions as user types
    const originalTtyWrite = rl._ttyWrite.bind(rl);
    rl._ttyWrite = function(s, key) {
        // Reset tab cycle on non-tab keys
        if (key && key.name !== 'tab') {
            lastTabLine = '';
            tabCycleIndex = -1;
            tabCycleOptions = [];
        }

        // Just delegate — the _refreshLine hook below will re-render the
        // ghost suggestion after readline redraws the prompt line. Doing it
        // there instead of here is more reliable because readline's own
        // `clearScreenDown` inside _refreshLine would otherwise wipe any
        // suggestion we wrote up front.
        suggestionVisible = false;
        currentSuggestion = '';
        return originalTtyWrite(s, key);
    };

    // Always redraw the inline suggestion after readline's own line refresh.
    // This is the key to the ghost-completion working reliably — readline
    // calls _refreshLine on every keystroke, so we piggy-back on it.
    const originalRefreshLine = rl._refreshLine.bind(rl);
    rl._refreshLine = function() {
        originalRefreshLine();
        const line = rl.line || '';
        if (!line.startsWith('/')) return;
        const suggestion = getSuggestion(line);
        if (!suggestion) return;
        // Render ghost text in gray, then move the cursor back so the
        // user's next keystroke overwrites the suggestion naturally.
        currentSuggestion = suggestion;
        suggestionVisible = true;
        process.stdout.write(colors.gray + suggestion + colors.reset);
        process.stdout.write('\x1b[' + suggestion.length + 'D');
    };


    rl.prompt();

    // Paste detection: buffer lines that arrive within 50ms and combine them
    let pasteBuffer = [];
    let pasteTimeout = null;
    let pendingPasteInput = null;  // Holds paste content waiting for user to press Enter

    async function processInput(input) {
        // Handle auth flow
        if (authState) {
            if (authState === 'url') {
                authData.apiUrl = input || 'https://localhost:3001';
                authState = 'key';
                addToHistory('system', 'API Key:');
                displayChatHistory();
                rl.setPrompt(colorize('API Key: ', 'yellow'));
                rl.prompt();
                return;
            } else if (authState === 'key') {
                authData.apiKey = input;
                authState = 'secret';
                addToHistory('system', 'API Secret:');
                displayChatHistory();
                rl.setPrompt(colorize('API Secret: ', 'yellow'));
                rl.prompt();
                return;
            } else if (authState === 'secret') {
                authData.apiSecret = input;
                authState = null;

                // Test connection and save
                addToHistory('system', 'Testing connection...');
                displayChatHistory();

                const testApi = new AgentAPI(authData.apiUrl, authData.apiKey, authData.apiSecret);
                const result = await testApi.getAgents();

                if (result.success) {
                    saveConfig(authData);
                    api = testApi;
                    // Fetch API key usage stats
                    await updateApiKeyUsage(api);
                    addToHistory('system', '✓ Authentication configured successfully!');
                    addToHistory('system', `Config saved to ${CONFIG_FILE}`);
                    if (apiKeyUsage.name) {
                        addToHistory('system', `API Key: ${apiKeyUsage.name}`);
                    }
                } else {
                    addToHistory('system', `✗ Connection failed: ${result.error}`);
                    addToHistory('system', 'Configuration not saved.');
                }

                displayChatHistory();
                rl.setPrompt(colorize('> ', 'cyan'));
                rl.prompt();
                return;
            }
        }

        if (!input) {
            rl.prompt();
            return;
        }

        // Check for "y"/"yes" input after a web mode error - user might be confused
        const lowerInput = input.toLowerCase().trim();
        if (lastWebModeError && (lowerInput === 'y' || lowerInput === 'yes')) {
            // User typed "y" after web mode error - they probably expected a confirmation
            addToHistory('system', 'There\'s no pending confirmation. To enable web search mode, type /web');
            displayChatHistory();
            rl.prompt();
            return;
        }

        // Clear web mode error flag when user sends a real message
        lastWebModeError = false;

        try {
            // Check if it's a command
            if (input.startsWith('/')) {
                const [command, ...args] = input.split(/\s+/);

                // Special case: just "/" shows interactive menu
                if (input === '/') {
                    await showCommandMenu();
                    rl.prompt();
                    return;
                }

                switch (command) {
                    case '/auth':
                        // Start inline auth flow
                        authState = 'url';
                        authData = {};
                        addToHistory('system', '━━━ Authentication Setup ━━━');
                        addToHistory('system', 'API URL (press enter for default: https://localhost:3001):');
                        displayChatHistory();
                        rl.setPrompt(colorize('API URL: ', 'yellow'));
                        rl.prompt();
                        return;

                    case '/init':
                        await handleInit(api);
                        break;

                    case '/project':
                        await handleProject(args);
                        break;

                    case '/cwd':
                        await handleCwd();
                        break;

                    case '/web':
                    case '/websearch':
                    case '/ws':
                        // Toggle websearch mode
                        websearchMode = !websearchMode;
                        lastWebModeError = false; // Clear web mode error flag
                        const webStatus = websearchMode ? 'enabled' : 'disabled';
                        const webIcon = websearchMode ? '[web]' : '[ ]';
                        const webColor = websearchMode ? 'green' : 'yellow';
                        addToHistory('system', `${webIcon} Web search ${colorize(webStatus, webColor)}`);
                        if (websearchMode) {
                            addToHistory('system', colorize('Queries will include live web results', 'dim'));
                        }
                        displayChatHistory();
                        break;

                    case '/help':
                        await handleHelp();
                        break;

                    case '/clear':
                        handleClear();
                        break;

                    case '/clearsession':
                        handleClearSession();
                        break;

                    case '/files':
                        await handleFiles();
                        break;

                    case '/add-file':
                        await handleAddFile(args);
                        break;

                    case '/remove-file':
                        await handleRemoveFile(args);
                        break;

                    case '/focus':
                        await handleFocus(args);
                        break;

                    case '/clear-focus':
                        await handleClearFocus();
                        break;

                    case '/quality':
                        await handleQuality(args);
                        break;

                    case '/refactor':
                        await handleRefactor(args);
                        break;

                    case '/search':
                    case '/websearch':
                        if (!api) {
                            addToHistory('system', 'Not authenticated. Run /auth first.');
                            displayChatHistory();
                        } else {
                            await handleSearch(api, args);
                        }
                        break;

                    case '/docs':
                        if (!api) {
                            addToHistory('system', 'Not authenticated. Run /auth first.');
                            displayChatHistory();
                        } else {
                            await handleDocs(api, args);
                        }
                        break;

                    case '/exit':
                    case '/quit':
                        logDim('Goodbye!');
                        process.exit(0);
                        break;

                    default:
                        addToHistory('system', `Unknown command: ${command}. Type /help for commands.`);
                        displayChatHistory();
                }
            } else {
                if (!api) {
                    addToHistory('system', 'Not authenticated. Run /auth first to chat with AI.');
                    displayChatHistory();
                } else {
                    await handleChat(api, input);
                }
            }
        } catch (error) {
            addToHistory('system', `Error: ${error.message}`);
            displayChatHistory();
        }

        rl.prompt();
    }

    rl.on('line', async (line) => {
        const input = line.trim();

        // If we have a pending paste and user just pressed Enter, process the paste
        if (pendingPasteInput !== null && !input) {
            const pasteToProcess = pendingPasteInput;
            pendingPasteInput = null;

            // Clear readline buffer
            rl.line = '';
            rl.cursor = 0;

            await processInput(pasteToProcess);
            return;
        }

        // If we have a pending paste but user typed something, cancel the paste and process the new input
        if (pendingPasteInput !== null && input) {
            pendingPasteInput = null;
            addToHistory('system', colorize('Previous paste cancelled.', 'dim'));
            // Fall through to process the new input
        }

        // Clear any existing paste timeout
        if (pasteTimeout) {
            clearTimeout(pasteTimeout);
            pasteTimeout = null;
        }

        // Add line to paste buffer
        pasteBuffer.push(input);

        // Set timeout to detect paste
        // If more lines arrive within 50ms, they'll be combined (paste detection)
        pasteTimeout = setTimeout(async () => {
            const bufferLength = pasteBuffer.length;
            const combinedInput = pasteBuffer.join('\n');
            pasteBuffer = [];
            pasteTimeout = null;

            // If it's a multi-line paste, show it and wait for Enter
            if (bufferLength > 1) {
                // Store the paste content
                pendingPasteInput = combinedInput;

                // Clear the readline buffer to prevent text bleeding
                rl.line = '';
                rl.cursor = 0;

                // Add to history so user can see what they pasted
                addToHistory('user', combinedInput);
                addToHistory('system', colorize('Press Enter to send, or type a command...', 'dim'));
                displayChatHistory();
                rl.prompt();
            } else {
                // Single line - process immediately as before
                await processInput(combinedInput);
            }
        }, 50);
    });

    rl.on('close', () => {
        log('');
        process.exit(0);
    });

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
        log('\nUse /quit to exit koda');
        rl.prompt();
    });
}

// -----------------------------------------------------------------------------
// Entry point: single-shot mode or interactive REPL.
//
// Single-shot usage:
//   koda -p "question"                     Ask a question, print the answer, exit.
//   koda --prompt "question"               Same, long form.
//   echo "question" | koda -p -            Read the question from stdin.
//   KODA_API_KEY=... KODA_API_SECRET=... koda -p "question"
//                                          Override credentials without touching config.
// -----------------------------------------------------------------------------
const _kodaArgv = process.argv.slice(2);
const _kodaPromptIdx = _kodaArgv.findIndex(a => a === '-p' || a === '--prompt');

async function runSingleShot(prompt) {
    // Single-shot mode is non-interactive by definition: auto-accept any
    // confirmation prompts that would otherwise block waiting on stdin.
    // Users who want strict manual approval can set KODA_YES=0.
    global.__kodaAutoConfirm = true;

    // Allow env-var overrides so tests and CI can bypass the encrypted config.
    const envKey = process.env.KODA_API_KEY;
    const envSecret = process.env.KODA_API_SECRET;
    const envUrl = process.env.KODA_API_URL || 'https://localhost:3001';

    let api;
    if (envKey && envSecret) {
        api = new AgentAPI(envUrl, envKey, envSecret);
    } else {
        const cfg = loadConfig();
        if (!cfg) {
            console.error('Error: no koda config found. Run `koda` and then `/auth`, or set KODA_API_KEY and KODA_API_SECRET.');
            process.exit(2);
        }
        api = new AgentAPI(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
    }

    // Suppress the interactive UI: single-shot mode just prints the final
    // answer and exits. handleChat writes streaming tokens via stdout.write
    // and would also redraw the chat history via displayChatHistory, which
    // is noisy for scripted testing. Redirect displayChatHistory to a no-op.
    if (typeof displayChatHistory === 'function') {
        // eslint-disable-next-line no-global-assign
        displayChatHistory = function () {};
    }

    try {
        // Seed the working set with project docs before the single-shot
        // query runs. Without this, single-shot koda has no awareness of
        // README.md / CLAUDE.md / AGENTS.md / koda.md in the cwd — which
        // is the whole point of running it inside a project.
        autoLoadProjectContext();

        // handleChat does its own streaming output; we just wait for it and
        // then print the cleaned final assistant message once, so test
        // harnesses can grep for it reliably.
        await handleChat(api, prompt);

        const last = [...chatHistory].reverse().find(m => m.role === 'assistant');
        if (last && last.content) {
            const cleaned = cleanSkillSyntax(last.content).trim();
            process.stdout.write('\n--- KODA RESPONSE ---\n');
            // Show the markdown-rendered form by default; test harnesses
            // that need the raw text can strip ANSI codes from this output.
            process.stdout.write(renderMarkdown(cleaned) + '\n');
            process.stdout.write('--- END RESPONSE ---\n');
        } else {
            process.stderr.write('\n(no response produced)\n');
        }
        process.exit(0);
    } catch (err) {
        console.error('\nkoda error:', err && err.message ? err.message : err);
        process.exit(1);
    }
}

if (_kodaPromptIdx !== -1) {
    let prompt = _kodaArgv.slice(_kodaPromptIdx + 1).join(' ').trim();
    if (prompt === '-' || prompt === '') {
        // Read from stdin
        let stdinBuf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { stdinBuf += chunk; });
        process.stdin.on('end', () => {
            const p = stdinBuf.trim();
            if (!p) {
                console.error('Usage: koda -p "your question"   or   echo "q" | koda -p -');
                process.exit(1);
            }
            runSingleShot(p);
        });
    } else {
        runSingleShot(prompt);
    }
} else {
    // Start the interactive shell
    startShell();
}
