import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { Dispatch, MutableRefObject, RefObject } from "react";
import type { ClientMessage, ServerMessage } from "../transport/types.js";
import type { ChatAction, StreamableMessage } from "./chat-reducer.js";

export interface MessageHandlerRefs {
  wsRef: RefObject<WebSocket | null>;
  currentSessionIdRef: RefObject<string | null>;
  streamMessageRef: MutableRefObject<AgentMessage | null>;
  onCustomEventRef: RefObject<((name: string, data: Record<string, unknown>) => void) | undefined>;
  onCustomRequestRef: RefObject<
    | ((
        name: string,
        data: Record<string, unknown>,
      ) => Promise<Record<string, unknown>> | Record<string, unknown>)
    | undefined
  >;
  onTaskEventRef: RefObject<
    | ((event: {
        changeType: string;
        task: Record<string, unknown>;
        dep?: Record<string, unknown>;
      }) => void)
    | undefined
  >;
  onSubagentEventRef: RefObject<
    | ((event: {
        subagentId: string;
        profileId: string;
        childSessionId: string;
        taskId?: string;
        event: unknown;
      }) => void)
    | undefined
  >;
  lastPongAtRef: MutableRefObject<number>;
  pongTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export function createMessageHandler(dispatch: Dispatch<ChatAction>, refs: MessageHandlerRefs) {
  return (event: MessageEvent) => {
    // Ignore events from stale WebSocket connections (StrictMode double-mount, HMR, reconnection overlap)
    if (event.target !== refs.wsRef.current) return;

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
        refs.currentSessionIdRef.current = msg.sessionId;
        refs.streamMessageRef.current = msg.streamMessage ?? null;

        // Auto-fetch next page if more entries exist
        if (msg.hasMore && refs.wsRef.current?.readyState === WebSocket.OPEN) {
          refs.wsRef.current.send(
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
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
        const agentEvent = msg.event;

        if (agentEvent.type === "message_start") {
          const msg = agentEvent.message;
          const isAssistant = msg && "role" in msg && msg.role === "assistant";
          if (isAssistant) {
            dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
            refs.streamMessageRef.current = msg;
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
          refs.streamMessageRef.current = agentEvent.message;

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
              if (next.length > 0 && refs.streamMessageRef.current) {
                const last = next[next.length - 1] as StreamableMessage;
                if ("role" in last && last.role === "assistant" && last._streaming) {
                  next[next.length - 1] = {
                    ...refs.streamMessageRef.current,
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

          refs.streamMessageRef.current = null;
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
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
        const toolEvent = msg.event;
        if (toolEvent.type === "tool_execution_start") {
          dispatch({
            type: "TOOL_EXECUTION_START",
            toolCallId: toolEvent.toolCallId,
            toolName: toolEvent.toolName,
          });
        }
        if (toolEvent.type === "tool_execution_update") {
          dispatch({
            type: "TOOL_EXECUTION_UPDATE",
            toolCallId: toolEvent.toolCallId,
            toolName: toolEvent.toolName,
            partialResult: toolEvent.partialResult,
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
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
        dispatch({ type: "ADD_COST", cost: msg.event });
        break;

      case "schedule_list":
        dispatch({ type: "SET_SCHEDULES", schedules: msg.schedules });
        break;

      case "command_list":
        dispatch({ type: "SET_AVAILABLE_COMMANDS", availableCommands: msg.commands });
        break;

      case "skill_list":
        dispatch({ type: "SET_SKILLS", skills: msg.skills });
        break;

      case "command_result": {
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
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
            // biome-ignore lint/style/useNamingConvention: _ prefix is a convention for internal transient state
            _commandResult: true,
            // biome-ignore lint/style/useNamingConvention: _ prefix is a convention for internal transient state
            _commandName: msg.name,
            // biome-ignore lint/style/useNamingConvention: _ prefix is a convention for internal transient state
            _isError: msg.isError,
          } as unknown as AgentMessage,
        });
        break;
      }

      case "inject_message":
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
        dispatch({ type: "ADD_MESSAGE", message: msg.message });
        break;

      case "custom_event": {
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
        const eventData = msg.event.data;
        const requestId = eventData._requestId as string | undefined;

        if (requestId) {
          // Server is requesting data from the client — handle and respond
          const handler = refs.onCustomRequestRef.current;
          const respondWith = (data: Record<string, unknown>) => {
            if (refs.wsRef.current?.readyState === WebSocket.OPEN) {
              refs.wsRef.current.send(
                JSON.stringify({
                  type: "custom_response",
                  sessionId: msg.sessionId,
                  requestId,
                  data,
                } satisfies ClientMessage),
              );
            }
          };

          if (handler) {
            // Strip _requestId from the data passed to the handler
            const { _requestId: _, ...cleanData } = eventData;
            Promise.resolve(handler(msg.event.name, cleanData))
              .then(respondWith)
              .catch((err: unknown) => {
                respondWith({
                  // biome-ignore lint/style/useNamingConvention: _error is a protocol convention
                  _error: true,
                  message: err instanceof Error ? err.message : String(err),
                });
              });
          } else {
            // biome-ignore lint/style/useNamingConvention: _error is a protocol convention
            respondWith({ _error: true, message: "No onCustomRequest handler configured" });
          }
        } else {
          refs.onCustomEventRef.current?.(msg.event.name, msg.event.data);
        }
        break;
      }

      case "system_prompt":
        dispatch({ type: "SET_SYSTEM_PROMPT", sections: msg.sections, raw: msg.raw });
        break;

      case "pong":
        refs.lastPongAtRef.current = Date.now();
        if (refs.pongTimeoutRef.current) {
          clearTimeout(refs.pongTimeoutRef.current);
          refs.pongTimeoutRef.current = null;
        }
        break;

      case "task_event":
        refs.onTaskEventRef.current?.(msg.event);
        break;

      case "subagent_event":
        if (msg.sessionId !== refs.currentSessionIdRef.current) break;
        refs.onSubagentEventRef.current?.(msg);
        break;

      case "mcp_status":
        // Could expose this, keeping it simple for now
        break;

      case "error":
        console.error(`[agent-runtime] ${msg.code}: ${msg.message}`);
        dispatch({ type: "ERROR_RECEIVED", message: msg.message });
        break;
    }
  };
}
