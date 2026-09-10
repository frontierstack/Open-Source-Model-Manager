#!/bin/bash
# Shared "what goes into this image" checksum, used by build.sh and update.sh
# so both agree on whether an image is current.
#
#   ms_build_inputs_hash <project_dir> <component_dir>
#
# Hashes every file Docker would COPY into the image: tracked + untracked-but-
# not-ignored files under the build context (git), minus the patterns in that
# context's .dockerignore. Outside a git checkout it falls back to a plain
# directory walk (node_modules / build output skipped). File modes are included
# where the filesystem has real POSIX modes (chmod +x on an entrypoint changes
# the image); on 9p/drvfs/NTFS-style mounts (WSL /mnt/c) they are ignored.
#
# Why not build.sh's old Dockerfile/*.sh/*.py-only md5: a webapp/server.js or
# chat/src change never registered there, so ./build.sh reported "up to date"
# and the chat image in particular was never rebuilt after first start.

ms_fs_has_modes() {
    local t
    t=$(stat -f -c %T "$1" 2>/dev/null || echo unknown)
    case "$t" in
        9p|v9fs|fuseblk|fuse|vfat|msdos|ntfs|cifs|smb2|drvfs|exfat) return 1 ;;
    esac
    return 0
}

ms_build_inputs_hash() {
    local project_dir="$1" dir="$2"
    [ -d "$project_dir/$dir" ] || { echo "missing"; return; }

    local -a ignore_globs=()
    if [ -f "$project_dir/$dir/.dockerignore" ]; then
        local line
        while IFS= read -r line; do
            line="${line%%#*}"; line="${line// /}"; line="${line%$'\r'}"
            [ -z "$line" ] && continue
            ignore_globs+=("$line")
        done < "$project_dir/$dir/.dockerignore"
    fi

    local with_modes=true
    ms_fs_has_modes "$project_dir" || with_modes=false

    (
        cd "$project_dir" || exit 1
        if git -c core.filemode=false rev-parse --is-inside-work-tree > /dev/null 2>&1; then
            git -c core.filemode=false ls-files -z --cached --others --exclude-standard -- "$dir" 2>/dev/null
        else
            find "$dir" -type f \
                -not -path '*/node_modules/*' -not -path '*/public/dist/*' \
                -not -path '*/__pycache__/*' -not -name '*.log' -print0 2>/dev/null
        fi \
        | while IFS= read -r -d '' f; do
            [ -f "$f" ] || continue
            local rel="${f#$dir/}" skip=false g
            for g in "${ignore_globs[@]}"; do
                case "$rel" in
                    $g|$g/*|*/$g|*/$g/*) skip=true; break ;;
                esac
                case "$(basename "$rel")" in
                    $g) skip=true; break ;;
                esac
            done
            [ "$skip" = true ] && continue
            printf '%s\0' "$f"
        done \
        | sort -z \
        | while IFS= read -r -d '' f; do
            if [ "$with_modes" = true ]; then
                printf '%s %s ' "$f" "$(stat -c '%a' "$f")"
            else
                printf '%s - ' "$f"
            fi
            sha256sum "$f" | cut -d' ' -f1
        done \
        | sha256sum | cut -d' ' -f1
    )
}
