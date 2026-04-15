import type { Capability, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { SubagentHost } from "./host.js";
import { PendingSubagentStore } from "./pending-store.js";
import {
  createCallSubagentTool,
  createCancelSubagentTool,
  createCheckSubagentTool,
  createStartSubagentTool,
} from "./tools.js";
import type { Mode } from "./types.js";

export interface SubagentCapabilityOptions {
  /** The host that implements subagent execution. */
  host: SubagentHost;
  /** Available subagent spawn modes. */
  modes: Mode[];
  /** The parent agent's system prompt (for mode resolution). */
  getSystemPrompt: () => string;
  /** The parent agent's resolved tools (for mode tool filtering). */
  getParentTools: () => unknown[];
}

/**
 * Create the subagent capability.
 *
 * Provides tools for spawning and managing child agents:
 *   call_subagent   — blocking delegation (quick sub-tasks)
 *   start_subagent  — non-blocking delegation (background work)
 *   check_subagent  — check status of running subagent
 *   cancel_subagent — cancel an in-flight subagent
 *
 * Includes onConnect hook for orphaned subagent detection after hibernation.
 */
export function subagentCapability(options: SubagentCapabilityOptions): Capability {
  let _storage: CapabilityStorage | undefined;

  const getStorage = (): CapabilityStorage => {
    if (!_storage) {
      throw new Error("Subagent capability not initialized");
    }
    return _storage;
  };

  /** Track parent-child session relationships for authority inheritance. */
  const parentSessionMap = new Map<string, string>();

  return {
    id: "subagent",
    name: "Subagent",
    description: "Spawn and manage child agents within the same Durable Object.",

    tools: (context) => {
      _storage = context.storage;
      const deps = {
        getHost: () => options.host,
        getModes: () => options.modes,
        getParentSessionId: () => context.sessionId,
        getParentSystemPrompt: options.getSystemPrompt,
        // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
        getParentTools: options.getParentTools as () => any[],
        getStorage: () => getStorage(),
        getBroadcast: () => context.broadcastToAll,
      };

      return [
        createCallSubagentTool(deps),
        createStartSubagentTool(deps),
        createCheckSubagentTool(deps),
        createCancelSubagentTool(deps),
      ];
    },

    promptSections: () => [
      "You can spawn subagent child agents for specialized tasks. " +
        `Available modes: ${options.modes.map((m) => `${m.id} (${m.description})`).join(", ")}. ` +
        "Use call_subagent for quick tasks needing an immediate answer. " +
        "Use start_subagent for background work — the result arrives asynchronously.",
    ],

    hooks: {
      onConnect: async (ctx) => {
        // Detect orphaned subagents after hibernation
        const pendingStore = new PendingSubagentStore(ctx.storage);
        const active = await pendingStore.listActive();

        if (active.length > 0 && ctx.broadcast) {
          // Mark orphaned subagents as failed (Agent instances lost during hibernation)
          for (const sub of active) {
            await pendingStore.updateState(sub.subagentId, "failed");
            await pendingStore.delete(sub.subagentId);
          }

          ctx.broadcast("subagent_orphaned", {
            count: active.length,
            subagents: active.map((s) => ({
              subagentId: s.subagentId,
              modeId: s.modeId,
              prompt: s.prompt,
            })),
          });
        }
      },
    },
  };
}

/**
 * Create an auth checker that grants subagent sessions write access
 * to their parent session's tasks.
 *
 * Usage with task-tracker:
 * ```ts
 * const authChecker = createSubagentAuthChecker(sessionParentMap);
 * taskTracker({ sql, authChecker });
 * ```
 */
export function createSubagentAuthChecker(
  parentSessionMap: Map<string, string>,
): (callerSession: string, ownerSession: string) => boolean {
  return (callerSession: string, ownerSession: string): boolean => {
    if (callerSession === ownerSession) return true;
    // Walk up the parent chain
    let current = callerSession;
    const visited = new Set<string>();
    while (parentSessionMap.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parentSessionMap.get(current)!;
      if (current === ownerSession) return true;
    }
    return false;
  };
}
