import type { AgentEvent, AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { CostEvent } from "../costs/types.js";
import type { PromptSectionSource } from "../prompt/types.js";
import type { Session } from "../session/types.js";
import type { ErrorCode } from "./error-codes.js";

// --- Server → Client messages ---

export interface AgentEventMessage {
  type: "agent_event";
  sessionId: string;
  event: AgentEvent;
}

export interface ToolEventMessage {
  type: "tool_event";
  sessionId: string;
  event: {
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
    toolCallId: string;
    toolName: string;
    args?: unknown;
    partialResult?: unknown;
    result?: unknown;
    isError?: boolean;
  };
}

export interface SessionSyncMessage {
  type: "session_sync";
  sessionId: string;
  session: Session;
  messages: AgentMessage[];
  streamMessage?: AgentMessage | null;
  /** Seq of the last entry in this page. Used as cursor for requesting more pages. */
  cursor?: number;
  /** Whether more entries exist beyond this page. */
  hasMore?: boolean;
  /**
   * Active {@link import("../modes/define-mode.js").Mode} id + display
   * name at sync time, or `undefined` when no mode is active. Clients
   * use this to initialize their mode badge on connection establish /
   * session switch.
   */
  activeMode?: { id: string; name: string };
}

/**
 * Server → client notification that the session's active
 * {@link import("../modes/define-mode.js").Mode} changed. Emitted
 * immediately after a `mode_change` session entry is appended and
 * after the metadata cache has been updated in the same transaction.
 *
 * Both `entered` and `exited` event kinds carry `modeId` and
 * `modeName` — exit events name the mode that just closed, not the
 * previous mode, matching the shape in design D10.
 */
export interface ModeEventMessage {
  type: "mode_event";
  sessionId: string;
  event:
    | { kind: "entered"; modeId: string; modeName: string }
    | { kind: "exited"; modeId: string; modeName: string };
}

export interface SessionListMessage {
  type: "session_list";
  sessions: Array<{
    id: string;
    name: string;
    source: string;
    updatedAt: string;
  }>;
}

export interface CostEventMessage {
  type: "cost_event";
  sessionId: string;
  event: CostEvent;
}

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface CommandResultMessage {
  type: "command_result";
  sessionId: string;
  name: string;
  result: { text?: string; data?: unknown };
  isError: boolean;
}

export interface CustomEventMessage {
  type: "custom_event";
  sessionId: string;
  event: {
    name: string;
    data: Record<string, unknown>;
  };
}

export interface InjectMessageMessage {
  type: "inject_message";
  sessionId: string;
  message: AgentMessage;
}

/**
 * Entry in a skill list broadcast (payload of `capability_state` for `capabilityId: "skills"`).
 * Kept as a public type for consumers that need to type the skills data.
 */
export interface SkillListEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  autoUpdate: boolean;
  stale: boolean;
  /** True for skills declared at build time — cannot be uninstalled. */
  builtIn?: boolean;
}

/**
 * Snapshot of the assembled system prompt delivered in response to a
 * `request_system_prompt` client message. Each section carries source
 * attribution (default / tools / capability / custom), an `included` flag,
 * and an optional `excludedReason` for sections that were declared but
 * conditionally omitted from the prompt the LLM actually receives.
 *
 * The `source`, `included`, and `excludedReason` fields are typed as
 * optional on the wire so new clients can forward-compat against older
 * servers: the client normalizer defaults missing fields.
 */
export interface SystemPromptMessage {
  type: "system_prompt";
  sections: Array<{
    name: string;
    key: string;
    content: string;
    lines: number;
    tokens?: number;
    source?: PromptSectionSource;
    included?: boolean;
    excludedReason?: string;
  }>;
  raw: string;
}

export interface PongMessage {
  type: "pong";
}

/**
 * Generic capability state envelope. All capability-specific state pushes
 * (schedules, skills, tasks, subagent events, MCP status, commands, queue)
 * are sent as `capability_state` messages with the appropriate `capabilityId`.
 * Capabilities broadcast via `context.broadcastState()`.
 * AgentDO broadcasts core-owned state via `this.broadcastCoreState()`.
 */
