// ============================================================================
// A2A v1.0 Protocol Types
// Mirrors the canonical spec: https://github.com/a2aproject/A2A
// All JSON field names use camelCase per spec convention.
// ============================================================================

// --- Roles ---

export type Role = "user" | "agent";

// --- Parts (discriminated by field presence) ---

export interface TextPart {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64-encoded
    uri?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

// --- Type guards for Parts ---

export function isTextPart(part: Part): part is TextPart {
  return "text" in part;
}

export function isFilePart(part: Part): part is FilePart {
  return "file" in part;
}

export function isDataPart(part: Part): part is DataPart {
  return "data" in part && !("text" in part) && !("file" in part);
}

// --- Messages ---

export interface Message {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

// --- Task State Machine ---

export type TaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "input-required"
  | "auth-required"
  | "unknown";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set([
  "input-required",
  "auth-required",
]);

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isInterruptedState(state: TaskState): boolean {
  return INTERRUPTED_STATES.has(state);
}

// --- Task ---

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string; // ISO 8601 UTC
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

// --- SendMessage ---

export interface MessageSendConfiguration {
  acceptedOutputModes?: string[];
  blocking?: boolean;
  historyLength?: number;
  pushNotificationConfig?: PushNotificationConfig;
}

export interface MessageSendParams {
  message: Message;
  configuration?: MessageSendConfiguration;
}

// --- Streaming Events ---

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** Discriminated union — exactly one field is present. */
export type StreamEvent =
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent }
  | { message: Message }
  | { task: Task };

// --- Push Notifications ---

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
}

// --- Agent Card ---

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  capabilities: AgentCardCapabilities;
  provider?: {
    organization: string;
    url?: string;
  };
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Array<Record<string, string[]>>;
  skills?: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  documentationUrl?: string;
  iconUrl?: string;
}

export interface AgentCardCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface SecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// --- JSON-RPC 2.0 ---

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown[];
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function isJsonRpcError(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return "error" in response;
}

// --- GetTask / CancelTask params ---

export interface GetTaskParams {
  id: string;
  historyLength?: number;
}

export interface CancelTaskParams {
  id: string;
}

export interface ListTasksParams {
  contextId?: string;
  limit?: number;
  offset?: number;
}
