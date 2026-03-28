import {
  type AgentContext,
  type AgentTool,
  defineTool,
  Type,
} from "@claw-for-cloudflare/agent-runtime";

export function listSchedulesTool(context: AgentContext): AgentTool {
  return defineTool({
    name: "list_schedules",
    label: "List Schedules",
    description:
      "List all scheduled prompts with their status, cron expression, and next fire time.",
    parameters: Type.Object({}),
    execute: async () => {
      const schedules = context.schedules.list();

      if (schedules.length === 0) {
        return {
          content: [{ type: "text", text: "No schedules configured." }],
          details: { schedules: [] },
        };
      }

      const lines = schedules.map(
        (s) =>
          `- **${s.name}** (${s.id}): \`${s.cron}\` | ${s.enabled ? "enabled" : "disabled"} | ${s.status} | next: ${s.nextFireAt ?? "none"}${s.expiresAt ? ` | expires: ${s.expiresAt}` : ""}`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { schedules },
      };
    },
  }) as unknown as AgentTool;
}
