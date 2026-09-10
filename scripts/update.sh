#!/bin/bash
# ============================================================================
# update.sh — pull the latest code from GitHub, rebuild only what changed,
#             test, and clean up
#
#   1. Preflight      root, git, docker, disk, WSL detection
#   2. Pull           git fetch + fast-forward from GitHub. A non-git install
#                     (zip download) is bootstrapped into a checkout first.
#                     Local edits to tracked files are stashed and restored.
#   3. Checksum       hash every build input per image (tracked + untracked-
#                     not-ignored files under each Docker context, minus that
#                     context's .dockerignore) and compare with the hash
#                     recorded at the last successful build
#                     (.build-state/<component>.tree)
#   4. Build          rebuild ONLY the images whose inputs changed
#   5. Deploy         recreate webapp/chat containers on the new images
#   6. Test           container health, HTTP probes, container code == checkout,
#                     boot-log scan, sanity-run of rebuilt base images
#   7. Cleanup        dangling images, stale build cache, orphan state files,
#                     __pycache__ under the bind-mounted scripts dir
#
# What is updated where:
#   webapp/ chat/ sandbox-runtime/ llamacpp/ sglang/  → baked into images → rebuild
#   scripts/ certs/ models/                            → bind-mounted → live on pull
#   docker-compose.yml                                 → containers recreated
#   .env certs/ models/.modelserver/ CLAUDE.md         → ignored by git, never touched
#
# Exit codes: 0 ok · 1 preflight/usage · 2 pull failed · 3 build failed ·
#             4 deploy failed · 5 tests failed
# ============================================================================
set -e
set -o pipefail

# Require root / sudo for Docker access
if [ "$(id -u)" -ne 0 ]; then
    echo ""
    echo "  This script requires root privileges (for Docker)."
    echo "  Run with:  sudo $0 $*"
    echo ""
    exit 1
fi

# Resolve symlinks to get actual script location. The pull below replaces
# scripts/update.sh itself, so run from a private copy: bash reads a script
# incrementally and must never see the file change underneath it.
if [ -z "${UPDATE_SH_ORIG:-}" ]; then
    export UPDATE_SH_ORIG="$(readlink -f "$0")"
    _self_copy="$(mktemp "${TMPDIR:-/tmp}/update.sh.XXXXXX")"
    cp "$UPDATE_SH_ORIG" "$_self_copy"
    export UPDATE_SH_COPY="$_self_copy"
    exec bash "$_self_copy" "$@"
fi
trap 'rm -f "${UPDATE_SH_COPY:-}"' EXIT
SCRIPT_PATH="$UPDATE_SH_ORIG"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Shared WSL / network helpers (ms_is_wsl, ms_wsl_networking_mode).
if [ -f "$SCRIPT_DIR/lib/netaccess.sh" ]; then
    . "$SCRIPT_DIR/lib/netaccess.sh"
else
    ms_is_wsl() { grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; }
    ms_wsl_networking_mode() { echo "unknown"; }
fi

# Shared build-input checksum — the SAME function build.sh uses, so the two
# scripts always agree on whether an image is current.
. "$SCRIPT_DIR/lib/buildinputs.sh"

BUILD_STATE_DIR="$PROJECT_DIR/.build-state"
mkdir -p "$BUILD_STATE_DIR"

DEFAULT_REPO_URL="https://github.com/frontierstack/Open-Source-Model-Manager.git"

# ============================================================================
# TERMINAL OUTPUT HELPERS
# ============================================================================

if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
    DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
    IS_TTY=true
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; DIM=''; BOLD=''; NC=''
    IS_TTY=false
fi

SYM_OK="${GREEN}✓${NC}"
SYM_FAIL="${RED}✗${NC}"
SYM_SKIP="${DIM}–${NC}"
SYM_WARN="${YELLOW}!${NC}"
SYM_ARROW="${CYAN}→${NC}"

log_success() { echo -e "  ${SYM_OK}  $1"; }
log_skip()    { echo -e "  ${SYM_SKIP}  $1"; }
log_warning() { echo -e "  ${SYM_WARN}  ${YELLOW}$1${NC}"; }
log_error()   { echo -e "  ${SYM_FAIL}  ${RED}$1${NC}"; }
log_step()    { echo -e "  ${SYM_ARROW}  $1"; }

section() {
    echo ""
    echo -e "  ${BOLD}${CYAN}$1${NC}"
    echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 ${#1}))${NC}"
}

SPINNER_PID=""
start_spinner() {
    local msg="$1"
    if [ "$IS_TTY" != true ]; then
        echo "  ...  $msg"
        return
    fi
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    (
        local i=0
        while true; do
            printf "\r  ${CYAN}${frames[$i]}${NC}  %s" "$msg"
            i=$(( (i + 1) % ${#frames[@]} ))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
    disown $SPINNER_PID 2>/dev/null
}

stop_spinner() {
    if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null
        wait "$SPINNER_PID" 2>/dev/null || true
    fi
    SPINNER_PID=""
    [ "$IS_TTY" = true ] && printf "\r\033[K"
    return 0
}

trap 'stop_spinner; rm -f "${UPDATE_SH_COPY:-}"' EXIT

fmt_duration() {
    local secs=$1
    if [ "$secs" -ge 3600 ]; then
        echo "$((secs / 3600))h $(( (secs % 3600) / 60 ))m"
    elif [ "$secs" -ge 60 ]; then
        echo "$((secs / 60))m $((secs % 60))s"
    else
        echo "${secs}s"
    fi
}

# ============================================================================
# ARGUMENTS
# ============================================================================

DO_PULL=true
DO_BUILD=true
DO_DEPLOY=true
DO_TEST=true
DO_CLEANUP=true
DRY_RUN=false
NO_CACHE=false
PARALLEL=true
STOP_INSTANCES=false
DISCARD_LOCAL=false
DEEP_CLEAN=false
GIT_REF=""
REPO_URL="${MODELSERVER_REPO:-}"
declare -a FORCE_COMPONENTS=()

usage() {
    cat <<EOF

  Usage: sudo ./update.sh [OPTIONS]

  Pulls the latest code from GitHub, checksums every image's build inputs,
  rebuilds only the images whose inputs changed, redeploys, tests, cleans up.

  Options:
    --no-pull            Skip the GitHub pull (rebuild whatever changed locally)
    --ref <branch>       Pull a specific branch (default: the tracked branch, else main)
    --repo <url>         Git remote to pull from (default: the checkout's origin,
                         else $DEFAULT_REPO_URL)
    --force <component>  Rebuild a component regardless of checksum
                         (webapp | chat | sandbox-runtime | llamacpp | sglang | all)
    --no-cache           Rebuild forced/changed images without Docker layer cache
    --no-parallel        Build images one at a time (low-memory hosts)
    --stop-instances     Stop running model instances before updating
                         (required for them to pick up a rebuilt llamacpp/sglang image)
    --discard-local      Throw away uncommitted local edits to tracked files
                         (default: stash them and restore after the pull)
    --skip-build         Pull + checksum only; report what would rebuild
    --skip-deploy        Build but do not recreate containers
    --skip-tests         Do not run the post-update checks
    --no-cleanup         Leave dangling images / stale cache / orphan files
    --deep-clean         Also prune ALL unused build cache (next full rebuild is slower)
    --dry-run            Show the plan (fetch + checksum), change nothing
    -h, --help           This help

  Environment: MODELSERVER_REPO overrides the remote URL; proxy/SSL variables in
  .env (HTTP_PROXY, NODE_TLS_REJECT_UNAUTHORIZED, GIT_SSL_NO_VERIFY, ...) are
  honoured for the pull and the builds, same as ./build.sh.

EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-pull)        DO_PULL=false; shift ;;
        --ref)            GIT_REF="$2"; shift 2 ;;
        --repo)           REPO_URL="$2"; shift 2 ;;
        --force)          FORCE_COMPONENTS+=("$2"); shift 2 ;;
        --no-cache)       NO_CACHE=true; shift ;;
        --no-parallel)    PARALLEL=false; shift ;;
        --stop-instances) STOP_INSTANCES=true; shift ;;
        --discard-local)  DISCARD_LOCAL=true; shift ;;
        --skip-build)     DO_BUILD=false; DO_DEPLOY=false; DO_TEST=false; shift ;;
        --skip-deploy)    DO_DEPLOY=false; shift ;;
        --skip-tests)     DO_TEST=false; shift ;;
        --no-cleanup)     DO_CLEANUP=false; shift ;;
        --deep-clean)     DEEP_CLEAN=true; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        usage; exit 0 ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# ============================================================================
