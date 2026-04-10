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
  createdAt: string;
  updatedAt: string;
}

export type SessionEntryType = "message" | "compaction" | "model_change" | "custom";

/** Base fields shared across all session entry types. */
interface SessionEntryBase {
  id: string;
  parentId: string | null;
  sessionId: string;
  seq: number;
  createdAt: string;
}

/** A discriminated union of session entry types. Discriminant: `type`. */
export type SessionEntry = MessageEntry | CompactionEntry | ModelChangeEntry | CustomEntry;

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  data: MessageEntryData;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  data: CompactionEntryData;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  data: ModelChangeEntryData;
}

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
