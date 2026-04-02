import type { AgentEvent } from "@claw-for-cloudflare/agent-core";

/**
 * Metadata attached to each forwarded subagent event.
 */
export interface SubagentEventMeta {
  subagentId: string;
  profileId: string;
  childSessionId: string;
  taskId?: string;
}

/**
 * Wraps an AgentEvent from a child session into a subagent_event
 * transport message for the parent session's WebSocket connections.
 */
export function wrapSubagentEvent(
  parentSessionId: string,
  meta: SubagentEventMeta,
  event: AgentEvent,
): {
  type: "subagent_event";
  sessionId: string;
  subagentId: string;
  profileId: string;
  childSessionId: string;
  taskId?: string;
  event: AgentEvent;
} {
  return {
    type: "subagent_event",
    sessionId: parentSessionId,
    subagentId: meta.subagentId,
    profileId: meta.profileId,
    childSessionId: meta.childSessionId,
    taskId: meta.taskId,
    event,
  };
}

/**
 * Create a subscription handler that forwards child agent events
 * to the parent session as subagent_event messages.
 *
 * Usage in AgentDODelegate.startAgentForSession:
 * ```ts
 * const unsub = childAgent.subscribe(
 *   createEventForwarder(meta, parentSessionId, (msg) =>
 *     this.broadcastToSession(parentSessionId, msg)
 *   )
 * );
 * ```
 */
export function createEventForwarder(
  meta: SubagentEventMeta,
  parentSessionId: string,
  broadcast: (message: unknown) => void,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    broadcast(wrapSubagentEvent(parentSessionId, meta, event));
  };
}
