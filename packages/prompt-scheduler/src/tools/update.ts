import {
  type AgentContext,
  type AgentTool,
  defineTool,
  Type,
  validateCron,
} from "@claw-for-cloudflare/agent-runtime";

export function updateScheduleTool(context: AgentContext): AgentTool {
  return defineTool({
    name: "update_schedule",
    label: "Update Schedule",
    description: "Update an existing schedule's cron, prompt, enabled state, or other settings.",
    parameters: Type.Object({
      id: Type.String({ description: "Schedule ID to update" }),
      cron: Type.Optional(Type.String({ description: "New cron expression or interval" })),
      prompt: Type.Optional(Type.String({ description: "New prompt text" })),
      enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the schedule" })),
      name: Type.Optional(Type.String({ description: "New schedule name" })),
      timezone: Type.Optional(Type.String({ description: "New IANA timezone" })),
    }),
    execute: async (_id, args) => {
      if (args.cron && !validateCron(args.cron)) {
        return {
          content: [{ type: "text", text: `Invalid cron expression: "${args.cron}"` }],
          details: { error: "invalid_cron" },
        };
      }

      const schedule = await context.schedules.update(args.id, {
        ...(args.cron !== undefined ? { cron: args.cron } : {}),
        ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
      });

      if (!schedule) {
        return {
          content: [{ type: "text", text: `Schedule not found: "${args.id}"` }],
          details: { error: "not_found" },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Schedule "${schedule.name}" updated. Next fire: ${schedule.nextFireAt ?? "pending"}.`,
          },
        ],
        details: { schedule },
      };
    },
  }) as unknown as AgentTool;
}
