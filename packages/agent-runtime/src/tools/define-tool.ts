import type {
  AgentTool,
  AgentToolResult,
  ToolExecuteContext,
} from "@claw-for-cloudflare/agent-core";
import { type Static, type TObject, type TSchema, Type } from "@sinclair/typebox";

/**
 * Define an agent tool with TypeBox schema and type-safe execute function.
 * Returns a pi-agent-core AgentTool that can be passed directly to Agent.setTools().
 */
export function defineTool<TParameters extends TObject>(opts: {
  name: string;
  description: string;
  parameters: TParameters;
  label?: string;
  execute: (
    args: Static<TParameters>,
    context: ToolExecuteContext,
    // biome-ignore lint/suspicious/noExplicitAny: AgentToolResult generic comes from pi-agent-core type boundary
  ) => Promise<AgentToolResult<any>>;
}): AgentTool<TParameters> {
  return {
    name: opts.name,
    label: opts.label ?? opts.name,
    description: opts.description,
    parameters: opts.parameters,
    execute: opts.execute,
  };
}

/**
 * Convenience helpers for constructing common tool result shapes.
 */
export const toolResult = {
  text(text: string, details?: unknown) {
    return { content: [{ type: "text" as const, text }], details: details ?? {} };
  },
  error(text: string, details?: unknown) {
    return { content: [{ type: "text" as const, text }], details: details ?? { error: true }, isError: true as const };
  },
};

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpServer {
  name: string;
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: unknown; isError?: boolean }>;
}

/**
 * Convert an MCP tool definition to a pi-agent-core AgentTool.
 * Uses Type.Unsafe() to accept the MCP tool's JSON Schema as-is.
 */
export function mcpToolToAgentTool(mcpTool: McpTool, server: McpServer): AgentTool {
  const prefixedName = `mcp_${server.name}_${mcpTool.name}`;

  return {
    name: prefixedName,
    label: prefixedName,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    parameters: Type.Unsafe(mcpTool.inputSchema) as TSchema,
    execute: async (args) => {
      const result = await server.callTool(mcpTool.name, args as Record<string, unknown>);
      const text =
        typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      return {
        content: [{ type: "text" as const, text }],
        details: result,
      };
    },
  };
}
