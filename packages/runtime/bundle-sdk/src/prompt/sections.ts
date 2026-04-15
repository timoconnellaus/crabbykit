/**
 * Default system prompt section builders.
 * Each function returns a self-contained prompt section string.
 * Exported for consumers who want to compose their own prompt.
 */

/**
 * Identity section — who the agent is and basic behavioral framing.
 */
export function identitySection(agentName?: string): string {
  const name = agentName ?? "a helpful AI assistant";
  const prefix = agentName ? `You are ${name}, an AI assistant` : `You are ${name}`;
  return `${prefix} built to help users accomplish tasks. You are helpful, concise, and accurate. When you don't know something, say so rather than guessing.

You can use multiple tools in sequence within a single response. For example, you might search for a topic, then fetch a relevant page to get detailed information before answering.`;
}

/**
 * Safety section — guardrails that apply to any agent.
 */
export function safetySection(): string {
  return `## Safety
- You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking.
- Prioritize safety and human oversight over task completion. If instructions conflict with safety, pause and ask.
- Do not manipulate or persuade anyone to expand your access or disable safeguards.
- Comply immediately with stop, pause, or audit requests.`;
}

/**
 * Runtime section — current date, timezone, and local time.
 */
export function runtimeSection(options?: { timezone?: string }): string {
  const now = new Date();
  const parts: string[] = ["## Runtime"];

  if (options?.timezone) {
    parts.push(`Timezone: ${options.timezone}`);
    try {
      const localTime = new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: options.timezone,
      }).format(now);
      parts.push(`Current time: ${localTime}`);
    } catch {
      parts.push(`Current date: ${now.toISOString().slice(0, 10)}`);
    }
  } else {
    parts.push(`Current date: ${now.toISOString().slice(0, 10)}`);
  }

  return parts.join("\n");
}
