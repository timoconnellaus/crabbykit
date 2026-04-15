import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import {
  createContext,
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ClientMessage } from "../transport/types.js";
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  createInitialState,
} from "./chat-reducer.js";
import { createMessageHandler } from "./message-handler.js";

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const RECONNECT_BACKOFF_BASE = 2;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * Handler invoked when the provider receives a capability_state message.
 * Receives the event name (e.g. "sync", "update") and its payload.
 */
export type CapabilityEventHandler = (event: string, data: unknown) => void;

/**
 * Handler invoked when the current session changes (either via SESSION_SYNC
 * from the server or explicit SET_CURRENT_SESSION_ID). Used by hooks that
 * need to reset per-session state (e.g. queue resets).
 */
export type SessionSwitchHandler = (sessionId: string | null) => void;

export interface AgentConnectionProviderProps {
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
  /**
   * Called when the server requests data from the client (via requestFromClient).
   * The handler receives the event name and data, and should return the response data.
   * If not provided or if it throws, an error response is sent back.
   */
  onCustomRequest?: (
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  children: ReactNode;
}

export interface AgentConnectionContextValue {
  /** Send a client message over the WebSocket. No-op if not connected. */
  send: (msg: ClientMessage) => void;
  /** Current WebSocket connection status. */
  connectionStatus: "connecting" | "connected" | "disconnected" | "reconnecting";
  /**
   * Subscribe to capability_state events for a specific capability.
   * Returns an unsubscribe function.
   */
  subscribe: (capabilityId: string, handler: CapabilityEventHandler) => () => void;
  /** Latest current session id (reactive, via state). */
  currentSessionId: string | null;
  /** Ref to the latest current session id (for use inside stable callbacks). */
  currentSessionIdRef: MutableRefObject<string | null>;
  /** Shared reducer dispatch for hooks built on top of the provider. */
  dispatch: Dispatch<ChatAction>;
  /** Shared reducer state. */
  state: ChatState;
  /**
   * Subscribe to session switch events (fired on SESSION_SYNC or
   * SET_CURRENT_SESSION_ID). Returns an unsubscribe function.
   */
  onSessionSwitch: (handler: SessionSwitchHandler) => () => void;
}

/**
 * React context carrying the agent connection value.
 *
 * @internal Exported for tests and advanced consumers that need to provide
 * a mock context value (e.g. to test decomposed hooks in isolation without
 * a real WebSocket). Prefer `useAgentConnection` for normal usage.
 */
export const AgentConnectionContext = createContext<AgentConnectionContextValue | null>(null);

export function AgentConnectionProvider(props: AgentConnectionProviderProps): ReactElement {
  const {
    url,
    sessionId,
    getToken,
    autoReconnect,
    maxReconnectDelay,
    onCustomEvent,
    onCustomRequest,
    children,
  } = props;

  const [state, baseDispatch] = useReducer(chatReducer, sessionId, createInitialState);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamMessageRef = useRef<AgentMessage | null>(null);
  /** Tracks the current sessionId for use inside the handleMessage callback (which has [] deps). */
  const currentSessionIdRef = useRef<string | null>(sessionId ?? null);
  /** Set to true by effect cleanup to suppress reconnect from stale onclose handlers. */
  const disposedRef = useRef(false);
  /** Tracks the active URL so stale onclose handlers from a previous URL don't trigger reconnects. */
  const activeUrlRef = useRef(url);

  const onCustomEventRef = useRef(onCustomEvent);
  onCustomEventRef.current = onCustomEvent;
  const onCustomRequestRef = useRef(onCustomRequest);
  onCustomRequestRef.current = onCustomRequest;

  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPongAtRef = useRef<number>(0);

  const capabilitySubscribersRef = useRef(new Map<string, Set<CapabilityEventHandler>>());
  const sessionSwitchListenersRef = useRef(new Set<SessionSwitchHandler>());

  // Wrap dispatch to observe session-switching actions and notify listeners.
  const dispatch = useCallback<Dispatch<ChatAction>>((action) => {
    baseDispatch(action);
    if (action.type === "SESSION_SYNC") {
      const next = action.currentSessionId;
      for (const listener of sessionSwitchListenersRef.current) {
        listener(next);
      }
    } else if (action.type === "SET_CURRENT_SESSION_ID") {
      const next = action.currentSessionId;
      for (const listener of sessionSwitchListenersRef.current) {
        listener(next);
      }
    } else if (action.type === "RESET") {
      for (const listener of sessionSwitchListenersRef.current) {
        listener(null);
      }
    }
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((capabilityId: string, handler: CapabilityEventHandler) => {
    const map = capabilitySubscribersRef.current;
    let set = map.get(capabilityId);
    if (!set) {
      set = new Set();
      map.set(capabilityId, set);
    }
    set.add(handler);
    return () => {
      const existing = capabilitySubscribersRef.current.get(capabilityId);
      if (!existing) return;
      existing.delete(handler);
      if (existing.size === 0) {
        capabilitySubscribersRef.current.delete(capabilityId);
      }
    };
  }, []);

  const onSessionSwitch = useCallback((handler: SessionSwitchHandler) => {
    sessionSwitchListenersRef.current.add(handler);
    return () => {
      sessionSwitchListenersRef.current.delete(handler);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is stable; message-handler refs don't need to be deps
  const handleMessage = useCallback(
    createMessageHandler(dispatch, {
      wsRef,
      currentSessionIdRef,
      streamMessageRef,
      onCustomEventRef,
      onCustomRequestRef,
      lastPongAtRef,
      pongTimeoutRef,
      capabilitySubscribersRef,
    }),
    [],
  );

  const connect = useCallback(async () => {
    // Skip connection when URL is empty (e.g. before agent ID is loaded)
    if (!url) {
      dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "disconnected" });
      return;
    }

    // Capture the URL this connection was created for, so the onclose handler
    // can detect whether it belongs to a stale connection (URL changed).
    const connectUrl = url;

    dispatch({ type: "SET_CONNECTION_STATUS", connectionStatus: "connecting" });

    let wsUrl = url;
    if (getToken) {
      const token = await getToken();
      // If the URL changed while we were awaiting the token, bail out
      if (activeUrlRef.current !== connectUrl) return;
      const separator = wsUrl.includes("?") ? "&" : "?";
      wsUrl = `${wsUrl}${separator}token=${encodeURIComponent(token)}`;
    }

    const ws = new WebSocket(wsUrl);
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

      if (autoReconnect !== false) {
        const delay = Math.min(
          1000 * RECONNECT_BACKOFF_BASE ** reconnectAttemptRef.current,
          maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY,
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
  }, [url, getToken, autoReconnect, maxReconnectDelay, handleMessage, dispatch]);

  useEffect(() => {
    disposedRef.current = false;
    activeUrlRef.current = url;

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
  }, [connect, url, dispatch]);

  const value = useMemo<AgentConnectionContextValue>(
    () => ({
      send,
      connectionStatus: state.connectionStatus,
      subscribe,
      currentSessionId: state.currentSessionId,
      currentSessionIdRef,
      dispatch,
      state,
      onSessionSwitch,
    }),
    [send, state, subscribe, dispatch, onSessionSwitch],
  );

  return (
    <AgentConnectionContext.Provider value={value}>{children}</AgentConnectionContext.Provider>
  );
}

/**
 * Read the agent connection context. Throws if used outside of an
 * `AgentConnectionProvider`.
 */
export function useAgentConnection(): AgentConnectionContextValue {
  const ctx = useContext(AgentConnectionContext);
  if (!ctx) {
    throw new Error(
      "useAgentConnection must be used inside an <AgentConnectionProvider>. " +
        "Wrap your component tree with the provider.",
    );
  }
  return ctx;
}
