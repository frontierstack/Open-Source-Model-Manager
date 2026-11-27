#!/bin/bash
# Upgrade an inference engine to a newer upstream release, safely.
#
#   sudo ./scripts/engine-upgrade.sh [--engine E] status
#   sudo ./scripts/engine-upgrade.sh [--engine E] check     # is a newer release out?
#   sudo ./scripts/engine-upgrade.sh [--engine E] upgrade [--version X] [--force] [--if-newer]
#   sudo ./scripts/engine-upgrade.sh [--engine E] rollback
#   sudo ./scripts/engine-upgrade.sh effective-ref [llamacpp|sglang]
#
# E = llamacpp (default) | strata | vllm | sglang. Nothing replaces the working
# engine until the new one has passed its test:
#   llamacpp  build modelserver-llamacpp:next at the release, run :next and
#             :latest on the same small GGUF and card; the new one must answer,
#             make a valid tool call when the old one can, and decode at least
#             UPGRADE_MIN_SPEED_RATIO (0.85) as fast
#   strata    pull the release image, run the old and the new image on the real
#             model with the live settings (all GPUs: no Strata model may be
#             loaded — the console unloads it and loads it again afterwards);
#             same checks as llama.cpp
#   vllm      pull the release image; it must start and see the GPUs (no vLLM
#             model is kept on this server to compare with)
#   sglang    build modelserver-sglang:next on the release base image with our
#             patches; it must import and start its server help (same reason)
# Promotion keeps a rollback point: llama.cpp / SGLang tag :latest as
# :pre-<version>; Strata / vLLM keep the previous image and record the version
# in the override file the webapp, engines.sh and update.sh read
# (models/.modelserver/engine-upgrade/versions.json), so the checkout's pins in
# webapp/services/engineVersions.json are never edited by an upgrade.
#
# Progress: models/.modelserver/engine-upgrade/status[-<engine>].json and
# upgrade[-<engine>].log (llama.cpp keeps the unsuffixed names). The console's
# Engines card reads both; its Upgrade buttons run this script in a helper
# container. One upgrade at a time (they share the GPUs and the build cache).
set -uo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PROJECT_DIR="${MODELSERVER_PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
BUILD_STATE_DIR="$PROJECT_DIR/.build-state"
PINS_FILE="$PROJECT_DIR/webapp/services/engineVersions.json"
MIN_SPEED_RATIO="${UPGRADE_MIN_SPEED_RATIO:-0.85}"
TEST_PORT=8099
WEBAPP_CONTAINER="${WEBAPP_CONTAINER:-modelserver-webapp-1}"

# ---- engine selection ---------------------------------------------------------
ENGINE="${UPGRADE_ENGINE:-llamacpp}"
ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --engine) ENGINE="$2"; shift 2 ;;
        --engine=*) ENGINE="${1#--engine=}"; shift ;;
        *) ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
case "$ENGINE" in llamacpp|strata|vllm|sglang) ;; *) echo "Unknown engine: $ENGINE (llamacpp, strata, vllm, sglang)" >&2; exit 2 ;; esac

mkdir -p "$BUILD_STATE_DIR"

# Host path of the models directory (the webapp's /models mount), with the
# project's models/ as the fallback.
host_models_dir() {
    local p
    p=$(docker inspect "$WEBAPP_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
    [ -n "$p" ] && [ -d "$p" ] && { echo "$p"; return; }
    echo "$PROJECT_DIR/models"
}
MODELS_DIR="${UPGRADE_MODELS_DIR:-$(host_models_dir)}"
STATE_DIR="$MODELS_DIR/.modelserver/engine-upgrade"
SUFFIX=""; [ "$ENGINE" != llamacpp ] && SUFFIX="-$ENGINE"
STATUS_FILE="$STATE_DIR/status$SUFFIX.json"
LOG_FILE="$STATE_DIR/upgrade$SUFFIX.log"
VERSIONS_FILE="$STATE_DIR/versions.json"
mkdir -p "$STATE_DIR"

# ---- per-engine facts ---------------------------------------------------------
case "$ENGINE" in
    llamacpp) IMAGE_REPO="modelserver-llamacpp"; UPSTREAM_REPO="ggml-org/llama.cpp"; MIN_FREE_GB="${UPGRADE_MIN_FREE_GB:-25}"
              STAGES='["Build","Test the new build","Test the current build","Install"]' ;;
    sglang)   IMAGE_REPO="modelserver-sglang"; UPSTREAM_REPO="sgl-project/sglang"; MIN_FREE_GB="${UPGRADE_MIN_FREE_GB:-45}"
              STAGES='["Build","Test the new build","Install"]' ;;
    strata)   UPSTREAM_REPO="Niko1221/Strata"; MIN_FREE_GB="${UPGRADE_MIN_FREE_GB:-6}"
              STAGES='["Download","Test the new version","Test the current version","Install"]' ;;
    vllm)     UPSTREAM_REPO="vllm-project/vllm"; MIN_FREE_GB="${UPGRADE_MIN_FREE_GB:-35}"
              STAGES='["Download","Test the new version","Install"]' ;;
