import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import {
  clearAllElevation,
  clearAllProcessOwners,
  isSessionElevated,
  setSessionElevated,
} from "./session-state.js";
import { getTeardownPromise } from "./teardown.js";
import type { SandboxProvider } from "./types.js";

const NOT_ELEVATED_RESULT = {
  content: [
    {
      type: "text" as const,
      text: "Not elevated. Call the elevate tool first to activate the sandbox.",
    },
  ],
  details: { error: "not_elevated" },
};

const CONTAINER_RESTART_FAILED_RESULT = {
  content: [
    {
      type: "text" as const,
      text: "The sandbox container died and could not be restarted. Call the elevate tool to try again.",
    },
  ],
  details: { error: "container_restart_failed" },
};

/**
 * Check if the sandbox is elevated for a specific session.
 * Returns a tool error result if not elevated, or null if elevated.
 *
 * When a `provider` is supplied, also verifies the container is actually alive.
 * If the container is dead but the session is marked elevated (stale state from
 * a wrangler restart, idle timeout, etc.), clears the stale state and attempts
 * to restart the container transparently.
 */
export async function checkElevation(
  storage: CapabilityStorage | undefined,
  sessionId: string,
  provider?: SandboxProvider,
): Promise<typeof NOT_ELEVATED_RESULT | typeof CONTAINER_RESTART_FAILED_RESULT | null> {
  if (!storage) throw new Error("Sandbox capability requires storage");
  const elevated = await isSessionElevated(storage, sessionId);
  if (!elevated) return NOT_ELEVATED_RESULT;

  // If no provider given, trust the elevation state (backwards compatible)
  if (!provider) return null;

  // Verify the container is actually alive
  try {
    const health = await provider.health();
    if (health.ready) return null; // All good
  } catch {
    // health() threw — container is dead
  }

  // Container is dead but session marked elevated — attempt restart
  console.warn("[sandbox] Dead container detected during exec — restarting");
  await clearAllElevation(storage);
  await clearAllProcessOwners(storage);

  const pending = getTeardownPromise();
  if (pending) await pending;

  try {
    await provider.start();
    const health = await provider.health();
    if (!health.ready) {
      return CONTAINER_RESTART_FAILED_RESULT;
    }
  } catch {
    return CONTAINER_RESTART_FAILED_RESULT;
  }

  // Re-establish elevation for this session
  await setSessionElevated(storage, sessionId, "auto-restarted after container death");
  return null;
}
