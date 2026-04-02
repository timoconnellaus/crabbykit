import { setAuthHeaders, signToken } from "@claw-for-cloudflare/agent-auth";
import type { AgentTool, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type, toolResult } from "@claw-for-cloudflare/agent-runtime";
import { clearAttachedAgentId, getAttachedAgentId, setAttachedAgentId } from "./attach.js";
import type { FleetOptions } from "./types.js";

/**
 * Create the agent_list tool.
 * Lists all agents owned by the same owner, with relationship info.
 */
export function createAgentListTool(
  options: FleetOptions,
  _getStorage: () => CapabilityStorage,
): AgentTool {
  return defineTool({
    name: "agent_list",
    description:
      "List all agents in the fleet. Shows each agent's ID, name, status, and relationship to this agent.",
    guidance:
      "List all agents in the fleet with their status and relationship to this agent. Use this to discover available child agents before delegating work.",
    parameters: Type.Object({}),
    execute: async () => {
      const agents = await options.registry.list(options.ownerId);
      const results = await Promise.all(
        agents.map(async (agent) => {
          const relationship = await options.registry.getRelationship(options.agentId, agent.id);
          return {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            relationship: agent.id === options.agentId ? "self" : (relationship ?? "none"),
          };
        }),
      );
      return toolResult.text(JSON.stringify(results, null, 2), { agents: results });
    },
  }) as unknown as AgentTool;
}

/**
 * Create the agent_create tool.
 * Creates a new child agent, registers it, initializes it, and auto-attaches.
 */
export function createAgentCreateTool(
  options: FleetOptions,
  getStorage: () => CapabilityStorage,
  getSessionId: () => string,
): AgentTool {
  return defineTool({
    name: "agent_create",
    description:
      "Create a new child agent. The new agent is registered, initialized via /agent-init, and auto-attached for immediate configuration.",
    guidance:
      "Create a new child agent in the fleet. The agent is registered, initialized, and auto-attached for immediate configuration. Use agent_detach when done configuring.",
    parameters: Type.Object({
      name: Type.String({ description: "Human-readable name for the new agent" }),
    }),
    execute: async ({ name }) => {
      const id = crypto.randomUUID();

      const record = await options.registry.create({
        id,
        name,
        ownerId: options.ownerId,
        parentAgentId: options.agentId,
      });

      const stub = options.getAgentStub(id);

      // Sign a token targeting the new child agent.
      // Resolve the registry UUID to the DO's hex ID so the token target
      // matches what the receiving DO sees as its own identity.
      const resolveDoId = options.resolveDoId ?? ((x: string) => x);
      const targetDoId = resolveDoId(id);
      const token = await signToken(options.agentId, targetDoId, options.secret);
      const headers = new Headers({ "Content-Type": "application/json" });
      setAuthHeaders(headers, token, options.agentId);

      const initResponse = await stub.fetch("https://agent/agent-init", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerId: options.ownerId,
          parentAgentId: options.agentId,
        }),
      });

      if (!initResponse.ok) {
        return toolResult.error(
          `Agent created in registry but initialization failed: ${initResponse.status} ${await initResponse.text()}`,
          { agentId: id, error: "init_failed" },
        );
      }

      // Auto-handshake via peering if available
      if (options.peeringService) {
        await options.peeringService.requestPeer(id);
      }

      // Call onChildCreated hook if provided
      if (options.onChildCreated) {
        await options.onChildCreated(stub, id);
      }

      // Auto-attach to the new child for immediate configuration
      const storage = getStorage();
      const sessionId = getSessionId();
      await setAttachedAgentId(storage, sessionId, id);

      return toolResult.text(
        `Created and attached to agent "${name}" (${id}). You are now in configuration mode for this agent. Use agent_detach when done.`,
        { agent: record, attached: true },
      );
    },
  }) as unknown as AgentTool;
}

/**
 * Create the agent_delete tool.
 * Deletes a child agent after verifying parent relationship.
 */
