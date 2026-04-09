#!/bin/bash
# koda regression battery. Runs a set of representative queries in
# single-shot mode and shows just the response block for each so you
# can eyeball quality before/after changes.
set -u

: "${KODA_API_KEY:?set KODA_API_KEY to an API key with query+skills permissions}"
: "${KODA_API_SECRET:?set KODA_API_SECRET to the matching secret}"
export KODA_API_URL="${KODA_API_URL:-https://localhost:3001}"

KODA="node $(dirname "$0")/bin/koda.js"
HR='================================================================'

run() {
    local label="$1"
    local query="$2"
    echo ""
    echo "$HR"
    echo "#> $label"
    echo "#> query: $query"
    echo "$HR"
    # Timeout long queries so the whole battery finishes in reasonable time
    timeout 90 $KODA -p "$query" 2>&1 \
        | sed -n '/--- KODA RESPONSE ---/,/--- END RESPONSE ---/p'
}

run "arithmetic-simple"     "10+10"
run "arithmetic-words"      "what is 47 times 38"
run "greeting"              "hi"
run "factual-short"         "who wrote Hamlet"
run "factual-longer"        "explain what a hash table is in two sentences"
run "code-snippet"          "write a python function that reverses a string"
run "file-listing"          "list the files in the current directory"
run "git-status"            "what git branch am I on"
run "metadata-trap"         "count to 5"
run "ambiguous"             "test"

echo ""
echo "$HR"
echo "Battery complete."
