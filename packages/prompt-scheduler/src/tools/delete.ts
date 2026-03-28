import {
  type AgentContext,
  type AgentTool,
  defineTool,
  Type,
} from "@claw-for-cloudflare/agent-runtime";

export function deleteScheduleTool(context: AgentContext): AgentTool {
  return defineTool({
    name: "delete_schedule",
    label: "Delete Schedule",
    description: "Delete an existing schedule. Stops all future executions.",
    parameters: Type.Object({
      id: Type.String({ description: "Schedule ID to delete" }),
    }),
    execute: async (_id, args) => {
      const existing = context.schedules.get(args.id);
      if (!existing) {
        return {
          content: [{ type: "text", text: `Schedule not found: "${args.id}"` }],
          details: { error: "not_found" },
        };
      }

      await context.schedules.delete(args.id);

      return {
        content: [{ type: "text", text: `Schedule "${existing.name}" deleted.` }],
        details: { deleted: args.id },
      };
    },
  }) as unknown as AgentTool;
}
