#!/usr/bin/env node

/**
 * koda CLI
 * Interactive AI assistant for your projects
 */

const readline = require('readline');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Diff = require('diff');
const { spawn } = require('child_process');
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
    if (fs.existsSync(destPath)) {
        const destContent = fs.readFileSync(destPath, 'utf8');
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
function promptConfirmation(message) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(colorize(`${message} (y/n/s=skip): `, 'yellow'), (answer) => {
            rl.close();
            const normalized = answer.trim().toLowerCase();
            if (normalized === 'y' || normalized === 'yes') {
                resolve('yes');
            } else if (normalized === 's' || normalized === 'skip') {
                resolve('skip');
            } else {
                resolve('no');
            }
        });
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
    if (content === null && fs.existsSync(absolutePath)) {
        try {
            content = fs.readFileSync(absolutePath, 'utf8');
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
                    if (fs.existsSync(importPath + ext)) {
                        imports.push(importPath + ext);
                        break;
                    }
                }
            } else if (fs.existsSync(importPath)) {
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
            if (fs.existsSync(modulePath)) {
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
                log(`${colorize('You:', 'green')} ${msg.content}`);
            } else if (msg.role === 'assistant' || msg.role === 'assistant-streaming') {
                const formattedContent = formatCodeBlocks(msg.content);
                log(`${colorize('Koda:', 'cyan')} ${formattedContent}`);
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
    const modeStr = websearchMode ? `${displayMode},websearch` : displayMode;
    statusParts.push(colorize(`Mode: ${modeStr}`, 'cyan'));

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
let lastStreamingLineCount = 0;

// Update streaming message without full screen refresh (reduces flicker)
function updateStreamingMessage(message) {
    if (!isStreaming) return;

    const formattedContent = formatCodeBlocks(message);
    const fullMessage = `${colorize('Koda:', 'cyan')} ${formattedContent}`;

    // Split into lines to handle multi-line streaming
    const lines = fullMessage.split('\n');
    const lineCount = lines.length;

    // Clear previous streaming lines
    if (lastStreamingLineCount > 0) {
        // Move cursor up and clear lines
        for (let i = 0; i < lastStreamingLineCount; i++) {
            readline.moveCursor(process.stdout, 0, -1);
            readline.clearLine(process.stdout, 0);
        }
        readline.cursorTo(process.stdout, 0);
    } else {
        // First streaming message - ensure clean output
        readline.cursorTo(process.stdout, 0);
    }

    // Write new content
    process.stdout.write(fullMessage);
    if (!message.endsWith('\n')) {
        process.stdout.write('\n');
    }

    lastStreamingLineCount = lineCount;
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
        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');

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
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        const encrypted = encryptData(config);
        fs.writeFileSync(CONFIG_FILE, encrypted, 'utf8');
        // Set restrictive permissions (owner read/write only)
        fs.chmodSync(CONFIG_FILE, 0o600);
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

    // Web search using DuckDuckGo
    async webSearch(query, limit = 5) {
        return this.request('GET', `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
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
function parseSkillCalls(response) {
    const skillCalls = [];

    // Pattern 1: [SKILL:name(params)]
    const bracketPattern = /\[SKILL:(\w+)\((.*?)\)\]/g;
    let match;
    while ((match = bracketPattern.exec(response)) !== null) {
        const skillName = match[1];
        const paramsStr = match[2];
        const params = {};

        // Parse key="value" pairs
        const paramPattern = /(\w+)\s*=\s*"([^"]*)"/g;
        let paramMatch;
        while ((paramMatch = paramPattern.exec(paramsStr)) !== null) {
            params[paramMatch[1]] = paramMatch[2];
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

// Build system prompt with skill instructions
function buildSkillSystemPrompt(skills, mode = 'standalone') {
    if (!skills || skills.length === 0) {
        return '';
    }

    const enabledSkills = skills.filter(s => s.enabled);
    if (enabledSkills.length === 0) {
        return '';
    }

    // Only include the most useful file-related skills to avoid overwhelming the context
    const prioritySkills = ['create_file', 'read_file', 'update_file', 'delete_file', 'list_directory'];
    const filteredSkills = enabledSkills.filter(s => prioritySkills.includes(s.name));
    const skillsToShow = filteredSkills.length > 0 ? filteredSkills : enabledSkills.slice(0, 5);

    let prompt = `You are Koda, a helpful AI assistant. You can have normal conversations, answer questions, help with coding, math, explanations, and any other topics.

You also have the ability to execute file operations directly when needed. When the user asks you to create, read, modify, or delete files, use the skill format below instead of suggesting commands.

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
[SKILL:create_file(filePath="${userWorkingDirectory}/<project_dir>/<filename>", content="file content here")]
[SKILL:read_file(filePath="${userWorkingDirectory}/<path_to_file>")]
[SKILL:list_directory(dirPath="${userWorkingDirectory}/<directory>")]

When asked to work with files, execute skills directly rather than suggesting bash commands.
Intelligently choose project directory names based on what the user is building.
For all other questions (math, coding help, explanations, general chat), respond normally.

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

// Execute skills and return results
async function executeSkillCalls(api, skillCalls, agentId = null) {
    const results = [];
    const fileModifyingSkills = ['create_file', 'update_file'];

    for (const call of skillCalls) {
        // Check if this is a file-modifying skill that needs diff preview
        const needsDiffPreview = fileModifyingSkills.includes(call.skillName) && call.params.filePath;

        if (needsDiffPreview) {
            // Read current file content (if exists)
            let oldContent = '';
            const filePath = call.params.filePath;

            try {
                if (fs.existsSync(filePath)) {
                    oldContent = fs.readFileSync(filePath, 'utf8');
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

        addToHistory('system', `Executing skill: ${call.skillName}...`);
        displayChatHistory();

        const result = await api.executeSkill(call.skillName, call.params, agentId);

        if (result.success) {
            results.push({
                skill: call.skillName,
                success: true,
                result: result.data
            });

            // Enhanced messages for file operations
            if (call.skillName === 'create_file' && result.data.filePath) {
                const relativePath = result.data.filePath.replace(userWorkingDirectory, '.');
                addToHistory('system', `✓ File created: ${colorize(relativePath, 'green')}`);

                // Auto-add to working set
                addToWorkingSet(result.data.filePath, call.params.content);
            } else if (call.skillName === 'read_file') {
                addToHistory('system', `✓ File read successfully`);

                // Auto-add to working set if not already there
                if (result.data.filePath && result.data.content) {
                    addToWorkingSet(result.data.filePath, result.data.content);
                }
            } else if (call.skillName === 'update_file' && result.data.filePath) {
                const relativePath = result.data.filePath.replace(userWorkingDirectory, '.');
                addToHistory('system', `✓ File updated: ${colorize(relativePath, 'green')}`);

                // Auto-add to working set (refresh content)
                addToWorkingSet(result.data.filePath);
            } else {
                addToHistory('system', `✓ ${call.skillName} completed successfully`);
            }
        } else {
            results.push({
                skill: call.skillName,
                success: false,
                error: result.error
            });
            addToHistory('system', `✗ ${call.skillName} failed: ${result.error}`);
        }
    }

    displayChatHistory();
    return results;
}

// Build feedback message with skill results for AI
function buildSkillResultsMessage(results) {
    if (results.length === 0) return '';

    let message = '\n\n[SKILL EXECUTION RESULTS]\n';

    for (const r of results) {
        if (r.success) {
            message += `✓ ${r.skill}: ${JSON.stringify(r.result, null, 2)}\n`;
        } else {
            message += `✗ ${r.skill}: ERROR - ${r.error}\n`;
        }
    }

    message += '\nContinue with your response based on these results. Execute more skills if needed, or provide your final response.';

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
        const items = fs.readdirSync(dir);
        for (const item of items) {
            // Skip common ignore patterns
            if (item.startsWith('.') || item === 'node_modules' || item === 'dist' || item === 'build') {
                continue;
            }

            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

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
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
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
    fs.writeFileSync(kodaPath, kodaContent);

    logSuccess(`Project understanding saved to koda.md`);
    logDim(`File: ${kodaPath}\n`);
}

async function handleHelp() {
    addToHistory('system', '━━━ Available Commands ━━━');
    addToHistory('system', '');
    addToHistory('system', colorize('Setup & Configuration:', 'yellow'));
    addToHistory('system', '/auth - Authenticate with API credentials');
    addToHistory('system', '/init - Analyze project and create koda.md context file');
    addToHistory('system', '/project <name> - Create a project directory structure');
    addToHistory('system', '/cwd - Show current working directory');
    addToHistory('system', '');
    addToHistory('system', colorize('Modes:', 'yellow'));
    addToHistory('system', '/mode <standalone|agent|agent collab>[,websearch] - Switch between modes');
    addToHistory('system', '  • standalone - General chat with autonomous tool execution');
    addToHistory('system', '  • agent - Task-aware with autonomous skills');
    addToHistory('system', '  • agent collab - Multi-agent collaboration with skill execution');
    addToHistory('system', '  • websearch - Enable automatic web search (can be combined with any mode)');
    addToHistory('system', '');
    addToHistory('system', '  Examples:');
    addToHistory('system', '    /mode standalone          - Chat mode with tools');
    addToHistory('system', '    /mode standalone,websearch - Chat mode with web search');
    addToHistory('system', '    /mode agent,websearch     - Agent mode with web search');
    addToHistory('system', '');
    addToHistory('system', colorize('Session Management:', 'yellow'));
    addToHistory('system', '/clear - Clear chat history');
    addToHistory('system', '/clearsession - Clear session context (keeps history visible)');
    addToHistory('system', '/quit - Exit koda');
    addToHistory('system', '');
    addToHistory('system', colorize('Note:', 'dim'));
    addToHistory('system', colorize('Koda has automatic access to file operations, code analysis, refactoring,', 'dim'));
    addToHistory('system', colorize('web search, and documentation tools. Just ask naturally!', 'dim'));
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
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true });
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
    const files = fs.readdirSync(userWorkingDirectory).slice(0, 10);
    if (files.length > 0) {
        addToHistory('system', '');
        addToHistory('system', 'Contents (first 10 items):');
        files.forEach(file => {
            const fullPath = path.join(userWorkingDirectory, file);
            const isDir = fs.statSync(fullPath).isDirectory();
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

    if (!fs.existsSync(absolutePath)) {
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
        if (fs.existsSync(absolutePath)) {
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

    if (!fs.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
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
        fs.writeFileSync(absolutePath, result.newContent, 'utf8');
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

    if (!fs.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
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
        fs.writeFileSync(absolutePath, result.newContent, 'utf8');
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

    if (!fs.existsSync(absoluteSourcePath)) {
        addToHistory('system', `✗ Source file not found: ${sourcePath}`);
        displayChatHistory();
        return;
    }

    const sourceContent = fs.readFileSync(absoluteSourcePath, 'utf8');
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
        fs.writeFileSync(absoluteSourcePath, result.newSourceContent, 'utf8');
        fs.writeFileSync(absoluteDestPath, result.newDestContent, 'utf8');

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

    if (!fs.existsSync(absolutePath)) {
        addToHistory('system', `✗ File not found: ${filePath}`);
        displayChatHistory();
        return;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
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
    addToHistory('system', `Agents collaborating: ${selectedAgents.map(a => a.name).join(', ')}...`);
    displayChatHistory();

    // If websearch mode is enabled, perform web search first
    let webSearchContext = '';
    if (websearchMode) {
        try {
            // Update indicator
            chatHistory.pop();
            addToHistory('system', colorize('Searching the web...', 'yellow'));
            displayChatHistory();

            const searchResponse = await api.webSearch(message, 10);

            if (!searchResponse.success) {
                throw new Error(searchResponse.error || 'Search API returned unsuccessful response');
            }

            if (searchResponse.data && searchResponse.data.results && searchResponse.data.results.length > 0) {
                const searchResults = searchResponse.data.results;

                // Build search context for agents with enhanced formatting
                webSearchContext = '\n\n=== WEB SEARCH RESULTS ===\n';
                webSearchContext += `Query: "${message}"\n`;
                webSearchContext += `Found ${searchResults.length} results:\n\n`;

                searchResults.forEach((result, idx) => {
                    webSearchContext += `[${idx + 1}] ${result.title}\n`;
                    webSearchContext += `    URL: ${result.url}\n`;
                    webSearchContext += `    ${result.snippet}\n\n`;
                });
                webSearchContext += '=== END OF SEARCH RESULTS ===\n';
                webSearchContext += 'IMPORTANT: Use the above web search results to provide accurate, current, and well-sourced information.\n';

                // Update indicator
                chatHistory.pop();
                addToHistory('system', `${colorize(`Found ${searchResults.length} web results`, 'green')} - Agents collaborating: ${selectedAgents.map(a => a.name).join(', ')}...`);
                displayChatHistory();
            } else {
                chatHistory.pop();
                const noResultsMsg = searchResponse.data && searchResponse.data.results
                    ? 'No search results found'
                    : 'Search returned empty response';
                addToHistory('system', `${colorize(noResultsMsg, 'yellow')} - Agents collaborating: ${selectedAgents.map(a => a.name).join(', ')}...`);
                displayChatHistory();
            }
        } catch (error) {
            chatHistory.pop();

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

    // Remove "thinking" indicator
    chatHistory.pop();

    // Coordinate agents - each agent contributes to the solution with skill execution
    for (const agent of selectedAgents) {
        addToHistory('system', `━━━ ${agent.name} ━━━`);
        addToHistory('system', 'Thinking...');
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

            // Use the agent's assigned model
            const result = await api.chat(currentPrompt, agent.modelName);

            // Remove "thinking" indicator on first iteration
            if (iteration === 1) {
                chatHistory.pop();
            }

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

            // Show thinking again for next iteration
            addToHistory('system', `${agent.name} processing results...`);
            displayChatHistory();
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

    // If websearch mode is enabled, perform web search first
    let searchResults = null;
    if (websearchMode) {
        try {
            addToHistory('system', colorize('Searching the web...', 'yellow'));
            displayChatHistory();

            const searchResponse = await api.webSearch(message, 10);

            // Debug logging
            if (!searchResponse.success) {
                throw new Error(searchResponse.error || 'Search API returned unsuccessful response');
            }

            if (searchResponse.data && searchResponse.data.results && searchResponse.data.results.length > 0) {
                searchResults = searchResponse.data.results;

                // Add search results to system prefix with enhanced formatting
                systemPrefix += '=== WEB SEARCH RESULTS ===\n';
                systemPrefix += `Query: "${message}"\n`;
                systemPrefix += `Found ${searchResults.length} results:\n\n`;

                searchResults.forEach((result, idx) => {
                    systemPrefix += `[${idx + 1}] ${result.title}\n`;
                    systemPrefix += `    URL: ${result.url}\n`;
                    systemPrefix += `    ${result.snippet}\n\n`;
                });
                systemPrefix += '=== END OF SEARCH RESULTS ===\n\n';
                systemPrefix += 'IMPORTANT: Use the above web search results to provide accurate, current, and well-sourced information in your response. Reference specific sources when relevant.\n\n';

                // Show results to user
                addToHistory('system', colorize(`Found ${searchResults.length} web results`, 'green'));
                displayChatHistory();
            } else {
                const noResultsMsg = searchResponse.data && searchResponse.data.results
                    ? 'No search results found'
                    : 'Search returned empty response';
                addToHistory('system', colorize(noResultsMsg, 'yellow'));
                displayChatHistory();
            }
        } catch (error) {
            // Handle improved error responses from backend
            let errorMsg = 'Web search failed';
            if (error.response?.data?.error) {
                errorMsg = error.response.data.error;
            } else if (error.message) {
                errorMsg = error.message;
            }

            addToHistory('system', colorize(errorMsg, 'red'));

            // Show retry suggestion if error is retryable
            if (error.response?.data?.retryable) {
                addToHistory('system', colorize('Try again in a few seconds', 'yellow'));
            }

            displayChatHistory();
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

        // Show streaming indicator for first iteration
        if (iteration === 1) {
            addToHistory('system', 'Koda is thinking...');
            displayChatHistory();
        }

        // Use streaming API
        let streamingResponse = '';
        let tokenCount = 0;
        let hasRemovedThinkingIndicator = false;

        // Enable streaming mode to prevent flickering
        isStreaming = true;

        const result = await api.chatStream(
            currentMessage,
            null,
            4000,
            // onToken callback - display tokens in real-time
            (token) => {
                streamingResponse += token;
                tokenCount++;

                // Remove thinking indicator on first token
                if (!hasRemovedThinkingIndicator && iteration === 1 && chatHistory.length > 0 &&
                    chatHistory[chatHistory.length - 1].role === 'system') {
                    chatHistory.pop();
                    hasRemovedThinkingIndicator = true;
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
                // Disable streaming mode
                isStreaming = false;
                lastStreamingLineCount = 0;

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

                // Final full refresh with updated stats
                displayChatHistory();
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
            // No skill calls, we're done
            break;
        }

        // Display what AI said before executing skills (already displayed during streaming)
        // Just execute the skills
        const skillResults = await executeSkillCalls(api, skillCalls);

        // Build feedback message for the AI
        const feedbackMessage = buildSkillResultsMessage(skillResults);

        // Continue the conversation with skill results
        currentMessage = contextMessage + '\n\nPrevious response: ' + response + feedbackMessage;

        // Show thinking again for next iteration
        addToHistory('system', 'Processing skill results...');
        displayChatHistory();
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

    // Command autocomplete function
    const availableCommands = ['/auth', '/init', '/project', '/cwd', '/mode', '/help', '/clear', '/clearsession', '/quit', '/exit'];
    const modeOptions = ['standalone', 'agent', 'agent collab'];

    function completer(line) {
        // Disable default completion display - return empty array
        // We'll handle TAB manually
        return [[], line];
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colorize('> ', 'cyan'),
        completer: completer
    });

    // Tab cycling state
    let tabCycleIndex = -1;
    let tabCycleOptions = [];
    let lastTabLine = '';

    // Custom TAB key handler for cycling using readline's internal hook
    const originalCompleter = rl.completer;

    // Override the internal _tabComplete to prevent display
    const originalTabComplete = rl._tabComplete.bind(rl);
    rl._tabComplete = function() {
        const currentLine = rl.line || '';
        const trimmed = currentLine.trim();

        // Handle "/" - cycle through all commands
        if (trimmed === '/') {
            if (lastTabLine !== currentLine) {
                tabCycleIndex = -1;
                tabCycleOptions = availableCommands;
            }

            tabCycleIndex = (tabCycleIndex + 1) % tabCycleOptions.length;
            const selected = tabCycleOptions[tabCycleIndex];

            rl.line = selected;
            rl.cursor = selected.length;
            rl._refreshLine();
            lastTabLine = selected;
            return;
        }

        // Handle "/mode " - cycle through mode options
        if (trimmed.startsWith('/mode ')) {
            if (lastTabLine !== currentLine) {
                tabCycleIndex = -1;
                tabCycleOptions = modeOptions;
            }

            tabCycleIndex = (tabCycleIndex + 1) % tabCycleOptions.length;
            const selected = tabCycleOptions[tabCycleIndex];

            rl.line = `/mode ${selected}`;
            rl.cursor = rl.line.length;
            rl._refreshLine();
            lastTabLine = rl.line;
            return;
        }

        // Handle partial commands
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
                const selected = tabCycleOptions[tabCycleIndex];

                rl.line = selected;
                rl.cursor = selected.length;
                rl._refreshLine();
                lastTabLine = selected;
            }
            return;
        }

        // Reset and use default for non-commands
        lastTabLine = '';
        tabCycleIndex = -1;
        tabCycleOptions = [];
    };

    // Hook to reset cycle on regular input
    const originalTtyWrite = rl._ttyWrite.bind(rl);
    rl._ttyWrite = function(s, key) {
        if (key && key.name !== 'tab') {
            lastTabLine = '';
            tabCycleIndex = -1;
            tabCycleOptions = [];
        }
        return originalTtyWrite(s, key);
    };


    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();

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
