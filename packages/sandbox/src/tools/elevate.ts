import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { getTeardownPromise } from "../teardown.js";
import { resetDeElevationTimer } from "../timer.js";
import { injectCredentials } from "./credentials.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

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
    execute: async (_toolCallId, args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      // Check if already elevated
      const current = await storage.get<boolean>("elevated");
      if (current) {
        return {
          content: [{ type: "text" as const, text: "Already elevated. Sandbox is active." }],
          details: { alreadyElevated: true },
        };
      }

      // Wait for any pending teardown from a previous de-elevation
      const pending = getTeardownPromise();
      if (pending) {
        await pending;
      }

      // Start the sandbox
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
        const { files, envVars, errors } = await injectCredentials(storage, provider);
        if (Object.keys(envVars).length > 0) {
          // Re-start with credential env vars
          await provider.start({ envVars });
        }
        if (errors.length > 0) {
          console.warn("[sandbox] Credential injection errors:", errors);
        }
      } catch (err) {
        console.warn("[sandbox] Credential injection failed:", err);
      }

      // Persist elevation state
      await storage.put("elevated", true);
      await storage.put("elevationReason", args.reason);
      await storage.put("elevatedAt", new Date().toISOString());

      // Start auto-de-elevation timer
      const timeout = args.timeout ?? config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
      await resetDeElevationTimer(provider, config, context, timeout);

      // Broadcast elevation state to UI
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
