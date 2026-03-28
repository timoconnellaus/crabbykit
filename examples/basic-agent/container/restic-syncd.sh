#!/bin/bash
# restic-syncd — Root-owned sync daemon for restic backup/restore operations.
# Communicates with the sandbox server via a Unix socket at /var/run/sync.sock.
# Holds R2 credentials and RESTIC_PASSWORD in its own process memory;
# these are scrubbed from the environment before the sandbox server starts.

set -uo pipefail

SOCKET_PATH="/var/run/sync.sock"
PERSIST_PATH="/opt/gia/persist"
STATE_FILE="/var/run/syncd-state"
HANDLER_SCRIPT="/var/run/restic-handler.sh"

# Restic S3 repository path (set via env vars from startup.sh)
export RESTIC_REPOSITORY="s3:https://${SYNCD_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${SYNCD_R2_BUCKET_NAME}/${SYNCD_AGENT_ID}/persist-repo"
export RESTIC_PASSWORD="${SYNCD_ENCRYPTION_KEY:-default-persist-key}"
export AWS_ACCESS_KEY_ID="${SYNCD_AWS_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${SYNCD_AWS_SECRET_ACCESS_KEY}"

# Initialize state file
cat > "$STATE_FILE" <<'INITEOF'
INITIALIZED=false
LAST_BACKUP=
SNAPSHOT_COUNT=0
IN_PROGRESS=
INITEOF

cleanup() {
  rm -f "$SOCKET_PATH" "$STATE_FILE" "$HANDLER_SCRIPT"
}
trap cleanup EXIT

# Remove stale socket
rm -f "$SOCKET_PATH"

# Check if repo is already initialized
if restic snapshots --json >/dev/null 2>&1; then
  count=$(restic snapshots --json 2>/dev/null | jq 'length' 2>/dev/null || echo 0)
  cat > "$STATE_FILE" <<EOF
INITIALIZED=true
LAST_BACKUP=
SNAPSHOT_COUNT=$count
IN_PROGRESS=
EOF
  # Clear stale locks from previous crashes
  restic unlock 2>/dev/null || true
fi

# Write the request handler script (runs per-connection with stdin/stdout on socket)
cat > "$HANDLER_SCRIPT" <<'HANDLER'
#!/bin/bash
STATE_FILE="/var/run/syncd-state"
PERSIST_PATH="/opt/gia/persist"

load_state() { source "$STATE_FILE"; }
save_state() {
  cat > "$STATE_FILE" <<EOF
INITIALIZED=$INITIALIZED
LAST_BACKUP=$LAST_BACKUP
SNAPSHOT_COUNT=$SNAPSHOT_COUNT
IN_PROGRESS=$IN_PROGRESS
EOF
}

# Read request line
read -r request_line
method=$(echo "$request_line" | awk '{print $1}')
path=$(echo "$request_line" | awk '{print $2}')

# Consume headers
while IFS= read -r header; do
  header=$(echo "$header" | tr -d '\r')
  [ -z "$header" ] && break
done

load_state

response_status="200 OK"
response_body='{"error":"unknown"}'