export interface CapabilityStateMessage {
  type: "capability_state";
  capabilityId: string;
  scope: "session" | "global";
  event: string;
  data: unknown;
  sessionId?: string;
}

/**
 * Broadcast by the bundle dispatch subsystem when a bundle is disabled
 * (manual `/bundle/disable`, transient-failure auto-revert, or catalog
 * mismatch at promotion / dispatch time). `data.rationale` is the
 * human-readable string existing consumers already read; `data.reason`
 * is the optional structured form. Defined codes:
 * - `"ERR_CAPABILITY_MISMATCH"` — bundle declared `requiredCapabilities`
 *   the host has not registered.
 * - `"ERR_HTTP_ROUTE_COLLISION"` — bundle declared a `surfaces.httpRoutes`
 *   entry that overlaps a host static handler (`bundle-http-and-ui-surface`).
 * - `"ERR_ACTION_ID_COLLISION"` — bundle declared a `surfaces.actionCapabilityIds`
 *   entry that overlaps a host-registered capability id.
 *
 * Future disable paths may introduce further codes without breaking
 * legacy consumers; pattern-match on `code` rather than `instanceof`.
 */
export interface BundleDisabledMessage {
  type: "bundle_disabled";
  sessionId: string;
  data: {
    rationale: string;
    versionId: string | null;
    sessionId?: string;
    reason?:
      | {
          code: "ERR_CAPABILITY_MISMATCH";
          missingIds: string[];
          versionId: string;
        }
      | {
          code: "ERR_HTTP_ROUTE_COLLISION";
          collisions: Array<{ method: string; path: string }>;
          versionId: string;
        }
      | {
          code: "ERR_ACTION_ID_COLLISION";
          collidingIds: string[];
          versionId: string;
        };
  };
}

export type ServerMessage =
  | AgentEventMessage
  | ToolEventMessage
  | SessionSyncMessage
  | SessionListMessage
  | CostEventMessage
  | ErrorMessage
  | CommandResultMessage
  | CustomEventMessage
  | InjectMessageMessage
  | SystemPromptMessage
  | CapabilityStateMessage
  | ModeEventMessage
  | PongMessage
  | BundleDisabledMessage;

// --- Client → Server messages ---

export interface PromptMessage {
  type: "prompt";
  sessionId: string;
  text: string;
}

export interface SteerMessage {
  type: "steer";
  sessionId: string;
  text: string;
}

export interface AbortMessage {
  type: "abort";
  sessionId: string;
}

export interface SwitchSessionMessage {
  type: "switch_session";
  sessionId: string;
}

export interface NewSessionMessage {
  type: "new_session";
  name?: string;
}

export interface DeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
}

export interface CommandMessage {
  type: "command";
  sessionId: string;
  /** Command name without leading slash. */
  name: string;
  /** Raw argument string (parsed server-side against command schema). */
  args?: string;
}

export interface RequestSyncMessage {
  type: "request_sync";
  sessionId: string;
  /** Fetch entries after this seq number. Omit for the first page. */
  afterSeq?: number;
}

export interface CustomResponseMessage {
  type: "custom_response";
  sessionId: string;
  requestId: string;
  data: Record<string, unknown>;
}

export interface RequestSystemPromptMessage {
  type: "request_system_prompt";
  sessionId: string;
}

export interface PingMessage {
  type: "ping";
}

/**
 * Generic capability action envelope. All capability-specific client actions
 * (schedule toggle, queue message/delete/steer, etc.) are sent as
 * `capability_action` messages. Routed to the matching capability's `onAction`
 * handler or AgentDO's core handler for well-known capability IDs.
 */
export interface CapabilityActionMessage {
  type: "capability_action";
  capabilityId: string;
  action: string;
  data: unknown;
  sessionId: string;
}

export type ClientMessage =
  | PromptMessage
  | SteerMessage
  | AbortMessage
  | SwitchSessionMessage
  | NewSessionMessage
  | DeleteSessionMessage
  | CommandMessage
  | RequestSyncMessage
  | CustomResponseMessage
  | RequestSystemPromptMessage
  | CapabilityActionMessage
  | PingMessage;