esac
LABEL_OF() { case "$1" in llamacpp) echo llama.cpp ;; sglang) echo SGLang ;; strata) echo Strata ;; vllm) echo vLLM ;; esac; }
LABEL="$(LABEL_OF "$ENGINE")"
REF_FILE="$BUILD_STATE_DIR/$ENGINE.ref"

# ---- small helpers --------------------------------------------------------------
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2; }
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# status <state> <step> [extra JSON fields without braces]
STARTED_AT="${STARTED_AT:-$(date +%s)}"
FROM_VER=""; TARGET=""; STAGE_INDEX=-1
status() {
    local state="$1" step="$2" extra="${3:-}"
    local tmp="$STATUS_FILE.tmp.$$"
    {
        printf '{"engine":%s,"state":%s,"step":%s,"from":%s,"target":%s,"startedAt":%s,"updatedAt":%s,"stages":%s,"stageIndex":%s' \
            "$(json_str "$ENGINE")" "$(json_str "$state")" "$(json_str "$step")" "$(json_str "$FROM_VER")" "$(json_str "$TARGET")" \
            "$STARTED_AT" "$(date +%s)" "$STAGES" "$STAGE_INDEX"
        [ -n "$extra" ] && printf ',%s' "$extra"
        printf '}\n'
    } > "$tmp" && mv -f "$tmp" "$STATUS_FILE"
}
# stage <index> <step text>: move the progress bar to a stage.
KEEP=""
stage() { STAGE_INDEX="$1"; status running "$2" "$KEEP"; log "$2"; }
# Keep fields of the previous status (promotion record, rollback tag) when a
# later run only checks or fails.
prev_field() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$STATUS_FILE" "$1" 2>/dev/null; }

image_version() { docker image inspect -f '{{ index .Config.Labels "modelserver.engine.version" }}' "$1" 2>/dev/null || true; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
has_image() { docker image inspect "$1" > /dev/null 2>&1; }
version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | tail -1)" = "${1#v}" ]; }
free_gb() { df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9'; }
has_avx2() { grep -m1 '^flags' /proc/cpuinfo | grep -qw avx2; }

latest_release() {
    curl -fsSL --max-time 15 -H 'User-Agent: modelserver' \
        "https://api.github.com/repos/$UPSTREAM_REPO/releases/latest" 2>/dev/null \
        | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); t=d.get("tag_name") or ""
    print("" if d.get("prerelease") or d.get("draft") else t)
except Exception: print("")'
}

# Version pins and the override file (Strata / vLLM).
pin_of() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$PINS_FILE" "$1"; }
override_of() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$VERSIONS_FILE" "$1" 2>/dev/null; }
set_override() {  # set_override <engine> <version|"">
    python3 - "$VERSIONS_FILE" "$1" "$2" <<'PY'
import json, os, sys
path, eng, ver = sys.argv[1:4]
try: d = json.load(open(path))
except Exception: d = {}
if ver: d[eng] = ver
else: d.pop(eng, None)
tmp = path + ".tmp"
json.dump(d, open(tmp, "w"), indent=2); os.replace(tmp, path)
PY
}
# The version in use for a pulled engine: the override when it is newer than the pin.
pulled_version() {
    local pin over; pin=$(pin_of "$1"); over=$(override_of "$1")
    if [ -n "$over" ] && version_gt "$over" "$pin"; then echo "$over"; else echo "$pin"; fi
}
strata_image() { if has_avx2; then echo "ghcr.io/niko1221/strata:${1#v}-cuda13"; else echo "modelserver-strata:${1#v}"; fi; }
vllm_image() { echo "vllm/vllm-openai:$1"; }

dockerfile_ref() {
    case "$ENGINE" in
        llamacpp) sed -n 's/^ARG LLAMACPP_REF=\(.*\)$/\1/p' "$PROJECT_DIR/llamacpp/Dockerfile" | head -1 ;;
        sglang)   sed -n 's/^ARG SGLANG_VERSION=\(.*\)$/\1/p' "$PROJECT_DIR/sglang/Dockerfile" | head -1 ;;
    esac
}
# The version build.sh / update.sh should build: the promoted one, unless the
# checkout's own pin has caught up with it.
effective_ref() {
    local pin promoted
    pin=$(dockerfile_ref)
    promoted=$(cat "$REF_FILE" 2>/dev/null || true)
    if [ -n "$promoted" ] && version_gt "$promoted" "$pin"; then echo "$promoted"; else echo "$pin"; fi
}

current_version() {
    case "$ENGINE" in
        llamacpp|sglang) image_version "$IMAGE_REPO:latest" ;;
        strata|vllm) pulled_version "$ENGINE" ;;
    esac
}
# Release tag → the version string the pins use (Strata pins "0.2.23").
normalize_target() { case "$ENGINE" in strata) echo "${1#v}" ;; *) echo "$1" ;; esac; }

