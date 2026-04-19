import type { AgentToolResult, AnyAgentTool, ToolExecuteContext } from "@crabbykit/agent-core";
import { type Static, type TObject, type TSchema, Type } from "@sinclair/typebox";

/** Return type accepted by `defineTool()` execute functions. */
export type ToolExecuteReturn = string | AgentToolResult<unknown>;

/** Wrap a string return into a full AgentToolResult. */
function wrapStringResult(result: ToolExecuteReturn): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return { content: [{ type: "text" as const, text: result }], details: null };
  }
  return result;
}

/**
 * Define an agent tool with TypeBox schema and type-safe execute function.
 * Returns an AnyAgentTool assignable to Capability.tools() without casts.
 *
 * The `execute` function can return either:
 * - A plain string (auto-wrapped into `{ content: [{ type: "text", text }], details: null }`)
 * - A full `AgentToolResult` for complex cases (images, structured details, isError)
 */
export function defineTool<TParameters extends TObject>(opts: {
  name: string;
  description: string;
  /** Behavioral instructions injected into the system prompt. Unlike `description`
   *  (which goes to the API tool definition), `guidance` provides detailed usage
   *  instructions. Falls back to `description` if unset. */
  guidance?: string;
  parameters: TParameters;
  label?: string;
  /** Optional timeout in milliseconds. Tool execution is aborted if it exceeds this duration. */
  timeout?: number;
  execute: (args: Static<TParameters>, context: ToolExecuteContext) => Promise<ToolExecuteReturn>;
}): AnyAgentTool {
  const userExecute = opts.execute;
  const wrappedExecute = async (args: unknown, ctx: ToolExecuteContext) => {
    const result = await userExecute(args as Static<TParameters>, ctx);
    return wrapStringResult(result);
  };

  const execute = opts.timeout
    ? wrapWithTimeout(wrappedExecute, opts.timeout, opts.name)
    : wrappedExecute;

  return {
    name: opts.name,
    label: opts.label ?? opts.name,
    description: opts.description,
    guidance: opts.guidance,
    parameters: opts.parameters,
    execute,
  };
}

/**
 * Wrap a tool execute function with a timeout.
 * On timeout, returns an error result instead of the tool's output.
 */
function wrapWithTimeout(
  fn: (args: unknown, ctx: ToolExecuteContext) => Promise<AgentToolResult<unknown>>,
  timeoutMs: number,
  toolName: string,
): (args: unknown, ctx: ToolExecuteContext) => Promise<AgentToolResult<unknown>> {
  return (args: unknown, ctx: ToolExecuteContext) => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs);
    });
    return Promise.race([fn(args, ctx), timeout]).catch((err) => {
      if (err instanceof ToolTimeoutError) {
        return {
          content: [
            { type: "text" as const, text: `Tool '${toolName}' timed out after ${timeoutMs}ms` },
          ],
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
export function applyDefaultTimeout(tools: AnyAgentTool[], timeoutMs: number): AnyAgentTool[] {
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
    return {
      content: [{ type: "text" as const, text }],
      details: details ?? { error: true },
      isError: true as const,
    };
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
export function mcpToolToAgentTool(mcpTool: McpTool, server: McpServer): AnyAgentTool {
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