# COMPONENT TABLE
# ============================================================================
# component        → source dir (Docker build context)   → image tag

COMPONENTS=(webapp chat sandbox-runtime llamacpp sglang)

declare -A COMP_DIR=(
    [webapp]="webapp"
    [chat]="chat"
    [sandbox-runtime]="sandbox-runtime"
    [llamacpp]="llamacpp"
    [sglang]="sglang"
)
declare -A COMP_IMAGE=(
    [webapp]="modelserver-webapp:latest"
    [chat]="modelserver-chat:latest"
    [sandbox-runtime]="modelserver-sandbox-python:latest"
    [llamacpp]="modelserver-llamacpp:latest"
    [sglang]="modelserver-sglang:latest"
)
declare -A COMP_ETA=(
    [webapp]="3–6 min"
    [chat]="1–3 min"
    [sandbox-runtime]="3–8 min"
    [llamacpp]="20–90 min (CUDA compile)"
    [sglang]="8–12 min"
)
# Minimum free disk (GB) to attempt a rebuild of each image.
declare -A COMP_MIN_DISK_GB=(
    [webapp]=6
    [chat]=2
    [sandbox-runtime]=6
    [llamacpp]=10
    [sglang]=30
)
# Files whose in-container copy must equal the checkout after deploy — the
# runtime code that is COPYed verbatim (src/ is compiled into a bundle and
# public/ holds build output, so those are excluded).
declare -A COMP_VERIFY_EXCLUDE=(
    [webapp]='^webapp/(src/|public/|\.dockerignore|.*\.md$)'
    [chat]='^chat/(src/|public/|\.dockerignore|.*\.md$)'
)
declare -A COMP_SERVICE=( [webapp]="webapp" [chat]="chat" )

# ============================================================================
# CHECKSUM
# ============================================================================

# On a Windows filesystem mounted into WSL (/mnt/c, 9p/drvfs) or any FS without
# real POSIX modes, every file reports the same mode and git may report the
# whole tree as "modified" — ignore modes there (the checksum does the same).
FS_TYPE=$(stat -f -c %T "$PROJECT_DIR" 2>/dev/null || echo unknown)
FS_HAS_MODES=true
ms_fs_has_modes "$PROJECT_DIR" || FS_HAS_MODES=false
if [ "$FS_HAS_MODES" = false ]; then
    git() { command git -c core.filemode=false "$@"; }
fi

tree_state_file() { echo "$BUILD_STATE_DIR/$1.tree"; }

component_tree_hash() { ms_build_inputs_hash "$PROJECT_DIR" "${COMP_DIR[$1]}"; }

# build.sh reads .build-state/<comp>.state — same value, so ./build.sh agrees
# the image is current after an update (and vice versa).
record_component_built() {
    local comp="$1" h
    h=$(component_tree_hash "$comp")
    echo "$h" > "$(tree_state_file "$comp")"
    echo "$h" > "$BUILD_STATE_DIR/$comp.state"
}

image_exists() { [ -n "$(docker images -q "$1" 2>/dev/null)" ]; }

# True when the service's container runs an image OLDER than the current tag
# (e.g. ./build.sh rebuilt it but nothing recreated the container).
container_image_stale() {
    local svc="$1" tag="$2" cid cur run
    cid=$(docker compose ps -q "$svc" 2>/dev/null | head -1)
    [ -n "$cid" ] || return 1
    cur=$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null)
    run=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)
    [ -n "$cur" ] && [ -n "$run" ] && [ "$cur" != "$run" ]
}

# Files to compare host↔container for a component (relative to PROJECT_DIR).
verify_file_list() {
    local comp="$1"
    git ls-files -- "${COMP_DIR[$comp]}" 2>/dev/null | grep -v -E "${COMP_VERIFY_EXCLUDE[$comp]}" | while read -r f; do
        [ -f "$f" ] && echo "$f"
    done
}

# Compare the checkout's runtime files with the copies inside the running
# container. Prints the differing files; returns 1 if any differ, 2 if the
# container is not running.
container_code_diff() {
    local comp="$1" svc="${COMP_SERVICE[$1]}" dir="${COMP_DIR[$1]}"
    local cid
    cid=$(docker compose ps -q "$svc" 2>/dev/null | head -1)
    [ -n "$cid" ] || return 2
    [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ] || return 2

    local host_sums cont_sums
    host_sums=$(verify_file_list "$comp" | sed "s#^$dir/##" | sort | while read -r rel; do
        printf '%s  %s\n' "$(sha256sum "$dir/$rel" | cut -d' ' -f1)" "$rel"
    done)
    local files
    files=$(echo "$host_sums" | awk '{print $2}' | tr '\n' ' ')
    cont_sums=$(docker exec "$cid" sh -c "cd /usr/src/app && for f in $files; do if [ -f \"\$f\" ]; then sha256sum \"\$f\"; else echo \"missing  \$f\"; fi; done" 2>/dev/null \
        | sed 's#^\([0-9a-f]*\|missing\)  \./#\1  #' | sort -k2)
    diff <(echo "$host_sums" | sort -k2) <(echo "$cont_sums") | grep '^<' | awk '{print $3}'
    if [ "$(echo "$host_sums" | sort -k2)" = "$cont_sums" ]; then return 0; else return 1; fi
}

# ============================================================================
# PHASE 1: PREFLIGHT
# ============================================================================

echo ""
echo -e "  ${BOLD}Update Model Server${NC}"
[ "$DRY_RUN" = true ] && echo -e "  ${DIM}dry run — nothing will change${NC}"

section "Preflight"
TOTAL_START=$(date +%s)

if ! command -v git > /dev/null 2>&1; then
    log_error "git is required to pull updates from GitHub"
    echo -e "      ${DIM}Install it (Debian/Ubuntu/WSL: sudo apt-get install -y git) and re-run.${NC}"
    exit 1
fi

