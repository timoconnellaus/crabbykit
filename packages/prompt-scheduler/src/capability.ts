import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { createScheduleTool } from "./tools/create.js";
import { deleteScheduleTool } from "./tools/delete.js";
import { listSchedulesTool } from "./tools/list.js";
import { updateScheduleTool } from "./tools/update.js";

/**
 * Capability that gives agents tools to create, update, delete, and list
 * prompt-based schedules. The agent can autonomously set up recurring tasks.
 */
export function promptScheduler(): Capability {
  return {
    id: "prompt-scheduler",
    name: "Prompt Scheduler",
    description: "Tools for creating and managing scheduled agent prompts.",
    tools: (context: AgentContext) => [
      createScheduleTool(context),
      listSchedulesTool(context),
      updateScheduleTool(context),
      deleteScheduleTool(context),
    ],
    promptSections: () => [
      "You can create, update, delete, and list scheduled prompts. " +
        "Schedules use cron expressions (e.g., '0 9 * * MON-FRI' for weekdays at 9 AM) " +
        "or interval shorthands ('30m', '2h'). " +
        "Each schedule creates a new session and runs the prompt through the full agent loop. " +
        "Use maxDuration to auto-expire temporary schedules (e.g., '3d', '1h').",
    ],
  };
}
