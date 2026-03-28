import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CostEvent } from "../costs/types.js";
import type { ClientMessage, ServerMessage } from "../transport/types.js";
import type { AgentStatus, ConnectionStatus } from "./types.js";

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const RECONNECT_BACKOFF_BASE = 2;

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
  abort: () => void;
  switchSession: (sessionId: string) => void;
  createSession: (name?: string) => void;
  deleteSession: (sessionId: string) => void;
}

export function useAgentChat(config: UseAgentChatConfig): UseAgentChatReturn {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [sessions, setSessions] = useState<UseAgentChatReturn["sessions"]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(config.sessionId ?? null);
  const [thinking, setThinking] = useState<string | null>(null);
  const [toolStates, setToolStates] = useState<Map<string, ToolState>>(new Map());
  const [costs, setCosts] = useState<CostEvent[]>([]);
  const [schedules, setSchedules] = useState<UseAgentChatReturn["schedules"]>([]);
  const [availableCommands, setAvailableCommands] = useState<CommandInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        setMessages(syncMessages);
        setCurrentSessionId(msg.sessionId);
        currentSessionIdRef.current = msg.sessionId;
        setToolStates(new Map());
        setCosts([]);
        setThinking(null);
        setError(null);
        streamMessageRef.current = msg.streamMessage ?? null;
        setAgentStatus(msg.streamMessage ? "streaming" : "idle");
        break;
      }

      case "session_list":
        setSessions(msg.sessions);
        break;

      case "agent_event": {
        // Discard events for a session we're no longer watching (late arrivals after switch)
        if (msg.sessionId !== currentSessionIdRef.current) break;
        const agentEvent = msg.event;

        if (agentEvent.type === "message_start") {
          const msg = agentEvent.message;
          const isAssistant = msg && "role" in msg && msg.role === "assistant";
          if (isAssistant) {
            setAgentStatus("streaming");
            streamMessageRef.current = msg;
            // Add streaming placeholder immediately (handles non-streaming models)
            setMessages((prev) => [
              ...prev,
              {
                ...msg,
                // biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
                _streaming: true,
              } as StreamableMessage,
            ]);
          }
        }

        if (agentEvent.type === "message_update") {
          streamMessageRef.current = agentEvent.message;
          // Replace the streaming message with updated content
          setMessages((prev) => {
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
          });

          // Handle thinking blocks
          const aEvent = agentEvent.assistantMessageEvent;
          if (aEvent) {
            if (aEvent.type === "thinking_start") {
              setThinking("");
            } else if (aEvent.type === "thinking_delta") {
              setThinking((prev) => (prev ?? "") + aEvent.delta);
            } else if (aEvent.type === "thinking_end") {
              // Keep thinking visible until next message
            }
          }
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
          setMessages((prev) => {
            const next = [...prev];
            if (next.length > 0) {
              const last = next[next.length - 1] as StreamableMessage;
              if (last._streaming) {
                next[next.length - 1] = finalMessage as AgentMessage;
              }
            }
            return next;
          });
        }

        if (agentEvent.type === "agent_end") {
          setAgentStatus("idle");
          setThinking(null);
          setToolStates(new Map());
        }

        break;
      }

      case "tool_event": {
        if (msg.sessionId !== currentSessionIdRef.current) break;
        const toolEvent = msg.event;
        if (toolEvent.type === "tool_execution_start") {
          setAgentStatus("executing_tools");
          setToolStates((prev) => {
            const next = new Map(prev);
            next.set(toolEvent.toolCallId, {
              status: "executing",
              toolName: toolEvent.toolName,
            });
            return next;
          });
        }
        if (toolEvent.type === "tool_execution_end") {
          setToolStates((prev) => {
            const next = new Map(prev);
            next.set(toolEvent.toolCallId, {
              status: "complete",
              toolName: toolEvent.toolName,
              result: toolEvent.result,
              isError: toolEvent.isError ?? false,
            });
            return next;
          });
          // Persist tool result in messages array so it survives toolStates clearing on agent_end
          const toolResult = toolEvent.result as Record<string, unknown> | undefined;
          setMessages((prev) => [
            ...prev,
            {
              role: "toolResult",
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              content: toolResult?.content ?? toolEvent.result,
              details: toolResult?.details ?? null,
              isError: toolEvent.isError ?? false,
              timestamp: Date.now(),
            } as unknown as AgentMessage,
          ]);
        }
        break;
      }

      case "cost_event":
        if (msg.sessionId !== currentSessionIdRef.current) break;
        setCosts((prev) => [...prev, msg.event]);
        break;

      case "schedule_list":
        setSchedules(msg.schedules);
        break;

      case "command_list":
        setAvailableCommands(msg.commands);
        break;

      case "command_result": {
        if (msg.sessionId !== currentSessionIdRef.current) break;
        const resultText =
          msg.result.text ??
          (msg.result.data != null ? JSON.stringify(msg.result.data, null, 2) : "");
        // Command results are synthetic messages — they don't match the full AssistantMessage shape
        // but are displayed in the message list with distinct rendering via _commandResult tag
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: resultText,
            timestamp: Date.now(),
            _commandResult: true,
            _commandName: msg.name,
            _isError: msg.isError,
          } as unknown as AgentMessage,
        ]);
        break;
      }

      case "custom_event":
        if (msg.sessionId !== currentSessionIdRef.current) break;
        onCustomEventRef.current?.(msg.event.name, msg.event.data);
        break;

      case "mcp_status":
        // Could expose this, keeping it simple for now
        break;

      case "error":
        console.error(`[agent-runtime] ${msg.code}: ${msg.message}`);
        setError(msg.message);
        setAgentStatus("idle");
        break;
    }
  }, []);

  const connect = useCallback(async () => {
    setConnectionStatus("connecting");

    let url = config.url;
    if (config.getToken) {
      const token = await config.getToken();
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}token=${encodeURIComponent(token)}`;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus("connected");
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      setConnectionStatus("disconnected");
      wsRef.current = null;

      // Don't reconnect if the effect was cleaned up (HMR / unmount)
      if (disposedRef.current) return;

      if (config.autoReconnect !== false) {
        const delay = Math.min(
          1000 * RECONNECT_BACKOFF_BASE ** reconnectAttemptRef.current,
          config.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY,
        );
        reconnectAttemptRef.current++;
        setConnectionStatus("reconnecting");
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
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!currentSessionId) return;
      setError(null);

      // Detect slash commands: "/name" or "/name args..."
      // Only intercept known commands to avoid false positives (e.g. "/path/to/file")
      const commandMatch = text.match(/^\/(\S+)(?:\s+(.*))?$/);
      if (commandMatch) {
        const [, name, args] = commandMatch;
        const isKnownCommand = availableCommands.some((cmd) => cmd.name === name);
        if (isKnownCommand) {
          send({
            type: "command",
            sessionId: currentSessionId,
            name,
            args: args?.trim(),
          } as ClientMessage);

          // Optimistically add user message
          setMessages((prev) => [
            ...prev,
            { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
          ]);
          return;
        }
      }

      const type = agentStatus === "idle" ? "prompt" : "steer";
      send({ type, sessionId: currentSessionId, text } as ClientMessage);

      // Optimistically add user message
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      ]);
    },
    [currentSessionId, agentStatus, availableCommands, send],
  );

  const abort = useCallback(() => {
    if (currentSessionId) {
      send({ type: "abort", sessionId: currentSessionId });
    }
  }, [currentSessionId, send]);

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

  return {
    messages,
    connectionStatus,
    agentStatus,
    sessions,
    currentSessionId,
    thinking,
    toolStates,
    costs,
    schedules,
    availableCommands,
    error,
    sendMessage,
    abort,
    switchSession,
    createSession,
    deleteSession,
  };
}
