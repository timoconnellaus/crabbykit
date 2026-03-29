import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CostEvent } from "../costs/types.js";
import type { ClientMessage, ServerMessage } from "../transport/types.js";
import type { AgentStatus, ConnectionStatus } from "./types.js";

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const RECONNECT_BACKOFF_BASE = 2;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

/** AgentMessage with an optional streaming flag added during live updates. */
// biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
type StreamableMessage = AgentMessage & { _streaming?: boolean };

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
  | { status: "complete"; toolName: string; result: unknown; isError: boolean };

export interface UseAgentChatConfig {
  /** WebSocket URL to the agent DO */
  url: string;
  /** Initial session ID (optional) */
  sessionId?: string;
  /** Auth token getter (optional) */
  getToken?: () => Promise<string> | string;
  /** Auto-reconnect (default true) */
  autoReconnect?: boolean;
  /** Max reconnect delay in ms (default 30000) */
  maxReconnectDelay?: number;
  /** Called when a custom event is received from a capability. */
  onCustomEvent?: (name: string, data: Record<string, unknown>) => void;
}

export interface UseAgentChatReturn {
  messages: AgentMessage[];
  connectionStatus: ConnectionStatus;
  agentStatus: AgentStatus;
  sessions: Array<{ id: string; name: string; source: string; updatedAt: string }>;
  currentSessionId: string | null;
  thinking: string | null;
  /** Completed thinking text from the most recent thinking block. Remains set after agent finishes. */
  completedThinking: string | null;
  /** Per-tool-call execution state, keyed by toolCallId. Only populated during live streaming. */
  toolStates: Map<string, ToolState>;
  /** Accumulated cost events for the current session. */
  costs: CostEvent[];
  /** Active schedules. Updated when schedules change. */
  schedules: Array<{
    id: string;
    name: string;
    cron: string;
    enabled: boolean;
    status: string;
    nextFireAt: string | null;
    expiresAt: string | null;
    lastFiredAt: string | null;
  }>;
  /** Available slash commands registered on the server. */
  availableCommands: CommandInfo[];
  /** Last error received from the server. Cleared on next prompt. */
  error: string | null;
  sendMessage: (text: string) => void;
  /** Send a slash command programmatically without formatting a string. */
  sendCommand: (name: string, args?: string) => void;
  abort: () => void;
  switchSession: (sessionId: string) => void;
  createSession: (name?: string) => void;
  deleteSession: (sessionId: string) => void;
  /** Enable or disable a schedule by ID. */
  toggleSchedule: (scheduleId: string, enabled: boolean) => void;
}

// ---------------------------------------------------------------------------
// Reducer state & actions
// ---------------------------------------------------------------------------

interface ChatState {
  messages: AgentMessage[];
  connectionStatus: ConnectionStatus;
  agentStatus: AgentStatus;
  sessions: UseAgentChatReturn["sessions"];
  currentSessionId: string | null;
  thinking: string | null;
  completedThinking: string | null;
  toolStates: Map<string, ToolState>;
  costs: CostEvent[];
  schedules: UseAgentChatReturn["schedules"];
  availableCommands: CommandInfo[];
  error: string | null;
}

type ChatAction =
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
  | { type: "SET_SCHEDULES"; schedules: ChatState["schedules"] }
  | { type: "SET_AVAILABLE_COMMANDS"; availableCommands: CommandInfo[] }
  | { type: "SET_ERROR"; error: string | null }
  | {
      type: "SESSION_SYNC";
      messages: AgentMessage[];
      currentSessionId: string;
      agentStatus: AgentStatus;
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
      type: "TOOL_EXECUTION_END";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      toolResultMessage: AgentMessage;
    }
  | { type: "ERROR_RECEIVED"; message: string };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
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
    case "SET_SCHEDULES":
      return { ...state, schedules: action.schedules };
    case "SET_AVAILABLE_COMMANDS":
      return { ...state, availableCommands: action.availableCommands };
    case "SET_ERROR":
      return { ...state, error: action.error };
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
        error: null,
      };
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
          messages = [...messages.slice(0, -1), { ...last, _thinking: thinkingToAttach } as AgentMessage];
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function createInitialState(sessionId: string | undefined): ChatState {
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
    schedules: [],
    availableCommands: [],
    error: null,
  };
}

