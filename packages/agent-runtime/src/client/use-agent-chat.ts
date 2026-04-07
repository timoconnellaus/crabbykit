import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ClientMessage } from "../transport/types.js";
import { chatReducer, createInitialState } from "./chat-reducer.js";
import { createMessageHandler } from "./message-handler.js";

// Re-export public types so barrel imports don't need to change
export type { CommandInfo, CommandResultTag, ToolState } from "./chat-reducer.js";

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const RECONNECT_BACKOFF_BASE = 2;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

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
  /** Called when a task_event is received (task created, updated, closed, dep changed). */
  onTaskEvent?: (event: {
    changeType: string;
    task: Record<string, unknown>;
    dep?: Record<string, unknown>;
  }) => void;
  /** Called when a subagent_event is received (child agent activity). */
  onSubagentEvent?: (event: {
    subagentId: string;
    profileId: string;
    childSessionId: string;
    taskId?: string;
    event: unknown;
  }) => void;
  /**
   * Called when the server requests data from the client (via requestFromClient).
   * The handler receives the event name and data, and should return the response data.
   * If not provided or if it throws, an error response is sent back.
   */
  onCustomRequest?: (
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface UseAgentChatReturn {
  messages: AgentMessage[];
  connectionStatus: "connecting" | "connected" | "disconnected" | "reconnecting";
  agentStatus: "idle" | "streaming" | "executing_tools";
  sessions: Array<{ id: string; name: string; source: string; updatedAt: string }>;
  currentSessionId: string | null;
  thinking: string | null;
  /** Completed thinking text from the most recent thinking block. Remains set after agent finishes. */
  completedThinking: string | null;
  /** Per-tool-call execution state, keyed by toolCallId. Only populated during live streaming. */
  toolStates: Map<string, import("./chat-reducer.js").ToolState>;
  /** Accumulated cost events for the current session. */
  costs: import("../costs/types.js").CostEvent[];
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
  availableCommands: import("./chat-reducer.js").CommandInfo[];
  /** Installed skills. Updated when skill state changes. */
  skills: import("../transport/types.js").SkillListEntry[];
  /** Structured system prompt sections. Populated after calling requestSystemPrompt(). */
  systemPrompt: {
    sections: import("../prompt/types.js").PromptSection[];
    raw: string;
  } | null;
  /** Queued messages waiting to be processed after the current agent turn. */
  queuedMessages: import("./chat-reducer.js").QueuedItem[];
  /** Last error received from the server. Cleared on next prompt. */
  error: string | null;
  /** Request the server to send the current system prompt sections. */
  requestSystemPrompt: () => void;
  sendMessage: (text: string) => void;
  /** Send a message as a steer (injected into running inference). Use Ctrl+Enter. */
  steerMessage: (text: string) => void;
  /** Delete a queued message by ID. */
  deleteQueuedMessage: (queueId: string) => void;
  /** Promote a queued message to a steer (inject into running inference). */
  steerQueuedMessage: (queueId: string) => void;
  /** Send a slash command programmatically without formatting a string. */
  sendCommand: (name: string, args?: string) => void;
  abort: () => void;
  switchSession: (sessionId: string) => void;
  createSession: (name?: string) => void;
  deleteSession: (sessionId: string) => void;
  /** Enable or disable a schedule by ID. */
  toggleSchedule: (scheduleId: string, enabled: boolean) => void;
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
  /** Tracks the active URL so stale onclose handlers from a previous URL don't trigger reconnects. */
  const activeUrlRef = useRef(config.url);
  const onCustomEventRef = useRef(config.onCustomEvent);
  onCustomEventRef.current = config.onCustomEvent;
  const onCustomRequestRef = useRef(config.onCustomRequest);
  onCustomRequestRef.current = config.onCustomRequest;
  const onTaskEventRef = useRef(config.onTaskEvent);
  onTaskEventRef.current = config.onTaskEvent;
  const onSubagentEventRef = useRef(config.onSubagentEvent);
  onSubagentEventRef.current = config.onSubagentEvent;
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPongAtRef = useRef<number>(0);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleMessage = useCallback(
    createMessageHandler(dispatch, {
      wsRef,
      currentSessionIdRef,
      streamMessageRef,
      onCustomEventRef,
      onCustomRequestRef,
      onTaskEventRef,
      onSubagentEventRef,
      lastPongAtRef,
      pongTimeoutRef,
    }),
    [],
  );

  const connect = useCallback(async () => {
    // Skip connection when URL is empty (e.g. before agent ID is loaded)
    if (!config.url) {
      dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "disconnected" });
      return;
    }

    // Capture the URL this connection was created for, so the onclose handler
    // can detect whether it belongs to a stale connection (URL changed).
    const connectUrl = config.url;

    dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "connecting" });

    let url = config.url;
    if (config.getToken) {
      const token = await config.getToken();
      // If the URL changed while we were awaiting the token, bail out
      if (activeUrlRef.current !== connectUrl) return;
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
      // Only clear wsRef if this is still the active connection
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      // Clean up heartbeat timers
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (pongTimeoutRef.current) {
        clearTimeout(pongTimeoutRef.current);
        pongTimeoutRef.current = null;
      }

      // Don't reconnect if:
      // 1. The effect was cleaned up (HMR / unmount)
      // 2. The URL has changed since this connection was created (agent switch)
      if (disposedRef.current) return;
      if (activeUrlRef.current !== connectUrl) return;

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
    activeUrlRef.current = config.url;

    // Reset all agent-specific state so stale data from the previous agent
    // is never rendered while waiting for the new agent's session_sync.
    dispatch({ type: "RESET" });
    currentSessionIdRef.current = null;
    streamMessageRef.current = null;
    reconnectAttemptRef.current = 0;

    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
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
  }, [connect, config.url]);

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

      if (state.agentStatus === "idle") {
        send({ type: "prompt", sessionId: state.currentSessionId, text } as ClientMessage);
        // Optimistically add user message and set agent as streaming
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
        });
        dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
      } else {
        send({ type: "queue_message", sessionId: state.currentSessionId, text } as ClientMessage);
        // Optimistically add to queued messages
        dispatch({
          type: "SET_QUEUE",
          items: [
            ...state.queuedMessages,
            { id: `optimistic-${Date.now()}`, text, createdAt: new Date().toISOString() },
          ],
        });
      }
    },
    [
      state.currentSessionId,
      state.agentStatus,
      state.queuedMessages,
      state.availableCommands,
      send,
    ],
  );

  const steerMessage = useCallback(
    (text: string) => {
      if (!state.currentSessionId) return;
      dispatch({ type: "SET_ERROR", error: null });
      send({ type: "steer", sessionId: state.currentSessionId, text } as ClientMessage);
      dispatch({
        type: "ADD_MESSAGE",
        message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      });
      dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
    },
    [state.currentSessionId, send],
  );

  const deleteQueuedMessage = useCallback(
    (queueId: string) => {
      if (!state.currentSessionId) return;
      send({ type: "queue_delete", sessionId: state.currentSessionId, queueId } as ClientMessage);
      // Optimistically remove from local queue
      dispatch({
        type: "SET_QUEUE",
        items: state.queuedMessages.filter((item) => item.id !== queueId),
      });
    },
    [state.currentSessionId, state.queuedMessages, send],
  );

  const steerQueuedMessage = useCallback(
    (queueId: string) => {
      if (!state.currentSessionId) return;
      send({ type: "queue_steer", sessionId: state.currentSessionId, queueId } as ClientMessage);
      // Optimistically remove from local queue
      dispatch({
        type: "SET_QUEUE",
        items: state.queuedMessages.filter((item) => item.id !== queueId),
      });
    },
    [state.currentSessionId, state.queuedMessages, send],
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
    messages: state.messages.filter((m) => {
      // Skip empty assistant messages (e.g., abandoned partial responses from steer interrupts)
      if (m.role !== "assistant") return true;
      const content = m.content as string | unknown[];
      if (typeof content === "string") return content.length > 0;
      if (Array.isArray(content)) {
        return content.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            ((block as { type: string }).type === "toolCall" ||
              ((block as { type: string }).type === "text" &&
                (block as { text?: string }).text?.length)),
        );
      }
      return true;
    }),
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
    skills: state.skills,
    systemPrompt: state.systemPrompt,
    queuedMessages: state.queuedMessages,
    error: state.error,
    requestSystemPrompt: useCallback(() => {
      send({ type: "request_system_prompt" });
    }, [send]),
    sendMessage,
    steerMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    sendCommand,
    abort,
    switchSession,
    createSession,
    deleteSession,
    toggleSchedule,
  };
}
