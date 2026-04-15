#!/bin/sh
# nm-guard.sh — Background daemon that bind-mounts local disk over node_modules
# directories found on the FUSE-mounted R2 workspace.
#
# Runs as root (required for mount --bind). Started in startup.sh before
# dropping to unprivileged user.
#
# Why: FUSE (tigrisfs) cannot preserve POSIX execute bits. node_modules/.bin/
# shims need execute permissions. Bind-mounting local disk provides full POSIX
# semantics without consuming RAM (unlike tmpfs).

set -e

MOUNT_POINT="${MOUNT_POINT:-/workspace}"
NM_BASE="/opt/sandbox/nm"
POLL_INTERVAL="0.5"
SANDBOX_PORT="${SANDBOX_PORT:-8080}"

mkdir -p "$NM_BASE"

log() {
  echo "[nm-guard] $1"
}

# Generate a deterministic hash from a path for the local backing directory
path_hash() {
  echo -n "$1" | md5sum | cut -d' ' -f1
}

guard_loop() {
  while true; do
    # Find node_modules directories up to 4 levels deep under the FUSE mount
    find "$MOUNT_POINT" -maxdepth 4 -name node_modules -type d 2>/dev/null | while read -r nm_path; do
      # Skip if already bind-mounted (check /proc/mounts directly —
      # mountpoint -q is unreliable on some overlayfs/Docker Desktop setups)
      if grep -q " $nm_path " /proc/mounts 2>/dev/null; then
        continue
      fi

      # Compute relative path for cleanup and deterministic hash
      rel_path="${nm_path#$MOUNT_POINT/}"
      hash=$(path_hash "$rel_path")
      local_dir="$NM_BASE/$hash"

      log "Detected $rel_path — mounting local disk"

      # Create local backing directory and bind mount
      mkdir -p "$local_dir"
      mount --bind "$local_dir" "$nm_path"

      # Fix ownership so unprivileged user can write
      chown -R sandbox:sandbox "$local_dir" 2>/dev/null || true

      # Notify sandbox server for R2 cleanup
      curl -s "http://localhost:$SANDBOX_PORT/internal/cleanup-r2" \
        -H "Content-Type: application/json" \
        -d "{\"prefix\":\"$rel_path\"}" >/dev/null 2>&1 || true

      log "Mounted $rel_path -> $local_dir"
    done

    sleep "$POLL_INTERVAL"
  done
}

log "Starting node_modules guard daemon"
log "Watching: $MOUNT_POINT (max depth 4)"
guard_loop
