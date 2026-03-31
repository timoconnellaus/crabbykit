import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import {
  clearAllElevation,
  clearAllProcessOwners,
  isAnySessionElevated,
  isSessionElevated,
  setSessionElevated,
} from "../session-state.js";
import { getTeardownPromise } from "../teardown.js";
import { resetDeElevationTimer } from "../timer.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";
import { injectCredentials } from "./credentials.js";

const DEFAULT_IDLE_TIMEOUT = 180;

export function createElevateTool(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "elevate",
    description:
      "Activate the sandbox to get shell access. Provide a reason explaining why you need it.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why sandbox access is needed" }),
      timeout: Type.Optional(
        Type.Number({
          description: "Override idle timeout in seconds",
          minimum: 30,
        }),
      ),
    }),
    execute: async (args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      // Check if THIS session is already elevated
      const alreadyElevated = await isSessionElevated(storage, context.sessionId);
      if (alreadyElevated) {
        // Verify the container is actually alive before trusting stale state
        try {
          const health = await provider.health();
          if (health.ready) {
            return {
              content: [{ type: "text" as const, text: "Already elevated. Sandbox is active." }],
              details: { alreadyElevated: true },
            };
          }
        } catch {
          // Container is dead — fall through to full start sequence
        }
        console.warn("[sandbox] Session marked elevated but container is dead — restarting");
        await clearAllElevation(storage);
        await clearAllProcessOwners(storage);
      }

      // Check if another session already has the container running
      const containerRunning = await isAnySessionElevated(storage);

      // Even if another session claims to be elevated, verify the container
      // is actually alive. Stale elevation state from a dead container would
      // otherwise cause us to skip the start sequence entirely.
      let containerHealthy = false;
      if (containerRunning) {
        try {
          const health = await provider.health();
          containerHealthy = health.ready === true;
        } catch {
          // Container is dead — clear stale state and proceed with full start
          console.warn("[sandbox] Stale elevation state detected in elevate — clearing");
          await clearAllElevation(storage);
          await clearAllProcessOwners(storage);
        }
      }

      if (!containerHealthy) {
        // No healthy container — do the full start sequence
        const pending = getTeardownPromise();
        if (pending) {
          await pending;
        }

        await provider.start();

        // Verify the container actually started
        try {
          const health = await provider.health();
          if (!health.ready) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Sandbox failed to start — container is not ready. Try again.",
                },
              ],
              details: { error: "container_not_ready", health },
            };
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Sandbox failed to start: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { error: "health_check_failed" },
          };
        }

        // Inject saved credentials into the container
        try {
          const { envVars, errors } = await injectCredentials(storage, provider);
          if (Object.keys(envVars).length > 0) {
            await provider.start({ envVars });
          }
          if (errors.length > 0) {
            console.warn("[sandbox] Credential injection errors:", errors);
          }
        } catch (err) {
          console.warn("[sandbox] Credential injection failed:", err);
        }
      }

      // Mark THIS session as elevated
      await setSessionElevated(storage, context.sessionId, args.reason);

      // Reset the shared idle timer
      const timeout = args.timeout ?? config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
      await resetDeElevationTimer(config, context, timeout);

      // Broadcast elevation state to THIS session's UI
      const expiresAt = Date.now() + timeout * 1000;
      context.broadcast("sandbox_elevation", {
        elevated: true,
        reason: args.reason,
      });
      context.broadcast("sandbox_timeout", {
        expiresAt,
        timeoutSeconds: timeout,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Sandbox activated. You now have shell access via the bash tool. Auto-de-elevation in ${timeout}s.`,
          },
        ],
        details: { elevated: true, reason: args.reason, timeoutSeconds: timeout },
      };
    },
  });
}
