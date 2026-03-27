export interface Session {
  id: string;
  name: string;
  source: string;
  leafId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionEntryType = "message" | "compaction" | "model_change" | "custom";

export interface SessionEntry {
  id: string;
  parentId: string | null;
  sessionId: string;
  seq: number;
  type: SessionEntryType;
  data: MessageEntryData | CompactionEntryData | ModelChangeEntryData | CustomEntryData;
  createdAt: string;
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
