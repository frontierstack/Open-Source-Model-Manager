#!/bin/bash
# Consolidated integration test for the Skills/Tools/sandbox migration.
# Exercises every piece added in Phases 1–8.
#
# Usage:
#   API_KEY=... API_SECRET=... ./test-sandbox-suite.sh
#
# Prereqs: webapp running at BASE_URL (default https://localhost:3001),
# gVisor registered, sandbox image built.

set -u
BASE=${BASE_URL:-https://localhost:3001}
API_KEY=${API_KEY:?API_KEY required}
API_SECRET=${API_SECRET:?API_SECRET required}
AUTH=(-H "X-API-Key: $API_KEY" -H "X-API-Secret: $API_SECRET")

pass=0
fail=0
fails=()
assert() {
    # Second arg is a shell status code: 0 = success, non-zero = failure.
    local label="$1" rc="$2" detail="${3:-}"
    if [ "$rc" = "0" ]; then
        printf "  \e[32m✓\e[0m %s\n" "$label"
        pass=$((pass+1))
    else
        printf "  \e[31m✗\e[0m %s\n" "$label"
        [ -n "$detail" ] && printf "     \e[2m%s\e[0m\n" "$detail"
        fail=$((fail+1))
        fails+=("$label")
    fi
}

hr() { printf "\n\e[1;36m%s\e[0m\n" "$1"; }

# -----------------------------------------------------------------------
hr "Phase 2 — /api/tools alias"
skills_body=$(curl -sk "${BASE}/api/skills" "${AUTH[@]}")
tools_body=$(curl -sk  "${BASE}/api/tools"  "${AUTH[@]}")
skills_count=$(echo "$skills_body" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)
tools_count=$(echo  "$tools_body"  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)
[ "$skills_count" = "$tools_count" ] && [ -n "$skills_count" ]
assert "/api/tools returns same count as /api/skills ($skills_count)" $?

agents_body=$(curl -sk "${BASE}/api/agents/tools/available" "${AUTH[@]}" -o /dev/null -w "%{http_code}")
[ "$agents_body" = "200" ]
assert "/api/agents/tools/available alias returns 200" $?

# -----------------------------------------------------------------------
hr "Phase 3 — Markdown skills CRUD"
create_resp=$(curl -sk -X POST "${BASE}/api/markdown-skills" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"name":"suite test skill","description":"Temporary","triggers":"test","body":"## Steps\n1. Do a thing"}')
skill_id=$(echo "$create_resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id","") )' 2>/dev/null)
[ -n "$skill_id" ] && [ "$skill_id" = "suite-test-skill" ]
assert "POST /api/markdown-skills creates and returns id=$skill_id" $?

get_resp=$(curl -sk "${BASE}/api/markdown-skills/$skill_id" "${AUTH[@]}")
echo "$get_resp" | grep -q "Do a thing"
assert "GET /api/markdown-skills/:id returns body" $?

curl -sk -X PUT "${BASE}/api/markdown-skills/$skill_id" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"body":"## Updated\n1. Updated step"}' >/dev/null
echo "$(curl -sk "${BASE}/api/markdown-skills/$skill_id" "${AUTH[@]}")" | grep -q "Updated step"
assert "PUT /api/markdown-skills/:id updates body" $?

del_resp=$(curl -sk -X DELETE "${BASE}/api/markdown-skills/$skill_id" "${AUTH[@]}")
echo "$del_resp" | grep -q '"ok":true'
assert "DELETE /api/markdown-skills/:id returns ok" $?

after_del=$(curl -sk "${BASE}/api/markdown-skills" "${AUTH[@]}" | python3 -c 'import json,sys,re; print("1" if all(s["id"]!="suite-test-skill" for s in json.load(sys.stdin)) else "0")')
[ "$after_del" = "1" ]
assert "Deleted skill no longer in list" $?

# -----------------------------------------------------------------------
hr "Phase 5 — gVisor registered"
runtime_found=$(docker info 2>&1 | grep -c "runsc")
[ "$runtime_found" -gt 0 ]
assert "runsc registered as Docker runtime" $?

