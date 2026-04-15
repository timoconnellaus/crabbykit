export interface Session {
  id: string;
  name: string;
  /** Where the session originated. `"websocket"` by default, or a channel id like `"telegram"`. */
  source: string;
  /**
   * Remote identity that routed this session, for channel-sourced sessions.
   * `null` for WebSocket-originated sessions. Paired with `source` for
   * `SessionStore.findBySourceAndSender` lookups.
   */
  sender: string | null;
  leafId: string | null;
  /**
   * Cached active mode ID for O(1) lookup on the hot `ensureAgent`
   * path. Updated atomically with `mode_change` entry appends. `null`
   * when no mode is active.
   */
  activeModeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionEntryType = "message" | "compaction" | "model_change" | "mode_change" | "custom";

/** Base fields shared across all session entry types. */
interface SessionEntryBase {
  id: string;
  parentId: string | null;
  sessionId: string;
  seq: number;
  createdAt: string;
}

/** A discriminated union of session entry types. Discriminant: `type`. */
export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | ModelChangeEntry
  | ModeChangeEntry
  | CustomEntry;

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  data: MessageEntryData;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  data: CompactionEntryData;
}

/**
 * Records a change in the active LLM **model** for a session (provider
 * + model ID). Distinct from {@link ModeChangeEntry} — the names differ
 * by a single letter (`model_change` vs `mode_change`), so be precise
 * when pattern-matching: `"model_change"` means "we switched the
 * underlying LLM", `"mode_change"` means "we entered or exited a
 * {@link import("../modes/define-mode.js").Mode}".
 */
export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  data: ModelChangeEntryData;
}

/**
 * Records a session-level mode transition (entering or exiting a
 * {@link import("../modes/define-mode.js").Mode}). Distinct from
 * {@link ModelChangeEntry} — names differ by one letter (`mode_change`
 * vs `model_change`). `{ enter: id }` means the session entered that
 * mode; `{ exit: id }` carries the mode ID being exited (never a
 * boolean sentinel) so mode history is self-describing without a
 * backward walk.
 */
export interface ModeChangeEntry extends SessionEntryBase {
  type: "mode_change";
  data: ModeChangeEntryData;
}

/**
 * Payload for a `mode_change` session entry. `enter` carries the mode
 * ID being entered; `exit` carries the mode ID being exited — NEVER a
 * boolean sentinel. Both halves of the union are present so post-hoc
 * reconstruction of mode history from the entry log does not need to
 * walk backward to find the preceding enter event.
 */
export type ModeChangeEntryData = { enter: string } | { exit: string };

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  data: CustomEntryData;
}

/** Metadata attached to a message entry. Extensible for future use. */
export interface MessageMetadata {
  /** When true, this message is hidden from the chat UI but still sent to the LLM. */
  hidden?: boolean;
}

export interface MessageEntryData {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  /** Structured metadata from tool execution (e.g. query params, result counts). */
  details?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  /** Optional metadata controlling display and behavior. */
  metadata?: MessageMetadata;
}

export interface CompactionEntryData {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface ModelChangeEntryData {
  provider: string;
  modelId: string;
}

export interface CustomEntryData {
  customType: string;
  payload: unknown;
}
