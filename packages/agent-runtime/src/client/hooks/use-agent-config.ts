import { useCallback, useEffect, useState } from "react";
import { useAgentConnection } from "../agent-connection-provider.js";

/**
 * Snapshot of the agent-level config delivered by the runtime's
 * `capability_state { capabilityId: "agent-config" }` messages. The
 * schema is the TypeBox record declared on `defineAgent`'s `config`
 * field; values are the current persisted values per namespace.
 */
export interface AgentConfigSnapshot {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
}

export interface UseAgentConfigReturn {
  /** TypeBox schema record declared on `defineAgent`, keyed by namespace. */
  schema: Record<string, unknown>;
  /** Current values keyed by namespace. */
  values: Record<string, unknown>;
  /** Whether a sync payload has been received yet. */
  ready: boolean;
  /**
   * Write a new value for an agent-level namespace. Sends a
   * `capability_action { capabilityId: "agent-config", action: "set" }`
   * message. The runtime validates against the declared schema, persists,
   * and broadcasts an `update` event that this hook then applies.
   */
  setConfig: (namespace: string, value: unknown) => void;
}

/**
 * Subscribes to the `"agent-config"` capability state broadcast and
 * exposes a `setConfig` writer backed by `capability_action`.
 *
 * The runtime emits a `"sync"` event on WebSocket (re)connect with the
 * full `{ schema, values }` payload and an `"update"` event on every
 * `config_set` carrying `{ namespace, value }`. This hook merges both
 * shapes into a single live snapshot.
 */
export function useAgentConfig(): UseAgentConfigReturn {
  const { send, state, subscribe } = useAgentConnection();
  const [snapshot, setSnapshot] = useState<AgentConfigSnapshot>({ schema: {}, values: {} });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribe("agent-config", (event, data) => {
      if (event === "sync") {
        const payload = data as AgentConfigSnapshot;
        setSnapshot({
          schema: payload.schema ?? {},
          values: payload.values ?? {},
        });
        setReady(true);
        return;
      }
      if (event === "update") {
        const payload = data as { namespace: string; value: unknown };
        setSnapshot((prev) => ({
          schema: prev.schema,
          values: { ...prev.values, [payload.namespace]: payload.value },
        }));
      }
    });
    return unsubscribe;
  }, [subscribe]);

  const setConfig = useCallback(
    (namespace: string, value: unknown) => {
      if (!state.currentSessionId) return;
      send({
        type: "capability_action",
        capabilityId: "agent-config",
        action: "set",
        data: { namespace, value },
        sessionId: state.currentSessionId,
      });
    },
    [send, state.currentSessionId],
  );

  return {
    schema: snapshot.schema,
    values: snapshot.values,
    ready,
    setConfig,
  };
}