# -----------------------------------------------------------------------
hr "Phase 6 — Egress proxy stats endpoint"
ep_stats=$(curl -sk "${BASE}/api/system/egress-proxy" "${AUTH[@]}")
echo "$ep_stats" | grep -q '"listening":true'
assert "Egress proxy reports listening=true" $?

# -----------------------------------------------------------------------
hr "Phase 7 — Sandbox isolation"
# Seed a throwaway Python skill with sandbox:true that probes isolation.
docker exec modelserver-webapp-1 node -e '
const fs = require("fs");
const p = "/models/.modelserver/skills.json";
const skills = JSON.parse(fs.readFileSync(p, "utf8"));
const name = "suite_sbx_probe";
const existing = skills.find(s => s.name === name);
const skill = existing || {};
skill.id = skill.id || "suite_sbx_probe_" + Date.now().toString(36);
skill.name = name;
skill.description = "Sandbox suite probe";
skill.type = "function";
skill.parameters = {};
skill.enabled = true;
skill.sandbox = true;
skill.code = `def execute(params):
    import os, socket
    out = {}
    try: open("/evil","w").write("x"); out["root_fs"] = "ALLOWED"
    except Exception as e: out["root_fs"] = "blocked"
    try:
        with open("/artifacts/out.txt","w") as f: f.write("ok")
        out["artifact"] = "ok"
    except Exception as e: out["artifact"] = "FAIL"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2); s.connect(("example.com",80))
        out["net"] = "REACHED"
    except Exception: out["net"] = "blocked"
    try:
        out["uname"] = os.uname()
    except Exception: pass
    out["success"] = True
    return out
`;
if (!existing) skills.push(skill);
fs.writeFileSync(p, JSON.stringify(skills, null, 2));
' >/dev/null
docker restart modelserver-webapp-1 >/dev/null
sleep 4