proxy_build_args() {
    local -a a=()
    [ -n "${HTTP_PROXY:-}" ]        && a+=(--build-arg "HTTP_PROXY=$HTTP_PROXY")
    [ -n "${HTTPS_PROXY:-}" ]       && a+=(--build-arg "HTTPS_PROXY=$HTTPS_PROXY")
    [ -n "${NO_PROXY:-}" ]          && a+=(--build-arg "NO_PROXY=$NO_PROXY")
    [ -n "${GIT_SSL_NO_VERIFY:-}" ] && a+=(--build-arg "GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY")
    (( ${#a[@]} )) && printf '%s\n' "${a[@]}"
    return 0
}

# Record a promoted build so build.sh / update.sh agree with it.
record_build_state() {
    echo "$TARGET" > "$REF_FILE"
    if [ -f "$PROJECT_DIR/scripts/lib/buildinputs.sh" ]; then
        # shellcheck source=/dev/null
        . "$PROJECT_DIR/scripts/lib/buildinputs.sh"
        git config --global --add safe.directory "$PROJECT_DIR" > /dev/null 2>&1 || true
        local h; h=$(ms_build_inputs_hash "$PROJECT_DIR" "$ENGINE")
        echo "$h" > "$BUILD_STATE_DIR/$ENGINE.state"; echo "$h" > "$BUILD_STATE_DIR/$ENGINE.tree"
    fi
}

# ---- shared answer checks ---------------------------------------------------------
# judge <r1> <r2> <r3> <seconds1> <seconds2>: two prose answers + one tool call.
# Speed comes from llama.cpp's timings when present, else completion tokens over
# the wall clock of the request.
judge() {
    python3 - "$@" <<'PY'
import json, sys
def load(s):
    try: return json.loads(s)
    except Exception: return {}
out = {"ok": True}
speeds, answers = [], 0
for raw, secs in ((sys.argv[1], sys.argv[4]), (sys.argv[2], sys.argv[5])):
    d = load(raw)
    msg = ((d.get("choices") or [{}])[0].get("message") or {})
    text = (msg.get("content") or "") + (msg.get("reasoning_content") or "") + (msg.get("reasoning") or "")
    if len(text.strip()) >= 40: answers += 1
    t = (d.get("timings") or {}).get("predicted_per_second")
    if not t:
        n = (d.get("usage") or {}).get("completion_tokens")
        try:
            s = float(secs)
            if n and s > 0: t = n / s
        except Exception: pass
    if t: speeds.append(float(t))
out["answers"] = answers
out["tokensPerSecond"] = round(sum(speeds) / len(speeds), 2) if speeds else None
d = load(sys.argv[3])
calls = (((d.get("choices") or [{}])[0].get("message") or {}).get("tool_calls")) or []
tool_ok = False
if calls:
    f = calls[0].get("function") or {}
    try: tool_ok = f.get("name") == "get_weather" and "city" in json.loads(f.get("arguments") or "{}")
    except Exception: tool_ok = False
out["toolCall"] = tool_ok
if answers < 2: out["ok"] = False; out["error"] = "the model gave no usable answer"
print(json.dumps(out))
PY
}
# verdict <new-json> <old-json> → "OK …" | "SLOW …" | "FAIL …"
verdict() {
    python3 - "$1" "$2" "$MIN_SPEED_RATIO" <<'PY'
import json, sys
new, old, ratio = json.loads(sys.argv[1]), json.loads(sys.argv[2]), float(sys.argv[3])
if not new.get("ok"): print("FAIL " + (new.get("error") or "the new version failed the test")); sys.exit()
if old.get("toolCall") and not new.get("toolCall"): print("FAIL tool calling works on the current version but not on the new one"); sys.exit()
ns, os_ = new.get("tokensPerSecond"), old.get("tokensPerSecond")
if ns and os_ and ns < os_ * ratio:
    print(f"SLOW decode {ns} tok/s vs {os_} tok/s on the current version"); sys.exit()
print(f"OK decode {ns} vs {os_} tok/s, tool call {'ok' if new.get('toolCall') else 'n/a'}")
PY
}
PROMPT_CODE='Write a Python function that returns the nth Fibonacci number iteratively, with a docstring.'
PROMPT_PROSE='Explain in three short paragraphs why the sky is blue.'
TOOL_REQ='{"messages":[{"role":"user","content":"What is the weather in Paris right now? Use the tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"max_tokens":300,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}'

# ---- llama.cpp test harness -----------------------------------------------------
# Smallest usable single-file GGUF between 1 and 12 GB (no mmproj, no split
# parts after the first). Prints "<size_bytes> <path relative to MODELS_DIR>".
pick_test_model() {
    find "$MODELS_DIR" -path "$MODELS_DIR/.modelserver" -prune -o -type f -name '*.gguf' -size +1000M -size -12000M -printf '%s %P\n' 2>/dev/null \
        | grep -viE 'mmproj|-0000[2-9]-of-|-000[1-9][0-9]-of-' | sort -n | head -1
}

# GPU index with room for the model, or "cpu".
pick_device() {
    local need_mb="$1" image="$2" idx total used best="" best_free=0
    while IFS=',' read -r idx total used; do
        idx=${idx// /}; total=${total// /}; used=${used// /}
        [ -z "$idx" ] && continue
        local free=$(( total - used ))
        if [ "$free" -ge "$need_mb" ] && [ "$free" -gt "$best_free" ]; then best="$idx"; best_free="$free"; fi
    done < <(docker run --rm --gpus all --entrypoint nvidia-smi "$image" \
        --query-gpu=index,memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null)
    echo "${best:-cpu}"
}

# test_image <image> <tag-label> <model-rel> <device> → prints a JSON object
test_image() {
    local image="$1" label="$2" model="$3" device="$4"
    local name="lcb-upgrade-$label-$$"
    # The binary links libcuda, so even a CPU run needs the driver mounted;
    # no device is made visible then.
    local -a gpu=(--gpus all -e CUDA_VISIBLE_DEVICES=-1) ngl=(-ngl 0)
    if [ "$device" != cpu ]; then gpu=(--gpus "device=$device"); ngl=(-ngl 999); fi
    docker rm -f "$name" > /dev/null 2>&1 || true
    if ! docker run -d --name "$name" "${gpu[@]}" -v "$MODELS_DIR:/models:ro" \
            --entrypoint llama-server "$image" \
            -m "/models/$model" --host 127.0.0.1 --port "$TEST_PORT" -c 4096 "${ngl[@]}" \
            --jinja > /dev/null 2>>"$LOG_FILE"; then
        echo '{"ok":false,"error":"container did not start"}'; return
    fi
    local i healthy=false
    for i in $(seq 1 120); do
        if ! docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then break; fi
        if docker exec "$name" curl -fs "http://127.0.0.1:$TEST_PORT/health" > /dev/null 2>&1; then healthy=true; break; fi
        sleep 3
    done
    if [ "$healthy" != true ]; then
        docker logs --tail 30 "$name" >> "$LOG_FILE" 2>&1
        docker rm -f "$name" > /dev/null 2>&1
        echo '{"ok":false,"error":"server never became healthy (log tail in the upgrade log)"}'; return
    fi
    local req='{"messages":[{"role":"user","content":"PROMPT"}],"max_tokens":200,"temperature":0,"cache_prompt":false,"chat_template_kwargs":{"enable_thinking":false}}'
    local r1 r2 r3
    r1=$(docker exec "$name" curl -s --max-time 300 "http://127.0.0.1:$TEST_PORT/v1/chat/completions" -H 'Content-Type: application/json' -d "${req/PROMPT/$PROMPT_CODE}")
    r2=$(docker exec "$name" curl -s --max-time 300 "http://127.0.0.1:$TEST_PORT/v1/chat/completions" -H 'Content-Type: application/json' -d "${req/PROMPT/$PROMPT_PROSE}")
    r3=$(docker exec "$name" curl -s --max-time 300 "http://127.0.0.1:$TEST_PORT/v1/chat/completions" -H 'Content-Type: application/json' -d "$TOOL_REQ")
    docker rm -f "$name" > /dev/null 2>&1
    judge "$r1" "$r2" "$r3" 0 0
}

# ---- Strata test harness --------------------------------------------------------
# Settings of the test run: the live instance's (written by the webapp before it
# unloads the model, one KEY=VALUE per line), else a safe default.
strata_test_env() {
    local f="$STATE_DIR/strata-test.env"
    if [ -s "$f" ]; then grep -E '^(FAMILY|MODEL|MODEL_PATH|CONTEXT|PARALLEL|KV|VISION|TUNE|STRATA_SET|GPU_ROLES|GPU|GPUS)=' "$f"; return; fi
    printf '%s\n' FAMILY=qwen MODEL=Q2_0 CONTEXT=65536 PARALLEL=1 KV=q4_0 VISION=off TUNE=skip 'STRATA_SET=kv-resident=0 host-core=first'
    [ -d "$MODELS_DIR/Qwen3.8-Flash-Next-Q2_0" ] && echo "MODEL_PATH=/models/Qwen3.8-Flash-Next-Q2_0"
}
strata_loaded() { docker ps --format '{{.Names}}' | grep -E '^strata-' | head -1; }

# strata_request <container> <json-body> → prints "<seconds> <response-json>"
strata_request() {
    docker exec -i "$1" /opt/strata/terminal/python/bin/python3 - "$2" <<'PY'
import json, os, sys, time, urllib.request
body = sys.argv[1].encode()
req = urllib.request.Request("http://127.0.0.1:%s/v1/chat/completions" % os.environ.get("PORT", "8080"), data=body,
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ.get("API_KEY", "")})
t = time.time()
try:
    with urllib.request.urlopen(req, timeout=600) as r: out = r.read().decode()
except Exception as e: out = json.dumps({"error": str(e)})
print("%.3f %s" % (time.time() - t, out.replace("\n", " ")))
PY
}

# test_strata <image> <label> → prints a JSON object
test_strata() {
    local image="$1" label="$2" name="msup-strata-$2-$$"
    local key; key=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
    local -a envs=(-e "API_KEY=$key" -e "PORT=8080" -e "PRESET=upgrade-test")
    while IFS= read -r line; do [ -n "$line" ] && envs+=(-e "$line"); done < <(strata_test_env)
    docker rm -f "$name" > /dev/null 2>&1 || true
    if ! docker run -d --name "$name" --runtime nvidia --gpus all --shm-size 2g --ulimit memlock=-1:-1 \
            -v "$MODELS_DIR/.strata-data:/data" -v "$MODELS_DIR:/models:ro" "${envs[@]}" "$image" run > /dev/null 2>>"$LOG_FILE"; then
        echo '{"ok":false,"error":"container did not start"}'; return
    fi
    # Preparing the model for a new engine can take a while (the engine log
    # says what it is doing); give it 30 minutes.
    local i ready=false
    for i in $(seq 1 360); do
        if ! docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then break; fi
        if docker exec "$name" sh /opt/strata/healthcheck.sh > /dev/null 2>&1; then ready=true; break; fi
        sleep 5
    done
    if [ "$ready" != true ]; then
        docker logs --tail 40 "$name" >> "$LOG_FILE" 2>&1
        docker rm -f "$name" > /dev/null 2>&1
        echo '{"ok":false,"error":"the server never became ready (log tail in the upgrade log)"}'; return
    fi
    log "$label is ready after $(( i * 5 )) s"
    local req='{"messages":[{"role":"user","content":"PROMPT"}],"max_tokens":400,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}'
    strata_request "$name" "${req/PROMPT/Say hello in five words.}" > /dev/null   # warm-up
    local a b c
    a=$(strata_request "$name" "${req/PROMPT/$PROMPT_CODE}")
    b=$(strata_request "$name" "${req/PROMPT/$PROMPT_PROSE}")
    c=$(strata_request "$name" "$TOOL_REQ")
    docker stop -t 60 "$name" > /dev/null 2>&1; docker rm -f "$name" > /dev/null 2>&1
    judge "${a#* }" "${b#* }" "${c#* }" "${a%% *}" "${b%% *}"
}

# ---- vLLM / SGLang smoke test ----------------------------------------------------
smoke_vllm() {
    local out
    out=$(docker run --rm --gpus all --entrypoint python3 "$1" -c \
        'import json, torch, vllm; print(json.dumps({"vllm": vllm.__version__, "cuda": torch.cuda.is_available(), "gpus": torch.cuda.device_count()}))' 2>>"$LOG_FILE" | tail -1)
    python3 - "$out" <<'PY'
import json, sys
try: d = json.loads(sys.argv[1])
except Exception: print(json.dumps({"ok": False, "error": "vLLM did not import"})); sys.exit()
ok = bool(d.get("cuda")) and d.get("gpus", 0) > 0
print(json.dumps({"ok": ok, "version": d.get("vllm"), "gpus": d.get("gpus"), **({} if ok else {"error": "vLLM cannot see the GPUs"})}))
PY
}
smoke_sglang() {
    local out
    out=$(docker run --rm --gpus all --entrypoint sh "$1" -c \
        'python3 -c "import json, torch, sglang; print(json.dumps({\"sglang\": sglang.__version__, \"cuda\": torch.cuda.is_available(), \"gpus\": torch.cuda.device_count()}))" && python3 -m sglang.launch_server --help > /dev/null && echo HELP_OK' 2>>"$LOG_FILE" | tail -2)
    python3 - "$out" <<'PY'
import json, sys
lines = sys.argv[1].strip().splitlines()
try: d = json.loads(lines[0])
except Exception: print(json.dumps({"ok": False, "error": "SGLang did not import"})); sys.exit()
ok = bool(d.get("cuda")) and d.get("gpus", 0) > 0 and len(lines) > 1 and lines[1] == "HELP_OK"
print(json.dumps({"ok": ok, "version": d.get("sglang"), "gpus": d.get("gpus"), **({} if ok else {"error": "SGLang cannot see the GPUs or its server does not start"})}))
PY
}

# Pull an image, logging layer progress (the console turns it into a percentage).
pull_image() {
    docker pull "$1" >> "$LOG_FILE" 2>&1
}

# ---- commands ---------------------------------------------------------------
cmd_status() {
    echo "engine:    $LABEL"
    echo "installed: $(current_version)"
    case "$ENGINE" in llamacpp|sglang) echo "pinned:    $(dockerfile_ref) (build target: $(effective_ref))" ;;
        *) echo "pinned:    $(pin_of "$ENGINE") (override: $(override_of "$ENGINE"))" ;; esac
    echo "upstream:  $(latest_release)"
    [ -f "$STATUS_FILE" ] && { echo "last run:"; cat "$STATUS_FILE"; }
}

cmd_check() {
    local cur latest
    cur=$(current_version); latest=$(normalize_target "$(latest_release)")
    if [ -z "$latest" ]; then echo "Could not reach GitHub."; return 2; fi
    if version_gt "$latest" "$cur"; then echo "$LABEL $latest is available (installed $cur)."; return 0; fi
    echo "$LABEL $cur is current."; return 1
}

fail() {
    local msg="$1"
    log "FAILED: $msg"
    status failed "$msg" "\"error\":$(json_str "$msg")${KEEP:+,$KEEP}"
    return 1
}

cmd_upgrade() {
    local force=false if_newer=false want=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --version) want="$2"; shift 2 ;;
            --force) force=true; shift ;;
            --if-newer) if_newer=true; shift ;;
            *) echo "Unknown option $1" >&2; return 2 ;;
        esac
    done

    exec 9> "$STATE_DIR/lock"
    if ! flock -n 9; then echo "Another engine upgrade is already running." >&2; return 3; fi

    FROM_VER=$(current_version)
    TARGET=$(normalize_target "${want:-$(latest_release)}")
    if [ -z "$TARGET" ]; then log "Could not find the latest $LABEL release on GitHub."; return 2; fi
    if [ "$TARGET" = "$FROM_VER" ]; then echo "$LABEL $FROM_VER is already installed."; return 0; fi
    if [ "$if_newer" = true ] && [ -n "$FROM_VER" ] && ! version_gt "$TARGET" "$FROM_VER"; then
        echo "$LABEL $FROM_VER is current ($TARGET is not newer)."; return 0
    fi

    : > "$LOG_FILE"
    local prev_rollback; prev_rollback=$(prev_field rollbackTag)
    KEEP=""; [ -n "$prev_rollback" ] && KEEP="\"rollbackTag\":$(json_str "$prev_rollback")"
    log "Upgrading $LABEL ${FROM_VER:-?} -> $TARGET"
    local free; free=$(free_gb); [ -z "$free" ] && free=$(df -BG --output=avail "$PROJECT_DIR" | tail -1 | tr -dc '0-9')
    if [ "${free:-0}" -lt "$MIN_FREE_GB" ]; then fail "Not enough disk: ${MIN_FREE_GB} GB needed, ${free} GB free"; return 1; fi

    case "$ENGINE" in
        llamacpp) upgrade_llamacpp "$force" ;;
        sglang)   upgrade_sglang "$force" ;;
        strata)   upgrade_strata "$force" ;;
        vllm)     upgrade_vllm "$force" ;;
    esac
}

