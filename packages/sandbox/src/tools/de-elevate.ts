import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { cancelDeElevationTimer } from "../timer.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

export function createDeElevateTool(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "de_elevate",
    description: "Deactivate the sandbox and release resources.",
    parameters: Type.Object({}),
    execute: async () => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const elevated = await storage.get<boolean>("elevated");
      if (!elevated) {
        return {
          content: [{ type: "text" as const, text: "Not currently elevated." }],
          details: { alreadyDeElevated: true },
        };
      }

      // Clear state immediately
      await storage.put("elevated", false);
      await storage.delete("elevationReason");
      await storage.delete("elevatedAt");

      // Cancel auto-de-elevation timer
      await cancelDeElevationTimer(context);

      // Broadcast to UI
      context.broadcast("sandbox_elevation", { elevated: false });

      // Stop provider (fire-and-forget for responsiveness)
      provider.stop().catch(() => {});

      return {
        content: [{ type: "text" as const, text: "Sandbox deactivated. Shell access removed." }],
        details: { elevated: false },
      };
    },
  });
}
