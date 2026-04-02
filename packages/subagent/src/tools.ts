import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type, toolResult } from "@claw-for-cloudflare/agent-runtime";
import type { SubagentHost, SubagentRunResult } from "./host.js";
import { PendingSubagentStore } from "./pending-store.js";
import { resolveProfile } from "./resolve.js";
import type { SubagentProfile } from "./types.js";

export interface SubagentToolDeps {
  getHost: () => SubagentHost;
  getProfiles: () => SubagentProfile[];
  getParentSessionId: () => string;
  getParentSystemPrompt: () => string;
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  getParentTools: () => AgentTool<any>[];
  getStorage: () => CapabilityStorage;
  getBroadcast: () => (name: string, data: Record<string, unknown>) => void;
}

function profileChoices(profiles: SubagentProfile[]): string {
  return profiles.map((p) => `- ${p.id}: ${p.description}`).join("\n");
}

function formatResult(profileId: string, result: SubagentRunResult): string {
  if (result.success) {
    return `[Subagent "${profileId}" completed]\n${result.responseText}`;
  }
  return `[Subagent "${profileId}" failed]\n${result.error ?? "Unknown error"}`;
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createCallSubagentTool(deps: SubagentToolDeps): AgentTool<any> {
  return defineTool({
    name: "call_subagent",
    description:
      "Call a subagent and wait for its response. Use for quick tasks " +
      "that need an immediate answer. The subagent runs in its own session " +
      "with a specialized profile.",
    parameters: Type.Object({
      profile: Type.String({
        description: "Subagent profile ID to use",
      }),
      prompt: Type.String({
        description: "The task or question for the subagent",
      }),
      taskId: Type.Optional(Type.String({ description: "Associated task ID (for tracking)" })),
    }),
    execute: async (args) => {
      const profiles = deps.getProfiles();
      const profile = profiles.find((p) => p.id === args.profile);
      if (!profile) {
        return toolResult.error(
          `Unknown profile "${args.profile}". Available:\n${profileChoices(profiles)}`,
        );
      }

      const host = deps.getHost();
      const parentSessionId = deps.getParentSessionId();
      const resolved = resolveProfile(profile, deps.getParentSystemPrompt(), deps.getParentTools());

      // Create child session
      const session = host.createSubagentSession({
        name: `[${profile.name}] ${args.prompt.slice(0, 50)}`,
        parentSessionId,
      });

      try {
        const result = await host.runSubagentBlocking({
          childSessionId: session.id,
          systemPrompt: resolved.systemPrompt,
          tools: resolved.tools,
          modelId: resolved.modelId,
          prompt: args.prompt,
        });

        return toolResult.text(formatResult(profile.id, result), {
          profileId: profile.id,
          childSessionId: session.id,
          taskId: args.taskId,
          success: result.success,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return toolResult.error(`Subagent "${profile.id}" failed: ${message}`, {
          profileId: profile.id,
          childSessionId: session.id,
        });
      }
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createStartSubagentTool(deps: SubagentToolDeps): AgentTool<any> {
  return defineTool({
    name: "start_subagent",
    description:
      "Start a subagent in the background and continue working. " +
      "The result will arrive asynchronously — the subagent steers you " +
      "when done if you're active, or starts a new turn if you're idle.",
    parameters: Type.Object({
      profile: Type.String({
        description: "Subagent profile ID to use",
      }),
      prompt: Type.String({
        description: "The task for the subagent",
      }),
      taskId: Type.Optional(Type.String({ description: "Associated task ID (for tracking)" })),
    }),
    execute: async (args) => {
      const profiles = deps.getProfiles();
      const profile = profiles.find((p) => p.id === args.profile);
      if (!profile) {
        return toolResult.error(
          `Unknown profile "${args.profile}". Available:\n${profileChoices(profiles)}`,
        );
      }

      const host = deps.getHost();
      const parentSessionId = deps.getParentSessionId();
      const storage = deps.getStorage();
      const broadcast = deps.getBroadcast();
      const resolved = resolveProfile(profile, deps.getParentSystemPrompt(), deps.getParentTools());

      // Create child session
      const session = host.createSubagentSession({
        name: `[${profile.name}] ${args.prompt.slice(0, 50)}`,
        parentSessionId,
      });

      const subagentId = session.id; // Use child session ID as subagent ID

      // Store pending record (survives hibernation)
      const pendingStore = new PendingSubagentStore(storage);
      await pendingStore.save({
        subagentId,
        profileId: profile.id,
        childSessionId: session.id,
        parentSessionId,
        prompt: args.prompt,
        state: "running",
        taskId: args.taskId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Broadcast initial status
      broadcast("subagent_status", {
        subagentId,
        profileId: profile.id,
        state: "running",
        prompt: args.prompt,
      });

      // Start without awaiting — fire and forget
      host.startSubagentAsync(
        {
          childSessionId: session.id,
          systemPrompt: resolved.systemPrompt,
          tools: resolved.tools,
          modelId: resolved.modelId,
          prompt: args.prompt,
        },
        async (result) => {
          // Completion callback — mirrors A2A dual-path pattern
          const resultText = formatResult(profile.id, result);

          await pendingStore.updateState(subagentId, result.success ? "completed" : "failed");

          // Steer-or-prompt dual path
          if (host.isSessionStreaming(parentSessionId)) {
            host.steerSession(parentSessionId, resultText);
          } else {
            try {
              await host.promptSession(parentSessionId, resultText);
            } catch {
              // Session may be in an incompatible state
              console.error(`[subagent] Failed to deliver result to session ${parentSessionId}`);
            }
          }

          // Broadcast completion
          broadcast("subagent_status", {
            subagentId,
            profileId: profile.id,
            state: result.success ? "completed" : "failed",
            result: resultText,
          });

          // Clean up
          await pendingStore.delete(subagentId);
        },
      );

      return toolResult.text(
        `Subagent "${profile.name}" started (${subagentId}). ` +
          "The result will arrive asynchronously.",
        {
          subagentId,
          profileId: profile.id,
          childSessionId: session.id,
          taskId: args.taskId,
        },
      );
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createCheckSubagentTool(deps: SubagentToolDeps): AgentTool<any> {
  return defineTool({
    name: "check_subagent",
    description: "Check the status of a running subagent.",
    parameters: Type.Object({
      subagentId: Type.String({ description: "Subagent ID (returned by start_subagent)" }),
    }),
    execute: async (args) => {
      const storage = deps.getStorage();
      const pendingStore = new PendingSubagentStore(storage);
      const pending = await pendingStore.get(args.subagentId);

      if (!pending) {
        return toolResult.text(
          `No active subagent with ID: ${args.subagentId}. It may have already completed.`,
          { found: false },
        );
      }

      return toolResult.text(
        `Subagent "${pending.profileId}" (${pending.subagentId}): ${pending.state}\n` +
          `Prompt: ${pending.prompt}`,
        { pending },
      );
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createCancelSubagentTool(deps: SubagentToolDeps): AgentTool<any> {
  return defineTool({
    name: "cancel_subagent",
    description: "Cancel a running subagent.",
    parameters: Type.Object({
      subagentId: Type.String({ description: "Subagent ID to cancel" }),
    }),
    execute: async (args) => {
      const storage = deps.getStorage();
      const pendingStore = new PendingSubagentStore(storage);
      const pending = await pendingStore.get(args.subagentId);

      if (!pending) {
        return toolResult.text(`No active subagent with ID: ${args.subagentId}.`, { found: false });
      }

      if (pending.state !== "running") {
        return toolResult.text(`Subagent "${pending.profileId}" is already ${pending.state}.`, {
          state: pending.state,
        });
      }

      try {
        const host = deps.getHost();
        await host.abortSession(pending.childSessionId);
        await pendingStore.updateState(args.subagentId, "canceled");
        await pendingStore.delete(args.subagentId);

        deps.getBroadcast()("subagent_status", {
          subagentId: args.subagentId,
          profileId: pending.profileId,
          state: "canceled",
        });

        return toolResult.text(`Subagent "${pending.profileId}" (${args.subagentId}) canceled.`, {
          canceled: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return toolResult.error(`Failed to cancel: ${message}`);
      }
    },
  });
}
