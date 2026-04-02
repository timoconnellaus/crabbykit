import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, toolResult } from "@claw-for-cloudflare/agent-runtime";
import { Type } from "@sinclair/typebox";

const MAX_BATCH_SIZE = 25;
const BATCH_TOOL_NAME = "batch";

/** Result of a single sub-call within a batch. */
interface SubCallResult {
  tool: string;
  success: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: AgentToolResult generic is opaque from sub-call
  result?: { content: Array<{ type: string; text?: string }>; details: any };
  error?: string;
}

export interface BatchToolOptions {
  /**
   * Function that returns the current tool list for the session.
   * Called at execution time to resolve sub-call tools.
   *
   * @example
   * ```ts
   * batchTool({
   *   getTools: () => this.resolveToolsForSession(sessionId).tools,
   * })
   * ```
   */
  getTools: () => AgentTool[];
}

/**
 * Create a batch tool capability for parallel tool execution.
 *
 * The `batch` tool allows the LLM to explicitly execute multiple tool calls
 * in parallel via `Promise.all`. Each sub-call runs through the same execution
 * pipeline as a direct call.
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     batchTool({
 *       getTools: () => this.resolveToolsForSession(sessionId).tools,
 *     }),
 *   ];
 * }
 * ```
 */
export function batchTool(options: BatchToolOptions): Capability {
  return {
    id: "batch-tool",
    name: "Batch Tool",
    description: "Parallel execution of multiple tool calls.",
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast
    tools: (): AgentTool<any>[] => [
      defineTool({
        name: BATCH_TOOL_NAME,
        description:
          "Execute multiple tool calls in parallel. Each call runs independently — failures in one do not affect others. Maximum 25 calls per batch.",
        parameters: Type.Object({
          calls: Type.Array(
            Type.Object({
              tool: Type.String({ description: "Name of the tool to call" }),
              args: Type.Record(Type.String(), Type.Unknown(), {
                description: "Arguments to pass to the tool",
              }),
            }),
            { maxItems: MAX_BATCH_SIZE },
          ),
        }),
        execute: async (args) => {
          const { calls } = args;

          if (calls.length === 0) {
            return toolResult.text("Batch completed: 0 calls (empty batch).");
          }

          if (calls.length > MAX_BATCH_SIZE) {
            return toolResult.error(
              `Batch limited to ${MAX_BATCH_SIZE} tool calls, received ${calls.length}`,
            );
          }

          const tools = options.getTools();

          const results = await Promise.all(
            calls.map(async (call): Promise<SubCallResult> => {
              // Block self-referential calls
              if (call.tool === BATCH_TOOL_NAME) {
                return {
                  tool: call.tool,
                  success: false,
                  error: "Recursive batch calls are not allowed",
                };
              }

              const tool = tools.find((t) => t.name === call.tool);
              if (!tool) {
                return {
                  tool: call.tool,
                  success: false,
                  error: `Tool '${call.tool}' not found`,
                };
              }

              try {
                const result = await tool.execute(call.args, { toolCallId: `batch-${call.tool}` });
                return { tool: call.tool, success: true, result };
              } catch (err) {
                return {
                  tool: call.tool,
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }),
          );

          const succeeded = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;

          const summary = results.map((r, i) => {
            if (r.success && r.result) {
              const text =
                r.result.content
                  .filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
                  .map((c: { type: string; text?: string }) => c.text)
                  .join("\n") || "(no text output)";
              return `[${i}] ${r.tool}: OK\n${text}`;
            }
            return `[${i}] ${r.tool}: ERROR — ${r.error}`;
          });

          return toolResult.text(
            `Batch completed: ${succeeded} succeeded, ${failed} failed.\n\n${summary.join("\n\n")}`,
            { results: results.map(({ tool, success, error }) => ({ tool, success, error })) },
          );
        },
      }),
    ],
    promptSections: () => [
      "You have access to the `batch` tool for executing multiple tool calls in parallel. Use it when you have independent operations that can run concurrently (e.g., multiple file reads, multiple searches). Maximum 25 calls per batch.",
    ],
  };
}
