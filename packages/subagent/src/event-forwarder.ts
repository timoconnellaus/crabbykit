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
 * Create a subscription handler that forwards child agent events
 * to the parent session via `context.broadcastState()`.
 *
 * Usage in AgentDODelegate.startAgentForSession:
 * ```ts
 * const unsub = childAgent.subscribe(
 *   createEventForwarder(meta, broadcastState)
 * );
 * ```
 */
export function createEventForwarder(
  meta: SubagentEventMeta,
  broadcastState: (event: string, data: unknown) => void,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    broadcastState("event", {
      subagentId: meta.subagentId,
      profileId: meta.profileId,
      childSessionId: meta.childSessionId,
      taskId: meta.taskId,
      event,
    });
  };
}