# Common tail: compare and decide. Sets TEST_JSON. Returns 1 when not installing.
decide() {   # decide <new-json> <old-json> <force> <extra-test-fields>
    local new="$1" old="$2" force="$3" extra="$4" v
    v=$(verdict "$new" "$old")
    log "Verdict: $v"
    TEST_JSON="\"test\":{${extra:+$extra,}\"new\":$new,\"old\":$old,\"verdict\":$(json_str "$v")}"
    case "$v" in
        OK*) return 0 ;;
        SLOW*) if [ "$force" != true ]; then fail "${v#SLOW } (use --force to install anyway)"; return 1; fi; return 0 ;;
        *) fail "${v#FAIL }"; return 1 ;;
    esac
}

upgrade_llamacpp() {
    local force="$1"
    stage 0 "Building $TARGET (CUDA compile, 20-90 min)"
    local -a pargs=(); mapfile -t pargs < <(proxy_build_args)
    local t0; t0=$(date +%s)
    if [ "$(image_version "$IMAGE_REPO:next")" = "$TARGET" ] && [ "$(image_id "$IMAGE_REPO:next")" != "$(image_id "$IMAGE_REPO:latest")" ] && [ "${UPGRADE_REBUILD:-0}" != 1 ]; then
        log "Reusing the $TARGET build from an earlier run (UPGRADE_REBUILD=1 compiles it again)"
    elif ! docker build "${pargs[@]}" --build-arg "LLAMACPP_REF=$TARGET" --build-arg "BUILD_JOBS=$(nproc)" \
            -t "$IMAGE_REPO:next" "$PROJECT_DIR/llamacpp" >> "$LOG_FILE" 2>&1; then
        fail "Build of $TARGET failed (see the upgrade log)"; return 1
    fi
    log "Built in $(( ($(date +%s) - t0) / 60 )) min"
    if [ "$(image_version "$IMAGE_REPO:next")" != "$TARGET" ]; then fail "The built image does not carry version $TARGET"; return 1; fi

    local pick size model need dev
    pick=$(pick_test_model)
    TEST_JSON=""
    if [ -z "$pick" ]; then
        if [ "$force" != true ]; then fail "No GGUF between 1 and 12 GB under $MODELS_DIR to test with (use --force to skip the test)"; return 1; fi
        log "No test model found; --force given, skipping the comparison."
    else
        size=${pick%% *}; model=${pick#* }
        need=$(( size / 1048576 * 13 / 10 + 1536 ))
        dev=$(pick_device "$need" "$IMAGE_REPO:next")
        local where="CPU"; [ "$dev" != cpu ] && where="GPU $dev"
        log "Test model: $model ($(( size / 1048576 )) MB) on $where"
        local new old
        stage 1 "Testing $TARGET on $model"
        new=$(test_image "$IMAGE_REPO:next" new "$model" "$dev"); log "New ($TARGET): $new"
        stage 2 "Testing ${FROM_VER:-the current build} on $model"
        old=$(test_image "$IMAGE_REPO:latest" old "$model" "$dev"); log "Current (${FROM_VER:-latest}): $old"
        decide "$new" "$old" "$force" "\"model\":$(json_str "$model"),\"device\":$(json_str "$dev")" || return 1
    fi
    stage 3 "Installing $TARGET"
    local rollback="$IMAGE_REPO:pre-$TARGET"
    has_image "$IMAGE_REPO:latest" && docker tag "$IMAGE_REPO:latest" "$rollback"
    docker tag "$IMAGE_REPO:next" "$IMAGE_REPO:latest"
    record_build_state
    finish "$rollback" true
}

upgrade_sglang() {
    local force="$1"
    if ! curl -fsS --max-time 20 "https://hub.docker.com/v2/repositories/lmsysorg/sglang/tags/$TARGET-cu130-runtime" > /dev/null 2>&1; then
        fail "There is no lmsysorg/sglang:$TARGET-cu130-runtime image yet"; return 1
    fi
    stage 0 "Building SGLang $TARGET (downloads the base image, about 30 GB)"
    local -a pargs=(); mapfile -t pargs < <(proxy_build_args)
    if ! docker build "${pargs[@]}" --build-arg "SGLANG_VERSION=$TARGET" -t "$IMAGE_REPO:next" "$PROJECT_DIR/sglang" >> "$LOG_FILE" 2>&1; then
        fail "Build of $TARGET failed — our patches may not apply to it (see the upgrade log)"; return 1
    fi
    stage 1 "Testing SGLang $TARGET"
    local new old; new=$(smoke_sglang "$IMAGE_REPO:next"); log "New ($TARGET): $new"
    old='{"ok":true}'
    if ! python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("ok") else 1)' "$new"; then
        fail "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("error") or "test failed")' "$new")"; return 1
    fi
    TEST_JSON="\"test\":{\"new\":$new,\"verdict\":$(json_str "OK imports, sees $(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("gpus"))' "$new") GPUs, server starts")}"
    stage 2 "Installing $TARGET"
    local rollback="$IMAGE_REPO:pre-$TARGET"
    has_image "$IMAGE_REPO:latest" && docker tag "$IMAGE_REPO:latest" "$rollback"
    docker tag "$IMAGE_REPO:next" "$IMAGE_REPO:latest"
    record_build_state
    finish "$rollback" true
}

