import type { AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "../agent-do.js";
import type { Command } from "../commands/define-command.js";
import type { McpServerConfig } from "../mcp/types.js";
import { estimateTextTokens } from "../prompt/build-system-prompt.js";
import type { PromptSection } from "../prompt/types.js";
import type { ResolvedScheduleDeclaration } from "../scheduling/types.js";
import type { CapabilityStorage } from "./storage.js";
import { createNoopStorage } from "./storage.js";
import type {
  BeforeToolExecutionEvent,
  BeforeToolExecutionResult,
  Capability,
  CapabilityHookContext,
  CapabilityHttpContext,
  CapabilityPromptSection,
  ToolExecutionEvent,
} from "./types.js";

interface NormalizedCapabilitySection {
  included: boolean;
  content: string;
  name?: string;
  reason?: string;
}

function normalizeCapabilityPromptSection(
  entry: string | CapabilityPromptSection,
): NormalizedCapabilitySection {
  if (typeof entry === "string") {
    return { included: true, content: entry };
  }
  if (entry.kind === "included") {
    return { included: true, content: entry.content, name: entry.name };
  }
  return { included: false, content: "", name: entry.name, reason: entry.reason };
}

export interface ResolvedCapabilities {
  tools: AnyAgentTool[];
  commands: Command[];
  promptSections: PromptSection[];
  mcpServers: McpServerConfig[];
  beforeInferenceHooks: Array<
    (messages: AgentMessage[], ctx: CapabilityHookContext) => Promise<AgentMessage[]>
  >;
  beforeToolExecutionHooks: Array<
    (
      event: BeforeToolExecutionEvent,
      ctx: CapabilityHookContext,
    ) => Promise<BeforeToolExecutionResult | void>
  >;
  afterToolExecutionHooks: Array<
    (event: ToolExecutionEvent, ctx: CapabilityHookContext) => Promise<void>
  >;
  onConnectHooks: Array<{
    capabilityId: string;
    hook: (ctx: CapabilityHookContext) => Promise<void>;
  }>;
  schedules: ResolvedScheduleDeclaration[];
  httpHandlers: Array<{
    method: string;
    path: string;
    handler: (request: Request, ctx: CapabilityHttpContext) => Promise<Response>;
    capabilityId: string;
    storage: CapabilityStorage;
  }>;
  onActionHandlers: Map<
    string,
    (action: string, data: unknown, ctx: CapabilityHookContext) => Promise<void>
  >;
  disposers: Array<{ capabilityId: string; dispose: () => Promise<void> }>;
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
  createBroadcastState?: (capabilityId: string) => AgentContext["broadcastState"],
  agentConfigSnapshot: Record<string, unknown> = {},
): ResolvedCapabilities {
  const tools: AnyAgentTool[] = [];
  const toolNames = new Set<string>();
  const commands: Command[] = [];
  const commandNames = new Set<string>();
  const promptSections: PromptSection[] = [];
  const mcpServers: McpServerConfig[] = [];
  const beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];
  const beforeToolExecutionHooks: ResolvedCapabilities["beforeToolExecutionHooks"] = [];
  const afterToolExecutionHooks: ResolvedCapabilities["afterToolExecutionHooks"] = [];
  const onConnectHooks: ResolvedCapabilities["onConnectHooks"] = [];
  const schedules: ResolvedScheduleDeclaration[] = [];
  const httpHandlers: ResolvedCapabilities["httpHandlers"] = [];
  const httpHandlerKeys = new Set<string>();
  const onActionHandlers: ResolvedCapabilities["onActionHandlers"] = new Map();
  const disposers: ResolvedCapabilities["disposers"] = [];
  const getStorage = createStorage ?? (() => createNoopStorage());

  const getBroadcastState = createBroadcastState ?? (() => context.broadcastState);

  for (const cap of capabilities) {
    const capStorage = getStorage(cap.id);
    const capBroadcastState = getBroadcastState(cap.id);
    const mappedAgentConfig = cap.agentConfigMapping
      ? cap.agentConfigMapping(agentConfigSnapshot)
      : undefined;
    const capContext: AgentContext = {
      ...context,
      storage: capStorage,
      broadcastState: capBroadcastState,
      agentConfig: mappedAgentConfig,
    };

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
      const rawSections = cap.promptSections(capContext);
      for (const [i, entry] of rawSections.entries()) {
        const normalized = normalizeCapabilityPromptSection(entry);
        // Stable index-suffixed keys even for single-section capabilities:
        // this way UI expand state survives a capability going from 1→2 sections.
        const key = `cap-${cap.id}-${i + 1}`;
        const name =
          normalized.name ?? (rawSections.length === 1 ? cap.name : `${cap.name} (${i + 1})`);
        const source = {
          type: "capability" as const,
          capabilityId: cap.id,
          capabilityName: cap.name,
        };
        if (normalized.included) {
          promptSections.push({
            name,
            key,
            content: normalized.content,
            lines: normalized.content.split("\n").length,
            tokens: estimateTextTokens(normalized.content),
            source,
            included: true,
          });
        } else {
          promptSections.push({
            name,
            key,
            content: "",
            lines: 0,
            tokens: 0,
            source,
            included: false,
            excludedReason: normalized.reason ?? "Excluded (no reason provided)",
          });
        }
      }
    }

    if (cap.mcpServers) {
      mcpServers.push(...cap.mcpServers);
    }

    if (cap.schedules) {
      for (const config of cap.schedules(capContext)) {
        schedules.push({ config, ownerId: cap.id });
      }
    }

    // Every hook wrapper reads the mapped agent-config slice at call
    // time from the live snapshot reference so later `config_set`
    // mutations flow through without re-resolving capabilities.
    const capMapping = cap.agentConfigMapping;
    const resolveHookAgentConfig = (): unknown =>
      capMapping ? capMapping(agentConfigSnapshot) : undefined;

    if (cap.hooks?.beforeInference) {
      const rawHook = cap.hooks.beforeInference;
      beforeInferenceHooks.push(async (messages, ctx) =>
        rawHook(messages, {
          ...ctx,
          storage: capStorage,
          broadcastState: capBroadcastState,
          agentConfig: resolveHookAgentConfig(),
        }),
      );
    }

    if (cap.hooks?.beforeToolExecution) {
      const rawHook = cap.hooks.beforeToolExecution;
      beforeToolExecutionHooks.push(async (event, ctx) =>
        rawHook(event, {
          ...ctx,
          storage: capStorage,
          broadcastState: capBroadcastState,
          agentConfig: resolveHookAgentConfig(),
        }),
      );
    }

    if (cap.hooks?.afterToolExecution) {
      const rawHook = cap.hooks.afterToolExecution;
      afterToolExecutionHooks.push(async (event, ctx) =>
        rawHook(event, {
          ...ctx,
          storage: capStorage,
          broadcastState: capBroadcastState,
          agentConfig: resolveHookAgentConfig(),
        }),
      );
    }

    if (cap.hooks?.onConnect) {
      const rawHook = cap.hooks.onConnect;
      onConnectHooks.push({
        capabilityId: cap.id,
        hook: async (ctx) =>
          rawHook({
            ...ctx,
            storage: capStorage,
            agentConfig: resolveHookAgentConfig(),
          }),
      });
    }

    if (cap.onAction) {
      const rawHandler = cap.onAction;
      onActionHandlers.set(cap.id, async (action, data, ctx) =>
        rawHandler(action, data, { ...ctx, storage: capStorage }),
      );
    }

    if (cap.dispose) {
      disposers.push({ capabilityId: cap.id, dispose: cap.dispose });
    }

    if (cap.httpHandlers) {
      for (const h of cap.httpHandlers(capContext)) {
        const key = `${h.method}:${h.path}`;
        if (httpHandlerKeys.has(key)) {
          throw new Error(
            `[capabilities] HTTP handler collision: ${h.method} ${h.path} from capability "${cap.id}" — already registered`,
          );
        }
        httpHandlerKeys.add(key);
        httpHandlers.push({
          method: h.method,
          path: h.path,
          handler: h.handler,
          capabilityId: cap.id,
          storage: capStorage,
        });
      }
    }
  }

  return {
    tools,
    commands,
    promptSections,
    mcpServers,
    beforeInferenceHooks,
    beforeToolExecutionHooks,
    afterToolExecutionHooks,
    onConnectHooks,
    schedules,
    httpHandlers,
    onActionHandlers,
    disposers,
  };
}
