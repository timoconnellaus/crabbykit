import type { AgentContext } from "@crabbykit/agent-runtime";
import { defineTool, Type } from "@crabbykit/agent-runtime";
import {
  clearSessionElevation,
  isAnySessionElevated,
  isSessionElevated,
} from "../session-state.js";
import { setTeardownPromise } from "../teardown.js";
import { cancelDeElevationTimer } from "../timer.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

export function createDeElevateTool(
  provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "de_elevate",
    description: "Deactivate the sandbox and release resources.",
    guidance:
      "Explicitly deactivate the sandbox when you're done with shell access. This releases container resources. The sandbox also auto-deactivates after idle timeout, but prefer explicit de-elevation when you know you're finished.",
    parameters: Type.Object({}),
    execute: async () => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      // Check if THIS session is elevated
      const elevated = await isSessionElevated(storage, context.sessionId);
      if (!elevated) {
        return {
          content: [{ type: "text" as const, text: "Not currently elevated." }],
          details: { alreadyDeElevated: true },
        };
      }

      // Clear THIS session's elevation state
      await clearSessionElevation(storage, context.sessionId);

      // Broadcast to THIS session's UI
      context.broadcast("sandbox_elevation", { elevated: false });

      // Only stop the container if no other sessions are still elevated
      const othersElevated = await isAnySessionElevated(storage);
      if (!othersElevated) {
        await cancelDeElevationTimer(context);
        const teardown = provider.stop().catch(() => {});
        setTeardownPromise(teardown);
      }

      return {
        content: [{ type: "text" as const, text: "Sandbox deactivated. Shell access removed." }],
        details: { elevated: false },
      };
    },
  });
}
