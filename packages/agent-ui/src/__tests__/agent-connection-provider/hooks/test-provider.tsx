/**
 * Test-only provider that wraps children with a manually-constructed
 * AgentConnectionContext value. Lets us test the focused hooks
 * (useSchedules, useSkills, useCommands, useSessions, useQueue, ...) in
 * isolation without spinning up a real WebSocket.
 */

import {
  AgentConnectionContext,
  type AgentConnectionContextValue,
  type ClientMessage,
} from "@claw-for-cloudflare/agent-runtime/client";
import { type ReactElement, type ReactNode, useMemo, useRef } from "react";

export interface MockProviderOptions {
  /** Initial reducer state. Missing fields are filled with sensible defaults. */
  state?: Partial<AgentConnectionContextValue["state"]>;
  /** Initial session id exposed via currentSessionId / currentSessionIdRef. */
  currentSessionId?: string | null;
  /** Optional connection status override. Defaults to "connected". */
  connectionStatus?: AgentConnectionContextValue["connectionStatus"];
  /** Captures every ClientMessage passed to `send`. */
  sent?: ClientMessage[];
  /** Captures every dispatched action. */
  dispatched?: AgentConnectionContextValue["state"][keyof AgentConnectionContextValue["state"]] extends never
    ? never
    : Parameters<AgentConnectionContextValue["dispatch"]>[0][];
}

function defaultState(): AgentConnectionContextValue["state"] {
  return {
    messages: [],
    connectionStatus: "connected",
    agentStatus: "idle",
    sessions: [],
    currentSessionId: null,
    thinking: null,
    completedThinking: null,
    toolStates: new Map(),
    costs: [],
    systemPrompt: null,
    capabilityState: {},
    error: null,
  };
}

export interface MockProviderHandle {
  /** All ClientMessages passed to `send` during the test. */
  sent: ClientMessage[];
  /** All dispatched actions. */
  dispatched: Parameters<AgentConnectionContextValue["dispatch"]>[0][];
  /** Capability subscribers from the current context value (if any). */
  subscribers: Map<string, Set<Parameters<AgentConnectionContextValue["subscribe"]>[1]>>;
  /** Session-switch listeners for firing from tests. */
  sessionSwitchListeners: Set<Parameters<AgentConnectionContextValue["onSessionSwitch"]>[0]>;
}

export function createMockProviderHandle(): MockProviderHandle {
  return {
    sent: [],
    dispatched: [],
    subscribers: new Map(),
    sessionSwitchListeners: new Set(),
  };
}

export interface MockProviderProps {
  handle: MockProviderHandle;
  stateOverrides?: Partial<AgentConnectionContextValue["state"]>;
  currentSessionId?: string | null;
  connectionStatus?: AgentConnectionContextValue["connectionStatus"];
  children: ReactNode;
}

/**
 * Wraps children in an AgentConnectionContext.Provider with a mock context
 * value backed by the given handle. Calls into `send` / `dispatch` /
 * `subscribe` / `onSessionSwitch` are captured on the handle for assertions.
 *
 * The context `value` is re-created whenever the props change, so hook
 * re-renders get updated state when tests rerender the wrapper.
 */
export function MockAgentConnectionProvider(props: MockProviderProps): ReactElement {
  const { handle, stateOverrides, currentSessionId, connectionStatus, children } = props;

  const currentSessionIdRef = useRef<string | null>(currentSessionId ?? null);
  currentSessionIdRef.current = currentSessionId ?? null;

  const value = useMemo<AgentConnectionContextValue>(() => {
    const state: AgentConnectionContextValue["state"] = {
      ...defaultState(),
      ...stateOverrides,
      currentSessionId: currentSessionId ?? null,
    };

    const send: AgentConnectionContextValue["send"] = (msg) => {
      handle.sent.push(msg);
    };

    const dispatch: AgentConnectionContextValue["dispatch"] = (action) => {
      handle.dispatched.push(action);
    };

    const subscribe: AgentConnectionContextValue["subscribe"] = (capabilityId, handler) => {
      let set = handle.subscribers.get(capabilityId);
      if (!set) {
        set = new Set();
        handle.subscribers.set(capabilityId, set);
      }
      set.add(handler);
      return () => {
        const existing = handle.subscribers.get(capabilityId);
        if (!existing) return;
        existing.delete(handler);
        if (existing.size === 0) handle.subscribers.delete(capabilityId);
      };
    };

    const onSessionSwitch: AgentConnectionContextValue["onSessionSwitch"] = (listener) => {
      handle.sessionSwitchListeners.add(listener);
      return () => {
        handle.sessionSwitchListeners.delete(listener);
      };
    };

    return {
      send,
      connectionStatus: connectionStatus ?? "connected",
      subscribe,
      currentSessionId: currentSessionId ?? null,
      currentSessionIdRef,
      dispatch,
      state,
      onSessionSwitch,
    };
  }, [handle, stateOverrides, currentSessionId, connectionStatus]);

  return (
    <AgentConnectionContext.Provider value={value}>{children}</AgentConnectionContext.Provider>
  );
}

/** Convenience: fire a session-switch notification through the handle. */
export function fireSessionSwitch(handle: MockProviderHandle, sessionId: string | null): void {
  for (const listener of handle.sessionSwitchListeners) {
    listener(sessionId);
  }
}
