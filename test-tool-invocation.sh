#!/bin/bash
# Realistic invocation audit: does the chat model call the right tool
# when asked in natural language? Covers file ops, encoding, data, net,
# system, utility categories. Prints per-prompt tool calls + a clean
# pass/fail verdict so we can spot categories where the model falls back
# to text answers instead of tool-calling.

set -u
API_KEY=${API_KEY:?}
API_SECRET=${API_SECRET:?}
BASE=${BASE_URL:-https://localhost:3001}
MODEL=${MODEL:-gemma-4-26B-A4B-it-GGUF}

pass=0; fail=0; partial=0
results=()

test_prompt() {
    local category="$1" expected="$2" message="$3"
    local body
    body=$(python3 -c "import json,sys; print(json.dumps({'message':sys.argv[1],'model':'$MODEL','maxTokens':200}))" "$message")
    timeout 90 curl -sk -N -X POST "$BASE/api/chat/stream" \
        -H "X-API-Key: $API_KEY" -H "X-API-Secret: $API_SECRET" \
        -H "Content-Type: application/json" --data "$body" 2>/dev/null > /tmp/inv.sse

    local summary
    summary=$(python3 <<PY
import json
calls = []
with open('/tmp/inv.sse') as f:
    for line in f:
        if not line.startswith('data: '): continue
        raw = line[6:].strip()
        if raw == '[DONE]': break
        try: ev = json.loads(raw)
        except: continue
        if ev.get('type') == 'tool_executing':
            calls.append(ev.get('name'))
print(','.join(calls) if calls else '(none)')
PY
)
    local expected_tool="$expected"
    local status_label verdict
    if echo "$summary" | grep -qw "$expected_tool"; then
        verdict=PASS; pass=$((pass+1))
    elif [ "$summary" = "(none)" ]; then
        verdict=MISS; fail=$((fail+1))
    else
        verdict=OTHER; partial=$((partial+1))
    fi
    printf "  %-6s  [%s]  expect=%s  got=%s\n" "$verdict" "$category" "$expected_tool" "$summary"
    printf "          → %s\n" "$message"
}

echo "=== invocation audit: does the model call the right tool? ==="
echo

# ENCODING
test_prompt enc  base64_decode "Decode this base64 for me: SGVsbG8gV29ybGQh"
test_prompt enc  base64_encode "Encode the string 'Hello World' as base64"
test_prompt enc  hash_data     "What's the SHA-256 hash of the string 'password123'?"

# DATA parsing
test_prompt data parse_json    'Parse this JSON and tell me the value of "city": {"name":"Alice","city":"Paris"}'
test_prompt data count_words   "How many words are in this paragraph: the quick brown fox jumps over the lazy dog and the dog does not chase the fox"

# NETWORK
test_prompt net  dns_lookup    "What's the IP address for wikipedia.org?"
test_prompt net  ping_host     "Ping github.com and tell me if it's reachable"

# FILE OPS (workspace-sandboxed)
test_prompt file list_directory "List the files in the current workspace directory"
test_prompt file create_file   'Create a file named notes.txt with the content "my notes"'
test_prompt file read_file     "Read the contents of notes.txt"

# SYSTEM
test_prompt sys  system_info   "Tell me the current system info"
test_prompt sys  get_timestamp "What's the current timestamp in ISO 8601?"

# UTILITY
test_prompt util generate_uuid "Generate a new UUID for me"
test_prompt util find_patterns "In this text: 'hello world at 10:30 then 11:45', find all time patterns"

# ACTIVE SEARCH — should call the native web_search
test_prompt web  web_search    "Search the web for current news about SpaceX Starship"

echo
echo "=== totals ==="
echo "  PASS (right tool called):  $pass"
echo "  MISS (no tool call):       $fail"
echo "  OTHER (different tool):    $partial"
echo
printf "  %d / %d prompts triggered the EXPECTED tool\n" "$pass" "$((pass + fail + partial))"
