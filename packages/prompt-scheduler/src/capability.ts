import type { AgentContext, Capability, ConfigNamespace } from "@claw-for-cloudflare/agent-runtime";
import { Type, validateCron } from "@claw-for-cloudflare/agent-runtime";

/** Schema for schedule creation via config_set('schedules', { ... }). */
const SCHEDULE_CREATE_SCHEMA = Type.Object({
  name: Type.String({ description: "Schedule name." }),
  cron: Type.String({
    description:
      'Cron expression (5-field: "minute hour dom month dow") or interval shorthand ("30m", "2h").',
  }),
  prompt: Type.String({ description: "Prompt to send when the schedule fires." }),
  enabled: Type.Optional(
    Type.Boolean({ description: "Whether the schedule is active. Default: true." }),
  ),
  timezone: Type.Optional(
    Type.String({ description: "IANA timezone (e.g. Australia/Sydney). Default: UTC." }),
  ),
  maxDuration: Type.Optional(
    Type.String({ description: 'Auto-expire after this duration (e.g. "15m", "3d").' }),
  ),
});

/** Schema shown for schedule:{id} updates (informational — validation is done in set). */
const SCHEDULE_UPDATE_SCHEMA = Type.Object({
  name: Type.Optional(Type.String()),
  cron: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  timezone: Type.Optional(Type.String()),
});

const SCHEDULE_ID_PATTERN = /^schedule:(.+)$/;

/**
 * Capability that gives agents the ability to manage scheduled prompts
 * through the config namespace interface.
 *
 * Registers `schedules` and `schedule:{id}` config namespaces for CRUD
 * and adds a prompt section explaining scheduling to the agent.
 */
export function promptScheduler(): Capability {
  return {
    id: "prompt-scheduler",
    name: "Prompt Scheduler",
    description: "Manage scheduled agent prompts via config namespaces.",
    configNamespaces: (context: AgentContext): ConfigNamespace[] => [
      // "schedules" — list all or create new
      {
        id: "schedules",
        description: "List all schedules (get) or create a new schedule (set).",
        schema: SCHEDULE_CREATE_SCHEMA,
        get: async () => context.schedules.list(),
        set: async (_namespace, value) => {
          const input = value as {
            name: string;
            cron: string;
            prompt: string;
            enabled?: boolean;
            timezone?: string;
            maxDuration?: string;
          };

          if (!validateCron(input.cron)) {
            throw new Error(
              `Invalid cron expression: "${input.cron}". ` +
                'Use 5-field format (minute hour dom month dow) or interval shorthand ("30m", "2h").',
            );
          }

          const schedule = await context.schedules.create({
            id: `sched-${crypto.randomUUID()}`,
            name: input.name,
            cron: input.cron,
            prompt: input.prompt,
            timezone: input.timezone,
            maxDuration: input.maxDuration,
          });

          return `Schedule "${schedule.name}" created (id: ${schedule.id}). Next fire: ${schedule.nextFireAt ?? "pending"}.`;
        },
      },
      // "schedule:{id}" — read, update, or delete a specific schedule
      {
        id: "schedule:{id}",
        description:
          "Read, update, or delete a specific schedule. Use config_set('schedule:{id}', null) to delete.",
        schema: SCHEDULE_UPDATE_SCHEMA,
        pattern: SCHEDULE_ID_PATTERN,
        get: async (namespace) => {
          const match = namespace.match(SCHEDULE_ID_PATTERN);
          if (!match) return null;
          return context.schedules.get(match[1]);
        },
        set: async (namespace, value) => {
          const match = namespace.match(SCHEDULE_ID_PATTERN);
          if (!match) throw new Error("Invalid schedule namespace format.");
          const id = match[1];

          // Delete
          if (value === null) {
            const existing = context.schedules.get(id);
            if (!existing) throw new Error(`Schedule not found: ${id}`);
            await context.schedules.delete(id);
            return `Schedule "${existing.name}" deleted.`;
          }

          // Update
          const updates = value as Record<string, unknown>;
          if (typeof updates.cron === "string" && !validateCron(updates.cron)) {
            throw new Error(
              `Invalid cron expression: "${updates.cron}". ` +
                'Use 5-field format or interval shorthand ("30m", "2h").',
            );
          }

          const schedule = await context.schedules.update(id, {
            ...(typeof updates.name === "string" ? { name: updates.name } : {}),
            ...(typeof updates.cron === "string" ? { cron: updates.cron } : {}),
            ...(typeof updates.prompt === "string" ? { prompt: updates.prompt } : {}),
            ...(typeof updates.enabled === "boolean" ? { enabled: updates.enabled } : {}),
            ...(typeof updates.timezone === "string" ? { timezone: updates.timezone } : {}),
          });

          if (!schedule) throw new Error(`Schedule not found: ${id}`);
          return `Schedule "${schedule.name}" updated. Next fire: ${schedule.nextFireAt ?? "pending"}.`;
        },
      },
    ],
    promptSections: () => [
      "You can create, update, delete, and list scheduled prompts using config tools. " +
        "Use config_set('schedules', { name, cron, prompt }) to create a schedule. " +
        "Use config_get('schedules') to list all schedules. " +
        "Use config_set('schedule:{id}', { ... }) to update, or config_set('schedule:{id}', null) to delete. " +
        "Schedules use cron expressions (e.g., '0 9 * * MON-FRI' for weekdays at 9 AM) " +
        "or interval shorthands ('30m', '2h'). " +
        "Each schedule creates a new session and runs the prompt through the full agent loop. " +
        "Use maxDuration to auto-expire temporary schedules (e.g., '3d', '1h').",
    ],
  };
}
