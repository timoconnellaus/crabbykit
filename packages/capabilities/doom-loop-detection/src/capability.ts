import {
  type Capability,
  type CapabilityStorage,
  type Static,
  Type,
} from "@claw-for-cloudflare/agent-runtime";
import { stableStringify } from "./stable-stringify.js";

const DEFAULT_THRESHOLD = 3;
const DEFAULT_LOOKBACK = 10;
const STORAGE_KEY_PREFIX = "recent-tool-calls";

/** Serialized record of a tool call for comparison. */
interface ToolCallRecord {
  toolName: string;
  argsSignature: string;
}

/**
 * TypeBox schema for the doom-loop-detection capability's agent-level
 * config namespace. Fields match the legacy `DoomLoopDetectionOptions`
 * one-for-one so consumers can migrate by wiring a single mapping.
 */
export const DoomLoopConfigSchema = Type.Object({
  threshold: Type.Integer({ default: DEFAULT_THRESHOLD, minimum: 1 }),
  lookbackWindow: Type.Integer({ default: DEFAULT_LOOKBACK, minimum: 0 }),
  allowRepeatTools: Type.Array(Type.String(), { default: [] }),
});

export type DoomLoopConfig = Static<typeof DoomLoopConfigSchema>;

export interface DoomLoopDetectionOptions {
  /**
   * Agent-level config mapping. Typically `(c) => c.doomLoop`.
   */
  config?: (agentConfig: Record<string, unknown>) => DoomLoopConfig;

  /** @deprecated Use the agent-level `config` mapping. */
  threshold?: number;
  /** @deprecated Use the agent-level `config` mapping. */
  lookbackWindow?: number;
  /** @deprecated Use the agent-level `config` mapping. */
  allowRepeatTools?: string[];
}

function resolveConfig(
  options: DoomLoopDetectionOptions,
  contextAgentConfig: unknown,
): DoomLoopConfig {
  const mapped = contextAgentConfig as DoomLoopConfig | undefined;
  if (mapped) return mapped;
  return {
    threshold: options.threshold ?? DEFAULT_THRESHOLD,
    lookbackWindow: options.lookbackWindow ?? DEFAULT_LOOKBACK,
    allowRepeatTools: options.allowRepeatTools ?? [],
  };
}

/**
 * Create a doom loop detection capability.
 *
 * Detects when the agent calls the same tool with identical arguments
 * repeatedly and blocks further calls, returning an error to the LLM.
 */
export function doomLoopDetection(options: DoomLoopDetectionOptions = {}): Capability {
  return {
    id: "doom-loop-detection",
    name: "Doom Loop Detection",
    description: "Detects and blocks repeated identical tool calls to prevent runaway agent loops.",
    agentConfigMapping: options.config,
    hooks: {
      beforeToolExecution: async (event, ctx) => {
        const config = resolveConfig(options, ctx.agentConfig);
        const allowRepeatSet = new Set(config.allowRepeatTools);
        const storageKey = `${STORAGE_KEY_PREFIX}:${ctx.sessionId}`;

        if (allowRepeatSet.has(event.toolName)) {
          await recordToolCall(
            ctx.storage,
            storageKey,
            event.toolName,
            event.args,
            config.lookbackWindow,
          );
          return;
        }

        const argsSignature = stableStringify(event.args);
        const recentCalls = await getRecentCalls(ctx.storage, storageKey);

        // Count consecutive identical calls from the tail
        let consecutiveCount = 0;
        for (let i = recentCalls.length - 1; i >= 0; i--) {
          if (
            recentCalls[i].toolName === event.toolName &&
            recentCalls[i].argsSignature === argsSignature
          ) {
            consecutiveCount++;
          } else {
            break;
          }
        }

        await recordToolCall(
          ctx.storage,
          storageKey,
          event.toolName,
          event.args,
          config.lookbackWindow,
        );

        if (consecutiveCount + 1 >= config.threshold) {
          ctx.broadcast?.("doom_loop_detected", {
            toolName: event.toolName,
            count: consecutiveCount + 1,
          });
          return {
            block: true,
            reason: `Doom loop detected: you have called '${event.toolName}' with identical arguments ${consecutiveCount + 1} times. Try a different approach.`,
          };
        }
      },
    },
  };
}

async function getRecentCalls(storage: CapabilityStorage, key: string): Promise<ToolCallRecord[]> {
  const raw = await storage.get<string>(key);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ToolCallRecord[];
  } catch {
    return [];
  }
}

async function recordToolCall(
  storage: CapabilityStorage,
  key: string,
  toolName: string,
  args: unknown,
  lookbackWindow: number,
): Promise<void> {
  const recent = await getRecentCalls(storage, key);
  recent.push({ toolName, argsSignature: stableStringify(args) });
  while (recent.length > lookbackWindow) {
    recent.shift();
  }
  await storage.put(key, JSON.stringify(recent));
}
