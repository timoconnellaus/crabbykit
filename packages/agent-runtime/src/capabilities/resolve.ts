import type { AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "../agent-do.js";
import type { Command } from "../commands/define-command.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { ResolvedScheduleDeclaration } from "../scheduling/types.js";
import type { CapabilityStorage } from "./storage.js";
import { createNoopStorage } from "./storage.js";
import type { Capability, CapabilityHookContext, ToolExecutionEvent } from "./types.js";

export interface ResolvedCapabilities {
  tools: AgentTool[];
  commands: Command[];
  promptSections: string[];
  mcpServers: McpServerConfig[];
  beforeInferenceHooks: Array<
    (messages: AgentMessage[], ctx: CapabilityHookContext) => Promise<AgentMessage[]>
  >;
  afterToolExecutionHooks: Array<
    (event: ToolExecutionEvent, ctx: CapabilityHookContext) => Promise<void>
  >;
  onConnectHooks: Array<(ctx: CapabilityHookContext) => Promise<void>>;
  schedules: ResolvedScheduleDeclaration[];
}

/**
 * Resolve an ordered list of capabilities into merged tools, prompt sections,
 * MCP servers, and lifecycle hooks. Registration order is preserved for hooks.
 *
 * When `createStorage` is provided, each capability receives its own scoped
 * storage instance via `AgentContext.storage` (for tools/prompts) and
 * `CapabilityHookContext.storage` (for hooks). Without it, noop storage is used.
 *
 * Tool name collisions are logged and the duplicate is skipped.
 */
export function resolveCapabilities(
  capabilities: Capability[],
  context: AgentContext,
  createStorage?: (capabilityId: string) => CapabilityStorage,
): ResolvedCapabilities {
  const tools: AgentTool[] = [];
  const toolNames = new Set<string>();
  const commands: Command[] = [];
  const commandNames = new Set<string>();
  const promptSections: string[] = [];
  const mcpServers: McpServerConfig[] = [];
  const beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];
  const afterToolExecutionHooks: ResolvedCapabilities["afterToolExecutionHooks"] = [];
  const onConnectHooks: ResolvedCapabilities["onConnectHooks"] = [];
  const schedules: ResolvedScheduleDeclaration[] = [];
  const getStorage = createStorage ?? (() => createNoopStorage());

  for (const cap of capabilities) {
    const capStorage = getStorage(cap.id);
    const capContext: AgentContext = { ...context, storage: capStorage };

    if (cap.tools) {
      for (const tool of cap.tools(capContext)) {
        if (toolNames.has(tool.name)) {
          console.warn(
            `[capabilities] Duplicate tool name "${tool.name}" from capability "${cap.id}" — skipping`,
          );
          continue;
        }
        toolNames.add(tool.name);
        tools.push(tool);
      }
    }

    if (cap.commands) {
      for (const cmd of cap.commands(capContext)) {
        if (commandNames.has(cmd.name)) {
          console.warn(
            `[capabilities] Duplicate command name "${cmd.name}" from capability "${cap.id}" — skipping`,
          );
          continue;
        }
        commandNames.add(cmd.name);
        commands.push(cmd);
      }
    }

    if (cap.promptSections) {
      promptSections.push(...cap.promptSections(capContext));
    }

    if (cap.mcpServers) {
      mcpServers.push(...cap.mcpServers);
    }

    if (cap.schedules) {
      for (const config of cap.schedules(capContext)) {
        schedules.push({ config, ownerId: cap.id });
      }
    }

    if (cap.hooks?.beforeInference) {
      const rawHook = cap.hooks.beforeInference;
      beforeInferenceHooks.push(async (messages, ctx) =>
        rawHook(messages, { ...ctx, storage: capStorage }),
      );
    }

    if (cap.hooks?.afterToolExecution) {
      const rawHook = cap.hooks.afterToolExecution;
      afterToolExecutionHooks.push(async (event, ctx) =>
        rawHook(event, { ...ctx, storage: capStorage }),
      );
    }

    if (cap.hooks?.onConnect) {
      const rawHook = cap.hooks.onConnect;
      onConnectHooks.push(async (ctx) => rawHook({ ...ctx, storage: capStorage }));
    }
  }

  return {
    tools,
    commands,
    promptSections,
    mcpServers,
    beforeInferenceHooks,
    afterToolExecutionHooks,
    onConnectHooks,
    schedules,
  };
}