upgrade_strata() {
    local force="$1" new_img old_img
    new_img=$(strata_image "$TARGET"); old_img=$(strata_image "$FROM_VER")
    if [ -n "$(strata_loaded)" ]; then
        fail "A Strata model is loaded ($(strata_loaded)). The test needs every GPU: unload it first (the console's Upgrade button does that and loads it again afterwards)."; return 1
    fi
    stage 0 "Downloading Strata $TARGET"
    if has_avx2; then
        if ! pull_image "$new_img"; then fail "Could not download $new_img"; return 1; fi
    else
        if ! docker build --build-arg STRATA_VERSION="$TARGET" --build-arg RUNTIME_IMAGE="ghcr.io/niko1221/strata:$TARGET-cuda13" \
                --build-arg BUILD_JOBS="$(nproc)" -t "$new_img" "$PROJECT_DIR/strata" >> "$LOG_FILE" 2>&1; then
            fail "Build of Strata $TARGET for this CPU failed (see the upgrade log)"; return 1
        fi
    fi
    # Strata's small state (settings, presets) is shared by both versions; keep
    # a copy so a rollback finds it as it was.
    local backup="$STATE_DIR/strata-state-$FROM_VER.tar.gz"
    tar -C "$MODELS_DIR/.strata-data" -czf "$backup" config state install home 2>/dev/null && log "Saved Strata's settings to $(basename "$backup")"
    log "Test settings: $(strata_test_env | tr '\n' ' ')"
    local new old
    stage 1 "Testing Strata $TARGET on the real model (loads it, about 3-10 min)"
    new=$(test_strata "$new_img" new); log "New ($TARGET): $new"
    TEST_JSON=""
    if has_image "$old_img"; then
        stage 2 "Testing Strata $FROM_VER the same way"
        old=$(test_strata "$old_img" old); log "Current ($FROM_VER): $old"
    else
        log "The current image ($old_img) is not here; judging the new version on its own."
        old='{"ok":true}'
    fi
    decide "$new" "$old" "$force" "\"model\":$(json_str "$(strata_test_env | sed -n 's/^MODEL=//p')")" || return 1
    stage 3 "Installing Strata $TARGET"
    set_override strata "$TARGET"
    finish "$old_img" false "\"restoreInstances\":true"
}

