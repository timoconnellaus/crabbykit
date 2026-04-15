import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxConfig } from "./types.js";

export const TIMER_ID = "sandbox:de-elevate";

/**
 * Reset the auto-de-elevation timer delay.
 * Replaces any existing timer with a new delay, preserving the callback
 * (declared by the capability's schedules() method).
 */
export async function resetDeElevationTimer(
  config: Required<SandboxConfig>,
  context: AgentContext,
  timeoutSeconds?: number,
): Promise<void> {
  const timeout = timeoutSeconds ?? config.idleTimeout;
  // setTimer handles replacing existing timers internally —
  // don't cancelTimer first, as that would delete the callback.
  await context.schedules.setTimer(TIMER_ID, timeout);
}

/** Cancel the auto-de-elevation timer. */
export async function cancelDeElevationTimer(context: AgentContext): Promise<void> {
  await context.schedules.cancelTimer(TIMER_ID);
}
