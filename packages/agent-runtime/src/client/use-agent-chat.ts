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
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamMessageRef = useRef<AgentMessage | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    const msg: ServerMessage = JSON.parse(event.data);

    switch (msg.type) {
      case "session_sync":
        setMessages(msg.messages);
        setCurrentSessionId(msg.sessionId);
        setToolStates(new Map());
        setCosts([]);
        streamMessageRef.current = msg.streamMessage ?? null;
        if (msg.streamMessage) {
          setAgentStatus("streaming");
        }
        break;

      case "session_list":
        setSessions(msg.sessions);
        break;

      case "agent_event": {
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
          // Finalize: replace streaming placeholder with final content, or add if missing
          setMessages((prev) => {
            const next = [...prev];
            if (next.length > 0) {
              const last = next[next.length - 1] as StreamableMessage;
              if (last._streaming) {
                next[next.length - 1] = finalMessage as AgentMessage;
                return next;
              }
            }
            // No streaming message found — add the final message directly
            next.push(finalMessage as AgentMessage);
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
        }
        break;
      }

      case "cost_event":
        setCosts((prev) => [...prev, msg.event]);
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
    connect();
    return () => {
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
      const type = agentStatus === "idle" ? "prompt" : "steer";
      send({ type, sessionId: currentSessionId, text } as ClientMessage);

      // Optimistically add user message
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      ]);
    },
    [currentSessionId, agentStatus, send],
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
    error,
    sendMessage,
    abort,
    switchSession,
    createSession,
    deleteSession,
  };
}