upgrade_vllm() {
    local force="$1" new_img old_img
    new_img=$(vllm_image "$TARGET"); old_img=$(vllm_image "$FROM_VER")
    stage 0 "Downloading vLLM $TARGET (about 20 GB)"
    if ! pull_image "$new_img"; then fail "Could not download $new_img"; return 1; fi
    stage 1 "Testing vLLM $TARGET"
    local new; new=$(smoke_vllm "$new_img"); log "New ($TARGET): $new"
    if ! python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("ok") else 1)' "$new"; then
        fail "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("error") or "test failed")' "$new")"; return 1
    fi
    TEST_JSON="\"test\":{\"new\":$new,\"verdict\":$(json_str "OK starts and sees $(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("gpus"))' "$new") GPUs")}"
    stage 2 "Installing vLLM $TARGET"
    set_override vllm "$TARGET"
    finish "$old_img" false
}

# finish <rollback-ref> <reload-llamacpp-instances> [extra fields]
finish() {
    local rollback="$1" reload="$2" extra="${3:-}" now; now=$(date +%s)
    STAGE_INDEX=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$STAGES")
    local img; case "$ENGINE" in llamacpp|sglang) img=$(image_id "$IMAGE_REPO:latest") ;; strata) img=$(image_id "$(strata_image "$TARGET")") ;; vllm) img=$(image_id "$(vllm_image "$TARGET")") ;; esac
    status succeeded "Installed $TARGET" "\"promotedAt\":$now,\"rollbackTag\":$(json_str "$rollback"),\"rollbackVersion\":$(json_str "$FROM_VER"),\"imageId\":$(json_str "$img"),\"reloadInstances\":$reload${extra:+,$extra}${TEST_JSON:+,$TEST_JSON}"
    log "Installed $LABEL $TARGET. Rollback: sudo ./scripts/engine-upgrade.sh --engine $ENGINE rollback"
    [ "$reload" = true ] && log "Running models move to the new build when they are idle (the webapp reloads them)."
    return 0
}

