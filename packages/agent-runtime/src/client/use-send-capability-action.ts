import { type MutableRefObject, useCallback } from "react";
import type { ClientMessage } from "../transport/types.js";

/**
 * Returns a function that sends a capability_action message.
 * The returned function is scoped to the given capabilityId.
 */
export function useSendCapabilityAction(
  capabilityId: string,
  send: (msg: ClientMessage) => void,
  currentSessionIdRef: MutableRefObject<string | null>,
): (action: string, data: unknown) => void {
  return useCallback(
    (action: string, data: unknown) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId,
        action,
        data,
        sessionId,
      });
    },
    [capabilityId, send, currentSessionIdRef],
  );
}
