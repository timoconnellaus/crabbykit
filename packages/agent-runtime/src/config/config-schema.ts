import { Type } from "@sinclair/typebox";
import { defineTool, toolResult } from "../tools/define-tool.js";
import type { ConfigContext } from "./types.js";

/** Schema for session config. */
const SESSION_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["name"],
};

/**
 * Create the config_schema tool that returns JSON Schema for config namespaces.
 */
export function createConfigSchema(ctx: ConfigContext) {
  return defineTool({
    name: "config_schema",
    description: [
      "Return configuration schema.",
      "Pass a namespace to get its schema, or omit for the full schema listing.",
      "Use this to understand what configuration options are available before using config_set.",
    ].join(" "),
    parameters: Type.Object({
      namespace: Type.Optional(
        Type.String({
          description:
            "Optional: get schema for a specific namespace (e.g. 'session', 'capability:my-cap'). Omit for full schema.",
        }),
      ),
    }),
    execute: async ({ namespace }) => {
      // Single namespace lookup
      if (namespace) {
        const schema = resolveSchema(namespace, ctx);
        if (!schema) return toolResult.error(`Unknown namespace: ${namespace}`);
        return toolResult.text(JSON.stringify(schema, null, 2));
      }

      // Full schema listing
      const result: Record<string, unknown> = {
        session: SESSION_SCHEMA,
      };

      // Capabilities
      const capabilities: Record<string, unknown> = {};
      for (const cap of ctx.capabilities) {
        capabilities[cap.id] = {
          id: cap.id,
          name: cap.name,
          description: cap.description,
          configSchema: cap.configSchema ?? null,
        };
      }
      result.capabilities = capabilities;

      // Capability-contributed and consumer namespaces
      for (const ns of ctx.namespaces) {
        result[ns.id] = {
          description: ns.description,
          schema: ns.schema,
        };
      }

      return toolResult.text(JSON.stringify(result, null, 2));
    },
  });
}

function resolveSchema(namespace: string, ctx: ConfigContext): unknown | null {
  if (namespace === "session") return SESSION_SCHEMA;

  const capMatch = namespace.match(/^capability:(.+)$/);
  if (capMatch) {
    const cap = ctx.capabilities.find((c) => c.id === capMatch[1]);
    if (!cap) return null;
    return cap.configSchema ?? { type: "object", description: `${cap.name} does not accept configuration.` };
  }

  const ns = ctx.namespaces.find((n) => n.id === namespace);
  if (ns) return ns.schema;

  return null;
}
