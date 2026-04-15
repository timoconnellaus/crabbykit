/**
 * Shared constants for the sandbox container server.
 */

export const PORT = Number(process.env.PORT) || 8080;
export const DEFAULT_EXEC_TIMEOUT = 60_000;
export const MAX_BUFFER = 10_000;
export const PROCESS_GC_DELAY = 60_000;
export const IDLE_TIMEOUT_NORMAL = 10 * 60_000;
export const IDLE_TIMEOUT_DEV = 30 * 60_000;
export const IDLE_CHECK_INTERVAL = 60_000;
export const SYNC_DEBOUNCE_MS = 30_000;
export const SYNC_SOCKET = "/var/run/sync.sock";

// --- Session constants ---
export const LOG_DIR = "/tmp/sandbox-logs";
export const MAX_OUTPUT_CHARS = 204_800; // 200KB in-memory cap
export const SESSION_GC_DELAY = 5 * 60_000; // 5 minutes after exit
export const POLL_BACKOFF_SCHEDULE = [
  5000, 5000, 5000, 10_000, 10_000, 10_000, 30_000, 30_000, 30_000, 60_000,
];

export const SENSITIVE_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "ENCRYPTION_KEY",
];