cmd_rollback() {
    exec 9> "$STATE_DIR/lock"
    if ! flock -n 9; then echo "An engine upgrade is running; try again when it finishes." >&2; return 3; fi
    local tag; tag=$(prev_field rollbackTag)
    FROM_VER=$(current_version)
    case "$ENGINE" in
        llamacpp|sglang)
            if [ -z "$tag" ] || [ -z "$(image_id "$tag")" ]; then echo "No rollback image recorded." >&2; return 1; fi
            TARGET=$(image_version "$tag")
            docker tag "$tag" "$IMAGE_REPO:latest"
            # Build at the rolled-back version from now on (or the checkout's pin).
            if [ -n "$TARGET" ] && version_gt "$TARGET" "$(dockerfile_ref)"; then echo "$TARGET" > "$REF_FILE"; else rm -f "$REF_FILE"; fi
            STAGE_INDEX=-1
            status succeeded "Rolled back to $TARGET" "\"promotedAt\":$(date +%s),\"rolledBack\":true,\"imageId\":$(json_str "$(image_id "$IMAGE_REPO:latest")"),\"reloadInstances\":true"
            ;;
        strata|vllm)
            TARGET=$(prev_field rollbackVersion)
            if [ -z "$TARGET" ]; then echo "No previous version recorded." >&2; return 1; fi
            local img; if [ "$ENGINE" = strata ]; then img=$(strata_image "$TARGET"); else img=$(vllm_image "$TARGET"); fi
            if ! has_image "$img"; then pull_image "$img" || { echo "Could not download $img." >&2; return 1; }; fi
            # Same rule as llama.cpp: an override counts only while it is newer
            # than the checkout's pin. Rolling back to the pin (the usual case)
            # simply removes it.
            if version_gt "$TARGET" "$(pin_of "$ENGINE")"; then set_override "$ENGINE" "$TARGET"; else set_override "$ENGINE" ""; fi
            if [ "$(pulled_version "$ENGINE")" != "$TARGET" ]; then
                log "Note: the checkout pins $LABEL $(pin_of "$ENGINE"), newer than $TARGET; that pin stays in use."
            fi
            STAGE_INDEX=-1
            status succeeded "Rolled back to $TARGET" "\"promotedAt\":$(date +%s),\"rolledBack\":true,\"reloadInstances\":false$( [ "$ENGINE" = strata ] && echo ',"restoreInstances":true')"
            ;;
    esac
    log "Rolled back $LABEL $FROM_VER -> $TARGET."
}

