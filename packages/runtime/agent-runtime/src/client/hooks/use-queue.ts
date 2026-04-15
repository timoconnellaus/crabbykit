import { useCallback, useEffect } from "react";
import { useAgentConnection } from "../agent-connection-provider.js";
import type { QueuedItem } from "../chat-reducer.js";

export interface UseQueueReturn {
  queuedMessages: QueuedItem[];
  deleteQueuedMessage: (queueId: string) => void;
  steerQueuedMessage: (queueId: string) => void;
}

/**
 * Subscribes to the "queue" capability state and exposes delete/steer
 * actions. Resets local queue state on session switch.
 */
export function useQueue(): UseQueueReturn {
  const { send, state, dispatch, onSessionSwitch } = useAgentConnection();

  useEffect(() => {
    const unsubscribe = onSessionSwitch(() => {
      dispatch({ type: "SET_CAPABILITY_STATE", capabilityId: "queue", data: { items: [] } });
    });
    return unsubscribe;
  }, [onSessionSwitch, dispatch]);

  const data = state.capabilityState.queue as { items?: QueuedItem[] } | undefined;
  const queuedMessages = data?.items ?? [];

  const deleteQueuedMessage = useCallback(
    (queueId: string) => {
      if (!state.currentSessionId) return;
      send({
        type: "capability_action",
        capabilityId: "queue",
        action: "delete",
        data: { queueId },
        sessionId: state.currentSessionId,
      });
    },
    [send, state.currentSessionId],
  );

  const steerQueuedMessage = useCallback(
    (queueId: string) => {
      if (!state.currentSessionId) return;
      send({
        type: "capability_action",
        capabilityId: "queue",
        action: "steer",
        data: { queueId },
        sessionId: state.currentSessionId,
      });
    },
    [send, state.currentSessionId],
  );

  return {
    queuedMessages,
    deleteQueuedMessage,
    steerQueuedMessage,
  };
}
