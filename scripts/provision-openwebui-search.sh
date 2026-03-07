#!/bin/bash
# Provision Open WebUI with external web search configuration
# This script runs on startup to configure Open WebUI's search settings

set -e

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}>>> Configuring Open WebUI external search...${NC}"

# Wait for Open WebUI container to be running
MAX_WAIT=60
WAITED=0
while ! docker ps --format '{{.Names}}' | grep -q "open-webui"; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo "Warning: Open WebUI container not found after ${MAX_WAIT}s, skipping search provisioning"
        exit 0
    fi
    sleep 2
    WAITED=$((WAITED + 2))
done

echo ">>> Waiting for Open WebUI database to initialize..."

# Wait for database to be ready (longer wait on fresh install)
MAX_DB_WAIT=120
DB_WAITED=0
while ! docker exec modelserver-open-webui-1 test -f /app/backend/data/webui.db 2>/dev/null; do
    if [ $DB_WAITED -ge $MAX_DB_WAIT ]; then
        echo "Warning: Open WebUI database not found after ${MAX_DB_WAIT}s"
        echo "This may happen on first run. Try running this script manually after Open WebUI is fully loaded:"
        echo "  ./scripts/provision-openwebui-search.sh"
        exit 0
    fi
    sleep 3
    DB_WAITED=$((DB_WAITED + 3))
    echo "  Waiting for database... (${DB_WAITED}/${MAX_DB_WAIT}s)"
done

# Give the database a moment to fully initialize after creation
sleep 3

# Provision the configuration
docker exec modelserver-open-webui-1 python3 << 'PYTHON_SCRIPT'
import sqlite3
import json
import sys

DB_PATH = '/app/backend/data/webui.db'

# Advanced RAG template with web search awareness
RAG_TEMPLATE = '''### System Context
You are an AI assistant with **live web search capabilities**. When this prompt appears, a web search has been performed and real-time results are provided below.

### Knowledge Source Priority
Use this decision framework for answering:

1. **ALWAYS use search results for:**
   - Current date, time, or "today's" information (check the "Current Date & Time" source)
   - Recent news, events, or developments (past 1-2 years)
   - Current prices, statistics, or live data
   - Information that changes frequently (weather, stocks, sports scores)
   - Anything the user explicitly asks to "search" or "look up"

2. **Use your training knowledge for:**
   - Historical facts, established science, mathematics
   - Definitions, concepts, and explanations
   - Programming syntax, language rules, general how-to
   - Information unlikely to have changed since your training

3. **Combine both when:**
   - Explaining current events (use search for facts, your knowledge for context)
   - Technical topics with recent updates (base knowledge + latest from search)
   - Comparisons between past and present

### Response Guidelines
- **Never claim you cannot access the internet** - you have web search, and results are below
- **Never claim you don't know the current date** - it's in the search results
- **Cite sources** using [id] format when the <source> tag has an id attribute
- If search results don't contain relevant information, say so and use your knowledge
- Be direct and confident - avoid unnecessary disclaimers about your capabilities
- Respond in the same language as the user's query

### Citation Format
Only cite when <source id="X"> is present. Example: "The event occurred on March 5th [1]."

<context>
{{CONTEXT}}
</context>

### Your Response
Provide a clear, direct answer using the above context and guidelines.'''

# Aggressive query generation template
QUERY_GEN_TEMPLATE = '''### Task:
Analyze the chat history and generate search queries. You MUST generate queries for ANY of these scenarios:

**ALWAYS SEARCH FOR:**
- Questions about current date, time, day of week, or "today"
- Questions about recent events, news, or current affairs
- Questions containing words like: "latest", "recent", "current", "now", "today", "this week/month/year"
- Requests for real-time data (weather, prices, scores, stocks)
- Questions about people (their current status, recent activities)
- Technology updates or version information
- Any question where the answer might have changed recently

**MAY SKIP SEARCH FOR:**
- Mathematical calculations (pure math, no dates)
- Historical facts with fixed dates (e.g., "When was WWII?")
- Programming syntax or language rules
- Definitions of timeless concepts
- Questions explicitly about the AI itself

### Rules:
1. When in doubt, GENERATE A SEARCH QUERY
2. For date/time questions, search for "current date" or similar
3. Return 1-3 relevant queries
4. Today is: {{CURRENT_DATE}}

### Output Format (JSON only, no other text):
{ "queries": ["query1", "query2"] }

Return { "queries": [] } ONLY if you are 100% certain a search adds no value.

### Chat History:
<chat_history>
{{MESSAGES:END:6}}
</chat_history>
'''

try:
    import time

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # Wait for config table to exist (Open WebUI may still be running migrations)
    max_table_wait = 30
    table_waited = 0
    while table_waited < max_table_wait:
        c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='config'")
        if c.fetchone():
            break
        print(f"Waiting for config table to be created... ({table_waited}/{max_table_wait}s)")
        time.sleep(3)
        table_waited += 3

    if table_waited >= max_table_wait:
        print("Config table not found - Open WebUI may still be initializing")
        print("Try running this script again after Open WebUI is fully loaded")
        sys.exit(1)

    # Get current config
    c.execute('SELECT data FROM config WHERE id=1')
    row = c.fetchone()

    if not row:
        print("No config found, creating new config")
        data = {"version": 0}
    else:
        data = json.loads(row[0])

    # Ensure RAG config exists
    if 'rag' not in data:
        data['rag'] = {}
    if 'web' not in data['rag']:
        data['rag']['web'] = {}
    if 'search' not in data['rag']['web']:
        data['rag']['web']['search'] = {}

    # Configure external search (URL only - API key must be set manually)
    search_config = data['rag']['web']['search']
    search_config['enable'] = True
    search_config['engine'] = 'external'
    search_config['external_web_search_url'] = 'http://host.docker.internal:3080/api/openwebui/search'
    search_config['result_count'] = 5
    # Don't overwrite API key if already set
    if 'external_web_search_api_key' not in search_config:
        search_config['external_web_search_api_key'] = ''

    # Set RAG template
    data['rag']['template'] = RAG_TEMPLATE

    # Set query generation template
    if 'task' not in data:
        data['task'] = {}
    if 'query' not in data['task']:
        data['task']['query'] = {}
    data['task']['query']['prompt_template'] = QUERY_GEN_TEMPLATE

    # Update or insert config
    if row:
        c.execute('UPDATE config SET data = ? WHERE id = 1', (json.dumps(data),))
    else:
        c.execute('INSERT INTO config (id, data) VALUES (1, ?)', (json.dumps(data),))

    conn.commit()
    conn.close()

    print("SUCCESS: Open WebUI search configuration provisioned")
    print("  - External search URL: http://host.docker.internal:3080/api/openwebui/search")
    print("  - Search engine: external")
    print("  - Result count: 5")
    print("  - RAG template: web search awareness enabled")
    print("  - Query generation: aggressive search for time-sensitive queries")
    print("")
    print("NOTE: You must manually set the API key in Open WebUI:")
    print("  Admin > Settings > Web Search > External Web Search API Key")

except Exception as e:
    print(f"Error provisioning Open WebUI: {e}", file=sys.stderr)
    sys.exit(1)
PYTHON_SCRIPT

echo -e "${GREEN}>>> Open WebUI search configuration complete${NC}"
