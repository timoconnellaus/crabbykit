import { useAgentConnection } from "../agent-connection-provider.js";

/**
 * Currently active session-level {@link import("../../modes/define-mode.js").Mode}
 * for the connection, or `null` when no mode is active.
 *
 * The state is initialized from the `session_sync.activeMode` payload
 * on connection establish and session switch, and is kept in sync via
 * `mode_event` messages handled by the connection provider's reducer.
 */
export function useActiveMode(): { id: string; name: string } | null {
  const { state } = useAgentConnection();
  return state.activeMode;
}