export function useAgentChat(config: UseAgentChatConfig): UseAgentChatReturn {
  const [state, dispatch] = useReducer(chatReducer, config.sessionId, createInitialState);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamMessageRef = useRef<AgentMessage | null>(null);
  /** Tracks the current sessionId for use inside the handleMessage callback (which has [] deps). */
  const currentSessionIdRef = useRef<string | null>(config.sessionId ?? null);
  /** Set to true by effect cleanup to suppress reconnect from stale onclose handlers. */
  const disposedRef = useRef(false);
  const onCustomEventRef = useRef(config.onCustomEvent);
  onCustomEventRef.current = config.onCustomEvent;
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPongAtRef = useRef<number>(0);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    // Ignore events from stale WebSocket connections (StrictMode double-mount, HMR, reconnection overlap)
    if (event.target !== wsRef.current) return;

    const msg: ServerMessage = JSON.parse(event.data);

    switch (msg.type) {
      case "session_sync": {
        // Include in-flight streaming message in the array so subsequent
        // message_update/message_end events find a _streaming placeholder to replace.
        const syncMessages = msg.streamMessage
          ? [
              ...msg.messages,
              {
                ...msg.streamMessage,
                // biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
                _streaming: true,
              } as StreamableMessage,
            ]
          : msg.messages;
        dispatch({
          type: "SESSION_SYNC",
          messages: syncMessages,
          currentSessionId: msg.sessionId,
          agentStatus: msg.streamMessage ? "streaming" : "idle",
        });
        currentSessionIdRef.current = msg.sessionId;
        streamMessageRef.current = msg.streamMessage ?? null;

        // Auto-fetch next page if more entries exist
        if (msg.hasMore && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "request_sync",
              sessionId: msg.sessionId,
              afterSeq: msg.cursor,
            }),
          );
        }
        break;
      }

      case "session_list":
        dispatch({ type: "SET_SESSIONS", sessions: msg.sessions });
        break;

      case "agent_event": {
        // Discard events for a session we're no longer watching (late arrivals after switch)
        if (msg.sessionId !== currentSessionIdRef.current) break;
        const agentEvent = msg.event;

        if (agentEvent.type === "message_start") {
          const msg = agentEvent.message;
          const isAssistant = msg && "role" in msg && msg.role === "assistant";
          if (isAssistant) {
            dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
            streamMessageRef.current = msg;
            // Add streaming placeholder immediately (handles non-streaming models)
            dispatch({
              type: "ADD_MESSAGE",
              message: {
                ...msg,
                // biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
                _streaming: true,
              } as StreamableMessage,
            });
          }
        }

        if (agentEvent.type === "message_update") {
          streamMessageRef.current = agentEvent.message;

          // Determine thinking state change if any
          const aEvent = agentEvent.assistantMessageEvent;
          let thinking:
            | { mode: "start" }
            | { mode: "delta"; delta: string }
            | { mode: "end" }
            | undefined;
          if (aEvent) {
            if (aEvent.type === "thinking_start") {
              thinking = { mode: "start" };
            } else if (aEvent.type === "thinking_delta") {
              thinking = { mode: "delta", delta: aEvent.delta };
            } else if (aEvent.type === "thinking_end") {
              thinking = { mode: "end" };
            }
          }

          // Replace the streaming message with updated content
          dispatch({
            type: "UPDATE_STREAMING_MESSAGE",
            updater: (prev) => {
              const next = [...prev];
              if (next.length > 0 && streamMessageRef.current) {
                const last = next[next.length - 1] as StreamableMessage;
                if ("role" in last && last.role === "assistant" && last._streaming) {
                  next[next.length - 1] = {
                    ...streamMessageRef.current,
                    // biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
                    _streaming: true,
                  } as StreamableMessage;
                }
              }
              return next;
            },
            thinking,
          });
        }

        if (agentEvent.type === "message_end") {
          const finalMessage = agentEvent.message;
          const isAssistant =
            finalMessage && "role" in finalMessage && finalMessage.role === "assistant";
          if (!isAssistant) break;

          streamMessageRef.current = null;
          // Finalize: replace the _streaming placeholder with the completed message.
          // If no placeholder exists, this is a no-op — safer than blindly pushing a
          // potential duplicate. agent-core guarantees message_start before message_end.
          dispatch({
            type: "UPDATE_STREAMING_MESSAGE",
            updater: (prev) => {
              const next = [...prev];
              if (next.length > 0) {
                const last = next[next.length - 1] as StreamableMessage;
                if (last._streaming) {
                  next[next.length - 1] = finalMessage as AgentMessage;
                }
              }
              return next;
            },
          });
        }

        if (agentEvent.type === "agent_end") {
          dispatch({ type: "AGENT_END" });
        }

        break;
      }

      case "tool_event": {
        if (msg.sessionId !== currentSessionIdRef.current) break;
        const toolEvent = msg.event;
        if (toolEvent.type === "tool_execution_start") {
          dispatch({
            type: "TOOL_EXECUTION_START",
            toolCallId: toolEvent.toolCallId,
            toolName: toolEvent.toolName,
          });
        }
        if (toolEvent.type === "tool_execution_end") {
          // Persist tool result in messages array so it survives toolStates clearing on agent_end
          const toolResult = toolEvent.result as Record<string, unknown> | undefined;
          dispatch({
            type: "TOOL_EXECUTION_END",
            toolCallId: toolEvent.toolCallId,
            toolName: toolEvent.toolName,
            result: toolEvent.result,
            isError: toolEvent.isError ?? false,
            toolResultMessage: {
              role: "toolResult",
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              content: toolResult?.content ?? toolEvent.result,
              details: toolResult?.details ?? null,
              isError: toolEvent.isError ?? false,
              timestamp: Date.now(),
            } as unknown as AgentMessage,
          });
        }
        break;
      }

      case "cost_event":
        if (msg.sessionId !== currentSessionIdRef.current) break;
        dispatch({ type: "ADD_COST", cost: msg.event });
        break;

      case "schedule_list":
        dispatch({ type: "SET_SCHEDULES", schedules: msg.schedules });
        break;

      case "command_list":
        dispatch({ type: "SET_AVAILABLE_COMMANDS", availableCommands: msg.commands });
        break;

      case "command_result": {
        if (msg.sessionId !== currentSessionIdRef.current) break;
        const resultText =
          msg.result.text ??
          (msg.result.data != null ? JSON.stringify(msg.result.data, null, 2) : "");
        // Command results are synthetic messages — they don't match the full AssistantMessage shape
        // but are displayed in the message list with distinct rendering via _commandResult tag
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            role: "assistant",
            content: resultText,
            timestamp: Date.now(),
            _commandResult: true,
            _commandName: msg.name,
            _isError: msg.isError,
          } as unknown as AgentMessage,
        });
        break;
      }

      case "custom_event":
        if (msg.sessionId !== currentSessionIdRef.current) break;
        onCustomEventRef.current?.(msg.event.name, msg.event.data);
        break;

      case "pong":
        lastPongAtRef.current = Date.now();
        if (pongTimeoutRef.current) {
          clearTimeout(pongTimeoutRef.current);
          pongTimeoutRef.current = null;
        }
        break;

      case "mcp_status":
        // Could expose this, keeping it simple for now
        break;

      case "error":
        console.error(`[agent-runtime] ${msg.code}: ${msg.message}`);
        dispatch({ type: "ERROR_RECEIVED", message: msg.message });
        break;
    }
  }, []);

  const connect = useCallback(async () => {
    dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "connecting" });

    let url = config.url;
    if (config.getToken) {
      const token = await config.getToken();
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}token=${encodeURIComponent(token)}`;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "connected" });
      // Restore active session after reconnect
      const activeSessionId = currentSessionIdRef.current;
      if (reconnectAttemptRef.current > 0 && activeSessionId) {
        ws.send(JSON.stringify({ type: "switch_session", sessionId: activeSessionId }));
      }
      reconnectAttemptRef.current = 0;

      // Start heartbeat ping interval
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
          // Set a timeout waiting for pong
          if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
          pongTimeoutRef.current = setTimeout(() => {
            // No pong received in time — force reconnect
            console.warn("[agent-runtime] Pong timeout — triggering reconnect");
            ws.close();
          }, PONG_TIMEOUT_MS);
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "disconnected" });
      wsRef.current = null;

      // Clean up heartbeat timers
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (pongTimeoutRef.current) {
        clearTimeout(pongTimeoutRef.current);
        pongTimeoutRef.current = null;
      }

      // Don't reconnect if the effect was cleaned up (HMR / unmount)
      if (disposedRef.current) return;

      if (config.autoReconnect !== false) {
        const delay = Math.min(
          1000 * RECONNECT_BACKOFF_BASE ** reconnectAttemptRef.current,
          config.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY,
        );
        reconnectAttemptRef.current++;
        dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "reconnecting" });
        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, [config.url, config.getToken, config.autoReconnect, config.maxReconnectDelay, handleMessage]);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (pongTimeoutRef.current) {
        clearTimeout(pongTimeoutRef.current);
        pongTimeoutRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!state.currentSessionId) return;
      dispatch({ type: "SET_ERROR", error: null });

      // Detect slash commands: "/name" or "/name args..."
      // Only intercept known commands to avoid false positives (e.g. "/path/to/file")
      const commandMatch = text.match(/^\/(\S+)(?:\s+(.*))?$/);
      if (commandMatch) {
        const [, name, args] = commandMatch;
        const isKnownCommand = state.availableCommands.some((cmd) => cmd.name === name);
        if (isKnownCommand) {
          send({
            type: "command",
            sessionId: state.currentSessionId,
            name,
            args: args?.trim(),
          } as ClientMessage);

          // Optimistically add user message and set agent as streaming
          dispatch({
            type: "ADD_MESSAGE",
            message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
          });
          dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
          return;
        }
      }

      const type = state.agentStatus === "idle" ? "prompt" : "steer";
      send({ type, sessionId: state.currentSessionId, text } as ClientMessage);

      // Optimistically add user message and set agent as streaming
      dispatch({
        type: "ADD_MESSAGE",
        message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      });
      dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
    },
    [state.currentSessionId, state.agentStatus, state.availableCommands, send],
  );

  const abort = useCallback(() => {
    if (state.currentSessionId) {
      send({ type: "abort", sessionId: state.currentSessionId });
    }
  }, [state.currentSessionId, send]);

  const switchSession = useCallback(
    (sessionId: string) => {
      send({ type: "switch_session", sessionId });
    },
    [send],
  );

  const createSession = useCallback(
    (name?: string) => {
      send({ type: "new_session", name });
    },
    [send],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      send({ type: "delete_session", sessionId });
    },
    [send],
  );

  const toggleSchedule = useCallback(
    (scheduleId: string, enabled: boolean) => {
      send({ type: "toggle_schedule", scheduleId, enabled } as ClientMessage);
    },
    [send],
  );

  const sendCommand = useCallback(
    (name: string, args?: string) => {
      if (!state.currentSessionId) return;
      dispatch({ type: "SET_ERROR", error: null });
      send({
        type: "command",
        sessionId: state.currentSessionId,
        name,
        args: args?.trim(),
      } as ClientMessage);

      // Optimistically add user message
      const text = args ? `/${name} ${args}` : `/${name}`;
      dispatch({
        type: "ADD_MESSAGE",
        message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      });
    },
    [state.currentSessionId, send],
  );

  return {
    messages: state.messages,
    connectionStatus: state.connectionStatus,
    agentStatus: state.agentStatus,
    sessions: state.sessions,
    currentSessionId: state.currentSessionId,
    thinking: state.thinking,
    completedThinking: state.completedThinking,
    toolStates: state.toolStates,
    costs: state.costs,
    schedules: state.schedules,
    availableCommands: state.availableCommands,
    error: state.error,
    sendMessage,
    sendCommand,
    abort,
    switchSession,
    createSession,
    deleteSession,
    toggleSchedule,
  };
}
