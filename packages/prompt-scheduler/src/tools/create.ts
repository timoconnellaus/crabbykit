import {
  type AgentContext,
  type AgentTool,
  defineTool,
  Type,
  validateCron,
} from "@claw-for-cloudflare/agent-runtime";

export function createScheduleTool(context: AgentContext): AgentTool {
  return defineTool({
    name: "create_schedule",
    label: "Create Schedule",
    description:
      "Create a new scheduled prompt. The prompt will run on the specified cron schedule, " +
      "creating a new session each time. Use maxDuration to auto-expire temporary schedules.",
    parameters: Type.Object({
      name: Type.String({ description: "Human-readable name for the schedule" }),
      cron: Type.String({
        description:
          'Cron expression (e.g., "0 9 * * MON-FRI") or interval shorthand ("30m", "2h")',
      }),
      prompt: Type.String({ description: "The prompt to run on each scheduled execution" }),
      timezone: Type.Optional(
        Type.String({ description: 'IANA timezone (e.g., "America/New_York"). Defaults to UTC.' }),
      ),
      maxDuration: Type.Optional(
        Type.String({ description: 'Auto-expire after this duration (e.g., "15m", "3d", "1h")' }),
      ),
    }),
    execute: async (_id, args) => {
      if (!validateCron(args.cron)) {
        return {
          content: [{ type: "text", text: `Invalid cron expression: "${args.cron}"` }],
          details: { error: "invalid_cron" },
        };
      }

      const schedule = await context.schedules.create({
        id: `sched-${Date.now()}`,
        name: args.name,
        cron: args.cron,
        prompt: args.prompt,
        timezone: args.timezone,
        maxDuration: args.maxDuration,
      });

      return {
        content: [
          {
            type: "text",
            text: `Schedule "${schedule.name}" created (id: ${schedule.id}). Next fire: ${schedule.nextFireAt ?? "pending"}.`,
          },
        ],
        details: { schedule },
      };
    },
  }) as unknown as AgentTool;
}
