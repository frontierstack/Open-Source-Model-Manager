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
let currentMode = 'standalone'; // 'standalone', 'agent', or 'collab'
let websearchMode = false; // Web search enhancement mode
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

// Collaboration mode state
let collabAgents = []; // Array of selected agent IDs for collaboration
let collabContext = []; // Shared context between collaborating agents

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
    brain: ['🧠', '💭', '💡', '✨']
};

// Thinking message variations for variety
const thinkingMessages = [
    'Thinking',
    'Processing',
    'Analyzing',
    'Computing',
    'Reasoning'
];

// Current animation state
let activeAnimation = null;
let animationInterval = null;
let animationFrameIndex = 0;
let animationStartTime = 0;

// Start an animated spinner with a message
function startAnimation(message, style = 'dots') {
    stopAnimation(); // Stop any existing animation

    const frames = spinnerFrames[style] || spinnerFrames.dots;
    animationFrameIndex = 0;
    animationStartTime = Date.now();

    // Store the initial cursor position by saving the message line
    activeAnimation = {
        message,
        frames,
        style,
        line: ''
    };

    // Write initial frame
    const frame = frames[0];
    activeAnimation.line = `${colorize(frame, 'cyan')} ${colorize(message, 'dim')}`;
    process.stdout.write(activeAnimation.line);

    // Start the animation interval
    animationInterval = setInterval(() => {
        if (!activeAnimation) return;

        animationFrameIndex = (animationFrameIndex + 1) % frames.length;
        const frame = frames[animationFrameIndex];
        const elapsed = ((Date.now() - animationStartTime) / 1000).toFixed(1);

        // Clear the current line and rewrite
        process.stdout.write('\r\x1b[K'); // Clear line
        activeAnimation.line = `${colorize(frame, 'cyan')} ${colorize(message, 'dim')} ${colorize(`(${elapsed}s)`, 'gray')}`;
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
function updateAnimationMessage(newMessage) {
    if (!activeAnimation) return;

    activeAnimation.message = newMessage;
    const frame = activeAnimation.frames[animationFrameIndex];
    const elapsed = ((Date.now() - animationStartTime) / 1000).toFixed(1);

    process.stdout.write('\r\x1b[K');
    activeAnimation.line = `${colorize(frame, 'cyan')} ${colorize(newMessage, 'dim')} ${colorize(`(${elapsed}s)`, 'gray')}`;
    process.stdout.write(activeAnimation.line);
}

// Show a brief completion indicator
function showCompletionFlash(message, success = true) {
    const icon = success ? colorize('✓', 'green') : colorize('✗', 'red');
    const color = success ? 'green' : 'red';
    process.stdout.write(`\r\x1b[K${icon} ${colorize(message, 'dim')}\n`);
}

// Get a random thinking message for variety
function getRandomThinkingMessage() {
    return thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
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

// Format code blocks cleanly without borders for easy copying
function formatCodeBlocks(content) {
    // Match code blocks with ```language or just ```
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

    return content.replace(codeBlockRegex, (match, language, code) => {
        const lang = language || 'code';
        const lines = code.trimEnd().split('\n');

        // Clean header with language label
        let formatted = '\n' + colorize('━━━ ', 'dim') + colorize(`${lang.toUpperCase()}`, 'yellow') + colorize(' ━━━', 'dim') + '\n';

        // Code lines - plain text for easy copying
        for (const line of lines) {
            formatted += line + '\n';
        }

        // Footer separator
        formatted += colorize('━'.repeat(Math.min(60, lang.length + 10)), 'dim') + '\n';
        return formatted;
    });
}

// Display colored diff
function displayDiff(oldContent, newContent, filePath) {
    const diff = Diff.createPatch(filePath, oldContent || '', newContent || '', 'original', 'modified');
    const lines = diff.split('\n');

    log('\n' + colorize('━━━ DIFF PREVIEW ━━━', 'yellow'));
    log(colorize(`File: ${filePath}`, 'cyan'));
    log(colorize('━'.repeat(60), 'dim'));

    for (const line of lines.slice(4)) { // Skip header lines
        if (line.startsWith('+') && !line.startsWith('+++')) {
            log(colorize(line, 'green')); // Added lines
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            log(colorize(line, 'red')); // Removed lines
        } else if (line.startsWith('@@')) {
            log(colorize(line, 'cyan')); // Line numbers
        } else {
            logDim(line); // Context lines
        }
    }

    log(colorize('━'.repeat(60), 'dim') + '\n');
}

// Prompt user for confirmation
// Uses raw stdin to avoid conflicts with main readline interface
function promptConfirmation(message) {
    return new Promise((resolve) => {
        // Save terminal state
        const wasRaw = process.stdin.isRaw;
        if (process.stdin.setRawMode) {
            process.stdin.setRawMode(false);
        }

        // Write prompt
        process.stdout.write(colorize(`${message} (y/n/s=skip): `, 'yellow'));

        // Listen for a single line of input
        const onData = (data) => {
            const answer = data.toString().trim().toLowerCase();

            // Remove listener
            process.stdin.removeListener('data', onData);

            // Restore terminal state
            if (process.stdin.setRawMode && wasRaw) {
                process.stdin.setRawMode(true);
            }

            // Resolve based on answer
            if (answer === 'y' || answer === 'yes') {
                resolve('yes');
            } else if (answer === 's' || answer === 'skip') {
                resolve('skip');
            } else {
                resolve('no');
            }
        };

        // Attach listener
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

// Build context from working files
function buildWorkingFilesContext() {
    if (workingFiles.size === 0) {
        return '';
    }

    // Filter files based on focus mode
    let filesToInclude = Array.from(workingFiles.entries());
    if (focusMode && focusFiles.size > 0) {
        filesToInclude = filesToInclude.filter(([filePath]) => focusFiles.has(filePath));
    }

    if (filesToInclude.length === 0) {
        return '';
    }

    let context = '\n[Working Files Context]\n';
    for (const [filePath, info] of filesToInclude) {
        const relativePath = filePath.replace(userWorkingDirectory, '.');
        context += `\n--- ${relativePath} ---\n`;
        context += info.content;
        context += '\n';
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

// Display chat history
function displayChatHistory() {
    console.clear();

    // Header
    log('  ██╗  ██╗ ██████╗ ██████╗  █████╗ ', 'cyan');
    log('  ██║ ██╔╝██╔═══██╗██╔══██╗██╔══██╗', 'cyan');
    log('  █████╔╝ ██║   ██║██║  ██║███████║', 'cyan');
    log('  ██╔═██╗ ██║   ██║██║  ██║██╔══██║', 'cyan');
    log('  ██║  ██╗╚██████╔╝██████╔╝██║  ██║', 'cyan');
    log('  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝', 'cyan');
    logDim('  Your AI project assistant');
    logDim('  Type /help for commands | /exit to quit\n');

    // Display chat messages
    if (chatHistory.length === 0) {
        logDim('Start chatting! Type a message or use /help for commands.\n');
    } else {
        for (const msg of chatHistory) {
            if (msg.role === 'user') {
                // Format multi-line user messages in a clean, contained box
                const lines = msg.content.split('\n');
                if (lines.length > 1) {
                    // Multi-line message - show in a contained format
                    log(`${colorize('You:', 'green')}`);
                    const boxWidth = Math.min(process.stdout.columns - 4 || 76, 120);
                    log(colorize('┌' + '─'.repeat(boxWidth - 2) + '┐', 'dim'));
                    for (const line of lines) {
                        // Wrap long lines
                        if (line.length > boxWidth - 4) {
                            const chunks = line.match(new RegExp(`.{1,${boxWidth - 4}}`, 'g')) || [line];
                            for (const chunk of chunks) {
                                log(colorize('│ ', 'dim') + chunk.padEnd(boxWidth - 4) + colorize(' │', 'dim'));
                            }
                        } else {
                            log(colorize('│ ', 'dim') + line.padEnd(boxWidth - 4) + colorize(' │', 'dim'));
                        }
                    }
                    log(colorize('└' + '─'.repeat(boxWidth - 2) + '┘', 'dim'));
                } else {
                    // Single line message - show inline
                    log(`${colorize('You:', 'green')} ${msg.content}`);
                }
            } else if (msg.role === 'assistant' || msg.role === 'assistant-streaming') {
                // Clean any skill syntax before displaying
                const cleanedContent = cleanSkillSyntax(msg.content);
                if (cleanedContent) {
                    const formattedContent = formatCodeBlocks(cleanedContent);
                    log(`${colorize('Koda:', 'cyan')} ${formattedContent}`);
                }
            } else if (msg.role === 'system') {
                logDim(msg.content);
            }
        }
        console.log('');
    }

    // Bottom status bar
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

// Display status bar with token and context stats
function displayStatusBar() {
    const statusParts = [];

    // Mode indicator (display "agent collab" instead of "collab")
    const displayMode = currentMode === 'collab' ? 'agent collab' :
                       currentMode === 'collab-select' ? 'agent collab (selecting)' : currentMode;
    statusParts.push(colorize(`Mode: ${displayMode}`, 'cyan'));

    // Web search indicator - show prominently when enabled
    if (websearchMode) {
        statusParts.push(colorize('🔍 Web', 'green'));
    }

    // Last usage with tokens/sec
    if (lastTokenUsage.total > 0) {
        let tokensInfo = `Last: ${lastTokenUsage.total} tokens`;
        if (lastTokensPerSecond > 0) {
            tokensInfo += ` (${lastTokensPerSecond.toFixed(1)} tok/s)`;
        }
        statusParts.push(colorize(tokensInfo, 'white'));
    }

    // Context window info
    if (contextWindowLimit > 0) {
        statusParts.push(colorize(`Context: ${contextWindowUsed}/${contextWindowLimit}`, 'white'));
    }

    // API key daily token usage (if available)
    if (apiKeyUsage.rateLimitTokens) {
        const tokensLeft = apiKeyUsage.rateLimitTokens - apiKeyUsage.dailyTokens;
        const percentUsed = parseFloat(apiKeyUsage.tokenUsagePercentage || 0);
        const percentLeft = (100 - percentUsed).toFixed(1);
        const tokensLeftColor = percentLeft < 20 ? 'red' : percentLeft < 40 ? 'yellow' : 'green';

        statusParts.push(colorize(
            `Daily: ${apiKeyUsage.dailyTokens.toLocaleString()}/${apiKeyUsage.rateLimitTokens.toLocaleString()}`,
            'white'
        ));
        statusParts.push(colorize(`Remaining: ${percentLeft}%`, tokensLeftColor));
    }

    // Total tokens used in session
    if (totalTokensUsed > 0) {
        statusParts.push(colorize(`Session: ${totalTokensUsed} tokens`, 'white'));
    }

    if (statusParts.length > 0) {
        const separator = colorize(' │ ', 'dim');
        log(colorize('─'.repeat(80), 'dim'));
        log(statusParts.join(separator));
    }
    console.log('');
}

// Track if we're currently streaming (to avoid flicker)
let isStreaming = false;
let lastStreamedMessage = '';
let lastCleanedMessage = ''; // Track the cleaned version for comparison

// Helper function to clean skill syntax from response text
function cleanSkillSyntax(text) {
    return text
        // Remove complete skill calls: [SKILL:name(params)]
        .replace(/\[SKILL:\w+\([^\]]*\)\]/g, '')
        // Remove partial/incomplete skill calls during streaming: [SKILL:... (no closing bracket)
        .replace(/\[SKILL:[^\]]*$/g, '')
        // Remove truncated skill markers during streaming: [S, [SK, [SKI, [SKIL, [SKILL (without colon)
        .replace(/\[S(?:K(?:I(?:L(?:L)?)?)?)?$/g, '')
        // Remove variant formats with hyphen: [SKILL - ...] or [SKILL- ...]
        .replace(/\[SKILL\s*-[^\]]*\]/g, '')
        // Remove partial variant formats during streaming: [SKILL - ... (no closing bracket)
        .replace(/\[SKILL\s*-[^\]]*$/g, '')
        // Remove JSON skill format: ```json { "skill": ... } ```
        .replace(/```json\s*\n?\s*\{[\s\S]*?"skill"[\s\S]*?\}\s*\n?```/g, '')
        // Remove partial JSON skill blocks during streaming
        .replace(/```json\s*\n?\s*\{[^`]*$/g, '')
        // Remove inline JSON: {"skill": "...", "params": {...}}
        .replace(/\{"skill"\s*:\s*"\w+"\s*,\s*"params"\s*:\s*\{[^}]+\}\}/g, '')
        // Remove partial inline JSON during streaming
        .replace(/\{"skill"\s*:\s*"[^"]*"?\s*,?\s*"?params"?\s*:?\s*\{?[^}]*$/g, '')
        // Clean up whitespace artifacts from skill removal
        // Remove lines that are only whitespace
        .replace(/^\s*$/gm, '')
        // Collapse multiple consecutive newlines to max 2
        .replace(/\n{3,}/g, '\n\n')
        // Remove trailing spaces on lines
        .replace(/[ \t]+$/gm, '')
        .trim();
}

// Update streaming message without full screen refresh (reduces flicker)
function updateStreamingMessage(message) {
    if (!isStreaming) return;

    // Clean skill syntax from the message before displaying
    const cleanedMessage = cleanSkillSyntax(message);

    // Only display if there's actual content (not just skill calls)
    if (!cleanedMessage) {
        return;
    }

    const formattedContent = formatCodeBlocks(cleanedMessage);

    // On first message, write the prefix and content
    if (lastCleanedMessage === '') {
        process.stdout.write(colorize('Koda:', 'cyan') + ' ');
        process.stdout.write(formattedContent);
        lastStreamedMessage = message;
        lastCleanedMessage = formattedContent;
    } else {
        // Only write the new content that was added since last update
        // This prevents duplication by only appending new tokens
        if (formattedContent.startsWith(lastCleanedMessage)) {
            const newContent = formattedContent.substring(lastCleanedMessage.length);
            process.stdout.write(newContent);
            lastStreamedMessage = message;
            lastCleanedMessage = formattedContent;
        } else if (formattedContent === lastCleanedMessage) {
            // Content unchanged after cleaning - no need to write anything
            lastStreamedMessage = message;
        } else {
            // Content changed unexpectedly - append new content without duplicate prefix
            // This can happen when skill syntax is stripped mid-stream
            // Use carriage return to go back to start of line and rewrite
            const lines = lastCleanedMessage.split('\n');
            const lastLine = lines[lines.length - 1];
            // Move cursor back to start of last line and clear it
            process.stdout.write('\r\x1b[K');
            // Rewrite just the last line portion of the new content
            const newLines = formattedContent.split('\n');
            if (newLines.length === lines.length) {
                // Same number of lines - just rewrite last line
                const prefix = lines.length === 1 ? colorize('Koda:', 'cyan') + ' ' : '';
                process.stdout.write(prefix + newLines[newLines.length - 1]);
            } else {
                // Different structure - write full content on new line
                process.stdout.write('\n' + formattedContent);
            }
            lastStreamedMessage = message;
            lastCleanedMessage = formattedContent;
        }
    }
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
    async chatStream(message, model = null, maxTokens = 4000, onToken, onComplete) {
        lastApiCallStartTime = Date.now();

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
            };

            const postData = JSON.stringify({ message, model, maxTokens });

            return new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    if (res.statusCode !== 200) {
                        let errorData = '';
                        res.on('data', (chunk) => {
                            errorData += chunk;
                        });
                        res.on('end', () => {
                            try {
                                const error = JSON.parse(errorData);
                                reject(new Error(error.error || 'Request failed'));
                            } catch (e) {
                                reject(new Error('Request failed'));
                            }
                        });
                        return;
                    }

                    let buffer = '';
                    let fullResponse = '';
                    let tokens = null;

                    res.on('data', (chunk) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.slice(6));

                                    if (data.error) {
                                        reject(new Error(data.error));
                                        return;
                                    }

                                    if (data.done) {
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
                                    } else if (data.token) {
                                        fullResponse += data.token;
                                        if (onToken) {
                                            onToken(data.token);
                                        }
                                    }
                                } catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                    });

                    res.on('end', () => {
                        if (!tokens) {
                            resolve({
                                success: true,
                                data: { response: fullResponse, tokens: null }
                            });
                        }
                    });

                    res.on('error', (error) => {
                        reject(error);
                    });
                });

                req.on('error', (error) => {
                    reject(error);
                });

                req.write(postData);
                req.end();
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

    // Pattern 1: [SKILL:name(params)]
    // Use a more robust pattern that captures until )] to handle params with parentheses
    const bracketPattern = /\[SKILL:(\w+)\(([^[\]]*)\)\]/g;
    let match;
    while ((match = bracketPattern.exec(response)) !== null) {
        const skillName = match[1];
        const paramsStr = match[2];
        const params = {};

        // Parse key="value" pairs with support for escaped quotes
        // Matches: key="value with \"escaped\" quotes"
        const paramPattern = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
        let paramMatch;
        while ((paramMatch = paramPattern.exec(paramsStr)) !== null) {
            // Unescape string values to convert \n to actual newlines, etc.
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

    return skillCalls;
}

// Detect incomplete/malformed skill calls that the AI started but didn't finish
function detectMalformedSkillCalls(response) {
    const issues = [];

    // Check for incomplete bracket format: [SKILL:name( without closing )]
    const incompletePattern = /\[SKILL:(\w+)\([^[\]]*(?!\)\])/g;
    let match;
    while ((match = incompletePattern.exec(response)) !== null) {
        // Make sure this isn't a complete skill call
        const fullMatch = match[0];
        if (!fullMatch.includes(')]')) {
            issues.push({
                type: 'incomplete_bracket',
                skillName: match[1],
                context: fullMatch.substring(0, 50) + '...'
            });
        }
    }

    // Check for [SKILL: that's missing the closing bracket entirely
    const openBracketPattern = /\[SKILL:\w+\([^\]]*$/g;
    if (openBracketPattern.test(response)) {
        issues.push({
            type: 'missing_close_bracket',
            context: 'Skill call started but not completed'
        });
    }

    // Check for skill calls with malformed parameters (missing quotes)
    const malformedParamPattern = /\[SKILL:\w+\([^"]*=[^"]*\)\]/g;
    while ((match = malformedParamPattern.exec(response)) !== null) {
        // This might catch valid calls, so we need to verify
        const paramsStr = match[0];
        if (!paramsStr.includes('="')) {
            issues.push({
                type: 'malformed_params',
                context: paramsStr
            });
        }
    }

    return issues;
}

// Build system prompt with skill instructions
function buildSkillSystemPrompt(skills, mode = 'standalone') {
    if (!skills || skills.length === 0) {
        return '';
    }

    const enabledSkills = skills.filter(s => s.enabled);
    if (enabledSkills.length === 0) {
        return '';
    }

    // Only include the most useful skills to avoid overwhelming the context
    const prioritySkills = [
        // File operations
        'create_file', 'read_file', 'update_file', 'delete_file', 'create_directory', 'delete_directory', 'list_directory', 'append_to_file', 'tail_file', 'head_file',
        // Process management
        'list_processes', 'kill_process', 'start_process',
        // System info
        'system_info', 'disk_usage', 'get_uptime', 'list_ports', 'list_services',
        // Git operations
        'git_status', 'git_diff', 'git_log', 'git_branch',
        // Environment
        'get_env_var', 'set_env_var', 'which_command'
    ];
    const filteredSkills = enabledSkills.filter(s => prioritySkills.includes(s.name));
    const skillsToShow = filteredSkills.length > 0 ? filteredSkills : enabledSkills.slice(0, 5);

    let prompt = `You are Koda, a helpful AI assistant. You can have normal conversations, answer questions, help with coding, math, explanations, and any other topics.

You have the ability to execute file, process, system, git, and environment operations directly when needed. When the user asks about system info, processes, git status, or file operations, use the skill format below instead of suggesting commands.

IMPORTANT FILE PLACEMENT RULES:
- User's current working directory: ${userWorkingDirectory}
- When creating project files, ALWAYS organize them in a descriptive subdirectory based on the project type
- Create directory names from the user's request (e.g., "web_app", "api_server", "data_analysis")
- Use absolute paths starting with ${userWorkingDirectory}/
- Structure: ${userWorkingDirectory}/<project_name>/<files>
- NEVER use container-internal paths like /usr/src/app/ or /var/lib/
- Examples:
  * Web app request → ${userWorkingDirectory}/web_app/index.html
  * API project → ${userWorkingDirectory}/api_server/app.py
  * Data analysis → ${userWorkingDirectory}/data_analysis/analysis.ipynb

Available skills:
`;

    for (const skill of skillsToShow) {
        const params = skill.parameters || {};
        const paramList = Object.entries(params)
            .map(([name, type]) => `${name}: ${type}`)
            .join(', ');
        prompt += `- ${skill.name}(${paramList}): ${skill.description || ''}\n`;
    }

    prompt += `
Skill execution format:

FILE OPERATIONS:
[SKILL:create_file(filePath="${userWorkingDirectory}/<project_dir>/<filename>", content="file content here")]
[SKILL:read_file(filePath="${userWorkingDirectory}/<path_to_file>")]
[SKILL:update_file(filePath="${userWorkingDirectory}/<path_to_file>", content="updated file content here")]
[SKILL:delete_file(filePath="${userWorkingDirectory}/<path_to_file>")]
[SKILL:create_directory(dirPath="${userWorkingDirectory}/<directory>")]
[SKILL:list_directory(dirPath="${userWorkingDirectory}/<directory>")]

PROCESS MANAGEMENT:
[SKILL:list_processes(sort_by="cpu", limit="20")]
[SKILL:kill_process(pid="1234")]
[SKILL:start_process(command="python", args="['script.py']")]

SYSTEM INFO:
[SKILL:system_info()]
[SKILL:disk_usage(path="/")]
[SKILL:get_uptime()]
[SKILL:list_ports()]
[SKILL:list_services()]

GIT OPERATIONS:
[SKILL:git_status()]
[SKILL:git_diff(staged="false")]
[SKILL:git_log(limit="10")]
[SKILL:git_branch()]

ENVIRONMENT:
[SKILL:get_env_var(name="PATH")]
[SKILL:set_env_var(name="MY_VAR", value="my_value")]
[SKILL:which_command(command="node")]

CRITICAL EXECUTION RULES:
1. ONLY use the skills listed above - do not invent non-existent skills. Available skills: create_file, read_file, update_file, delete_file, create_directory, delete_directory, list_directory, move_file, list_processes, kill_process, start_process, system_info, disk_usage, get_uptime, list_ports, list_services, git_status, git_diff, git_log, git_branch, get_env_var, set_env_var, which_command, run_python, run_bash, create_pdf, html_to_pdf, markdown_to_html.
2. DISCOVERY FIRST for fuzzy/broad requests: When the user gives an imprecise request like "delete the security folder", "remove that old file", "find the config", etc., ALWAYS use list_directory FIRST to see what actually exists, then match to their intent, then act. Example: User says "remove the cyber security directory" → first list_directory to find "cybersecurity_news/" → then delete_directory on the match.
3. When working with files, EXECUTE skills directly - don't just suggest or describe changes
4. When you identify bugs or improvements in code you created, use update_file to fix them - don't just show corrected code
5. If you say "let me fix that" or "here's the corrected version", you MUST execute update_file, not just display the code
6. Intelligently choose project directory names based on what the user is building
7. When the user switches topics (e.g., from coding to summarizing an article), recognize this as a NEW request and respond to it - don't continue with the previous task
8. For non-file operations (math, coding help, explanations, general chat), respond conversationally
9. STOP LOOPING: After skills execute successfully, respond with a brief natural language confirmation - do NOT execute more skills to "verify" or "confirm" (no read_file to check, no list_directory to verify)
10. Only continue with more skills if a previous skill FAILED and you need to fix it

SKILL SYNTAX RULES - FOLLOW EXACTLY:
- Each skill call MUST be complete on a single line
- ALWAYS close brackets: [SKILL:name()] - note the )] at the end
- String parameters MUST use double quotes: param="value"
- Escape newlines in content as \\n (e.g., content="line1\\nline2")
- Escape quotes in content as \\" (e.g., content="he said \\"hello\\"")
- BAD: [SKILL:which_command(command="pip   (incomplete - missing closing ")]")
- GOOD: [SKILL:which_command(command="pip")]
- BAD: [SKILL:create_file(filePath=/path, content=text)]  (missing quotes)
- GOOD: [SKILL:create_file(filePath="/path", content="text")]

PDF/REPORT GENERATION:
[SKILL:create_pdf(outputPath="/path/to/report.pdf", title="Report Title", content="Report content here")]
[SKILL:html_to_pdf(htmlPath="/path/to/file.html", outputPath="/path/to/output.pdf")]
[SKILL:markdown_to_html(mdPath="/path/to/file.md", outputPath="/path/to/output.html", title="Title")]
- create_pdf: Creates PDF directly from text content (tries reportlab, wkhtmltopdf, enscript; falls back to HTML)
- html_to_pdf: Converts existing HTML file to PDF (tries wkhtmltopdf, weasyprint, chromium)
- markdown_to_html: Converts Markdown file to styled HTML (tries pandoc, then built-in converter)
- For complex reports: create HTML first with create_file, then convert with html_to_pdf

ADDITIONAL CAPABILITIES:
You have access to advanced development tools that you should use proactively when appropriate:

1. WEB SEARCH & DOCUMENTATION:
   - When you need current information, API docs, or external knowledge, suggest using web search
   - Example: "Let me search for the latest React 19 documentation" or "I can look up current best practices"

2. CODE ANALYSIS:
   - When analyzing code quality, you can provide insights on complexity, maintainability, and patterns
   - Consider file size, function complexity, code duplication, and best practices

3. FILE CONTEXT MANAGEMENT:
   - Track which files are relevant to the current conversation
   - When working across multiple files, maintain awareness of dependencies and imports
   - Suggest analyzing related files when making changes

4. REFACTORING SUGGESTIONS:
   - When you see opportunities to extract functions, rename symbols, or reorganize code, suggest improvements
   - Explain the benefits of proposed refactorings

Use these capabilities naturally as part of helping the user. You don't need explicit commands - just incorporate these tools into your responses when they would be helpful.
`;

    return prompt;
}

// Execute file operation skills locally (client-side)
async function executeFileOperationSkill(skillName, params) {
    try {
        switch (skillName) {
            case 'create_file':
            case 'update_file': {
                const filePath = params.filePath;
                const content = params.content || '';

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

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
                }

                const content = await fs.readFile(filePath, 'utf8');

                return {
                    success: true,
                    filePath: filePath,
                    content: content
                };
            }

            case 'delete_file': {
                const filePath = params.filePath;

                if (!filePath) {
                    return { success: false, error: 'filePath is required' };
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
                const stats = await fs.stat(dirPath);
                if (!stats.isDirectory()) {
                    return { success: false, error: `Path is a file, not a directory. Use delete_file instead: ${dirPath}` };
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

                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                const files = entries.map(entry => ({
                    name: entry.name,
                    isDirectory: entry.isDirectory(),
                    isFile: entry.isFile()
                }));

                return {
                    success: true,
                    dirPath: dirPath,
                    files: files
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
                const content = params.content || '';

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

// Execute network skills client-side
async function executeNetworkSkill(skillName, params) {
    const https = require('https');
    const http = require('http');
    const dns = require('dns').promises;
    const net = require('net');

    try {
        switch (skillName) {
            case 'fetch_url': {
                const url = params.url;
                if (!url) return { success: false, error: 'url parameter is required' };

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
                const hostname = params.hostname;
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
                const content = params.content || params.csv;
                if (!content) return { success: false, error: 'content parameter is required' };
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
                if (!content || !pattern) return { success: false, error: 'content and pattern parameters are required' };
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
                if (!content) return { success: false, error: 'content parameter is required' };
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
                const destPath = params.destPath || params.destination || '.';
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
                const destPath = params.destPath || params.destination || '.';
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
                const files = params.files;
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
                const directory = params.directory || '.';
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
                const destPath = params.destPath || params.destination;
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
                if (!filePath || search === undefined) return { success: false, error: 'filePath and search parameters are required' };

                const content = await fs.readFile(filePath, 'utf8');
                const regex = new RegExp(search, 'g');
                const newContent = content.replace(regex, replace || '');
                const count = (content.match(regex) || []).length;
                await fs.writeFile(filePath, newContent);
                return { success: true, filePath, replacements: count };
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
                const content = params.content || '';
                const title = params.title || 'Document';
                if (!outputPath) return { success: false, error: 'outputPath parameter is required' };
                if (!content) return { success: false, error: 'content parameter is required' };

                // Ensure directory exists
                const dir = path.dirname(outputPath);
                await fs.mkdir(dir, { recursive: true });

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
                        return { success: true, outputPath, message: `PDF created: ${outputPath}` };
                    }
                } catch (e) { /* Try next method */ }

                // Method 2: Use wkhtmltopdf with HTML wrapper
                try {
                    const htmlContent = `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:40px;}</style></head><body><h1>${title}</h1><pre style="white-space:pre-wrap;">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
                    const tempHtml = outputPath.replace('.pdf', '.tmp.html');
                    await fs.writeFile(tempHtml, htmlContent, 'utf8');
                    await execPromise(`wkhtmltopdf --quiet "${tempHtml}" "${outputPath}"`, { timeout: 60000 });
                    await fs.unlink(tempHtml).catch(() => {});
                    return { success: true, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* Try next method */ }

                // Method 3: Use enscript + ps2pdf for plain text
                try {
                    const tempTxt = outputPath.replace('.pdf', '.tmp.txt');
                    await fs.writeFile(tempTxt, `${title}\n${'='.repeat(title.length)}\n\n${content}`, 'utf8');
                    await execPromise(`enscript -B -p - "${tempTxt}" | ps2pdf - "${outputPath}"`, { timeout: 30000 });
                    await fs.unlink(tempTxt).catch(() => {});
                    return { success: true, outputPath, message: `PDF created: ${outputPath}` };
                } catch (e) { /* Try next method */ }

                // Method 4: Fallback - create HTML file instead
                const htmlPath = outputPath.replace('.pdf', '.html');
                const htmlContent = `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:40px;line-height:1.6;}h1{color:#333;}ul{margin:20px 0;}li{margin:10px 0;}</style></head><body><h1>${title}</h1><div>${content.replace(/\n/g, '<br>')}</div><p style="margin-top:40px;color:#666;font-size:12px;">Generated by Koda</p></body></html>`;
                await fs.writeFile(htmlPath, htmlContent, 'utf8');
                return {
                    success: true,
                    outputPath: htmlPath,
                    message: `PDF tools not available. Created HTML report instead: ${htmlPath}`,
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
                const filePath = params.filePath || params.imagePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

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
                const filePath = params.filePath;
                if (!filePath) return { success: false, error: 'filePath parameter is required' };

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
    let enabledSkillNames = new Set();
    try {
        const skillsResult = await api.getSkills();
        if (skillsResult.success && skillsResult.data) {
            enabledSkillNames = new Set(
                skillsResult.data
                    .filter(s => s.enabled)
                    .map(s => s.name)
            );
        }
    } catch (error) {
        // If we can't fetch skills, allow execution (fail open for client-side)
        enabledSkillNames = null;
    }

    for (const call of skillCalls) {
        // Check if skill is enabled before execution
        if (enabledSkillNames && !enabledSkillNames.has(call.skillName)) {
            results.push({
                skill: call.skillName,
                success: false,
                error: `Skill '${call.skillName}' is disabled`
            });
            showCompletionFlash(`${call.skillName} is disabled`, false);
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
                    success: true,
                    result: { filePath, skipped: true },
                    skipped: true
                });
                displayChatHistory();
                continue;
            }
            // If 'yes', continue with execution below
        }

        // Start user-friendly skill animation (compact, not verbose)
        const skillAction = formatSkillAction(call.skillName);
        startAnimation(skillAction, 'dots');

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

        // Stop the skill animation
        stopAnimation(true);

        if (result.success) {
            results.push({
                skill: call.skillName,
                success: true,
                result: result.data || result
            });

            // Show compact completion flash instead of verbose messages
            let completionMsg = skillAction;

            // Add brief context for file operations
            if (call.skillName === 'create_file' && (result.data?.filePath || result.filePath)) {
                const filePath = result.data?.filePath || result.filePath;
                const relativePath = filePath.replace(userWorkingDirectory, '.');
                completionMsg = `Created ${relativePath}`;
                addToWorkingSet(filePath, call.params.content);
            } else if (call.skillName === 'read_file') {
                const filePath = result.data?.filePath || result.filePath || call.params.filePath;
                const content = result.data?.content || result.content;
                const relativePath = (filePath || '').replace(userWorkingDirectory, '.');
                completionMsg = `Read ${relativePath}`;
                if (filePath && content) {
                    addToWorkingSet(filePath, content);
                }
            } else if (call.skillName === 'update_file' && (result.data?.filePath || result.filePath)) {
                const filePath = result.data?.filePath || result.filePath;
                const relativePath = filePath.replace(userWorkingDirectory, '.');
                completionMsg = `Updated ${relativePath}`;
                addToWorkingSet(filePath);
            } else if (call.skillName === 'delete_file' && (result.data?.filePath || result.filePath)) {
                const filePath = result.data?.filePath || result.filePath;
                const relativePath = filePath.replace(userWorkingDirectory, '.');
                completionMsg = `Deleted ${relativePath}`;
            } else if (call.skillName === 'web_search') {
                const count = result.data?.count || result.count || 0;
                completionMsg = `Found ${count} results`;
            } else if (call.skillName === 'git_status') {
                const branch = result.data?.branch || result.branch || '';
                completionMsg = `Git: ${branch}`;
            } else if (call.skillName === 'base64_encode' || call.skillName === 'base64_decode') {
                completionMsg = skillAction;
            }

            // Show compact completion indicator
            showCompletionFlash(completionMsg, true);
        } else {
            results.push({
                skill: call.skillName,
                success: false,
                error: result.error
            });
            // Show error flash
            showCompletionFlash(`${skillAction}: ${result.error}`, false);
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
                // Include actual file names so AI knows what's in the directory
                const fileNames = files.map(f => f.isDirectory ? `${f.name}/` : f.name).join(', ');
                message += `✓ Directory listed: ${dirPath}\nFiles: ${fileNames || '(empty)'}\n`;
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
                message += `✓ Listed ${count} processes on ${platform}\n`;
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
                    message += `✓ PDF tools unavailable, created HTML report instead: ${path}\n`;
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

    return message;
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

    // Key files to look for
    const keyFileNames = [
        'README.md', 'README', 'package.json', 'requirements.txt',
        'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
        'Makefile', 'docker-compose.yml', 'Dockerfile'
    ];

    // Scan directory structure
    const allFiles = scanDirectory(cwd);
    projectInfo.files = allFiles;

    // Find and read key files
    for (const fileName of keyFileNames) {
        const filePath = path.join(cwd, fileName);
        if (fsSync.existsSync(filePath)) {
            try {
                const content = fsSync.readFileSync(filePath, 'utf8');
                projectInfo.keyFiles.push({
                    name: fileName,
                    path: filePath,
                    content: content.substring(0, 5000) // Limit to first 5000 chars
                });
            } catch (error) {
                // Skip if can't read
            }
        }
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

    // Add key files content
    if (projectInfo.keyFiles.length > 0) {
        kodaContent += `## Key Files\n\n`;
        for (const file of projectInfo.keyFiles) {
            kodaContent += `### ${file.name}\n\n`;
            kodaContent += `\`\`\`\n${file.content}\n\`\`\`\n\n`;
        }
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

    // Ask AI for analysis if configured
    if (api) {
        logInfo('Analyzing project with AI...');

        const analysisPrompt = `I'm analyzing a project called "${projectName}". Here's what I found:\n\n` +
            `Key files:\n${projectInfo.keyFiles.map(f => `- ${f.name}`).join('\n')}\n\n` +
            `File types: ${Object.keys(filesByExt).join(', ')}\n\n` +
            `Please provide a brief 2-3 sentence summary of what this project appears to be and its main purpose.`;

        try {
            const result = await api.chat(analysisPrompt);

            if (result.success) {
                kodaContent += `\n## AI Analysis\n\n${result.data.response}\n`;
                log('\n' + result.data.response + '\n', 'white');
            } else {
                logDim('Could not get AI analysis (no models loaded or error occurred)\n');
            }
        } catch (error) {
            logDim('AI analysis timed out or failed\n');
        }
    }

    // Write koda.md
    const kodaPath = path.join(cwd, 'koda.md');
    fsSync.writeFileSync(kodaPath, kodaContent);

    logSuccess(`Project understanding saved to koda.md`);
    logDim(`File: ${kodaPath}\n`);
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
    addToHistory('system', colorize('Mode & Search:', 'yellow'));
    addToHistory('system', '  /mode <mode>       Switch mode (standalone, agent, agent collab)');
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

    addToHistory('system', '━━━ Available Skills ━━━');
    if (result.data.length === 0) {
        addToHistory('system', 'No skills found.');
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
    addToHistory('system', `Session context cleared for ${currentMode} mode`);
    addToHistory('system', 'Conversation will start fresh (chat history still visible)');
    addToHistory('system', 'Note: API key daily usage is tracked server-side and not reset');
    displayChatHistory();
}

async function handleMode(api, args) {
    if (!args || args.length === 0) {
        const displayMode = currentMode === 'collab' ? 'agent collab' : currentMode;
        const modeStr = websearchMode ? `${displayMode},websearch` : displayMode;
        addToHistory('system', `Current mode: ${modeStr}`);
        addToHistory('system', 'Usage: /mode <standalone|agent|agent collab>[,websearch]');
        addToHistory('system', 'Examples: /mode standalone,websearch | /mode agent,websearch');
        displayChatHistory();
        return;
    }

    // Handle "agent collab" as two words
    let modeInput = args.join(' ').toLowerCase();

    // Parse mode and flags (e.g., "standalone,websearch")
    const modeParts = modeInput.split(',').map(p => p.trim());
    let newMode = modeParts[0];
    let newWebsearchMode = false;

    // Check for websearch flag in any position
    if (modeParts.includes('websearch')) {
        newWebsearchMode = true;
        // Remove websearch from mode parts
        modeParts.splice(modeParts.indexOf('websearch'), 1);
        newMode = modeParts.join(' '); // Re-join in case of "agent collab"
    }

    // Normalize "agent collab" to "collab" internally
    if (newMode === 'agent collab') {
        newMode = 'collab';
    }

    if (newMode !== 'standalone' && newMode !== 'agent' && newMode !== 'collab') {
        addToHistory('system', 'Invalid mode. Use: /mode <standalone|agent|agent collab>[,websearch]');
        addToHistory('system', 'Examples: /mode standalone,websearch | /mode agent | /mode agent collab,websearch');
        displayChatHistory();
        return;
    }

    // If switching to collab mode, fetch available agents
    if (newMode === 'collab' && api) {
        const result = await api.getAgents();
        if (!result.success || result.data.length === 0) {
            addToHistory('system', 'No agents available. Create agents first.');
            displayChatHistory();
            return;
        }

        addToHistory('system', '━━━ Available Agents ━━━');
        result.data.forEach((agent, idx) => {
            addToHistory('system', `${idx + 1}. ${agent.name} - ${agent.description || 'No description'}`);
        });
        addToHistory('system', '');
        addToHistory('system', 'Select agents by number (e.g., "1,2,3") to collaborate:');
        displayChatHistory();

        // Store agents for selection
        collabAgents = result.data;
        currentMode = 'collab-select';
        websearchMode = newWebsearchMode;
        return;
    }

    currentMode = newMode;
    websearchMode = newWebsearchMode;
    const displayMode = currentMode === 'collab' ? 'agent collab' : currentMode;
    const modeStr = websearchMode ? `${displayMode},websearch` : displayMode;
    addToHistory('system', `Switched to ${modeStr} mode`);
    if (currentMode === 'standalone') {
        addToHistory('system', 'Standalone mode - General AI chat with file operation skills');
    } else if (currentMode === 'agent') {
        addToHistory('system', 'Agent mode - Task-aware with autonomous skill execution');
    } else if (currentMode === 'collab') {
        addToHistory('system', 'Agent Collaboration mode - Multiple agents with autonomous skill execution');
    }
    if (websearchMode) {
        addToHistory('system', colorize('Web search enabled - queries will include web search results', 'green'));
    }
    displayChatHistory();
}

async function handleAgentMode(api, rl) {
    log('\nAgent Mode\n', 'cyan');
    logInfo('Entering autonomous agent mode...');
    logDim('Agents can now perform actions based on enabled skills.');
    logDim('Type your request and the agent will execute it.\n');
    logDim('Type /exit to leave agent mode\n');

    // Agent mode sub-loop
    const agentPrompt = colorize('agent> ', 'magenta');

    return new Promise((resolve) => {
        const handleAgentInput = async (line) => {
            const input = line.trim();

            if (!input) {
                rl.question(agentPrompt, handleAgentInput);
                return;
            }

            if (input === '/exit' || input === '/quit') {
                log('Exiting agent mode...\n', 'cyan');
                resolve();
                return;
            }

            // Send to agent for execution
            logInfo('Agent processing request...\n');

            try {
                const result = await api.chat(input);
                if (result.success) {
                    log(result.data.response + '\n');
                } else {
                    logError(result.error + '\n');
                }
            } catch (error) {
                logError(error.message + '\n');
            }

            rl.question(agentPrompt, handleAgentInput);
        };

        rl.question(agentPrompt, handleAgentInput);
    });
}

async function handleStatus(api) {
    const result = await api.getAgents();
    if (result.success) {
        addToHistory('system', `✓ Connected | Agents: ${result.data.length}`);
    } else {
        addToHistory('system', `✗ Not connected: ${result.error}`);
    }
    displayChatHistory();
}

async function handleAgents(api, args) {
    if (!args || args.length === 0) {
        const result = await api.getAgents();
        if (!result.success) {
            addToHistory('system', `Error: ${result.error}`);
            displayChatHistory();
            return;
        }

        addToHistory('system', '━━━ Agents ━━━');
        if (result.data.length === 0) {
            addToHistory('system', 'No agents found. Use /create-agent to create one.');
        } else {
            result.data.forEach(agent => {
                addToHistory('system', `${agent.name} (ID: ${agent.id})`);
                addToHistory('system', `  Model: ${agent.modelName || 'Not assigned'} | Skills: ${agent.skills?.length || 0}`);
                if (agent.description) addToHistory('system', `  ${agent.description}`);
            });
        }
    } else {
        const result = await api.getAgent(args[0]);
        if (!result.success) {
            addToHistory('system', `Error: ${result.error}`);
            displayChatHistory();
            return;
        }

        const agent = result.data;
        addToHistory('system', `━━━ Agent: ${agent.name} ━━━`);
        addToHistory('system', `ID: ${agent.id}`);
        if (agent.description) addToHistory('system', `Description: ${agent.description}`);
        addToHistory('system', `Model: ${agent.modelName || 'Not assigned'}`);
        addToHistory('system', `Skills: ${agent.skills?.length || 0}`);
        addToHistory('system', `Created: ${new Date(agent.createdAt).toLocaleDateString()}`);
    }
    displayChatHistory();
}

async function handleTasks(api, args) {
    const agentId = args && args[0] !== 'create' ? args[0] : null;
    const result = await api.getTasks(agentId);

    if (!result.success) {
        addToHistory('system', `Error: ${result.error}`);
        displayChatHistory();
        return;
    }

    addToHistory('system', '━━━ Tasks ━━━');
    if (result.data.length === 0) {
        addToHistory('system', 'No tasks found.');
    } else {
        result.data.forEach(task => {
            const statusEmoji = task.status === 'completed' ? '✓' :
                              task.status === 'failed' ? '✗' :
                              task.status === 'in_progress' ? '⟳' : '○';
            addToHistory('system', `${statusEmoji} [${task.status.toUpperCase()}] ${task.description}`);
            addToHistory('system', `  Priority: ${task.priority} | ${new Date(task.createdAt).toLocaleDateString()}`);
        });
    }
    displayChatHistory();
}

// Handle collaboration mode chat with multiple agents and skill execution
async function handleCollabChat(api, message, selectedAgents) {
    // Add user message to history
    addToHistory('user', message);

    // Add to shared collaboration context
    collabContext.push({ role: 'user', content: message });

    // Show "thinking" indicator
    displayChatHistory();

    // If websearch mode is enabled, perform search with content fetching
    // Skip search for simple file save requests (use existing conversation context instead)
    let webSearchContext = '';
    const skipSearch = isFileSaveRequest(message);
    if (websearchMode && !skipSearch) {
        try {
            // Show animated web search indicator
            startAnimation('Searching the web', 'dots');

            // Search with content fetching enabled (8 results, fetch content from top 5)
            const searchResponse = await api.webSearch(message, 8, true, 5);

            // Stop animation
            stopAnimation(true);

            if (!searchResponse.success) {
                throw new Error(searchResponse.error || 'Search API returned unsuccessful response');
            }

            if (searchResponse.data && searchResponse.data.results && searchResponse.data.results.length > 0) {
                const searchResults = searchResponse.data.results;
                const contentCount = searchResponse.data.contentFetchedCount || 0;

                // Build search context for agents with actual content
                webSearchContext = '\n\n=== WEB SEARCH RESULTS ===\n';
                webSearchContext += `Query: "${message}"`;
                if (searchResponse.data.enhancedQuery) {
                    webSearchContext += ` (enhanced: "${searchResponse.data.enhancedQuery}")`;
                }
                webSearchContext += `\nFound ${searchResults.length} results (${contentCount} with content):\n\n`;

                searchResults.forEach((result, idx) => {
                    webSearchContext += `━━━ SOURCE [${idx + 1}] ━━━\n`;
                    webSearchContext += `Title: ${result.title}\n`;
                    webSearchContext += `URL: ${result.url}\n`;

                    if (result.content && result.contentFetched) {
                        webSearchContext += `\nCONTENT:\n${result.content}\n`;
                    } else if (result.snippet) {
                        webSearchContext += `\nSnippet: ${result.snippet}\n`;
                    }
                    webSearchContext += '\n';
                });
                webSearchContext += '=== END OF SEARCH RESULTS ===\n';
                webSearchContext += `IMPORTANT: Use the actual page content above to answer questions. Cite sources by number.\n`;

                // Show success flash
                showCompletionFlash(`Found ${searchResults.length} results (${contentCount} with content)`, true);
                addToHistory('system', `Agents collaborating: ${selectedAgents.map(a => a.name).join(', ')}`);
                displayChatHistory();
            } else {
                const noResultsMsg = searchResponse.data && searchResponse.data.results
                    ? 'No search results found'
                    : 'Search returned empty response';
                showCompletionFlash(noResultsMsg, false);
                addToHistory('system', `Agents collaborating: ${selectedAgents.map(a => a.name).join(', ')}`);
                displayChatHistory();
            }
        } catch (error) {
            stopAnimation(true);

            // Handle improved error responses from backend
            let errorMsg = 'Web search failed';
            if (error.response?.data?.error) {
                errorMsg = error.response.data.error;
            } else if (error.message) {
                errorMsg = error.message;
            }

            addToHistory('system', `${colorize(errorMsg, 'red')} - Agents collaborating: ${selectedAgents.map(a => a.name).join(', ')}...`);

            // Show retry suggestion if error is retryable
            if (error.response?.data?.retryable) {
                addToHistory('system', colorize('Search may work if retried in a few seconds', 'yellow'));
            }

            displayChatHistory();
        }
    }

    // Fetch tasks and skills for context awareness
    const tasksResult = await api.getTasks();
    const skillsResult = await api.getSkills();
    const skills = skillsResult.success ? skillsResult.data : [];
    const skillPrompt = buildSkillSystemPrompt(skills, 'collab');

    let contextInfo = webSearchContext;

    if (tasksResult.success && tasksResult.data.length > 0) {
        const pendingTasks = tasksResult.data.filter(t => t.status === 'pending' || t.status === 'in_progress');
        if (pendingTasks.length > 0) {
            contextInfo += `\n\n[Available Tasks: ${pendingTasks.length} tasks - `;
            contextInfo += pendingTasks.slice(0, 3).map(t => t.description).join(', ');
            if (pendingTasks.length > 3) contextInfo += '...';
            contextInfo += ']';
        }
    }

    // Build context from shared history
    const sharedContextMessage = collabContext.map(msg =>
        `${msg.role === 'user' ? 'User' : msg.agent || 'Assistant'}: ${msg.content}`
    ).join('\n\n');

    // Coordinate agents - each agent contributes to the solution with skill execution
    for (const agent of selectedAgents) {
        addToHistory('system', `━━━ ${agent.name} ━━━`);
        displayChatHistory();

        // Get agent-specific skills (filter by agent's assigned skills if any)
        let agentSkillPrompt = skillPrompt;
        if (agent.skills && agent.skills.length > 0) {
            const agentSkills = skills.filter(s => agent.skills.includes(s.id));
            if (agentSkills.length > 0) {
                agentSkillPrompt = buildSkillSystemPrompt(agentSkills, 'collab');
            }
        }

        const basePrompt = `[You are ${agent.name}: ${agent.description}]${contextInfo}${agentSkillPrompt}\n\nTask: ${message}\n\nShared Context:\n${sharedContextMessage}\n\nProvide your contribution to solving this task. Execute skills as needed:`;

        // Skill execution loop for this agent
        let iteration = 0;
        let currentPrompt = basePrompt;
        let finalResponse = '';
        let allSkillResults = [];

        while (iteration < MAX_SKILL_ITERATIONS) {
            iteration++;

            // Start animated thinking indicator
            if (iteration === 1) {
                startAnimation(`${agent.name} thinking`, 'dots');
            }

            // Use the agent's assigned model
            const result = await api.chat(currentPrompt, agent.modelName);

            // Stop animation after response
            stopAnimation(true);

            if (!result.success) {
                addToHistory('system', `Error from ${agent.name}: ${result.error}`);
                break;
            }

            // Update token tracking
            if (result.data.tokens) {
                lastTokenUsage = {
                    prompt: result.data.tokens.prompt_tokens || 0,
                    completion: result.data.tokens.completion_tokens || 0,
                    total: result.data.tokens.total_tokens || 0
                };
                totalTokensUsed += lastTokenUsage.total;
            }

            const response = result.data.response;
            finalResponse = response;

            // Check for skill calls in the response
            const skillCalls = parseSkillCalls(response);

            if (skillCalls.length === 0) {
                // No skill calls, agent is done
                break;
            }

            // Display what agent said before executing skills
            if (!isOnlySkillCalls(response)) {
                addToHistory('assistant', response);
                displayChatHistory();
            }

            // Execute the skills with agent ID
            const skillResults = await executeSkillCalls(api, skillCalls, agent.id);
            allSkillResults.push(...skillResults);

            // Build feedback message for the agent
            const feedbackMessage = buildSkillResultsMessage(skillResults);

            // Continue the conversation with skill results
            currentPrompt = basePrompt + '\n\nYour previous response: ' + response + feedbackMessage;

            // Show animated processing indicator for next iteration
            startAnimation(`${agent.name} processing`, 'dots');
        }

        if (iteration >= MAX_SKILL_ITERATIONS) {
            addToHistory('system', `Warning: ${agent.name} reached maximum iterations`);
        }

        // Add agent's final response to history and context
        if (finalResponse && !isOnlySkillCalls(finalResponse)) {
            addToHistory('assistant', finalResponse);
        } else if (allSkillResults.length > 0) {
            // If only skill calls, add a summary
            const successCount = allSkillResults.filter(r => r.success).length;
            addToHistory('assistant', `Executed ${allSkillResults.length} skills (${successCount} successful)`);
        }

        collabContext.push({ role: 'assistant', agent: agent.name, content: finalResponse });
        displayChatHistory();
    }

    // Keep collab context manageable
    if (collabContext.length > 30) {
        collabContext.splice(0, collabContext.length - 30);
    }

    // Update API key usage stats after collaboration
    await updateApiKeyUsage(api);
}

// Handle natural language chat with session awareness and skill execution (with streaming)
async function handleChat(api, message) {
    // Add user message to history
    addToHistory('user', message);

    // Add to conversation context for session awareness
    conversationContext.push({ role: 'user', content: message });

    // Fetch skills for skill execution capability
    const skillsResult = await api.getSkills();
    const skills = skillsResult.success ? skillsResult.data : [];
    const skillPrompt = buildSkillSystemPrompt(skills, currentMode);

    // Build context-aware message for the API
    let userMessage = message;
    let systemPrefix = '';

    // Add skill execution capability FIRST (most important)
    if (skillPrompt) {
        systemPrefix = skillPrompt + '\n\n';
    }

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
                systemPrefix += `IMPORTANT INSTRUCTIONS:
1. The search results above contain ACTUAL PAGE CONTENT - use it to answer the question
2. Extract specific facts, quotes, and data from the content provided
3. Cite which source (by number or title) information came from
4. If asked to create a file with summaries, use the content above to write real summaries
5. Do NOT say you cannot access web content - the content IS provided above\n\n`;

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

    // In agent mode, add task awareness
    if (currentMode === 'agent') {
        const tasksResult = await api.getTasks();

        if (tasksResult.success && tasksResult.data.length > 0) {
            const pendingTasks = tasksResult.data.filter(t => t.status === 'pending' || t.status === 'in_progress');
            if (pendingTasks.length > 0) {
                systemPrefix += `[You have ${pendingTasks.length} pending tasks: `;
                systemPrefix += pendingTasks.slice(0, 3).map(t => t.description).join(', ');
                if (pendingTasks.length > 3) systemPrefix += '...';
                systemPrefix += ']\n\n';
            }
        }
    }

    // Build final message: system prefix + working files + conversation context + user message
    let contextMessage = systemPrefix;

    // Add working files context if available
    const workingFilesContext = buildWorkingFilesContext();
    if (workingFilesContext) {
        contextMessage += workingFilesContext;
    }

    if (conversationContext.length > 1) {
        // Include recent context (last 5 exchanges, but skip the current message we just added)
        const recentContext = conversationContext.slice(-11, -1);
        if (recentContext.length > 0) {
            const contextStr = recentContext.map(msg =>
                `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
            ).join('\n\n');
            contextMessage += contextStr + '\n\n';
        }
    }

    contextMessage += 'User: ' + userMessage;

    // Skill execution loop
    let iteration = 0;
    let currentMessage = contextMessage;
    let finalResponse = '';

    while (iteration < MAX_SKILL_ITERATIONS) {
        iteration++;

        // Show animated indicator for each iteration
        displayChatHistory();
        if (iteration === 1) {
            startAnimation(getRandomThinkingMessage(), 'dots');
        } else {
            // Show processing animation for retry iterations
            startAnimation('Retrying with corrected syntax', 'dots');
        }

        // Use streaming API
        let streamingResponse = '';
        let tokenCount = 0;
        let hasStoppedAnimation = false;

        // Enable streaming mode to prevent flickering
        isStreaming = true;
        lastStreamedMessage = '';
        lastCleanedMessage = '';

        const result = await api.chatStream(
            currentMessage,
            null,
            4000,
            // onToken callback - display tokens in real-time
            (token) => {
                streamingResponse += token;
                tokenCount++;

                // Stop animation on first token and clear the line
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

                // Remove streaming cursor
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (lastMsg && lastMsg.role === 'assistant-streaming') {
                    lastMsg.role = 'assistant';
                    lastMsg.content = fullResponse;
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

        const response = result.data.response;
        finalResponse = response;

        // Check for skill calls in the response
        const skillCalls = parseSkillCalls(response);

        if (skillCalls.length === 0) {
            // No valid skill calls found - check if there were malformed attempts
            const malformedCalls = detectMalformedSkillCalls(response);

            if (malformedCalls.length > 0) {
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
                let errorFeedback = '\n\n[SKILL SYNTAX ERROR]\n';
                errorFeedback += 'Your skill call(s) were malformed. Correct format:\n';
                errorFeedback += '[SKILL:skill_name(param1="value1", param2="value2")]\n\n';
                errorFeedback += 'Issues detected:\n';
                for (const issue of malformedCalls) {
                    if (issue.type === 'incomplete_bracket') {
                        errorFeedback += `- Skill "${issue.skillName}" is missing closing ")]\"\n`;
                    } else if (issue.type === 'missing_close_bracket') {
                        errorFeedback += '- Skill call started but not completed\n';
                    } else if (issue.type === 'malformed_params') {
                        errorFeedback += `- Parameters must use key="value" format\n`;
                    }
                }
                errorFeedback += '\nPlease retry with correct syntax. Make sure to close all brackets and quotes.\n';

                // Show error to user
                addToHistory('system', 'Skill syntax error detected - asking AI to retry...');
                displayChatHistory();

                // Continue the conversation with error feedback
                currentMessage = contextMessage + '\n\nPrevious response: ' + response + errorFeedback;
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

        // Execute the skills
        const skillResults = await executeSkillCalls(api, skillCalls);

        // Build feedback message for the AI
        const feedbackMessage = buildSkillResultsMessage(skillResults);

        // Continue the conversation with skill results
        currentMessage = contextMessage + '\n\nPrevious response: ' + response + feedbackMessage;

        // Show animated processing indicator for next iteration (animation starts before next API call)
    }

    if (iteration >= MAX_SKILL_ITERATIONS) {
        addToHistory('system', `Warning: Maximum skill execution iterations (${MAX_SKILL_ITERATIONS}) reached`);
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
    const config = loadConfig();

    let api = config ? new AgentAPI(config.apiUrl, config.apiKey, config.apiSecret) : null;

    if (!config) {
        addToHistory('system', 'Welcome to koda! Run /auth to get started.');
        addToHistory('system', 'Commands: /auth | /help');
    } else {
        // Fetch API key usage stats on startup
        await updateApiKeyUsage(api);
        addToHistory('system', `Connected! Mode: ${currentMode}`);
        if (apiKeyUsage.name) {
            addToHistory('system', `API Key: ${apiKeyUsage.name}`);
        }
        addToHistory('system', 'Type a message to chat or use /help for commands.');
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
        { cmd: '/mode', desc: 'change mode' },
        { cmd: '/init', desc: 'analyze project' },
        { cmd: '/project', desc: 'create project' },
        { cmd: '/cwd', desc: 'show directory' },
        { cmd: '/help', desc: 'show commands' },
        { cmd: '/clear', desc: 'clear history' },
        { cmd: '/clearsession', desc: 'clear session' },
        { cmd: '/quit', desc: 'exit koda' },
        { cmd: '/exit', desc: 'exit koda' }
    ];
    const availableCommands = commandDefs.map(c => c.cmd);
    const modeOptions = ['standalone', 'agent', 'agent collab'];

    function completer(line) {
        return [[], line];
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colorize('> ', 'cyan'),
        completer: completer
    });

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

    // Get best command suggestion for current input
    function getSuggestion(line) {
        if (!line.startsWith('/')) return null;

        const trimmed = line.trim();

        // For just "/", show first command
        if (trimmed === '/') {
            return availableCommands[0].substring(1); // Return without the "/"
        }

        // For "/mode " or "/mode", suggest mode options
        if (trimmed === '/mode') {
            // Check original line to see if there's a trailing space
            if (line.endsWith(' ')) {
                return 'standalone';  // User typed "/mode ", suggest "standalone"
            }
            return ' standalone';  // User typed "/mode", suggest " standalone"
        }

        // For partial mode options
        if (trimmed.startsWith('/mode ')) {
            const modeInput = trimmed.substring(6);
            const match = modeOptions.find(m => m.startsWith(modeInput) && m !== modeInput);
            if (match) return match.substring(modeInput.length);
            return null;
        }

        // For partial commands
        if (trimmed.length > 1) {
            const matches = availableCommands.filter(cmd => cmd.startsWith(trimmed));
            if (matches.length === 1 && matches[0] !== trimmed) {
                return matches[0].substring(trimmed.length);
            }
            if (matches.length > 1) {
                // Find common prefix
                const first = matches[0];
                let commonLen = trimmed.length;
                for (let i = trimmed.length; i < first.length; i++) {
                    if (matches.every(m => m[i] === first[i])) {
                        commonLen++;
                    } else {
                        break;
                    }
                }
                if (commonLen > trimmed.length) {
                    return first.substring(trimmed.length, commonLen);
                }
            }
        }
        return null;
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

        // Handle "/mode " - cycle through mode options
        if (trimmed.startsWith('/mode ')) {
            const modeInput = trimmed.substring(6);
            const matches = modeOptions.filter(m => m.startsWith(modeInput));

            if (matches.length > 0) {
                if (lastTabLine !== currentLine) {
                    tabCycleIndex = -1;
                    tabCycleOptions = matches;
                }
                tabCycleIndex = (tabCycleIndex + 1) % tabCycleOptions.length;
                rl.line = `/mode ${tabCycleOptions[tabCycleIndex]}`;
                rl.cursor = rl.line.length;
                rl._refreshLine();
                lastTabLine = rl.line;
            }
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

        // Clear existing suggestion before processing input
        clearSuggestion();

        // Call original handler
        const result = originalTtyWrite(s, key);

        // After input is processed, check if we should show a suggestion
        const currentLine = rl.line || '';
        if (currentLine.startsWith('/') && !key?.name?.match(/^(return|enter|escape|backspace)$/)) {
            const suggestion = getSuggestion(currentLine);
            if (suggestion) {
                showSuggestion(suggestion);
            }
        }

        return result;
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

                    case '/mode':
                        await handleMode(api, args);
                        break;

                    case '/web':
                    case '/websearch':
                    case '/ws':
                        // Toggle websearch mode
                        websearchMode = !websearchMode;
                        const webStatus = websearchMode ? 'enabled' : 'disabled';
                        const webIcon = websearchMode ? '🔍' : '○';
                        const webColor = websearchMode ? 'green' : 'yellow';
                        addToHistory('system', `${webIcon} Web search ${colorize(webStatus, webColor)}`);
                        if (websearchMode) {
                            addToHistory('system', colorize('  Queries will include live web results', 'dim'));
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
                        collabAgents = [];
                        collabContext = [];
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
                } else if (currentMode === 'collab-select') {
                    // Handle agent selection for collaboration
                    const indices = input.split(',').map(s => parseInt(s.trim()) - 1);
                    const selectedAgents = indices.filter(i => i >= 0 && i < collabAgents.length)
                                                   .map(i => collabAgents[i]);

                    if (selectedAgents.length === 0) {
                        addToHistory('system', 'No valid agents selected. Try again or use /mode to exit.');
                        displayChatHistory();
                    } else {
                        collabAgents = selectedAgents;
                        currentMode = 'collab';
                        addToHistory('system', `✓ Collaboration mode active with: ${selectedAgents.map(a => a.name).join(', ')}`);
                        addToHistory('system', 'Agents will work together on your tasks.');
                        displayChatHistory();
                    }
                } else if (currentMode === 'collab' && collabAgents.length > 0) {
                    // Collaboration mode chat
                    await handleCollabChat(api, input, collabAgents);
                } else {
                    // Regular standalone chat
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

// Start the shell
startShell();
