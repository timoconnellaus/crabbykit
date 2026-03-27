import { useState, useEffect, useCallback, useRef } from "react";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ServerMessage, ClientMessage } from "../transport/types.js";
import type { ConnectionStatus, AgentStatus } from "./types.js";

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
  sendMessage: (text: string) => void;
  abort: () => void;
  switchSession: (sessionId: string) => void;
  createSession: (name?: string) => void;
}

export function useAgentChat(config: UseAgentChatConfig): UseAgentChatReturn {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [sessions, setSessions] = useState<UseAgentChatReturn["sessions"]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    config.sessionId ?? null,
  );
  const [thinking, setThinking] = useState<string | null>(null);

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
          setAgentStatus("streaming");
          streamMessageRef.current = agentEvent.message;
        }

        if (agentEvent.type === "message_update") {
          streamMessageRef.current = agentEvent.message;
          // Update last message in state with streaming content
          setMessages((prev) => {
            const next = [...prev];
            // Replace or append the streaming message
            if (next.length > 0 && streamMessageRef.current) {
              const last = next[next.length - 1] as any;
              if (last.role === "assistant" && (last as any)._streaming) {
                next[next.length - 1] = {
                  ...streamMessageRef.current,
                  _streaming: true,
                } as any;
              } else {
                next.push({
                  ...streamMessageRef.current,
                  _streaming: true,
                } as any);
              }
            } else if (streamMessageRef.current) {
              next.push({
                ...streamMessageRef.current,
                _streaming: true,
              } as any);
            }
            return next;
          });

          // Handle thinking blocks
          const aEvent = agentEvent.assistantMessageEvent;
          if (aEvent) {
            if (aEvent.type === "thinking_start") {
              setThinking("");
            } else if (aEvent.type === "thinking_delta") {
              setThinking((prev) => (prev ?? "") + (aEvent as any).text);
            } else if (aEvent.type === "thinking_end") {
              // Keep thinking visible until next message
            }
          }
        }

        if (agentEvent.type === "message_end") {
          streamMessageRef.current = null;
          // Finalize the message (remove _streaming flag)
          setMessages((prev) => {
            const next = [...prev];
            if (next.length > 0) {
              const last = next[next.length - 1] as any;
              if (last._streaming) {
                const { _streaming, ...rest } = last;
                next[next.length - 1] = rest as AgentMessage;
              }
            }
            return next;
          });
        }

        if (agentEvent.type === "agent_end") {
          setAgentStatus("idle");
          setThinking(null);
        }

        break;
      }

      case "tool_event":
        if (msg.event.type === "tool_execution_start") {
          setAgentStatus("executing_tools");
        }
        break;

      case "mcp_status":
        // Could expose this, keeping it simple for now
        break;

      case "error":
        console.error(`[agent-runtime] ${msg.code}: ${msg.message}`);
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
          1000 * 2 ** reconnectAttemptRef.current,
          config.maxReconnectDelay ?? 30000,
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

  return {
    messages,
    connectionStatus,
    agentStatus,
    sessions,
    currentSessionId,
    thinking,
    sendMessage,
    abort,
    switchSession,
    createSession,
  };
}