case "$method $path" in
  "POST /init")
    if [ "$INITIALIZED" = "true" ]; then
      response_body='{"status":"already_initialized"}'
    else
      IN_PROGRESS="init"
      save_state
      mkdir -p "$PERSIST_PATH"
      if restic init 2>/dev/null; then
        INITIALIZED="true"
        IN_PROGRESS=""
        save_state
        response_body='{"status":"initialized"}'
      else
        IN_PROGRESS=""
        save_state
        response_status="500 Internal Server Error"
        response_body='{"error":"restic init failed"}'
      fi
    fi
    ;;

  "POST /backup")
    if [ "$INITIALIZED" != "true" ]; then
      response_status="400 Bad Request"
      response_body='{"error":"repository not initialized"}'
    elif [ -n "$IN_PROGRESS" ]; then
      response_status="409 Conflict"
      response_body='{"error":"operation in progress","operation":"'"$IN_PROGRESS"'"}'
    else
      IN_PROGRESS="backup"
      save_state
      if restic backup "$PERSIST_PATH" --quiet 2>/dev/null; then
        LAST_BACKUP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        SNAPSHOT_COUNT=$(restic snapshots --json 2>/dev/null | jq 'length' 2>/dev/null || echo "$SNAPSHOT_COUNT")
        IN_PROGRESS=""
        save_state
        response_body='{"status":"complete","lastBackup":"'"$LAST_BACKUP"'","snapshotCount":'"$SNAPSHOT_COUNT"'}'
      else
        IN_PROGRESS=""
        save_state
        response_status="500 Internal Server Error"
        response_body='{"error":"restic backup failed"}'
      fi
    fi
    ;;

  "POST /restore")
    if [ "$INITIALIZED" != "true" ]; then
      response_status="400 Bad Request"
      response_body='{"error":"repository not initialized"}'
    elif [ -n "$IN_PROGRESS" ]; then
      response_status="409 Conflict"
      response_body='{"error":"operation in progress","operation":"'"$IN_PROGRESS"'"}'
    else
      IN_PROGRESS="restore"
      save_state
      if restic restore latest --target / --quiet 2>/dev/null; then
        # Fix ownership and permissions — restic restores as root
        chown -R gia:gia "$PERSIST_PATH" 2>/dev/null || true
        # Restore execute bits on bin directories and CLI entry points
        find "$PERSIST_PATH" -name "bin" -type d -exec chmod -R +x {} \; 2>/dev/null || true
        find "$PERSIST_PATH" -name "*.js" -path "*/bin/*" -exec chmod +x {} \; 2>/dev/null || true
        find "$PERSIST_PATH" -name "cli.js" -exec chmod +x {} \; 2>/dev/null || true
        IN_PROGRESS=""
        save_state
        response_body='{"status":"restored"}'
      else
        IN_PROGRESS=""
        save_state
        response_status="500 Internal Server Error"
        response_body='{"error":"restic restore failed"}'
      fi
    fi
    ;;

  "POST /prune")
    if [ "$INITIALIZED" != "true" ]; then
      response_status="400 Bad Request"
      response_body='{"error":"repository not initialized"}'
    elif [ -n "$IN_PROGRESS" ]; then
      response_status="409 Conflict"
      response_body='{"error":"operation in progress","operation":"'"$IN_PROGRESS"'"}'
    else
      IN_PROGRESS="prune"
      save_state
      if restic forget --keep-last 5 --prune --quiet 2>/dev/null; then
        SNAPSHOT_COUNT=$(restic snapshots --json 2>/dev/null | jq 'length' 2>/dev/null || echo "$SNAPSHOT_COUNT")
        IN_PROGRESS=""
        save_state
        response_body='{"status":"pruned","snapshotCount":'"$SNAPSHOT_COUNT"'}'
      else
        IN_PROGRESS=""
        save_state
        response_status="500 Internal Server Error"
        response_body='{"error":"restic prune failed"}'
      fi
    fi
    ;;

  "POST /unlock")
    restic unlock 2>/dev/null || true
    IN_PROGRESS=""
    save_state
    response_body='{"status":"unlocked"}'
    ;;

  "GET /status")
    response_body='{"initialized":'"$INITIALIZED"',"lastBackup":"'"$LAST_BACKUP"'","snapshotCount":'"$SNAPSHOT_COUNT"',"inProgress":"'"$IN_PROGRESS"'"}'
    ;;

  *)
    response_status="404 Not Found"
    response_body='{"error":"not found"}'
    ;;
esac

content_length=${#response_body}
printf "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" \
  "$response_status" "$content_length" "$response_body"
HANDLER

chmod +x "$HANDLER_SCRIPT"

echo "[restic-syncd] Starting on $SOCKET_PATH"

mkdir -p "$(dirname "$SOCKET_PATH")"

# Listen for connections — fork handles each, flock serializes restic operations
socat UNIX-LISTEN:"$SOCKET_PATH",mode=0660,user=root,group=gia,fork SYSTEM:"flock /var/run/syncd.lock bash $HANDLER_SCRIPT" 2>/dev/null
