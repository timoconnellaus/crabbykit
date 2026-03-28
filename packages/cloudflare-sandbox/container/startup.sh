#!/bin/sh
# startup.sh — Container entrypoint for Cloudflare sandbox containers.
#
# 1. Sets up FUSE device and mounts R2 via tigrisfs
# 2. Starts the nm-guard daemon (bind-mounts local disk over node_modules)
# 3. Scrubs credentials from the environment
# 4. Drops to unprivileged user
# 5. Starts the sandbox HTTP server

set -e

MOUNT_POINT="/mnt/r2"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# --- 1. FUSE setup ---

# Create FUSE device if not present
if [ ! -e /dev/fuse ]; then
  mknod /dev/fuse c 10 229
  chmod 666 /dev/fuse
fi

# Allow non-root processes to access FUSE mounts
if ! grep -q "user_allow_other" /etc/fuse.conf 2>/dev/null; then
  echo "user_allow_other" >> /etc/fuse.conf
fi

mkdir -p "$MOUNT_POINT"

# Debug: log which R2 vars are set (values redacted)
echo "[startup] AGENT_ID=${AGENT_ID:-<unset>}"
echo "[startup] R2_BUCKET_NAME=${R2_BUCKET_NAME:-<unset>}"
echo "[startup] R2_ACCOUNT_ID=${R2_ACCOUNT_ID:+set}${R2_ACCOUNT_ID:-<unset>}"
echo "[startup] AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:+set}${AWS_ACCESS_KEY_ID:-<unset>}"
echo "[startup] AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:+set}${AWS_SECRET_ACCESS_KEY:-<unset>}"

# Skip FUSE mount if R2 credentials are missing
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$R2_BUCKET_NAME" ] || [ -z "$R2_ACCOUNT_ID" ]; then
  echo "[startup] WARNING: R2 credentials not set — skipping FUSE mount. /mnt/r2 will be a regular directory."
else
# Mount R2 bucket scoped to this agent's prefix
echo "[startup] Mounting R2 at $MOUNT_POINT (agent: ${AGENT_ID})"
/usr/local/bin/tigrisfs \
  --endpoint "$R2_ENDPOINT" \
  --uid "$(id -u gia)" --gid "$(id -g gia)" \
  -o allow_other \
  -f "${R2_BUCKET_NAME}:${AGENT_ID}" "$MOUNT_POINT" &

# Wait for mount to be ready (up to 3 seconds)
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
fi  # end of R2 credentials check

# --- 2. Start nm-guard daemon (as root, before privilege drop) ---

/app/nm-guard.sh &

# --- 3. Scrub credentials ---
# tigrisfs and nm-guard already have what they need in their process memory.
# The sandbox server and user processes must not have access to R2 credentials.

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET_NAME

# --- 4. Drop to unprivileged user and start server ---

echo "[startup] Dropping to user 'gia' and starting sandbox server"
exec gosu gia node --experimental-strip-types /app/server.ts
