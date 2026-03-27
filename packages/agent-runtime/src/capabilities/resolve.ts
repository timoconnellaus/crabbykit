import type { AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "../agent-do.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { Capability, CapabilityHookContext } from "./types.js";

export interface ResolvedCapabilities {
  tools: AgentTool[];
  promptSections: string[];
  mcpServers: McpServerConfig[];
  beforeInferenceHooks: Array<
    (messages: AgentMessage[], ctx: CapabilityHookContext) => Promise<AgentMessage[]>
  >;
}

/**
 * Resolve an ordered list of capabilities into merged tools, prompt sections,
 * MCP servers, and lifecycle hooks. Registration order is preserved for hooks.
 *
 * Tool name collisions are logged and the duplicate is skipped.
 */
export function resolveCapabilities(
  capabilities: Capability[],
  context: AgentContext,
): ResolvedCapabilities {
  const tools: AgentTool[] = [];
  const toolNames = new Set<string>();
  const promptSections: string[] = [];
  const mcpServers: McpServerConfig[] = [];
  const beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];

  for (const cap of capabilities) {
    if (cap.tools) {
      for (const tool of cap.tools(context)) {
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

    if (cap.promptSections) {
      promptSections.push(...cap.promptSections(context));
    }

    if (cap.mcpServers) {
      mcpServers.push(...cap.mcpServers);
    }

    if (cap.hooks?.beforeInference) {
      beforeInferenceHooks.push(cap.hooks.beforeInference);
    }
  }

  return { tools, promptSections, mcpServers, beforeInferenceHooks };
}
