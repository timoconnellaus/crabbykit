import { Type } from "@sinclair/typebox";
import { defineTool, toolResult } from "../tools/define-tool.js";
import type { ConfigNamespace } from "./config-namespace.js";
import type { ConfigContext } from "./types.js";

/** Find a namespace by exact id or pattern match. */
function findNamespace(
  namespace: string,
  namespaces: ConfigNamespace[],
): ConfigNamespace | undefined {
  return (
    namespaces.find((ns) => ns.id === namespace) ??
    namespaces.find((ns) => ns.pattern?.test(namespace))
  );
}

/**
 * Create the config_get tool that reads agent configuration by namespace.
 */
export function createConfigGet(ctx: ConfigContext) {
  const namespaceList = ["capability:{id}", "session", ...ctx.namespaces.map((ns) => ns.id)];

  return defineTool({
    name: "config_get",
    description: [
      "Read the agent's configuration for a given namespace.",
      "Use this to check current settings before making changes.",
      `Available namespaces: ${namespaceList.join(", ")}.`,
    ].join(" "),
    guidance:
      "Read the current configuration for a given namespace. Use this to check current settings before making changes with config_set. Available namespaces include capability-specific configs and session settings.",
    parameters: Type.Object({
      namespace: Type.String({
        description: `Config namespace to read (e.g. ${namespaceList.slice(0, 3).join(", ")}).`,
      }),
    }),
    execute: async ({ namespace }) => {
      // capability:{id} — per-capability config
      const capMatch = namespace.match(/^capability:(.+)$/);
      if (capMatch) {
        const id = capMatch[1];
        const cap = ctx.capabilities.find((c) => c.id === id);
        if (!cap) return toolResult.error(`Unknown capability: ${id}`);
        const config = (await ctx.configStore.getCapabilityConfig(id)) ?? cap.configDefault ?? {};
        return toolResult.text(JSON.stringify(config, null, 2));
      }

      // session — session name
      if (namespace === "session") {
        const session = ctx.sessionStore.get(ctx.sessionId);
        const name = session?.name ?? "";
        return toolResult.text(JSON.stringify({ name }, null, 2));
      }

      // Capability-contributed and consumer namespaces (exact + pattern)
      const ns = findNamespace(namespace, ctx.namespaces);
      if (ns) {
        const value = await ns.get(namespace);
        return toolResult.text(JSON.stringify(value ?? {}, null, 2));
      }

      return toolResult.error(
        `Unknown namespace: ${namespace}. Available: ${namespaceList.join(", ")}`,
      );
    },
  });
}