IS_GIT_CHECKOUT=false
if git rev-parse --is-inside-work-tree > /dev/null 2>&1 && [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(readlink -f "$PROJECT_DIR")" ]; then
    IS_GIT_CHECKOUT=true
    log_success "Git checkout  ${DIM}$(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)${NC}"
else
    if [ "$DO_PULL" = true ]; then
        log_step "Not a git checkout  ${DIM}will bootstrap one from GitHub without touching local data${NC}"
    else
        log_error "Not a git checkout and --no-pull given — nothing to compare against"
        exit 1
    fi
fi

if ! docker info > /dev/null 2>&1; then
    log_error "Docker daemon not reachable"
    if ms_is_wsl; then
        echo -e "      ${DIM}WSL: start Docker Desktop (with WSL integration enabled for this distro),${NC}"
        echo -e "      ${DIM}or start the native daemon: sudo service docker start${NC}"
    fi
    exit 1
fi
log_success "Docker  ${DIM}$(docker --version | sed 's/Docker version //; s/,.*//')${NC}"

if ! docker compose version > /dev/null 2>&1; then
    log_error "docker compose (v2 plugin) not available"
    exit 1
fi

if ms_is_wsl; then
    wsl_mode=$(ms_wsl_networking_mode)
    log_success "WSL detected  ${DIM}networking: ${wsl_mode}${NC}"
    case "$PROJECT_DIR" in
        /mnt/[a-zA-Z]/*)
            log_warning "Checkout lives on the Windows filesystem ($PROJECT_DIR)"
            echo -e "      ${DIM}Works, but builds and git are much slower than under the Linux home dir.${NC}"
            ;;
    esac
    if [ "$FS_HAS_MODES" = false ]; then
        log_step "Filesystem $FS_TYPE has no POSIX modes  ${DIM}file modes ignored for checksums and git${NC}"
    fi
else
    log_success "Linux host  ${DIM}$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr)${NC}"
fi

FREE_GB=$(df -BG --output=avail "$PROJECT_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
FREE_GB=${FREE_GB:-0}
log_success "Free disk  ${DIM}${FREE_GB} GB${NC}"

# Is the app running? Updating works either way (images are rebuilt on disk);
# without running containers there is nothing to redeploy or probe.
service_running() {
    local cid
    cid=$(docker compose ps -q "$1" 2>/dev/null | head -1)
    [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]
}
SERVICES_RUNNING=true
NOT_RUNNING=""
for svc in webapp chat; do
    service_running "$svc" || NOT_RUNNING="$NOT_RUNNING $svc"
done
if [ -z "$NOT_RUNNING" ]; then
    log_success "App running  ${DIM}webapp :3001, chat :3002${NC}"
else
    SERVICES_RUNNING=false
    log_warning "App is not running (${NOT_RUNNING# })"
    echo -e "      ${DIM}The update will still pull and rebuild images, but nothing can be redeployed or${NC}"
    echo -e "      ${DIM}health-checked until the app is running. Start it with:  sudo ./start.sh${NC}"
fi

# Load .env so the same proxy/SSL settings build.sh uses reach git and the builds.
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; . "$PROJECT_DIR/.env"; set +a
fi

# ============================================================================
# PHASE 2: PULL (from GitHub)
# ============================================================================

OLD_HEAD=""
[ "$IS_GIT_CHECKOUT" = true ] && OLD_HEAD=$(git rev-parse HEAD)
NEW_HEAD="$OLD_HEAD"
BOOTSTRAPPED=false
BOOTSTRAP_REPLACED=""
STASHED=false
STASH_NAME="update.sh autostash $(date +%Y-%m-%dT%H:%M:%S)"
COMPOSE_CHANGED=false

# Pre-pull snapshot of every component so the plan can explain WHAT changed.
declare -A PRE_HASH
for comp in "${COMPONENTS[@]}"; do
    if [ "$IS_GIT_CHECKOUT" = true ]; then
        PRE_HASH[$comp]=$(component_tree_hash "$comp")
    else
        PRE_HASH[$comp]="no-git"
    fi
done

restore_stash() {
    [ "$STASHED" = true ] || return 0
    STASHED=false
    if git stash pop --quiet 2>/dev/null; then
        log_success "Local edits restored"
    else
        log_warning "Local edits could not be re-applied cleanly — kept in 'git stash list' as: $STASH_NAME"
        log_warning "Resolve with: git stash pop   (conflicting files are marked)"
    fi
}

if [ "$DO_PULL" = true ]; then
    section "Pull"

    # Remote: explicit --repo / MODELSERVER_REPO > the checkout's origin > GitHub default.
    if [ -z "$REPO_URL" ]; then
        if [ "$IS_GIT_CHECKOUT" = true ]; then
            REPO_URL=$(git remote get-url origin 2>/dev/null || true)
        fi
        [ -z "$REPO_URL" ] && REPO_URL="$DEFAULT_REPO_URL"
    fi
    # Never print credentials embedded in a remote URL.
    REPO_URL_SHOWN=$(echo "$REPO_URL" | sed -E 's#(https?://)[^@/]+@#\1#')

    if [ "$IS_GIT_CHECKOUT" = false ]; then
        BRANCH="${GIT_REF:-main}"
        if [ "$DRY_RUN" = true ]; then
            log_step "Would bootstrap a git checkout from $REPO_URL_SHOWN ($BRANCH) — dry run"
            echo ""
            echo -e "  ${DIM}Re-run without --dry-run to convert this install into a git checkout${NC}"
            echo -e "  ${DIM}and update it. Ignored files (.env, certs/, models/) are left alone.${NC}"
            echo ""
            exit 0
        fi
        start_spinner "Bootstrapping git checkout from $REPO_URL_SHOWN ($BRANCH)"
        {
            git init -q
            git remote add origin "$REPO_URL"
            git fetch -q --depth 50 origin "$BRANCH"
        } > "$BUILD_STATE_DIR/update.fetch.log" 2>&1 || {
            stop_spinner
            log_error "Could not fetch $REPO_URL_SHOWN"
            sed 's/^/    /' "$BUILD_STATE_DIR/update.fetch.log" | tail -10
            rm -rf "$PROJECT_DIR/.git"
            exit 2
        }
        # Any local file that differs from upstream is a hand edit of a
        # downloaded install — keep a copy before it is overwritten.
        BACKUP_DIR="$BUILD_STATE_DIR/pre-bootstrap-$(date +%Y%m%d-%H%M%S)"
        changed=0
        BOOTSTRAP_REPLACED=""
        while IFS= read -r f; do
            if [ ! -f "$f" ]; then
                # New upstream file — the local install never had it.
                BOOTSTRAP_REPLACED="$BOOTSTRAP_REPLACED$f"$'\n'
                continue
            fi
            if [ -L "$f" ]; then
                # git stores a symlink's TARGET TEXT as the blob, not the file it points at
                [ "$(readlink "$f")" = "$(git cat-file -p "FETCH_HEAD:$f" 2>/dev/null)" ] && continue
            elif [ "$(git hash-object "$f")" = "$(git rev-parse "FETCH_HEAD:$f" 2>/dev/null)" ]; then
                continue
            fi
            {
                mkdir -p "$BACKUP_DIR/$(dirname "$f")"
                cp -P "$f" "$BACKUP_DIR/$f"
                changed=$((changed + 1))
                BOOTSTRAP_REPLACED="$BOOTSTRAP_REPLACED$f"$'\n'
            }
        done < <(git ls-tree -r --name-only FETCH_HEAD)
        git reset -q --hard FETCH_HEAD
        git checkout -q -B "$BRANCH" FETCH_HEAD
        git branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
        stop_spinner
        IS_GIT_CHECKOUT=true
        BOOTSTRAPPED=true
        NEW_HEAD=$(git rev-parse HEAD)
        log_success "Checkout created  ${DIM}$(git rev-parse --short HEAD) on $BRANCH, tracking origin/$BRANCH${NC}"
        if [ "$changed" -gt 0 ]; then
            log_warning "$changed local file(s) differed from upstream and were replaced — copies kept in ${BACKUP_DIR#$PROJECT_DIR/}"
        else
            rmdir "$BACKUP_DIR" 2>/dev/null || true
        fi
    else
        BRANCH="$GIT_REF"
        if [ -z "$BRANCH" ]; then
            BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null | sed 's#^origin/##')
            [ -z "$BRANCH" ] && BRANCH=$(git rev-parse --abbrev-ref HEAD)
            [ "$BRANCH" = "HEAD" ] && BRANCH="main"
        fi
        log_step "Remote  ${DIM}$REPO_URL_SHOWN ($BRANCH)${NC}"

        # Local edits to TRACKED files would block a fast-forward. Stash (default)
        # or discard (--discard-local). Untracked/ignored files (.env, certs,
        # CLAUDE.md, models/) are never touched.
        if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
            if [ "$DISCARD_LOCAL" = true ]; then
                if [ "$DRY_RUN" = true ]; then
                    log_warning "Would discard local edits to tracked files (--discard-local)"
                else
                    git checkout -q -- .
                    log_warning "Discarded local edits to tracked files (--discard-local)"
                fi
            else
                if [ "$DRY_RUN" = true ]; then
                    log_warning "Local edits to tracked files would be stashed and restored after the pull"
                else
                    git stash push --quiet -m "$STASH_NAME"
                    STASHED=true
                    log_step "Local edits stashed  ${DIM}restored after the pull${NC}"
                fi
            fi
        fi

        start_spinner "Fetching $BRANCH from $REPO_URL_SHOWN"
        if ! git fetch --quiet --prune "$REPO_URL" "$BRANCH" 2> "$BUILD_STATE_DIR/update.fetch.log"; then
            stop_spinner
            log_error "git fetch failed"
            sed 's/^/    /' "$BUILD_STATE_DIR/update.fetch.log" | tail -10
            restore_stash
            exit 2
        fi
        stop_spinner
        # Keep origin/<branch> current when pulling from the configured origin.
        if [ "$REPO_URL" = "$(git remote get-url origin 2>/dev/null)" ]; then
            git update-ref "refs/remotes/origin/$BRANCH" FETCH_HEAD 2>/dev/null || true
        fi

        BEHIND=$(git rev-list --count "HEAD..FETCH_HEAD")
        AHEAD=$(git rev-list --count "FETCH_HEAD..HEAD")

        if [ "$BEHIND" -eq 0 ]; then
            log_success "Already up to date  ${DIM}$(git rev-parse --short HEAD)${NC}"
            [ "$AHEAD" -gt 0 ] && log_warning "Local branch is $AHEAD commit(s) ahead of $BRANCH on the remote"
        elif [ "$DRY_RUN" = true ]; then
            log_step "$BEHIND new commit(s)  ${DIM}$(git rev-parse --short HEAD) → $(git rev-parse --short FETCH_HEAD)${NC}"
            git log --oneline --no-decorate "HEAD..FETCH_HEAD" | head -15 | sed 's/^/      /'
            [ "$BEHIND" -gt 15 ] && echo "      … $((BEHIND - 15)) more"
            NEW_HEAD=$(git rev-parse FETCH_HEAD)
        else
            if [ "$AHEAD" -gt 0 ]; then
                log_error "Local branch has $AHEAD commit(s) not on the remote — refusing to merge automatically"
                echo -e "      ${DIM}Push or rebase them first; or back them up and reset to origin/$BRANCH.${NC}"
                restore_stash
                exit 2
            fi
            if ! git merge --ff-only --quiet FETCH_HEAD 2> "$BUILD_STATE_DIR/update.merge.log"; then
                log_error "Fast-forward failed"
                sed 's/^/    /' "$BUILD_STATE_DIR/update.merge.log" | tail -10
                restore_stash
                exit 2
            fi
            NEW_HEAD=$(git rev-parse HEAD)
            log_success "Updated  ${DIM}$(git rev-parse --short "$OLD_HEAD") → $(git rev-parse --short "$NEW_HEAD"), $BEHIND commit(s)${NC}"
            git log --oneline --no-decorate "$OLD_HEAD..$NEW_HEAD" | head -15 | sed 's/^/      /'
            [ "$BEHIND" -gt 15 ] && echo "      … $((BEHIND - 15)) more"

            REMOVED=$(git diff --name-only --diff-filter=D "$OLD_HEAD" "$NEW_HEAD" | wc -l)
            [ "$REMOVED" -gt 0 ] && log_step "$REMOVED file(s) removed upstream were deleted from the checkout"
        fi

        restore_stash

        # Files that are not baked into images: compose (recreate) and the
        # bind-mounted scripts (live immediately).
        if [ -n "$OLD_HEAD" ] && [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
            if [ -n "$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- docker-compose.yml)" ]; then
                log_step "docker-compose.yml changed  ${DIM}containers will be recreated${NC}"
                COMPOSE_CHANGED=true
            fi
            if [ -n "$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- scripts/)" ]; then
                log_step "scripts/ changed  ${DIM}bind-mounted into the webapp — live, no rebuild${NC}"
            fi
        fi
    fi
fi

# ============================================================================
# PHASE 3: CHECKSUM → BUILD PLAN
# ============================================================================

section "Build Plan"

declare -A NEEDS_BUILD
declare -A BUILD_REASON
declare -A CUR_HASH

force_all=false
for f in "${FORCE_COMPONENTS[@]}"; do
    [ "$f" = "all" ] && force_all=true
    if [ "$f" != "all" ] && [ -z "${COMP_DIR[$f]:-}" ]; then
        log_error "Unknown component for --force: $f"
        exit 1
    fi
done

is_forced() {
    [ "$force_all" = true ] && return 0
    local f
    for f in "${FORCE_COMPONENTS[@]}"; do [ "$f" = "$1" ] && return 0; done
    return 1
}

# Did the pulled (or previewed) commits touch this component's non-doc files?
pulled_changes_in() {
    [ -n "$OLD_HEAD" ] && [ "$OLD_HEAD" != "$NEW_HEAD" ] || return 1
    [ -n "$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- "${COMP_DIR[$1]}" | grep -v -E '\.md$')" ]
}

for comp in "${COMPONENTS[@]}"; do
    image="${COMP_IMAGE[$comp]}"
    dir="${COMP_DIR[$comp]}"
    CUR_HASH[$comp]=$(component_tree_hash "$comp")

    recorded=""
    [ -f "$(tree_state_file "$comp")" ] && recorded=$(cat "$(tree_state_file "$comp")")

    if is_forced "$comp"; then
        NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="forced"
    elif [ "${CUR_HASH[$comp]}" = "missing" ]; then
        NEEDS_BUILD[$comp]=false; BUILD_REASON[$comp]="source dir missing — skipped"
    elif ! image_exists "$image"; then
        NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="image not built yet"
    elif [ "$DRY_RUN" = true ] && [ "$NEW_HEAD" != "$OLD_HEAD" ]; then
        # Preview of unpulled commits: decide from the incoming diff.
        if pulled_changes_in "$comp"; then
            NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="incoming commits change $dir/"
        elif [ -n "$recorded" ] && [ "$recorded" != "${CUR_HASH[$comp]}" ]; then
            NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="inputs changed since last build (local edits)"
        else
            NEEDS_BUILD[$comp]=false; BUILD_REASON[$comp]="up to date"
        fi
    elif [ -z "$recorded" ]; then
        # First run of this updater (or a fresh bootstrap): no recorded hash.
        # Don't rebuild everything — decide from evidence, then record a baseline.
        stale=""
        if [ -n "${COMP_SERVICE[$comp]:-}" ]; then
            stale=$(container_code_diff "$comp" 2>/dev/null || true)
        fi
        if pulled_changes_in "$comp"; then
            NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="pulled changes in $dir/ (no build record yet)"
        elif [ "$BOOTSTRAPPED" = true ] && echo "${BOOTSTRAP_REPLACED:-}" | grep -q -E "^$dir/" ; then
            NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="bootstrap replaced files in $dir/"
        elif [ -n "$stale" ]; then
            NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="running container code differs from checkout ($(echo "$stale" | wc -l) file(s))"
        elif [ "$BOOTSTRAPPED" = false ] && [ "${PRE_HASH[$comp]}" != "${CUR_HASH[$comp]}" ]; then
            NEEDS_BUILD[$comp]=true; BUILD_REASON[$comp]="inputs changed during pull"
        else
            NEEDS_BUILD[$comp]=false; BUILD_REASON[$comp]="up to date (baseline recorded)"
            [ "$DRY_RUN" = true ] || echo "${CUR_HASH[$comp]}" > "$(tree_state_file "$comp")"
        fi
    elif [ "$recorded" != "${CUR_HASH[$comp]}" ]; then
        NEEDS_BUILD[$comp]=true
        if [ "${PRE_HASH[$comp]}" != "${CUR_HASH[$comp]}" ]; then
            BUILD_REASON[$comp]="inputs changed by this pull"
        else
            BUILD_REASON[$comp]="inputs changed since last build (local edits)"
        fi
    else
        NEEDS_BUILD[$comp]=false; BUILD_REASON[$comp]="up to date"
    fi
done

ANY_BUILD=false
for comp in "${COMPONENTS[@]}"; do
    if [ "${NEEDS_BUILD[$comp]}" = true ]; then
        ANY_BUILD=true
        log_step "${comp}  ${DIM}${BUILD_REASON[$comp]} · ~${COMP_ETA[$comp]}${NC}"
        if [ -n "$OLD_HEAD" ] && [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
            git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- "${COMP_DIR[$comp]}" | head -8 | sed 's/^/        /'
            n=$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- "${COMP_DIR[$comp]}" | wc -l)
            [ "$n" -gt 8 ] && echo "        … $((n - 8)) more"
        fi
    else
        log_success "${comp}  ${DIM}${BUILD_REASON[$comp]}${NC}"
    fi
done

declare -A REDEPLOY_STALE
for comp in webapp chat; do
    REDEPLOY_STALE[$comp]=false
    if [ "${NEEDS_BUILD[$comp]}" != true ] && container_image_stale "$comp" "${COMP_IMAGE[$comp]}"; then
        REDEPLOY_STALE[$comp]=true
        log_step "${comp}  ${DIM}container runs an older image than ${COMP_IMAGE[$comp]} — will be recreated${NC}"
    fi
done

if [ "$ANY_BUILD" = false ] && [ "$COMPOSE_CHANGED" = false ] && [ "${REDEPLOY_STALE[webapp]}" = false ] && [ "${REDEPLOY_STALE[chat]}" = false ]; then
    echo ""
    log_success "Nothing to rebuild"
fi

if [ "$DRY_RUN" = true ]; then
    echo ""
    echo -e "  ${DIM}Dry run complete — re-run without --dry-run to apply.${NC}"
    echo ""
    exit 0
fi

if [ "$DO_BUILD" = false ]; then
    echo ""
    echo -e "  ${DIM}--skip-build: stopping after the plan.${NC}"
    echo ""
    exit 0
fi

# Disk guard for the images about to be built.
need_gb=0
for comp in "${COMPONENTS[@]}"; do
    [ "${NEEDS_BUILD[$comp]}" = true ] && need_gb=$(( need_gb + ${COMP_MIN_DISK_GB[$comp]} ))
done
if [ "$need_gb" -gt 0 ] && [ "$FREE_GB" -lt "$need_gb" ]; then
    echo ""
    log_error "Only ${FREE_GB} GB free; the planned rebuilds need about ${need_gb} GB"
    log_error "Free space (docker system df / docker builder prune) and re-run"
    exit 1
fi

# ============================================================================
# PHASE 4: BUILD
# ============================================================================

# Same proxy/SSL build args build.sh passes (values from .env / environment).
declare -a BUILD_ARGS=()
[ -n "${HTTP_PROXY:-}" ]                   && BUILD_ARGS+=(--build-arg "HTTP_PROXY=$HTTP_PROXY")
[ -n "${HTTPS_PROXY:-}" ]                  && BUILD_ARGS+=(--build-arg "HTTPS_PROXY=$HTTPS_PROXY")
[ -n "${NO_PROXY:-}" ]                     && BUILD_ARGS+=(--build-arg "NO_PROXY=$NO_PROXY")
[ -n "${NODE_TLS_REJECT_UNAUTHORIZED:-}" ] && BUILD_ARGS+=(--build-arg "NODE_TLS_REJECT_UNAUTHORIZED=$NODE_TLS_REJECT_UNAUTHORIZED")
[ -n "${GIT_SSL_NO_VERIFY:-}" ]            && BUILD_ARGS+=(--build-arg "GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY")
[ -n "${PIP_TRUSTED_HOST:-}" ]             && BUILD_ARGS+=(--build-arg "PIP_TRUSTED_HOST=$PIP_TRUSTED_HOST")
[ -n "${PIP_CERT:-}" ]                     && BUILD_ARGS+=(--build-arg "PIP_CERT=$PIP_CERT")
declare -a NO_CACHE_ARGS=()
[ "$NO_CACHE" = true ] && NO_CACHE_ARGS=(--no-cache)

# Build one component to its log file. Returns the docker exit code.
build_component() {
    local comp="$1"
    local log="$BUILD_STATE_DIR/$comp.log"
    local start=$(date +%s)
    local rc=0
    case "$comp" in
        sandbox-runtime)
            docker build "${NO_CACHE_ARGS[@]}" "${BUILD_ARGS[@]}" \
                -t "${COMP_IMAGE[$comp]}" "$PROJECT_DIR/sandbox-runtime" > "$log" 2>&1 || rc=$?
            ;;
        llamacpp|sglang)
            docker compose --profile build-only build "${BUILD_ARGS[@]}" "${NO_CACHE_ARGS[@]}" "$comp" > "$log" 2>&1 || rc=$?
            ;;
        *)
            docker compose build "${BUILD_ARGS[@]}" "${NO_CACHE_ARGS[@]}" "$comp" > "$log" 2>&1 || rc=$?
            ;;
    esac
    echo $(( $(date +%s) - start )) > "$BUILD_STATE_DIR/$comp.duration"
    return $rc
}

declare -A BUILD_RC
BUILD_FAILED=false

if [ "$ANY_BUILD" = true ]; then
    section "Build"

    if [ "$STOP_INSTANCES" = true ]; then
        start_spinner "Stopping model instances"
        docker ps -q --filter "name=llamacpp-" 2>/dev/null | xargs -r docker stop > /dev/null 2>&1 || true
        docker ps -aq --filter "name=llamacpp-" 2>/dev/null | xargs -r docker rm > /dev/null 2>&1 || true
        docker ps -q --filter "name=sglang-" 2>/dev/null | xargs -r docker stop > /dev/null 2>&1 || true
        docker ps -aq --filter "name=sglang-" 2>/dev/null | xargs -r docker rm > /dev/null 2>&1 || true
        stop_spinner
        log_success "Model instances stopped"
    fi

    declare -a TO_BUILD=()
    for comp in "${COMPONENTS[@]}"; do
        [ "${NEEDS_BUILD[$comp]}" = true ] && TO_BUILD+=("$comp")
    done

    if [ "$PARALLEL" = true ] && [ "${#TO_BUILD[@]}" -gt 1 ]; then
        declare -A PIDS
        for comp in "${TO_BUILD[@]}"; do
            build_component "$comp" &
            PIDS[$comp]=$!
        done
        start_spinner "Building ${TO_BUILD[*]} in parallel  (logs: .build-state/<component>.log)"
        for comp in "${TO_BUILD[@]}"; do
            rc=0; wait "${PIDS[$comp]}" || rc=$?
            BUILD_RC[$comp]=$rc
        done
        stop_spinner
    else
        for comp in "${TO_BUILD[@]}"; do
            start_spinner "Building $comp  (~${COMP_ETA[$comp]}, log: .build-state/$comp.log)"
            rc=0; build_component "$comp" || rc=$?
            BUILD_RC[$comp]=$rc
            stop_spinner
        done
    fi

    for comp in "${TO_BUILD[@]}"; do
        if [ "${BUILD_RC[$comp]}" -eq 0 ] && ! docker image inspect "${COMP_IMAGE[$comp]}" > /dev/null 2>&1; then
            BUILD_RC[$comp]=99
        fi
        if [ "${BUILD_RC[$comp]}" -eq 0 ]; then
            record_component_built "$comp"
            log_success "$comp  ${DIM}$(fmt_duration "$(cat "$BUILD_STATE_DIR/$comp.duration")")${NC}"
        else
            BUILD_FAILED=true
            log_error "$comp build failed  ${DIM}exit ${BUILD_RC[$comp]}${NC}"
            echo ""
            echo -e "  ${DIM}Last 20 lines of .build-state/$comp.log:${NC}"
            tail -20 "$BUILD_STATE_DIR/$comp.log" 2>/dev/null | sed 's/^/    /'
            echo ""
        fi
    done

    if [ "$BUILD_FAILED" = true ]; then
        log_error "One or more builds failed — running containers were NOT touched"
        echo -e "  ${DIM}Fix the cause and re-run ./update.sh (images that built are skipped next time).${NC}"
        echo ""
        exit 3
    fi
fi

# ============================================================================
# PHASE 5: DEPLOY
# ============================================================================

SERVICES_REDEPLOYED=()
if [ "$DO_DEPLOY" = true ] && [ "$SERVICES_RUNNING" = false ]; then
    if [ "${NEEDS_BUILD[webapp]}" = true ] || [ "${NEEDS_BUILD[chat]}" = true ] || [ "$COMPOSE_CHANGED" = true ] || [ "${REDEPLOY_STALE[webapp]}" = true ] || [ "${REDEPLOY_STALE[chat]}" = true ]; then
        section "Deploy"
        log_warning "App is not running — images are updated on disk, containers were not started"
        echo -e "      ${DIM}Run  sudo ./start.sh  to bring the app up on the new images.${NC}"
    fi
    DO_DEPLOY=false
fi
if [ "$DO_DEPLOY" = true ]; then
    if [ "${NEEDS_BUILD[webapp]}" = true ] || [ "${NEEDS_BUILD[chat]}" = true ] || [ "$COMPOSE_CHANGED" = true ] || [ "${REDEPLOY_STALE[webapp]}" = true ] || [ "${REDEPLOY_STALE[chat]}" = true ]; then
        section "Deploy"
        start_spinner "Recreating containers"
        # Rebuilt services are force-recreated so the container can never keep
        # running an older image; the rest are recreated only if compose config
        # changed.
        declare -a RECREATE=()
        { [ "${NEEDS_BUILD[webapp]}" = true ] || [ "${REDEPLOY_STALE[webapp]}" = true ]; } && RECREATE+=(webapp)
        { [ "${NEEDS_BUILD[chat]}" = true ] || [ "${REDEPLOY_STALE[chat]}" = true ]; } && RECREATE+=(chat)
        if [ "${#RECREATE[@]}" -gt 0 ]; then
            docker compose up -d --force-recreate --no-deps "${RECREATE[@]}" > "$BUILD_STATE_DIR/update.deploy.log" 2>&1 || true
        else
            : > "$BUILD_STATE_DIR/update.deploy.log"
        fi
        if ! docker compose up -d --remove-orphans webapp chat >> "$BUILD_STATE_DIR/update.deploy.log" 2>&1; then
            stop_spinner
            log_error "docker compose up failed"
            sed 's/^/    /' "$BUILD_STATE_DIR/update.deploy.log" | tail -20
            exit 4
        fi
        stop_spinner
        for svc in webapp chat; do
            if grep -qE "Container [A-Za-z0-9_-]*${svc}-[0-9]+ +(Recreated|Created|Started)" "$BUILD_STATE_DIR/update.deploy.log"; then
                SERVICES_REDEPLOYED+=("$svc")
            fi
        done
        log_success "Containers up  ${DIM}${SERVICES_REDEPLOYED[*]:-no recreation needed}${NC}"
    fi

    if [ "${NEEDS_BUILD[llamacpp]}" = true ] || [ "${NEEDS_BUILD[sglang]}" = true ]; then
        running=$(docker ps --format '{{.Names}}' --filter "name=llamacpp-" --filter "name=sglang-" 2>/dev/null | tr '\n' ' ')
        if [ -n "$running" ]; then
            log_warning "Running model instances still use the previous image: $running"
            echo -e "      ${DIM}Reload them from the Models tab (or re-run with --stop-instances) to pick up the rebuilt image.${NC}"
        fi
    fi
fi

# ============================================================================
# PHASE 6: TEST
# ============================================================================

TESTS_RUN=0
TESTS_FAILED=0
TESTS_WARNED=0
test_pass() { TESTS_RUN=$((TESTS_RUN + 1)); log_success "$1"; }
test_fail() { TESTS_RUN=$((TESTS_RUN + 1)); TESTS_FAILED=$((TESTS_FAILED + 1)); log_error "$1"; }
test_warn() { TESTS_RUN=$((TESTS_RUN + 1)); TESTS_WARNED=$((TESTS_WARNED + 1)); log_warning "$1"; }

# Wait until a container is Up and not restarting. Args: compose service, max seconds.
wait_container_stable() {
    local svc="$1" max="$2" i=0 cid state restarts
    while [ $i -lt "$max" ]; do
        cid=$(docker compose ps -q "$svc" 2>/dev/null | head -1)
        if [ -n "$cid" ]; then
            state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)
            restarts=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null)
            [ "$state" = "running" ] && [ "${restarts:-0}" -eq 0 ] && return 0
            [ "$state" = "exited" ] && return 1
        fi
        sleep 2; i=$((i + 2))
    done
    return 1
}

# Poll a URL until it answers with one of the accepted codes. Args: url, codes(regex), max seconds.
wait_http() {
    local url="$1" codes="$2" max="$3" i=0 code
    while [ $i -lt "$max" ]; do
        code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
        if echo "$code" | grep -qE "^($codes)$"; then echo "$code"; return 0; fi
        sleep 2; i=$((i + 2))
    done
    echo "$code"; return 1
}

if [ "$DO_TEST" = true ] && [ "$SERVICES_RUNNING" = false ]; then
    section "Tests"
    log_warning "App is not running — only the images were checked"
    for comp in "${COMPONENTS[@]}"; do
        [ "${CUR_HASH[$comp]}" = "missing" ] && continue
        if image_exists "${COMP_IMAGE[$comp]}"; then
            test_pass "image ${COMP_IMAGE[$comp]}  ${DIM}$(docker image inspect -f '{{.Id}}' "${COMP_IMAGE[$comp]}" | cut -c8-19)${NC}"
        else
            test_fail "image ${COMP_IMAGE[$comp]} missing"
        fi
    done
    echo -e "      ${DIM}Start the app (sudo ./start.sh) and re-run  sudo ./update.sh --no-pull  for the full checks.${NC}"
    DO_TEST=false
fi

if [ "$DO_TEST" = true ]; then
    section "Tests"

    # --- images -------------------------------------------------------------
    for comp in "${COMPONENTS[@]}"; do
        [ "${CUR_HASH[$comp]}" = "missing" ] && continue
        if image_exists "${COMP_IMAGE[$comp]}"; then
            test_pass "image ${COMP_IMAGE[$comp]}  ${DIM}$(docker image inspect -f '{{.Id}}' "${COMP_IMAGE[$comp]}" | cut -c8-19)${NC}"
        else
            test_fail "image ${COMP_IMAGE[$comp]} missing"
        fi
    done

    # --- containers ---------------------------------------------------------
    for svc in webapp chat; do
        start_spinner "Waiting for $svc container"
        if wait_container_stable "$svc" 90; then
            stop_spinner; test_pass "$svc container running (no restarts)"
        else
            stop_spinner; test_fail "$svc container not stable"
            docker compose logs --tail 30 "$svc" 2>/dev/null | sed 's/^/    /'
        fi
    done

    # --- HTTP probes --------------------------------------------------------
    # /api/auth/me answers 401 the moment Express is listening (auth-gated, no
    # session) — a boot that dies before listen never reaches it.
    start_spinner "Probing webapp API"
    if code=$(wait_http "https://localhost:3001/api/auth/me" "401|200" 120); then
        stop_spinner; test_pass "webapp API answering  ${DIM}HTTP $code${NC}"
    else
        stop_spinner; test_fail "webapp API not answering  ${DIM}last HTTP $code${NC}"
    fi
    if code=$(wait_http "https://localhost:3001/" "200" 30); then
        test_pass "webapp UI served  ${DIM}HTTP $code${NC}"
    else
        test_fail "webapp UI not served  ${DIM}last HTTP $code${NC}"
    fi
    if code=$(wait_http "https://localhost:3002/health" "200" 60); then
        test_pass "chat /health  ${DIM}HTTP $code${NC}"
    else
        test_fail "chat /health failed  ${DIM}last HTTP $code${NC}"
    fi
    if code=$(wait_http "https://localhost:3002/" "200" 30); then
        test_pass "chat UI served  ${DIM}HTTP $code${NC}"
    else
        test_fail "chat UI not served  ${DIM}last HTTP $code${NC}"
    fi

    # --- bundle freshness: the UI must reference a bundle that actually exists
    if body=$(curl -sk --max-time 10 https://localhost:3001/ 2>/dev/null); then
        bundle=$(echo "$body" | grep -oE 'dist/bundle\.[a-f0-9]+\.js' | head -1)
        if [ -n "$bundle" ]; then
            code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://localhost:3001/$bundle" 2>/dev/null || echo 000)
            if [ "$code" = "200" ]; then
                test_pass "webapp bundle reachable  ${DIM}$bundle${NC}"
            else
                test_fail "webapp bundle $bundle → HTTP $code"
            fi
        fi
    fi

    # --- container image == current tag --------------------------------------
    for comp in webapp chat; do
        if container_image_stale "$comp" "${COMP_IMAGE[$comp]}"; then
            test_fail "$comp container runs an older image than ${COMP_IMAGE[$comp]}"
        else
            test_pass "$comp container runs the current ${COMP_IMAGE[$comp]}"
        fi
    done

    # --- served assets == the files inside the container (no cache layer) ------
    # The browser gets whatever the container serves; prove that is the freshly
    # built bundle/stylesheet and that it is sent with no-cache headers.
    check_served_asset() {
        local svc="$1" base="$2" html_path="$3" asset_re="$4" cont_file="$5"
        local cid html ref served_sha cont_sha cc
        cid=$(docker compose ps -q "$svc" 2>/dev/null | head -1)
        html=$(curl -sk --max-time 10 "$base$html_path" 2>/dev/null) || html=""
        ref=$(echo "$html" | grep -oE "$asset_re" | head -1)
        if [ -z "$ref" ]; then
            test_fail "$svc: page does not reference $(basename "$cont_file")"
            return
        fi
        served_sha=$(curl -sk --max-time 20 "$base/${ref#/}" 2>/dev/null | sha256sum | cut -d' ' -f1)
        cont_sha=$(docker exec "$cid" sha256sum "$cont_file" 2>/dev/null | cut -d' ' -f1)
        if [ -n "$cont_sha" ] && [ "$served_sha" = "$cont_sha" ]; then
            cc=$(curl -skI --max-time 10 "$base/${ref#/}" 2>/dev/null | grep -i '^cache-control' | tr -d '\r' | sed 's/^[^:]*: *//')
            test_pass "$svc serves the container's $(basename "$cont_file")  ${DIM}${ref%%\?*} · cache-control: ${cc:-none}${NC}"
        else
            test_fail "$svc serves a $(basename "$cont_file") that differs from the container's file — a stale copy is being served"
        fi
    }
    check_served_asset chat   https://localhost:3002 / 'bundle\.js(\?v=[0-9]+)?'  /usr/src/app/public/bundle.js
    check_served_asset chat   https://localhost:3002 / 'styles\.css(\?v=[0-9]+)?' /usr/src/app/public/styles.css
    if [ -n "$bundle" ]; then
        check_served_asset webapp https://localhost:3001 / "$bundle" "/usr/src/app/public/$bundle"
    fi
    # The chat's committed public/ build output is what git ships; if it lags the
    # source, the image build regenerates it anyway — say so rather than fail.
    if [ -f "$PROJECT_DIR/chat/public/styles.css" ]; then
        cid=$(docker compose ps -q chat 2>/dev/null | head -1)
        if [ "$(sha256sum "$PROJECT_DIR/chat/public/styles.css" | cut -d' ' -f1)" != "$(docker exec "$cid" sha256sum /usr/src/app/public/styles.css 2>/dev/null | cut -d' ' -f1)" ]; then
            log_step "chat: committed public/styles.css differs from the image's fresh build  ${DIM}(expected when src changed; the image build wins)${NC}"
        fi
    fi

    # --- container code == checkout (the "files updated where needed" proof) --
    for comp in webapp chat; do
        diffs=$(container_code_diff "$comp" 2>/dev/null); rc=$?
        if [ "$rc" -eq 0 ]; then
            test_pass "$comp container runs the checkout's code  ${DIM}$(verify_file_list "$comp" | wc -l) files verified${NC}"
        elif [ "$rc" -eq 2 ]; then
            test_fail "$comp container not running — cannot verify code"
        else
            test_fail "$comp container code differs from the checkout:"
            echo "$diffs" | head -10 | sed 's/^/      /'
            echo -e "      ${DIM}Re-run with --force $comp to rebuild it.${NC}"
        fi
    done

    # --- inside the webapp: the services that must load at boot ----------------
    if docker compose exec -T webapp node -e "
        for (const m of ['./services/chatTools.js','./services/loopGuard.js','./services/automationEngine.js','./services/memoryService.js']) require(m);
        console.log('ok');
    " 2>/dev/null | grep -q '^ok$'; then
        test_pass "webapp core services load"
    else
        test_fail "webapp core services failed to require() — see: docker compose logs webapp"
    fi

    # --- log scan: fatal patterns in a freshly (re)started container -----------
    if [ "${#SERVICES_REDEPLOYED[@]}" -gt 0 ]; then
        fatal=$(docker compose logs --no-log-prefix --since 5m webapp 2>/dev/null \
            | grep -E "Cannot find module|SyntaxError|EADDRINUSE|ReferenceError|Unhandled|FATAL" | head -5 || true)
        if [ -z "$fatal" ]; then
            test_pass "webapp boot log clean"
        else
            test_fail "webapp boot log has errors:"
            echo "$fatal" | sed 's/^/      /'
        fi
    fi

    # --- rebuilt base images: sanity-run them --------------------------------
    if [ "${NEEDS_BUILD[sandbox-runtime]}" = true ]; then
        if docker run --rm --network none "${COMP_IMAGE[sandbox-runtime]}" \
            python3 -c "import PIL, openpyxl, dpkt; print('ok')" 2>/dev/null | grep -q '^ok$'; then
            test_pass "sandbox-runtime imports (Pillow, openpyxl, dpkt)"
        else
            test_fail "sandbox-runtime image cannot import its core libraries"
        fi
        if docker run --rm --network none "${COMP_IMAGE[sandbox-runtime]}" rg --version 2>/dev/null | grep -q ripgrep; then
            test_pass "sandbox-runtime ripgrep present"
        else
            test_warn "sandbox-runtime: ripgrep missing (grep_code falls back to python)"
        fi
    fi
    if [ "${NEEDS_BUILD[llamacpp]}" = true ]; then
        if docker run --rm --entrypoint llama-server "${COMP_IMAGE[llamacpp]}" --version > /dev/null 2>&1; then
            test_pass "llamacpp llama-server binary runs"
        else
            test_warn "llamacpp: llama-server --version failed (may need GPU libs at runtime)"
        fi
    fi
    if [ "${NEEDS_BUILD[sglang]}" = true ]; then
        if docker run --rm --entrypoint python3 "${COMP_IMAGE[sglang]}" -c "import sglang, distro; print('ok')" 2>/dev/null | grep -q '^ok$'; then
            test_pass "sglang imports (sglang, distro)"
        else
            test_warn "sglang: import check failed (see CLAUDE.md sglang landmines)"
        fi
    fi

    echo ""
    if [ "$TESTS_FAILED" -gt 0 ]; then
        log_error "$TESTS_FAILED of $TESTS_RUN checks failed"
    else
        log_success "$TESTS_RUN checks passed$([ "$TESTS_WARNED" -gt 0 ] && echo " ($TESTS_WARNED warning(s))")"
    fi