export function createAgentDeleteTool(
  options: FleetOptions,
  getStorage: () => CapabilityStorage,
  getSessionId: () => string,
): AgentTool {
  return defineTool({
    name: "agent_delete",
    description: "Delete a child agent. Only agents where this agent is the parent can be deleted.",
    guidance:
      "Delete a child agent from the fleet. Only agents where this agent is the parent can be deleted. The agent is detached and its peering revoked before deletion.",
    parameters: Type.Object({
      agentId: Type.String({ description: "ID of the agent to delete" }),
    }),
    execute: async ({ agentId }) => {
      const relationship = await options.registry.getRelationship(options.agentId, agentId);
      if (relationship !== "parent") {
        return toolResult.error(
          `Cannot delete agent ${agentId}: this agent is not its parent (relationship: ${relationship ?? "none"}).`,
          { error: "not_parent" },
        );
      }

      // Detach if currently attached to this agent
      const storage = getStorage();
      const sessionId = getSessionId();
      const attachedId = await getAttachedAgentId(storage, sessionId);
      if (attachedId === agentId) {
        await clearAttachedAgentId(storage, sessionId);
      }

      // Revoke peering if available
      if (options.peeringService) {
        await options.peeringService.revokePeer(agentId);
      }

      await options.registry.delete(agentId);

      return toolResult.text(`Deleted agent ${agentId}.`, { agentId, deleted: true });
    },
  }) as unknown as AgentTool;
}

/**
 * Create the agent_attach tool.
 * Attaches to another agent for configuration mode (session-scoped).
 */
export function createAgentAttachTool(
  options: FleetOptions,
  getStorage: () => CapabilityStorage,
  getSessionId: () => string,
): AgentTool {
  return defineTool({
    name: "agent_attach",
    description:
      "Attach to another agent to enter configuration mode. Only parent or child agents can be attached.",
    guidance:
      "Enter configuration mode for another agent. Only parent or child agents can be attached. While attached, configuration actions apply to the target agent instead of this one.",
    parameters: Type.Object({
      agentId: Type.String({ description: "ID of the agent to attach to" }),
    }),
    execute: async ({ agentId }) => {
      const relationship = await options.registry.getRelationship(options.agentId, agentId);
      if (relationship !== "parent" && relationship !== "child") {
        return toolResult.error(
          `Cannot attach to agent ${agentId}: must be a parent or child (relationship: ${relationship ?? "none"}).`,
          { error: "invalid_relationship" },
        );
      }

      const agent = await options.registry.get(agentId);
      if (!agent) {
        return toolResult.error(`Agent ${agentId} not found.`, { error: "not_found" });
      }

      const storage = getStorage();
      const sessionId = getSessionId();
      await setAttachedAgentId(storage, sessionId, agentId);

      return toolResult.text(
        `Attached to agent "${agent.name}" (${agentId}). You are now in configuration mode. Use agent_detach when done.`,
        { agentId, agentName: agent.name, attached: true },
      );
    },
  }) as unknown as AgentTool;
}

/**
 * Create the agent_detach tool.
 * Detaches from the currently attached agent (session-scoped).
 */
export function createAgentDetachTool(
  _options: FleetOptions,
  getStorage: () => CapabilityStorage,
  getSessionId: () => string,
): AgentTool {
  return defineTool({
    name: "agent_detach",
    description: "Detach from the currently attached agent and return to your own context.",
    guidance:
      "Exit configuration mode and return to your own context. Use this after finishing configuration of an attached agent.",
    parameters: Type.Object({}),
    execute: async () => {
      const storage = getStorage();
      const sessionId = getSessionId();
      const attachedId = await getAttachedAgentId(storage, sessionId);

      if (!attachedId) {
        return toolResult.error("Not currently attached to any agent.", {
          error: "not_attached",
        });
      }

      await clearAttachedAgentId(storage, sessionId);

      return toolResult.text(`Detached from agent ${attachedId}. Returned to own context.`, {
        previousAgentId: attachedId,
        detached: true,
      });
    },
  }) as unknown as AgentTool;
}
