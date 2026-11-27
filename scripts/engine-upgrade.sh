#!/bin/bash
# Upgrade the llama.cpp engine image to a newer upstream release, safely.
#
#   sudo ./scripts/engine-upgrade.sh status
#   sudo ./scripts/engine-upgrade.sh check              # is a newer release out?
#   sudo ./scripts/engine-upgrade.sh upgrade [--version vX.Y.Z] [--force] [--if-newer]
#   sudo ./scripts/engine-upgrade.sh rollback
#
# An upgrade never replaces the working image until the new one has passed:
#   1. build modelserver-llamacpp:next with LLAMACPP_REF=<version>
#   2. start a throwaway server from :next AND from :latest on the same small
#      model and the same card (or CPU when no card has room), and check that
#      the new one answers, makes a valid tool call when the old one can, and
#      decodes at least UPGRADE_MIN_SPEED_RATIO (0.85) as fast
#   3. tag :latest as :pre-<version> (rollback point), tag :next as :latest
#   4. record the version in .build-state/llamacpp.ref so build.sh / update.sh
#      rebuild at that version instead of the older pin in llamacpp/Dockerfile
# Running model instances keep their container until the webapp reloads them
# on the new image (it does that by itself once they are idle).
#
# Progress goes to models/.modelserver/engine-upgrade/{status.json,upgrade.log};
# the webapp's My Models page reads both. The console's Upgrade button runs
# this same script in a helper container.
set -uo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PROJECT_DIR="${MODELSERVER_PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
BUILD_STATE_DIR="$PROJECT_DIR/.build-state"
IMAGE_REPO="modelserver-llamacpp"
UPSTREAM_REPO="ggml-org/llama.cpp"
DOCKERFILE="$PROJECT_DIR/llamacpp/Dockerfile"
REF_FILE="$BUILD_STATE_DIR/llamacpp.ref"
MIN_SPEED_RATIO="${UPGRADE_MIN_SPEED_RATIO:-0.85}"
MIN_FREE_GB="${UPGRADE_MIN_FREE_GB:-25}"
TEST_PORT=8099
WEBAPP_CONTAINER="${WEBAPP_CONTAINER:-modelserver-webapp-1}"

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
STATUS_FILE="$STATE_DIR/status.json"
LOG_FILE="$STATE_DIR/upgrade.log"
mkdir -p "$STATE_DIR"

# ---- small helpers ----------------------------------------------------------
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2; }
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# status <state> <step> [extra JSON fields without braces]
STARTED_AT="${STARTED_AT:-$(date +%s)}"
FROM_VER=""; TARGET=""
status() {
    local state="$1" step="$2" extra="${3:-}"
    local tmp="$STATUS_FILE.tmp.$$"
    {
        printf '{"engine":"llamacpp","state":%s,"step":%s,"from":%s,"target":%s,"startedAt":%s,"updatedAt":%s' \
            "$(json_str "$state")" "$(json_str "$step")" "$(json_str "$FROM_VER")" "$(json_str "$TARGET")" \
            "$STARTED_AT" "$(date +%s)"
        [ -n "$extra" ] && printf ',%s' "$extra"
        printf '}\n'
    } > "$tmp" && mv -f "$tmp" "$STATUS_FILE"
}
# Keep fields of the previous status (promotion record, rollback tag) when a
# later run only checks or fails.
prev_field() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$STATUS_FILE" "$1" 2>/dev/null; }

image_version() { docker image inspect -f '{{ index .Config.Labels "modelserver.engine.version" }}' "$1" 2>/dev/null || true; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
dockerfile_ref() { sed -n 's/^ARG LLAMACPP_REF=\(.*\)$/\1/p' "$DOCKERFILE" | head -1; }
version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | tail -1)" = "${1#v}" ]; }

latest_release() {
    curl -fsSL --max-time 15 -H 'User-Agent: modelserver' \
        "https://api.github.com/repos/$UPSTREAM_REPO/releases/latest" 2>/dev/null \
        | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); t=d.get("tag_name") or ""
    print("" if d.get("prerelease") or d.get("draft") else t)
except Exception: print("")'
}

