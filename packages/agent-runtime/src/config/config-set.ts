import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CapabilityHookContext } from "../capabilities/types.js";
import { defineTool, toolResult } from "../tools/define-tool.js";
import type { ConfigNamespace } from "./config-namespace.js";
import type { ConfigContext } from "./types.js";

/**
 * Format TypeBox validation errors into a human-readable string.
 */
function formatErrors(schema: unknown, value: unknown): string {
  const errors = [...Value.Errors(schema as Parameters<typeof Value.Errors>[0], value)];
  if (errors.length === 0) return "Validation failed";
  return errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}

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
 * Create the config_set tool that updates agent configuration by namespace.
 */
export function createConfigSet(ctx: ConfigContext) {
  const namespaceList = [
    "capability:{id}",
    "session",
    ...ctx.namespaces.map((ns) => ns.id),
  ];

  return defineTool({
    name: "config_set",
    description: [
      "Update the agent's configuration for a given namespace.",
      "The value is validated against the config schema.",
      "Use config_schema to inspect the expected shape before setting.",
      "For capabilities, use 'capability:{id}' namespace.",
      "To rename session: config_set('session', { name: '...' }).",
    ].join(" "),
    parameters: Type.Object({
      namespace: Type.String({ description: "Config namespace to update." }),
      value: Type.Unknown({ description: "The new configuration value." }),
    }),
    execute: async ({ namespace, value: rawValue }) => {
      // LLMs sometimes stringify JSON objects — parse them back
      let value = rawValue;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          // keep as string
        }
      }

      // capability:{id} — per-capability config
      const capMatch = namespace.match(/^capability:(.+)$/);
      if (capMatch) {
        const id = capMatch[1];
        const cap = ctx.capabilities.find((c) => c.id === id);
        if (!cap) return toolResult.error(`Unknown capability: ${id}`);

        if (!cap.configSchema) {
          return toolResult.error(`Capability "${id}" does not accept configuration.`);
        }

        if (!Value.Check(cap.configSchema, value)) {
          const hint = formatErrors(cap.configSchema, value);
          return toolResult.error(
            `Validation error: ${hint}\nExpected schema: ${JSON.stringify(cap.configSchema, null, 2)}`,
          );
        }

        // Fire onConfigChange if the capability defines it
        if (cap.hooks?.onConfigChange) {
          const oldConfig =
            (await ctx.configStore.getCapabilityConfig<Record<string, unknown>>(id)) ??
            cap.configDefault ??
            {};
          const hookContext: CapabilityHookContext = {
            sessionId: ctx.sessionId,
            sessionStore: ctx.sessionStore,
            storage: { get: async () => undefined, put: async () => {}, delete: async () => false, list: async () => new Map() },
          };
          try {
            await cap.hooks.onConfigChange(
              oldConfig,
              value as Record<string, unknown>,
              hookContext,
            );
          } catch (err) {
            return toolResult.error(
              `Error in ${cap.name} onConfigChange: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        await ctx.configStore.setCapabilityConfig(id, value);
        return toolResult.text(`Configuration updated: ${namespace}`);
      }

      // session — rename
      if (namespace === "session") {
        const input = value as Record<string, unknown> | null;
        if (!input || typeof input !== "object" || typeof input.name !== "string") {
          return toolResult.error('Expected { name: "..." }.');
        }
        const name = input.name as string;
        if (name.length === 0 || name.length > 200) {
          return toolResult.error("Session name must be 1-200 characters.");
        }
        ctx.sessionStore.rename(ctx.sessionId, name);
        return toolResult.text(`Session renamed to: ${name}`);
      }

      // Capability-contributed and consumer namespaces (exact + pattern)
      const ns = findNamespace(namespace, ctx.namespaces);
      if (ns) {
        // For exact-match namespaces, validate against schema
        // For pattern-matched namespaces, the capability handles its own validation
        if (!ns.pattern && !Value.Check(ns.schema, value)) {
          const hint = formatErrors(ns.schema, value);
          return toolResult.error(
            `Validation error: ${hint}\nExpected schema: ${JSON.stringify(ns.schema, null, 2)}`,
          );
        }
        try {
          const result = await ns.set(namespace, value);
          return toolResult.text(
            typeof result === "string" ? result : `Configuration updated: ${namespace}`,
          );
        } catch (err) {
          return toolResult.error(
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return toolResult.error(
        `Unknown namespace: ${namespace}. Available: ${namespaceList.join(", ")}`,
      );
    },
  });
}