fi

# ============================================================================
# PHASE 7: CLEANUP
# ============================================================================

if [ "$DO_CLEANUP" = true ]; then
    section "Cleanup"

    before=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)

    # Old image layers left behind by the rebuild (untagged <none> images).
    # Never `-a`: model instances reference the base images only while running.
    n_dangling=$(docker images -f dangling=true -q 2>/dev/null | wc -l)
    if [ "$n_dangling" -gt 0 ]; then
        docker image prune -f > /dev/null 2>&1 || true
        log_success "Removed $n_dangling dangling image(s)"
    else
        log_skip "No dangling images"
    fi

    # Build cache: keep the recent layers (they make the next webapp rebuild
    # minutes instead of tens of minutes); drop entries older than 30 days.
    if [ "$DEEP_CLEAN" = true ]; then
        docker builder prune -af > /dev/null 2>&1 || true
        log_success "Build cache pruned (all)"
    else
        out=$(docker builder prune -f --filter "until=720h" 2>/dev/null | tail -1 || true)
        log_success "Build cache pruned (older than 30 days)  ${DIM}${out:-}${NC}"
    fi

    # Orphaned build-state files for components that no longer exist (e.g. n8n).
    removed=0
    for f in "$BUILD_STATE_DIR"/*; do
        [ -f "$f" ] || continue
        name=$(basename "$f")
        case "$name" in
            update.*) continue ;;
        esac
        base="${name%.*}"
        if [ -z "${COMP_DIR[$base]:-}" ]; then
            rm -f "$f"; removed=$((removed + 1))
        fi
    done
    if [ "$removed" -gt 0 ]; then
        log_success "Removed $removed stale build-state file(s)"
    else
        log_skip "No stale build-state files"
    fi

    # Python bytecode under the bind-mounted scripts dir (regenerated on demand).
    pyc=$(find "$PROJECT_DIR/scripts" -type d -name __pycache__ 2>/dev/null | wc -l)
    if [ "$pyc" -gt 0 ]; then
        find "$PROJECT_DIR/scripts" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
        log_success "Removed $pyc __pycache__ dir(s) under scripts/"
    fi

    after=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)
    [ -n "$before" ] && echo -e "  ${DIM}Docker reclaimable (images): $before → $after${NC}"
fi

# ============================================================================
# SUMMARY
# ============================================================================

section "Summary"
for comp in "${COMPONENTS[@]}"; do
    [ "${CUR_HASH[$comp]}" = "missing" ] && continue
    if [ "${NEEDS_BUILD[$comp]}" = true ]; then
        d="$BUILD_STATE_DIR/$comp.duration"
        echo -e "  ${SYM_OK}  ${comp}  ${DIM}rebuilt$([ -f "$d" ] && echo " in $(fmt_duration "$(cat "$d")")")${NC}"
    else
        echo -e "  ${SYM_SKIP}  ${comp}  ${DIM}unchanged${NC}"
    fi
done
echo ""
if [ -n "$OLD_HEAD" ]; then
    echo -e "  ${DIM}Code:        $(git rev-parse --short "$OLD_HEAD")$([ "$OLD_HEAD" != "$NEW_HEAD" ] && echo " → $(git rev-parse --short "$NEW_HEAD")")${NC}"
else
    echo -e "  ${DIM}Code:        $(git rev-parse --short HEAD) (new checkout)${NC}"
fi
echo -e "  ${DIM}Total time:  $(fmt_duration $(( $(date +%s) - TOTAL_START )))${NC}"
echo ""
if [ "$TESTS_FAILED" -gt 0 ]; then
    echo -e "  ${RED}Update finished with failing checks — see above.${NC}"
    echo -e "  ${DIM}Logs: docker compose logs -f webapp | chat${NC}"
    echo ""
    exit 5
fi
echo -e "  ${BOLD}https://localhost:3001${NC}  ${DIM}admin${NC}"
echo -e "  ${BOLD}https://localhost:3002${NC}  ${DIM}chat${NC}"
if [ "${#SERVICES_REDEPLOYED[@]}" -gt 0 ]; then
    echo -e "  ${DIM}Hard refresh your browser (Ctrl+Shift+R) to pick up the new bundle.${NC}"
fi
if ms_is_wsl && [ "$(ms_wsl_networking_mode)" != "mirrored" ]; then
    echo -e "  ${DIM}WSL (NAT): reachable from this machine only — run sudo ./wsl-expose.sh for LAN access.${NC}"
fi
echo ""
