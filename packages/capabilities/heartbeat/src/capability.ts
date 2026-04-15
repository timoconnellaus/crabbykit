import type { Capability } from "@claw-for-cloudflare/agent-runtime";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const DEFAULT_SESSION_PREFIX = "Heartbeat";
const DEFAULT_RETENTION = 50;
const DEFAULT_EVERY = "1h";

const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists. Follow its instructions strictly. " +
  "Do not infer or repeat old tasks. If nothing needs attention or HEARTBEAT.md does not exist, " +
  "reply with HEARTBEAT_OK.";

/**
 * TypeBox schema for the heartbeat capability's agent-level config
 * namespace. Exported so consumers can wire it into `defineAgent`'s
 * `config` field and pass the corresponding slice via the capability
 * factory's `config` mapping parameter.
 */
export const HeartbeatConfigSchema = Type.Object({
  every: Type.String({ default: DEFAULT_EVERY }),
  timezone: Type.Optional(Type.String()),
  sessionPrefix: Type.String({ default: DEFAULT_SESSION_PREFIX }),
  retention: Type.Integer({ default: DEFAULT_RETENTION, minimum: 1 }),
  prompt: Type.String({ default: HEARTBEAT_PROMPT }),
  enabled: Type.Boolean({ default: false }),
});

export type HeartbeatConfig = Static<typeof HeartbeatConfigSchema>;

export interface HeartbeatOptions {
  /**
   * Agent-level config mapping. Receives the full agent config record
   * declared on `defineAgent` and returns the slice this capability
   * cares about — typically `(c) => c.heartbeat`. When supplied the
   * runtime injects the mapped slice onto `context.agentConfig` and
   * fires `onAgentConfigChange` whenever it changes.
   */
  config?: (agentConfig: Record<string, unknown>) => HeartbeatConfig;

  /**
   * @deprecated Prefer wiring the schedule via the agent-level `config`
   * field on `defineAgent` and the `config` mapping parameter above.
   * These fields remain for one release as a fallback for consumers who
   * haven't migrated yet.
   */
  every?: string;
  /** @deprecated Use the mapped agent config. */
  timezone?: string;
  /** @deprecated Use the mapped agent config. */
  sessionPrefix?: string;
  /** @deprecated Use the mapped agent config. */
  retention?: number;
  /** @deprecated Use the mapped agent config. */
  prompt?: string;
  /** @deprecated Use the mapped agent config. */
  enabled?: boolean;
}

function resolveConfig(options: HeartbeatOptions, sliceFromCtx: unknown): HeartbeatConfig {
  const mapped = sliceFromCtx as HeartbeatConfig | undefined;
  if (mapped) return mapped;
  const fallback = {
    every: options.every ?? DEFAULT_EVERY,
    timezone: options.timezone,
    sessionPrefix: options.sessionPrefix ?? DEFAULT_SESSION_PREFIX,
    retention: options.retention ?? DEFAULT_RETENTION,
    prompt: options.prompt ?? HEARTBEAT_PROMPT,
    enabled: options.enabled ?? false,
  };
  return Value.Cast(HeartbeatConfigSchema, fallback);
}

/**
 * Create a heartbeat capability that schedules recurring autonomous check-ins.
 *
 * On each fire, the agent receives a prompt telling it to read HEARTBEAT.md
 * and follow its instructions. The schedule is recomputed whenever the
 * mapped agent config changes (cron interval, timezone, enabled flag).
 */
export function heartbeat(options: HeartbeatOptions = {}): Capability {
  return {
    id: "heartbeat",
    name: "Heartbeat",
    description: "Recurring autonomous check-ins on a configurable schedule.",
    agentConfigMapping: options.config,

    schedules: (context) => {
      const config = resolveConfig(options, context.agentConfig);
      return [
        {
          id: "heartbeat",
          name: "Heartbeat",
          cron: config.every,
          enabled: config.enabled,
          prompt: config.prompt,
          timezone: config.timezone,
          sessionPrefix: config.sessionPrefix,
          retention: config.retention,
        },
      ];
    },

    promptSections: () => [
      [
        "You have a recurring heartbeat schedule. On each check-in, read HEARTBEAT.md in the workspace for instructions.",
        "If HEARTBEAT.md does not exist or has no actionable items, respond with HEARTBEAT_OK.",
        "Do not repeat tasks you have already completed in previous heartbeat sessions.",
      ].join(" "),
    ],

    hooks: {
      onAgentConfigChange: async (_oldSlice, _newSlice, _ctx) => {
        // The runtime's config-change dispatcher re-runs
        // syncCapabilitySchedules for every change, so the heartbeat
        // schedule is reshaped automatically when cron / enabled /
        // timezone change. Keep the hook declared so future derived
        // state (e.g. rolled-over session prefix renames) has a hook
        // to attach to.
      },
    },
  };
}
