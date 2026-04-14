import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { CostEvent } from "../costs/types.js";
import type { PromptSection } from "../prompt/types.js";
import type { AgentStatus, ConnectionStatus } from "./types.js";

/** AgentMessage with an optional streaming flag added during live updates. */
// biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
export type StreamableMessage = AgentMessage & { _streaming?: boolean };

/** Metadata for available slash commands, received from the server. */
export interface CommandInfo {
  name: string;
  description: string;
}

/** AgentMessage tagged as a command result for distinct UI rendering. */
// biome-ignore lint/style/useNamingConvention: _ prefix is a convention for internal transient state
export type CommandResultTag = { _commandResult: true; _commandName: string; _isError: boolean };

/** Per-tool-call execution state, tracked during live streaming. */
export type ToolState =
  | { status: "executing"; toolName: string }
  | { status: "streaming"; toolName: string; partialResult: unknown }
  | { status: "complete"; toolName: string; result: unknown; isError: boolean };

/** A queued message waiting to be processed after the current agent turn. */
export interface QueuedItem {
  id: string;
  text: string;
  createdAt: string;
}

export interface ChatState {
  messages: AgentMessage[];
  connectionStatus: ConnectionStatus;
  agentStatus: AgentStatus;
  sessions: Array<{ id: string; name: string; source: string; updatedAt: string }>;
  currentSessionId: string | null;
  thinking: string | null;
  completedThinking: string | null;
  toolStates: Map<string, ToolState>;
  costs: CostEvent[];
  systemPrompt: { sections: PromptSection[]; raw: string } | null;
  /** Generic capability state keyed by capability ID. Populated by capability_state sync events. */
  capabilityState: Record<string, unknown>;
  /**
   * Active session-level mode, or `null` when no mode is active.
   * Initialized from `session_sync.activeMode` on connection and
   * session switch; updated on `mode_event` messages.
   */
  activeMode: { id: string; name: string } | null;
  error: string | null;
}

export type ChatAction =
  | { type: "RESET" }
  | { type: "SET_MESSAGES"; messages: AgentMessage[] }
  | { type: "ADD_MESSAGE"; message: AgentMessage }
  | { type: "SET_CONNECTION_STATUS"; connectionStatus: ConnectionStatus }
  | { type: "SET_AGENT_STATUS"; agentStatus: AgentStatus }
  | { type: "SET_SESSIONS"; sessions: ChatState["sessions"] }
  | { type: "SET_CURRENT_SESSION_ID"; currentSessionId: string | null }
  | { type: "SET_THINKING"; thinking: string | null }
  | { type: "SET_TOOL_STATES"; toolStates: Map<string, ToolState> }
  | { type: "SET_COSTS"; costs: CostEvent[] }
  | { type: "ADD_COST"; cost: CostEvent }
  | { type: "SET_SYSTEM_PROMPT"; sections: PromptSection[]; raw: string }
  | { type: "SET_ERROR"; error: string | null }
  | {
      type: "SESSION_SYNC";
      messages: AgentMessage[];
      currentSessionId: string;
      agentStatus: AgentStatus;
      activeMode: { id: string; name: string } | null;
    }
  | { type: "AGENT_END" }
  | {
      type: "UPDATE_STREAMING_MESSAGE";
      updater: (prev: AgentMessage[]) => AgentMessage[];
      thinking?: { mode: "start" } | { mode: "delta"; delta: string } | { mode: "end" };
    }
  | {
      type: "TOOL_EXECUTION_START";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "TOOL_EXECUTION_UPDATE";
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "TOOL_EXECUTION_END";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      toolResultMessage: AgentMessage;
    }
  | { type: "SET_CAPABILITY_STATE"; capabilityId: string; data: unknown }
  | { type: "SET_ACTIVE_MODE"; activeMode: { id: string; name: string } | null }
  | { type: "ERROR_RECEIVED"; message: string };

