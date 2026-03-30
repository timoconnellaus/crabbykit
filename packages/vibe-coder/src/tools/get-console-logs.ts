import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";

export function createGetConsoleLogsTool(
  context: AgentContext,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "get_console_logs",
    description:
      "Retrieve console logs from the preview iframe. " +
      "Useful for debugging errors, warnings, and other output from the running app.",
    parameters: Type.Object({
      level: Type.Optional(
        Type.String({
          description:
            'Filter by log level: "all", "error", "warn", "info", or "log". Defaults to "all".',
        }),
      ),
    }),
    execute: async ({ level }) => {
      try {
        const response = await context.requestFromClient("get_console_logs", {
          level: level ?? "all",
        });

        if (response._error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Could not retrieve logs: ${response.message ?? "Unknown error"}`,
              },
            ],
            details: null,
          };
        }

        const logs = response.logs as
          | Array<{ level: string; text: string; ts: number }>
          | undefined;

        if (!logs || logs.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No console logs captured." }],
            details: null,
          };
        }

        const formatted = logs
          .map((entry) => `[${entry.level.toUpperCase()}] ${entry.text}`)
          .join("\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { count: logs.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to retrieve console logs: ${message}`,
            },
          ],
          details: null,
        };
      }
    },
  });
}