case "${1:-status}" in
    status) cmd_status ;;
    check) cmd_check ;;
    upgrade) shift; cmd_upgrade "$@" ;;
    rollback) cmd_rollback ;;
    effective-ref)
        [ -n "${2:-}" ] && { ENGINE="$2"; REF_FILE="$BUILD_STATE_DIR/$ENGINE.ref"; }
        effective_ref ;;
    current) current_version ;;
    last-step) prev_field step ;;
    selftest)  # run the comparison harness on the current version only
        case "$ENGINE" in
            llamacpp)
                pick=$(pick_test_model); [ -z "$pick" ] && { echo "no test model"; exit 1; }
                size=${pick%% *}; model=${pick#* }
                dev=$(pick_device $(( size / 1048576 * 13 / 10 + 1536 )) "$IMAGE_REPO:latest")
                echo "model=$model device=$dev"; test_image "$IMAGE_REPO:latest" self "$model" "$dev" ;;
            strata) [ -n "$(strata_loaded)" ] && { echo "unload the Strata model first"; exit 1; }; test_strata "$(strata_image "$(current_version)")" self ;;
            vllm) smoke_vllm "$(vllm_image "$(current_version)")" ;;
            sglang) smoke_sglang "modelserver-sglang:latest" ;;
        esac ;;
    *) echo "Usage: $0 [--engine llamacpp|strata|vllm|sglang] status | check | upgrade [--version X] [--force] [--if-newer] | rollback" >&2; exit 2 ;;
esac
