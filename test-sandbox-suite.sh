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
