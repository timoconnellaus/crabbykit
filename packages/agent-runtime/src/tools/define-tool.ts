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
  /** Optional timeout in milliseconds. Tool execution is aborted if it exceeds this duration. */
  timeout?: number;
  execute: (
    args: Static<TParameters>,
    context: ToolExecuteContext,
    // biome-ignore lint/suspicious/noExplicitAny: AgentToolResult generic comes from pi-agent-core type boundary
  ) => Promise<AgentToolResult<any>>;
}): AgentTool<TParameters> {
  const execute = opts.timeout
    ? wrapWithTimeout(opts.execute, opts.timeout, opts.name)
    : opts.execute;

  return {
    name: opts.name,
    label: opts.label ?? opts.name,
    description: opts.description,
    parameters: opts.parameters,
    execute,
  };
}

/**
 * Wrap a tool execute function with a timeout.
 * On timeout, returns an error result instead of the tool's output.
 */
function wrapWithTimeout<TArgs, TCtx>(
  // biome-ignore lint/suspicious/noExplicitAny: AgentToolResult generic comes from pi-agent-core type boundary
  fn: (args: TArgs, ctx: TCtx) => Promise<AgentToolResult<any>>,
  timeoutMs: number,
  toolName: string,
  // biome-ignore lint/suspicious/noExplicitAny: AgentToolResult generic comes from pi-agent-core type boundary
): (args: TArgs, ctx: TCtx) => Promise<AgentToolResult<any>> {
  return (args: TArgs, ctx: TCtx) => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs);
    });
    return Promise.race([fn(args, ctx), timeout]).catch((err) => {
      if (err instanceof ToolTimeoutError) {
        return {
          content: [{ type: "text" as const, text: `Tool '${toolName}' timed out after ${timeoutMs}ms` }],
          details: { error: true, timeout: true },
          isError: true as const,
        };
      }
      throw err;
    });
  };
}

class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool '${toolName}' timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Apply a default timeout to all tools in an array.
 * If a tool already has a per-tool timeout (set via `defineTool({ timeout })`),
 * the per-tool timeout fires first (inner wrapper), making the outer timeout a safety net.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires any
export function applyDefaultTimeout(tools: AgentTool<any>[], timeoutMs: number): AgentTool<any>[] {
  return tools.map((tool) => ({
    ...tool,
    execute: wrapWithTimeout(tool.execute, timeoutMs, tool.name),
  }));
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
