import type { Capability, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { Type } from "@sinclair/typebox";
import { stableStringify } from "./stable-stringify.js";

const DEFAULT_THRESHOLD = 3;
const DEFAULT_LOOKBACK = 10;
const STORAGE_KEY_PREFIX = "recent-tool-calls";

/** Serialized record of a tool call for comparison. */
interface ToolCallRecord {
  toolName: string;
  argsSignature: string;
}

export interface DoomLoopDetectionOptions {
  /** Number of consecutive identical calls before blocking (default 3). */
  threshold?: number;
  /** Number of recent tool calls to track (default 10). */
  lookbackWindow?: number;
  /** Tool names that are exempt from doom loop detection. */
  allowRepeatTools?: string[];
}

/**
 * Create a doom loop detection capability.
 *
 * Detects when the agent calls the same tool with identical arguments
 * repeatedly and blocks further calls, returning an error to the LLM.
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     doomLoopDetection({ threshold: 3 }),
 *   ];
 * }
 * ```
 */
export function doomLoopDetection(options: DoomLoopDetectionOptions = {}): Capability {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const lookbackWindow = options.lookbackWindow ?? DEFAULT_LOOKBACK;
  const allowRepeatSet = new Set(options.allowRepeatTools ?? []);

  return {
    id: "doom-loop-detection",
    name: "Doom Loop Detection",
    description: "Detects and blocks repeated identical tool calls to prevent runaway agent loops.",
    configSchema: Type.Object({
      threshold: Type.Optional(Type.Number({ minimum: 1, default: DEFAULT_THRESHOLD })),
      lookbackWindow: Type.Optional(Type.Number({ minimum: 0, default: DEFAULT_LOOKBACK })),
    }),
    configDefault: { threshold, lookbackWindow },
    hooks: {
      beforeToolExecution: async (event, ctx) => {
        const storageKey = `${STORAGE_KEY_PREFIX}:${ctx.sessionId}`;

        // Check allow-repeat exemption
        if (allowRepeatSet.has(event.toolName)) {
          await recordToolCall(ctx.storage, storageKey, event.toolName, event.args, lookbackWindow);
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

        // Record the current call
        await recordToolCall(ctx.storage, storageKey, event.toolName, event.args, lookbackWindow);

        // +1 because the current call counts too
        if (consecutiveCount + 1 >= threshold) {
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
  // Trim to lookback window
  while (recent.length > lookbackWindow) {
    recent.shift();
  }
  await storage.put(key, JSON.stringify(recent));
}