# The version build.sh / update.sh should build: the promoted one, unless the
# checkout's own pin has caught up with it.
effective_ref() {
    local pin promoted
    pin=$(dockerfile_ref)
    promoted=$(cat "$REF_FILE" 2>/dev/null || true)
    if [ -n "$promoted" ] && version_gt "$promoted" "$pin"; then echo "$promoted"; else echo "$pin"; fi
}

proxy_build_args() {
    local -a a=()
    [ -n "${HTTP_PROXY:-}" ]        && a+=(--build-arg "HTTP_PROXY=$HTTP_PROXY")
    [ -n "${HTTPS_PROXY:-}" ]       && a+=(--build-arg "HTTPS_PROXY=$HTTPS_PROXY")
    [ -n "${NO_PROXY:-}" ]          && a+=(--build-arg "NO_PROXY=$NO_PROXY")
    [ -n "${GIT_SSL_NO_VERIFY:-}" ] && a+=(--build-arg "GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY")
    (( ${#a[@]} )) && printf '%s\n' "${a[@]}"
    return 0
}

# ---- test harness -----------------------------------------------------------
# Smallest usable single-file GGUF between 1 and 12 GB (no mmproj, no split
# parts after the first). Prints "<size_bytes> <path relative to MODELS_DIR>".
pick_test_model() {
    find "$MODELS_DIR" -path "$MODELS_DIR/.modelserver" -prune -o -type f -name '*.gguf' -size +1000M -size -12000M -printf '%s %P\n' 2>/dev/null \
        | grep -viE 'mmproj|-0000[2-9]-of-|-000[1-9][0-9]-of-' | sort -n | head -1
}

# GPU index with room for the model, or "cpu".
pick_device() {
    local need_mb="$1" image="$2" line idx total used best="" best_free=0
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
        echo '{"ok":false,"error":"server never became healthy (log tail in upgrade.log)"}'; return
    fi
    local req='{"messages":[{"role":"user","content":"PROMPT"}],"max_tokens":200,"temperature":0,"cache_prompt":false,"chat_template_kwargs":{"enable_thinking":false}}'
    local r1 r2 r3
    r1=$(docker exec "$name" curl -s --max-time 300 "http://127.0.0.1:$TEST_PORT/v1/chat/completions" -H 'Content-Type: application/json' \
        -d "${req/PROMPT/Write a Python function that returns the nth Fibonacci number iteratively, with a docstring.}")
    r2=$(docker exec "$name" curl -s --max-time 300 "http://127.0.0.1:$TEST_PORT/v1/chat/completions" -H 'Content-Type: application/json' \
        -d "${req/PROMPT/Explain in three short paragraphs why the sky is blue.}")
    r3=$(docker exec "$name" curl -s --max-time 300 "http://127.0.0.1:$TEST_PORT/v1/chat/completions" -H 'Content-Type: application/json' \
        -d '{"messages":[{"role":"user","content":"What is the weather in Paris right now? Use the tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"max_tokens":300,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}')
    docker rm -f "$name" > /dev/null 2>&1
    python3 - "$r1" "$r2" "$r3" <<'PY'
import json, sys
def load(s):
    try: return json.loads(s)
    except Exception: return {}
out = {"ok": True}
speeds, answers = [], 0
for raw in sys.argv[1:3]:
    d = load(raw)
    msg = ((d.get("choices") or [{}])[0].get("message") or {})
    text = (msg.get("content") or "") + (msg.get("reasoning_content") or "")
    if len(text.strip()) >= 40: answers += 1
    t = (d.get("timings") or {}).get("predicted_per_second")
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

# ---- commands ---------------------------------------------------------------
cmd_status() {
    echo "installed: $(image_version "$IMAGE_REPO:latest")"
    echo "pinned:    $(dockerfile_ref) (build target: $(effective_ref))"
    echo "upstream:  $(latest_release)"
    [ -f "$STATUS_FILE" ] && { echo "last run:"; cat "$STATUS_FILE"; }
}

cmd_check() {
    local cur latest
    cur=$(image_version "$IMAGE_REPO:latest"); latest=$(latest_release)
    if [ -z "$latest" ]; then echo "Could not reach GitHub."; return 2; fi
    if version_gt "$latest" "$cur"; then echo "llama.cpp $latest is available (installed $cur)."; return 0; fi
    echo "llama.cpp $cur is current."; return 1
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

    FROM_VER=$(image_version "$IMAGE_REPO:latest")
    TARGET="${want:-$(latest_release)}"
    if [ -z "$TARGET" ]; then log "Could not find the latest llama.cpp release on GitHub."; return 2; fi
    if [ "$TARGET" = "$FROM_VER" ]; then
        echo "llama.cpp $FROM_VER is already installed."; return 0
    fi
    if [ "$if_newer" = true ] && [ -n "$FROM_VER" ] && ! version_gt "$TARGET" "$FROM_VER"; then
        echo "llama.cpp $FROM_VER is current."; return 0
    fi

    : > "$LOG_FILE"
    local prev_rollback prev_promoted
    prev_rollback=$(prev_field rollbackTag); prev_promoted=$(prev_field promotedAt)
    local keep=""
    [ -n "$prev_rollback" ] && keep="\"rollbackTag\":$(json_str "$prev_rollback")"
    fail() {
        local msg="$1"
        log "FAILED: $msg"
        status failed "$msg" "\"error\":$(json_str "$msg")${keep:+,$keep}"
        return 1
    }

    log "Upgrading llama.cpp ${FROM_VER:-?} -> $TARGET"
    local free
    free=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9')
    [ -z "$free" ] && free=$(df -BG --output=avail "$PROJECT_DIR" | tail -1 | tr -dc '0-9')
    if [ "${free:-0}" -lt "$MIN_FREE_GB" ]; then fail "Not enough disk: ${MIN_FREE_GB} GB needed, ${free} GB free"; return 1; fi

    # 1. build
    status running "Building $TARGET (CUDA compile, 20-90 min)" "${keep}"
    local -a pargs=()
    mapfile -t pargs < <(proxy_build_args)
    local t0=$(date +%s)
    if [ "$(image_version "$IMAGE_REPO:next")" = "$TARGET" ] && [ "$(image_id "$IMAGE_REPO:next")" != "$(image_id "$IMAGE_REPO:latest")" ] && [ "${UPGRADE_REBUILD:-0}" != 1 ]; then
        log "Reusing the $TARGET build from an earlier run (UPGRADE_REBUILD=1 compiles it again)"
    elif ! docker build "${pargs[@]}" --build-arg "LLAMACPP_REF=$TARGET" --build-arg "BUILD_JOBS=$(nproc)" \
            -t "$IMAGE_REPO:next" "$PROJECT_DIR/llamacpp" >> "$LOG_FILE" 2>&1; then
        fail "Build of $TARGET failed (see upgrade.log)"; return 1
    fi
    log "Built in $(( ($(date +%s) - t0) / 60 )) min"
    if [ "$(image_version "$IMAGE_REPO:next")" != "$TARGET" ]; then fail "The built image does not carry version $TARGET"; return 1; fi

    # 2. test new against current
    status running "Testing $TARGET against ${FROM_VER:-the current image}" "${keep}"
    local pick size model need dev
    pick=$(pick_test_model)
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
        new=$(test_image "$IMAGE_REPO:next" new "$model" "$dev"); log "New ($TARGET): $new"
        old=$(test_image "$IMAGE_REPO:latest" old "$model" "$dev"); log "Current (${FROM_VER:-latest}): $old"
        local verdict
        verdict=$(python3 - "$new" "$old" "$MIN_SPEED_RATIO" <<'PY'
import json, sys
new, old, ratio = json.loads(sys.argv[1]), json.loads(sys.argv[2]), float(sys.argv[3])
if not new.get("ok"): print("FAIL " + (new.get("error") or "the new build failed the test")); sys.exit()
if old.get("toolCall") and not new.get("toolCall"): print("FAIL tool calling works on the current build but not on the new one"); sys.exit()
ns, os_ = new.get("tokensPerSecond"), old.get("tokensPerSecond")
if ns and os_ and ns < os_ * ratio:
    print(f"SLOW decode {ns} tok/s vs {os_} tok/s on the current build"); sys.exit()
print(f"OK decode {ns} vs {os_} tok/s, tool call {'ok' if new.get('toolCall') else 'n/a'}")
PY
)
        log "Verdict: $verdict"
        TEST_JSON="\"test\":{\"model\":$(json_str "$model"),\"device\":$(json_str "$dev"),\"new\":$new,\"old\":$old,\"verdict\":$(json_str "$verdict")}"
        case "$verdict" in
            OK*) ;;
            SLOW*) if [ "$force" != true ]; then fail "${verdict#SLOW } (use --force to install anyway)"; return 1; fi ;;
            *) fail "${verdict#FAIL }"; return 1 ;;
        esac
    fi

    # 3. promote
    status running "Installing $TARGET" "${keep}"
    local rollback="$IMAGE_REPO:pre-$TARGET"
    if [ -n "$(image_id "$IMAGE_REPO:latest")" ]; then docker tag "$IMAGE_REPO:latest" "$rollback"; fi
    docker tag "$IMAGE_REPO:next" "$IMAGE_REPO:latest"
    echo "$TARGET" > "$REF_FILE"
    # The build inputs did not change; keep build.sh / update.sh in agreement.
    if [ -f "$PROJECT_DIR/scripts/lib/buildinputs.sh" ]; then
        # shellcheck source=/dev/null
        . "$PROJECT_DIR/scripts/lib/buildinputs.sh"
        git config --global --add safe.directory "$PROJECT_DIR" > /dev/null 2>&1 || true
        local h; h=$(ms_build_inputs_hash "$PROJECT_DIR" llamacpp)
        echo "$h" > "$BUILD_STATE_DIR/llamacpp.state"; echo "$h" > "$BUILD_STATE_DIR/llamacpp.tree"
    fi
    local now; now=$(date +%s)
    status succeeded "Installed $TARGET" "\"promotedAt\":$now,\"rollbackTag\":$(json_str "$rollback"),\"imageId\":$(json_str "$(image_id "$IMAGE_REPO:latest")"),\"reloadInstances\":true${TEST_JSON:+,$TEST_JSON}"
    log "Installed llama.cpp $TARGET. Rollback: sudo ./scripts/engine-upgrade.sh rollback"
    log "Running models move to the new build when they are idle (the webapp reloads them)."
}

cmd_rollback() {
    exec 9> "$STATE_DIR/lock"
    if ! flock -n 9; then echo "An engine upgrade is running; try again when it finishes." >&2; return 3; fi
    local tag; tag=$(prev_field rollbackTag)
    if [ -z "$tag" ] || [ -z "$(image_id "$tag")" ]; then echo "No rollback image recorded." >&2; return 1; fi
    FROM_VER=$(image_version "$IMAGE_REPO:latest"); TARGET=$(image_version "$tag")
    docker tag "$tag" "$IMAGE_REPO:latest"
    # Build at the rolled-back version from now on (or the checkout's pin).
    if [ -n "$TARGET" ] && version_gt "$TARGET" "$(dockerfile_ref)"; then echo "$TARGET" > "$REF_FILE"; else rm -f "$REF_FILE"; fi
    status succeeded "Rolled back to $TARGET" "\"promotedAt\":$(date +%s),\"rolledBack\":true,\"imageId\":$(json_str "$(image_id "$IMAGE_REPO:latest")"),\"reloadInstances\":true"
    log "Rolled back llama.cpp $FROM_VER -> $TARGET."
}

case "${1:-status}" in
    status) cmd_status ;;
    check) cmd_check ;;
    upgrade) shift; cmd_upgrade "$@" ;;
    rollback) cmd_rollback ;;
    effective-ref) effective_ref ;;
    last-step) prev_field step ;;
    selftest)  # run the comparison harness on the current image only
        pick=$(pick_test_model); [ -z "$pick" ] && { echo "no test model"; exit 1; }
        size=${pick%% *}; model=${pick#* }
        dev=$(pick_device $(( size / 1048576 * 13 / 10 + 1536 )) "$IMAGE_REPO:latest")
        echo "model=$model device=$dev"; test_image "$IMAGE_REPO:latest" self "$model" "$dev" ;;
    *) echo "Usage: $0 status | check | upgrade [--version vX] [--force] [--if-newer] | rollback" >&2; exit 2 ;;
esac
