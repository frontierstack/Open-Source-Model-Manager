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

// Collaboration mode state
let collabAgents = []; // Array of selected agent IDs for collaboration
let collabContext = []; // Shared context between collaborating agents

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
            } else if (msg.role === 'assistant') {
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

// Display status bar with token and context stats
function displayStatusBar() {
    const tokensLeftPercent = contextWindowLimit > 0 ?
        ((1 - (contextWindowUsed / contextWindowLimit)) * 100).toFixed(1) : 100;
    const tokensLeftColor = tokensLeftPercent < 20 ? 'red' : tokensLeftPercent < 40 ? 'yellow' : 'green';

    const statusParts = [];

    // Mode indicator (display "agent collab" instead of "collab")
    const displayMode = currentMode === 'collab' ? 'agent collab' :
                       currentMode === 'collab-select' ? 'agent collab (selecting)' : currentMode;
    statusParts.push(colorize(`Mode: ${displayMode}`, 'cyan'));

    // Tokens left percentage with last usage and tokens/sec
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

    // Tokens left percentage
    if (contextWindowLimit > 0) {
        statusParts.push(colorize(`Tokens Left: ${tokensLeftPercent}%`, tokensLeftColor));
    }

    // Total tokens used in session
    if (totalTokensUsed > 0) {
        statusParts.push(colorize(`Total: ${totalTokensUsed} tokens`, 'white'));
    }

    if (statusParts.length > 0) {
        const separator = colorize(' │ ', 'dim');
        log(colorize('─'.repeat(80), 'dim'));
        log(statusParts.join(separator));
    }
    console.log('');
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

    // Execute a skill
    async executeSkill(skillName, params, agentId = null) {
        const data = { ...params };
        if (agentId) {
            data.agentId = agentId;
        }
        return this.request('POST', `/api/skills/${skillName}/execute`, data);
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
`;

    return prompt;
}

// Execute skills and return results
async function executeSkillCalls(api, skillCalls, agentId = null) {
    const results = [];

    for (const call of skillCalls) {
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
            } else if (call.skillName === 'read_file') {
                addToHistory('system', `✓ File read successfully`);
            } else if (call.skillName === 'update_file' && result.data.filePath) {
                const relativePath = result.data.filePath.replace(userWorkingDirectory, '.');
                addToHistory('system', `✓ File updated: ${colorize(relativePath, 'green')}`);
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
    addToHistory('system', '/auth - Authenticate with API credentials');
    addToHistory('system', '/init - Analyze project and create koda.md context file');
    addToHistory('system', '/project <name> - Create a project directory structure');
    addToHistory('system', '/cwd - Show current working directory');
    addToHistory('system', '/mode <standalone|agent|agent collab> - Switch between modes');
    addToHistory('system', '  • standalone - General chat with file skill execution');
    addToHistory('system', '  • agent - Task-aware with autonomous skills');
    addToHistory('system', '  • agent collab - Multi-agent with skill execution');
    addToHistory('system', '/clear - Clear chat history');
    addToHistory('system', '/clearsession - Clear session context (keeps history visible)');
    addToHistory('system', '/quit - Exit koda');
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
    displayChatHistory();
}

async function handleMode(api, args) {
    if (!args || args.length === 0) {
        const displayMode = currentMode === 'collab' ? 'agent collab' : currentMode;
        addToHistory('system', `Current mode: ${displayMode}`);
        addToHistory('system', 'Usage: /mode <standalone|agent|agent collab>');
        displayChatHistory();
        return;
    }

    // Handle "agent collab" as two words
    let newMode = args.join(' ').toLowerCase();

    // Normalize "agent collab" to "collab" internally
    if (newMode === 'agent collab') {
        newMode = 'collab';
    }

    if (newMode !== 'standalone' && newMode !== 'agent' && newMode !== 'collab') {
        addToHistory('system', 'Invalid mode. Use: /mode <standalone|agent|agent collab>');
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
        return;
    }

    currentMode = newMode;
    const displayMode = currentMode === 'collab' ? 'agent collab' : currentMode;
    addToHistory('system', `Switched to ${displayMode} mode`);
    if (currentMode === 'standalone') {
        addToHistory('system', 'Standalone mode - General AI chat with file operation skills');
    } else if (currentMode === 'agent') {
        addToHistory('system', 'Agent mode - Task-aware with autonomous skill execution');
    } else if (currentMode === 'collab') {
        addToHistory('system', 'Agent Collaboration mode - Multiple agents with autonomous skill execution');
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

    // Fetch tasks and skills for context awareness
    const tasksResult = await api.getTasks();
    const skillsResult = await api.getSkills();
    const skills = skillsResult.success ? skillsResult.data : [];
    const skillPrompt = buildSkillSystemPrompt(skills, 'collab');

    let contextInfo = '';

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
}

// Handle natural language chat with session awareness and skill execution
async function handleChat(api, message) {
    // Add user message to history
    addToHistory('user', message);

    // Add to conversation context for session awareness
    conversationContext.push({ role: 'user', content: message });

    // Fetch skills for skill execution capability
    const skillsResult = await api.getSkills();
    const skills = skillsResult.success ? skillsResult.data : [];
    const skillPrompt = buildSkillSystemPrompt(skills, currentMode);

    // Show "thinking" indicator
    addToHistory('system', 'Thinking...');
    displayChatHistory();

    // Build context-aware message for the API
    let userMessage = message;
    let systemPrefix = '';

    // Add skill execution capability FIRST (most important)
    if (skillPrompt) {
        systemPrefix = skillPrompt + '\n\n';
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

    // Build final message: system prefix + conversation context + user message
    let contextMessage = systemPrefix;

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

        const result = await api.chat(currentMessage);

        // Remove "thinking" indicator on first iteration
        if (iteration === 1) {
            chatHistory.pop();
        }

        if (!result.success) {
            addToHistory('system', `Error: ${result.error}`);
            displayChatHistory();
            return;
        }

        // Update token usage stats
        if (result.data.tokens) {
            lastTokenUsage = {
                prompt: result.data.tokens.prompt_tokens || 0,
                completion: result.data.tokens.completion_tokens || 0,
                total: result.data.tokens.total_tokens || 0
            };
            totalTokensUsed += lastTokenUsage.total;

            // Update context window tracking
            contextWindowUsed = conversationContext.length > 0 ?
                conversationContext.reduce((sum, msg) => sum + Math.ceil(msg.content.length / 4), 0) : 0;
        }

        const response = result.data.response;
        finalResponse = response;

        // Check for skill calls in the response
        const skillCalls = parseSkillCalls(response);

        if (skillCalls.length === 0) {
            // No skill calls, we're done
            break;
        }

        // Display what AI said before executing skills
        if (!isOnlySkillCalls(response)) {
            addToHistory('assistant', response);
            displayChatHistory();
        }

        // Execute the skills
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

    // Add final assistant response to history (if not already added)
    if (!isOnlySkillCalls(finalResponse)) {
        addToHistory('assistant', finalResponse);
    }
    displayChatHistory();
}

// Main interactive shell
async function startShell() {
    const config = loadConfig();

    if (!config) {
        addToHistory('system', 'Welcome to koda! Run /auth to get started.');
        addToHistory('system', 'Commands: /auth | /help');
    } else {
        addToHistory('system', `Connected! Mode: ${currentMode}`);
        addToHistory('system', 'Type a message to chat or use /help for commands.');
    }

    let api = config ? new AgentAPI(config.apiUrl, config.apiKey, config.apiSecret) : null;

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
                    addToHistory('system', '✓ Authentication configured successfully!');
                    addToHistory('system', `Config saved to ${CONFIG_FILE}`);
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
                // Natural language chat or agent selection
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
}

// Start the shell
startShell();
