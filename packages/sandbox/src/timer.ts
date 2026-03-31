import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { clearAllElevation, clearAllProcessOwners, isAnySessionElevated } from "./session-state.js";
import type { SandboxConfig, SandboxProvider } from "./types.js";

export const TIMER_ID = "sandbox:de-elevate";

/**
 * Reset the auto-de-elevation timer.
 * Cancels any existing timer and sets a new one.
 */
export async function resetDeElevationTimer(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
  timeoutSeconds?: number,
): Promise<void> {
  const timeout = timeoutSeconds ?? config.idleTimeout;

  // Cancel existing timer
  await context.schedules.cancelTimer(TIMER_ID);

  // Set new timer
  await context.schedules.setTimer(TIMER_ID, timeout, async () => {
    const storage = context.storage;
    if (!storage) return;

    const anyElevated = await isAnySessionElevated(storage);
    if (!anyElevated) return;

    // Auto-de-elevate: stop provider and clear ALL session states
    try {
      await provider.stop();
    } catch {
      // Best-effort stop
    }

    await clearAllElevation(storage);
    await clearAllProcessOwners(storage);

    context.broadcastToAll("sandbox_elevation", { elevated: false });
  });
}

/** Cancel the auto-de-elevation timer. */
export async function cancelDeElevationTimer(context: AgentContext): Promise<void> {
  await context.schedules.cancelTimer(TIMER_ID);
}
