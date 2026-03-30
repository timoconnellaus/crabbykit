import type { Capability } from "@claw-for-cloudflare/agent-runtime";

const DEFAULT_SESSION_PREFIX = "Heartbeat";
const DEFAULT_RETENTION = 50;

const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists. Follow its instructions strictly. " +
  "Do not infer or repeat old tasks. If nothing needs attention or HEARTBEAT.md does not exist, " +
  "reply with HEARTBEAT_OK.";

export interface HeartbeatOptions {
  /** Interval or cron expression (e.g., "30m", "2h", or a 5-field cron string). */
  every: string;
  /** IANA timezone for schedule evaluation (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
  /** Prefix for heartbeat session names. Defaults to "Heartbeat". */
  sessionPrefix?: string;
  /** Maximum heartbeat sessions to retain. Defaults to 50. */
  retention?: number;
  /** Custom prompt override. Defaults to reading HEARTBEAT.md. */
  prompt?: string;
  /** Whether the heartbeat schedule is enabled on creation. Defaults to false. */
  enabled?: boolean;
}

/**
 * Create a heartbeat capability that schedules recurring autonomous check-ins.
 *
 * On each fire, the agent receives a prompt telling it to read HEARTBEAT.md
 * and follow its instructions. This lets you define ongoing tasks, monitoring
 * checks, or periodic actions in a simple markdown file.
 *
 * The heartbeat schedule is owned by this capability and managed automatically.
 * Consumers can customize the prompt or use `onScheduleFire` on their AgentDO
 * subclass for advanced control (e.g., quiet hours, dedup).
 */
export function heartbeat(options: HeartbeatOptions): Capability {
  return {
    id: "heartbeat",
    name: "Heartbeat",
    description: "Recurring autonomous check-ins on a configurable schedule.",

    schedules: () => [
      {
        id: "heartbeat",
        name: "Heartbeat",
        cron: options.every,
        enabled: options.enabled ?? false,
        prompt: options.prompt ?? HEARTBEAT_PROMPT,
        timezone: options.timezone,
        sessionPrefix: options.sessionPrefix ?? DEFAULT_SESSION_PREFIX,
        retention: options.retention ?? DEFAULT_RETENTION,
      },
    ],

    promptSections: () => [
      [
        "You have a recurring heartbeat schedule. On each check-in, read HEARTBEAT.md in the workspace for instructions.",
        "If HEARTBEAT.md does not exist or has no actionable items, respond with HEARTBEAT_OK.",
        "Do not repeat tasks you have already completed in previous heartbeat sessions.",
      ].join(" "),
    ],
  };
}