export function createInitialState(sessionId: string | undefined): ChatState {
  return {
    messages: [],
    connectionStatus: "connecting",
    agentStatus: "idle",
    sessions: [],
    currentSessionId: sessionId ?? null,
    thinking: null,
    completedThinking: null,
    toolStates: new Map(),
    costs: [],
    systemPrompt: null,
    capabilityState: {},
    activeMode: null,
    error: null,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "RESET":
      return createInitialState(undefined);
    case "SET_MESSAGES":
      return { ...state, messages: action.messages };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "SET_CONNECTION_STATUS":
      return { ...state, connectionStatus: action.connectionStatus };
    case "SET_AGENT_STATUS":
      return { ...state, agentStatus: action.agentStatus };
    case "SET_SESSIONS":
      return { ...state, sessions: action.sessions };
    case "SET_CURRENT_SESSION_ID":
      return { ...state, currentSessionId: action.currentSessionId };
    case "SET_THINKING":
      return { ...state, thinking: action.thinking };
    case "SET_TOOL_STATES":
      return { ...state, toolStates: action.toolStates };
    case "SET_COSTS":
      return { ...state, costs: action.costs };
    case "ADD_COST":
      return { ...state, costs: [...state.costs, action.cost] };
    case "SET_SYSTEM_PROMPT":
      return {
        ...state,
        systemPrompt: { sections: action.sections, raw: action.raw },
      };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_CAPABILITY_STATE":
      return {
        ...state,
        capabilityState: {
          ...state.capabilityState,
          [action.capabilityId]: action.data,
        },
      };
    case "SESSION_SYNC":
      return {
        ...state,
        messages: action.messages,
        currentSessionId: action.currentSessionId,
        agentStatus: action.agentStatus,
        toolStates: new Map(),
        costs: [],
        thinking: null,
        completedThinking: null,
        capabilityState: {},
        activeMode: action.activeMode,
        error: null,
      };
    case "SET_ACTIVE_MODE":
      return { ...state, activeMode: action.activeMode };
    case "AGENT_END":
      return {
        ...state,
        agentStatus: "idle",
        thinking: null,
        toolStates: new Map(),
      };
    case "UPDATE_STREAMING_MESSAGE": {
      let { thinking, completedThinking } = state;
      let thinkingToAttach: string | null = null;
      if (action.thinking) {
        if (action.thinking.mode === "start") {
          thinking = "";
          completedThinking = null;
        } else if (action.thinking.mode === "delta") {
          thinking = (thinking ?? "") + action.thinking.delta;
        } else if (action.thinking.mode === "end") {
          // Capture thinking text to attach to the message, clear live indicator
          thinkingToAttach = thinking;
          completedThinking = thinking;
          thinking = null;
        }
      }
      let messages = action.updater(state.messages);
      // Attach completed thinking to the streaming assistant message
      if (thinkingToAttach && messages.length > 0) {
        const last = messages[messages.length - 1] as StreamableMessage;
        if ("role" in last && last.role === "assistant") {
          messages = [
            ...messages.slice(0, -1),
            // biome-ignore lint/style/useNamingConvention: _thinking is a convention for internal transient state
            { ...last, _thinking: thinkingToAttach } as AgentMessage,
          ];
        }
      }
      return {
        ...state,
        messages,
        thinking,
        completedThinking,
      };
    }
    case "TOOL_EXECUTION_START": {
      const next = new Map(state.toolStates);
      next.set(action.toolCallId, {
        status: "executing",
        toolName: action.toolName,
      });
      return {
        ...state,
        agentStatus: "executing_tools",
        toolStates: next,
      };
    }
    case "TOOL_EXECUTION_UPDATE": {
      const next = new Map(state.toolStates);
      next.set(action.toolCallId, {
        status: "streaming",
        toolName: action.toolName,
        partialResult: action.partialResult,
      });
      return { ...state, toolStates: next };
    }
    case "TOOL_EXECUTION_END": {
      const next = new Map(state.toolStates);
      next.set(action.toolCallId, {
        status: "complete",
        toolName: action.toolName,
        result: action.result,
        isError: action.isError,
      });
      return {
        ...state,
        toolStates: next,
        messages: [...state.messages, action.toolResultMessage],
      };
    }
    case "ERROR_RECEIVED":
      return {
        ...state,
        error: action.message,
        agentStatus: "idle",
      };
  }
}
