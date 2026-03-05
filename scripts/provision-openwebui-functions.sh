#!/bin/bash

# Provision custom functions to Open WebUI
# Run this after start.sh or when Open WebUI is running

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo ">>> Provisioning Open WebUI functions..."

# Check if Open WebUI is running
if ! docker ps | grep -q "modelserver-open-webui-1"; then
    echo "Error: Open WebUI container is not running"
    echo "Start services first: ./start.sh"
    exit 1
fi

# Read function code
FUNCTION_FILE="$PROJECT_DIR/webapp/openwebui-functions/web_search.py"
if [ ! -f "$FUNCTION_FILE" ]; then
    echo "Error: Function file not found: $FUNCTION_FILE"
    exit 1
fi

# Copy database from container
docker cp modelserver-open-webui-1:/app/backend/data/webui.db /tmp/webui.db

# Provision function using Python
python3 << EOF
import sqlite3
import json
import time

with open('$FUNCTION_FILE', 'r') as f:
    function_content = f.read()

conn = sqlite3.connect('/tmp/webui.db')
cursor = conn.cursor()

function_id = 'modelserver_web_search'
function_meta = json.dumps({'description': 'Search the web using DuckDuckGo with Playwright content fetching'})
now = int(time.time())

cursor.execute('''
    INSERT OR REPLACE INTO function (id, user_id, name, type, content, meta, created_at, updated_at, valves, is_active, is_global)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
''', (function_id, '', 'Web Search', 'tool', function_content, function_meta, now, now, None, 1, 1))

conn.commit()
print(f'Provisioned: Web Search function')
conn.close()
EOF

# Copy back to container
docker cp /tmp/webui.db modelserver-open-webui-1:/app/backend/data/webui.db

# Clean up
rm -f /tmp/webui.db

echo ""
echo ">>> Functions provisioned successfully!"
echo ""
echo "Next steps:"
echo "  1. Restart Open WebUI: docker compose restart open-webui"
echo "  2. Go to Open WebUI Admin Panel > Functions"
echo "  3. Configure API_KEY and API_SECRET in the Web Search function settings"
echo ""
