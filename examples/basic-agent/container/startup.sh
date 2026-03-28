#!/bin/sh
# startup.sh — Container entrypoint for Cloudflare sandbox containers.
#
# 1. Sets up FUSE device and mounts R2 via tigrisfs
# 2. Starts restic sync daemon (dev mode only — for package persistence)
# 3. Starts the nm-guard daemon (bind-mounts local disk over node_modules)
# 4. Scrubs credentials from the environment
# 5. Drops to unprivileged user
# 6. Starts the sandbox HTTP server

set -e

MOUNT_POINT="/mnt/r2"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
CONTAINER_MODE="${CONTAINER_MODE:-normal}"

# --- 1. FUSE setup ---

if [ ! -e /dev/fuse ]; then
  mknod /dev/fuse c 10 229
  chmod 666 /dev/fuse
fi

if ! grep -q "user_allow_other" /etc/fuse.conf 2>/dev/null; then
  echo "user_allow_other" >> /etc/fuse.conf
fi

mkdir -p "$MOUNT_POINT"

echo "[startup] Mode: $CONTAINER_MODE"
echo "[startup] AGENT_ID=${AGENT_ID:-<unset>}"
echo "[startup] R2_BUCKET_NAME=${R2_BUCKET_NAME:-<unset>}"
echo "[startup] R2_ACCOUNT_ID=${R2_ACCOUNT_ID:+set}"
echo "[startup] AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:+set}"

# Skip FUSE mount if R2 credentials are missing
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$R2_BUCKET_NAME" ] || [ -z "$R2_ACCOUNT_ID" ]; then
  echo "[startup] WARNING: R2 credentials not set — skipping FUSE mount."
else
  echo "[startup] Mounting R2 at $MOUNT_POINT (agent: ${AGENT_ID})"
  /usr/local/bin/tigrisfs \
    --endpoint "$R2_ENDPOINT" \
    --uid "$(id -u gia)" --gid "$(id -g gia)" \
    -o allow_other \
    -f "${R2_BUCKET_NAME}:${AGENT_ID}" "$MOUNT_POINT" &

  for i in 1 2 3 4 5 6; do
    if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
      echo "[startup] R2 mounted successfully"
      break
    fi
    sleep 0.5
  done

  if ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    echo "[startup] WARNING: FUSE mount not ready after 3s, continuing anyway"
  fi
fi

# --- 2. Dev mode: start restic sync daemon ---

if [ "$CONTAINER_MODE" = "dev" ] && [ -n "$AWS_ACCESS_KEY_ID" ]; then
  echo "[startup] Dev mode — starting restic sync daemon"

  # Pass credentials to syncd via prefixed env vars (scrubbed from main env later)
  export SYNCD_AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export SYNCD_AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  export SYNCD_R2_ACCOUNT_ID="$R2_ACCOUNT_ID"
  export SYNCD_R2_BUCKET_NAME="$R2_BUCKET_NAME"
  export SYNCD_AGENT_ID="${AGENT_ID:-default}"
  export SYNCD_ENCRYPTION_KEY="${ENCRYPTION_KEY:-default-persist-key}"

  /app/restic-syncd.sh &

  # Wait for sync daemon socket to be ready
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ -S /var/run/sync.sock ]; then
      echo "[startup] Restic sync daemon ready"
      break
    fi
    sleep 0.5
  done

  # Restore packages from last snapshot (if any)
  if [ -S /var/run/sync.sock ]; then
    # Only restore if persist dir is empty (avoid overwriting same-host data)
    if [ -z "$(ls -A /opt/gia/persist 2>/dev/null)" ]; then
      echo "[startup] Restoring packages from last snapshot..."
      curl -s --unix-socket /var/run/sync.sock http://localhost/restore -X POST || true
    else
      echo "[startup] Persist dir non-empty — skipping restore"
    fi
  fi

  # Clean up syncd env vars
  unset SYNCD_AWS_ACCESS_KEY_ID SYNCD_AWS_SECRET_ACCESS_KEY SYNCD_R2_ACCOUNT_ID SYNCD_R2_BUCKET_NAME SYNCD_AGENT_ID SYNCD_ENCRYPTION_KEY
fi

# --- 3. Start nm-guard daemon (as root, before privilege drop) ---

/app/nm-guard.sh &

# --- 4. Scrub credentials ---

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET_NAME ENCRYPTION_KEY

# --- 5. Drop to unprivileged user and start server ---

echo "[startup] Dropping to user 'gia' and starting sandbox server"
exec gosu gia node --experimental-strip-types /app/server.ts