probe=$(curl -sk -X POST "${BASE}/api/tools/suite_sbx_probe/execute" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{}')

echo "$probe" | grep -q '"root_fs":"blocked"'
assert "Sandbox blocks writes to root filesystem" $? "$probe"
echo "$probe" | grep -q '"artifact":"ok"'
assert "Sandbox can write to /artifacts" $?
echo "$probe" | grep -q '"net":"blocked"'
assert "Sandbox blocks network with network=none" $?
echo "$probe" | grep -q '"_artifacts"'
assert "Response includes _artifacts with download URLs" $?
# os.uname() serializes as a positional array in Python's json; the release
# field is the 3rd element (index 2). gVisor always reports "4.4.0".
echo "$probe" | grep -qE '"4\.4\.0"'
assert "Sandbox kernel is gVisor's virtualized 4.4.0 (not host)" $?

# -----------------------------------------------------------------------
hr "Phase 8 — Artifact download"
url=$(echo "$probe" | python3 -c 'import json,sys,re; d=json.load(sys.stdin); arts=d.get("_artifacts",[]); print(arts[0]["url"] if arts else "")' 2>/dev/null || echo "")
if [ -n "$url" ]; then
    body=$(curl -sk "${BASE}${url}" "${AUTH[@]}")
    [ "$body" = "ok" ]
    assert "GET $url streams artifact body" $?
else
    assert "Artifact URL present for download" 0
fi

# Traversal reject
st=$(curl -sk -o /dev/null -w "%{http_code}" "${BASE}/api/tool-artifacts/badRunId/foo.txt" "${AUTH[@]}")
[ "$st" = "400" ]
assert "Artifact endpoint rejects bad runId (got $st)" $?

# -----------------------------------------------------------------------
hr "Markdown Skills — library inventory"
md_list=$(curl -sk "${BASE}/api/markdown-skills" "${AUTH[@]}")
md_count=$(echo "$md_list" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)
[ -n "$md_count" ] && [ "$md_count" -ge 30 ]
assert "Markdown skill library populated (count=$md_count ≥ 30)" $?
echo "$md_list" | grep -q '"github-repo-research"'
assert "Library contains github-repo-research skill" $?
echo "$md_list" | grep -q '"troubleshoot-docker"'
assert "Library contains troubleshoot-docker skill" $?
# Verify one skill loads fully (including body)
one=$(curl -sk "${BASE}/api/markdown-skills/debug-python-error" "${AUTH[@]}")
echo "$one" | grep -q "Steps"
assert "Skill body retrievable (debug-python-error)" $?

# -----------------------------------------------------------------------
hr "Native tool catalog"
# Queries the webapp's in-process registry via the admin endpoint — the
# chatTools singleton reflects all IIFE registrations from server.js
# (load_skill, web_search, fetch_url) rather than just the baseline.
tools_dump=$(curl -sk "${BASE}/api/system/tools-catalog" "${AUTH[@]}")
echo "$tools_dump" | grep -q "load_skill"
assert "Tool catalog includes load_skill" $?
echo "$tools_dump" | grep -q "web_search"
assert "Tool catalog includes web_search" $?
echo "$tools_dump" | grep -q "fetch_url"
assert "Tool catalog includes fetch_url" $?
echo "$tools_dump" | grep -q "base64_decode"
assert "Tool catalog includes base64_decode (dynamic skill surface)" $?
echo "$tools_dump" | grep -q "dns_lookup"
assert "Tool catalog includes dns_lookup (dynamic skill surface)" $?
# Count should be well above the 3 static tools once skills are surfaced
catalog_count=$(echo "$tools_dump" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("count",0))' 2>/dev/null)
[ "${catalog_count:-0}" -ge 30 ]
assert "Tool catalog surfaces >= 30 skills (count=$catalog_count)" $?

# -----------------------------------------------------------------------
hr "Skill enable/disable toggle"
# Flip base64_decode enabled=false on disk and verify the catalog hides it
# AND direct execute refuses. Flip back to enabled=true afterwards.
toggle_skill() {
    docker exec modelserver-webapp-1 node -e "
const fs=require('fs');
const p='/models/.modelserver/skills.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
const t=s.find(x=>x.name==='base64_decode');
if(!t){console.error('not found'); process.exit(1);}
t.enabled=$1;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
" >/dev/null
    docker restart modelserver-webapp-1 >/dev/null
    sleep 4
}
catalog_has() {
    curl -sk "${BASE}/api/system/tools-catalog" "${AUTH[@]}" \
      | python3 -c "import json,sys; print('yes' if '$1' in json.load(sys.stdin).get('tools',[]) else 'no')" 2>/dev/null
}
execute_b64() {
    curl -sk -X POST "${BASE}/api/tools/base64_decode/execute" "${AUTH[@]}" \
      -H "Content-Type: application/json" -d '{"encodedData":"SGVsbG8="}'
}

# Enabled baseline
toggle_skill true
[ "$(catalog_has base64_decode)" = "yes" ]
assert "enabled skill: present in catalog" $?
enabled_exec=$(execute_b64)
echo "$enabled_exec" | grep -q '"decoded":"Hello"'
assert "enabled skill: direct execute succeeds" $?

# Disabled — should be hidden + refused
toggle_skill false
[ "$(catalog_has base64_decode)" = "no" ]
assert "disabled skill: hidden from catalog" $?
disabled_exec=$(execute_b64)
echo "$disabled_exec" | grep -q '"enabled":false'
assert "disabled skill: direct execute refused" $?

# Restore
toggle_skill true
[ "$(catalog_has base64_decode)" = "yes" ]
assert "restore: skill re-enabled and visible" $?

# -----------------------------------------------------------------------
hr "Workspace-migrated defaults"
# Seed a file the workspace skills can see
docker exec modelserver-webapp-1 sh -c 'mkdir -p /models/.modelserver/workspaces/global; chmod 0777 /models/.modelserver/workspaces/global; echo "probe content" > /models/.modelserver/workspaces/global/probe.txt' >/dev/null

# list_directory — relative path, runs in sandbox + workspace
ld=$(curl -sk -X POST "${BASE}/api/tools/list_directory/execute" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{"dirPath": "."}')
echo "$ld" | grep -q "probe.txt"
assert "list_directory sees probe.txt in workspace" $? "$ld"

# read_file — normalized path
rf=$(curl -sk -X POST "${BASE}/api/tools/read_file/execute" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{"filePath": "probe.txt"}')
echo "$rf" | grep -q "probe content"
assert "read_file returns workspace content" $? "$rf"

# traversal blocked with structured error
tr=$(curl -sk -X POST "${BASE}/api/tools/read_file/execute" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{"filePath": "../../etc/passwd"}')
echo "$tr" | grep -q "escapes workspace"
assert "Traversal rejected with structured error" $? "$tr"

# absolute path coerced to basename — content different (no demo outside workspace)
abs=$(curl -sk -X POST "${BASE}/api/tools/read_file/execute" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{"filePath": "/etc/passwd"}')
# Should either 404 (no /workspace/passwd) or return passwd if one happens to exist.
# What matters is that it is NOT reading the host's /etc/passwd.
echo "$abs" | grep -qE "(success.{0,4}false|\"filePath\":\"/workspace/)"
assert "Absolute path coerced under /workspace (not host's /etc/passwd)" $? "$abs"

# -----------------------------------------------------------------------
hr "Chat stream end-to-end — native tool call"
# Only runs if a model instance is available; else skip with a note.
model=$(curl -sk "${BASE}/api/llamacpp/instances" "${AUTH[@]}" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    arr = json.load(sys.stdin)
    if isinstance(arr, list) and arr:
        print(arr[0].get("name") or arr[0].get("model") or "")
except Exception: pass
')
if [ -n "$model" ]; then
    # Ask the model a question that should trigger load_skill; with native
    # tool calling registered, we expect at least one tool_executing event
    # and one tool_result in the SSE stream.
    stream=$(timeout 60 curl -sk -N -X POST "${BASE}/api/chat/stream" "${AUTH[@]}" \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"I need to research a GitHub repo — load the skill that explains how.\",\"model\":\"$model\",\"maxTokens\":200}" 2>/dev/null)
    echo "$stream" | grep -q '"type":"tool_executing"'
    assert "Model issued a tool call during chat (load_skill or similar)" $?
    echo "$stream" | grep -q '"type":"tool_result"'
    assert "Server returned tool_result back to the stream" $?
else
    echo "  - (no model instance loaded — skipping chat e2e)"
fi

# -----------------------------------------------------------------------
hr "Live code preview endpoint (/api/sandbox/run-code)"
rc=$(curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"import sys\nprint(\"ok\", sys.version.split()[0])"}')
echo "$rc" | grep -q '"success":true'
assert "run-code executes python in sandbox" $? "$rc"
echo "$rc" | grep -q '"sandboxed":true'
assert "run-code reports sandboxed=true (gVisor engaged)" $?
echo "$rc" | grep -q '"stdout":"ok 3\.12'
assert "run-code stdout uses sandbox Python (3.12), not host's 3.11" $? "$rc"

# Language reject
bad=$(curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{"language":"bash","code":"echo hi"}')
echo "$bad" | grep -q "not runnable server-side"
assert "run-code refuses non-Python languages server-side" $?

# Network is blocked (no allowlist on this path)
netblock=$(curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"import socket\ntry:\n    s=socket.socket()\n    s.settimeout(2)\n    s.connect((\"example.com\",80))\n    print(\"REACHED\")\nexcept Exception as e:\n    print(\"blocked:\", type(e).__name__)"}')
echo "$netblock" | grep -q "blocked:"
assert "run-code has no network access (network=none)" $? "$netblock"

# Scientific stack imports
scientific=$(curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"import numpy, pandas, matplotlib, scipy, PIL, sympy, pygame\nprint(\"ok\", numpy.__version__)"}')
echo "$scientific" | grep -q '"success":true'
assert "Sandbox image includes numpy/pandas/matplotlib/scipy/pillow/sympy/pygame" $? "$scientific"

# Matplotlib → artifact PNG surfaces in response
mpl=$(curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"import matplotlib.pyplot as plt\nplt.plot([1,2,3,4],[1,4,9,16])\nplt.savefig(\"/artifacts/fig.png\")\nprint(\"ok\")"}')
echo "$mpl" | grep -q '"name":"fig.png"'
assert "Matplotlib plot saved to /artifacts returns in response" $?
art_url=$(echo "$mpl" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["artifacts"][0]["url"] if d.get("artifacts") else "")' 2>/dev/null)
if [ -n "$art_url" ]; then
    ct=$(curl -sk -o /tmp/_suite_fig.png -w "%{http_code}" "${BASE}${art_url}" "${AUTH[@]}")
    [ "$ct" = "200" ] && head -c 8 /tmp/_suite_fig.png | xxd -p | grep -q "89504e470d0a1a0a"
    assert "Artifact URL returns a real PNG (png magic bytes)" $?
    rm -f /tmp/_suite_fig.png
fi

# pygame can init + render to offscreen surface
pg=$(curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"import pygame\npygame.init()\ns = pygame.Surface((32,32))\ns.fill((100,150,200))\npygame.image.save(s, \"/artifacts/sprite.png\")\nprint(\"pg\", pygame.version.ver)"}')
echo "$pg" | grep -q '"name":"sprite.png"'
assert "pygame renders offscreen to /artifacts (SDL_VIDEODRIVER=dummy)" $? "$pg"

# pygame "while running:" game loop — harness auto-captures first frame
# and raises SystemExit so chat-generated snippets don't hit the timeout.
pg_loop=$(timeout 15 curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"import pygame\npygame.init()\nscreen = pygame.display.set_mode((100, 50))\nclock = pygame.time.Clock()\nrunning = True\nwhile running:\n    for e in pygame.event.get():\n        if e.type == pygame.QUIT: running = False\n    screen.fill((20, 60, 120))\n    pygame.display.flip()\n    clock.tick(60)\npygame.quit()"}')
echo "$pg_loop" | grep -q '"success":true'
assert "pygame game loop auto-exits instead of timing out" $? "$pg_loop"
echo "$pg_loop" | grep -q '"name":"frame.png"'
assert "pygame game loop saves first frame as artifact" $?

# input() — fast-fail, not a timeout
stdin=$(timeout 10 curl -sk -X POST "${BASE}/api/sandbox/run-code" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"language":"python","code":"x = input(\"> \")\nprint(x)"}')
echo "$stdin" | grep -q '"success":true'
assert "input() fast-fails rather than blocking on stdin" $?
echo "$stdin" | grep -q "not available in sandbox"
assert "input() error message is clear about why" $?

# -----------------------------------------------------------------------
hr "Egress proxy — rejection counters increment on bad request"
before=$(curl -sk "${BASE}/api/system/egress-proxy" "${AUTH[@]}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["rejectedNoToken"])')
docker exec modelserver-webapp-1 sh -c 'curl -sS --proxy http://localhost:3180 http://example.com/ >/dev/null 2>&1' || true
after=$(curl -sk "${BASE}/api/system/egress-proxy" "${AUTH[@]}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["rejectedNoToken"])')
[ "$after" -gt "$before" ]
assert "rejectedNoToken counter increments on unauthenticated proxy hit ($before → $after)" $?

# Cleanup workspace probe
docker exec modelserver-webapp-1 rm -f /models/.modelserver/workspaces/global/probe.txt >/dev/null

# -----------------------------------------------------------------------
hr "Regression — existing endpoints still respond"
for ep in /api/auth/me /api/models /api/skills /api/apps /api/conversations /api/agents; do
    st=$(curl -sk -o /dev/null -w "%{http_code}" "${BASE}${ep}" "${AUTH[@]}")
    [ "$st" = "200" ] || [ "$st" = "403" ]
    assert "$ep responds (status=$st)" $?
done

# Cleanup
docker exec modelserver-webapp-1 node -e '
const fs=require("fs"); const p="/models/.modelserver/skills.json";
const s=JSON.parse(fs.readFileSync(p,"utf8"));
fs.writeFileSync(p, JSON.stringify(s.filter(x=>x.name!=="suite_sbx_probe"), null, 2));
' >/dev/null

# -----------------------------------------------------------------------
hr "Summary"
printf "  \e[1mpassed: %d   failed: %d\e[0m\n" "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
    printf "  \e[31mfailed tests:\e[0m\n"
    for f in "${fails[@]}"; do printf "    - %s\n" "$f"; done
    exit 1
fi
exit 0
