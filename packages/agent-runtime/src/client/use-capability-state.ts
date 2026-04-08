import { type MutableRefObject, useEffect, useRef, useState } from "react";

/**
 * Subscribe to capability state by ID. Returns the latest snapshot
 * from "sync" events, or undefined if no state has arrived yet.
 */
export function useCapabilityState<T = unknown>(
  capabilityId: string,
  subscribersRef: MutableRefObject<Map<string, Set<(event: string, data: unknown) => void>>>,
): T | undefined {
  const [state, setState] = useState<T | undefined>(undefined);

  useEffect(() => {
    const handler = (event: string, data: unknown) => {
      if (event === "sync") {
        setState(data as T);
      }
    };
    const map = subscribersRef.current;
    if (!map.has(capabilityId)) {
      map.set(capabilityId, new Set());
    }
    map.get(capabilityId)?.add(handler);
    return () => {
      map.get(capabilityId)?.delete(handler);
      if (map.get(capabilityId)?.size === 0) {
        map.delete(capabilityId);
      }
    };
  }, [capabilityId, subscribersRef]);

  return state;
}

/**
 * Subscribe to ALL capability state events for a given ID.
 * Calls handler for every event (not just "sync").
 * The handler is NOT stored in state -- use for ephemeral event streams.
 */
export function useCapabilityEvents(
  capabilityId: string,
  handler: (event: string, data: unknown) => void,
  subscribersRef: MutableRefObject<Map<string, Set<(event: string, data: unknown) => void>>>,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const wrappedHandler = (event: string, data: unknown) => {
      handlerRef.current(event, data);
    };
    const map = subscribersRef.current;
    if (!map.has(capabilityId)) {
      map.set(capabilityId, new Set());
    }
    map.get(capabilityId)?.add(wrappedHandler);
    return () => {
      map.get(capabilityId)?.delete(wrappedHandler);
      if (map.get(capabilityId)?.size === 0) {
        map.delete(capabilityId);
      }
    };
  }, [capabilityId, subscribersRef]);
}
