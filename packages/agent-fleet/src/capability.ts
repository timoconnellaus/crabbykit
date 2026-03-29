import { getAuthFromRequest, verifyToken } from "@claw-for-cloudflare/agent-auth";
import type {
  AgentMessage,
  Capability,
  CapabilityStorage,
} from "@claw-for-cloudflare/agent-runtime";
import { getAttachedAgentId } from "./attach.js";
import {
  createAgentAttachTool,
  createAgentCreateTool,
  createAgentDeleteTool,
  createAgentDetachTool,
  createAgentListTool,
} from "./tools.js";
import type { FleetOptions } from "./types.js";

/**
 * Create an agent fleet management capability.
 *
 * Provides five tools for agent lifecycle management:
 * - `agent_list` — List all agents in the fleet
 * - `agent_create` — Create a new child agent
 * - `agent_delete` — Delete a child agent
 * - `agent_attach` — Enter configuration mode for another agent
 * - `agent_detach` — Exit configuration mode
 *
 * Also provides an HTTP handler for `/agent-init` (child agent initialization)
 * and a `beforeInference` hook that injects context when attached to another agent.
 */
export function agentFleet(options: FleetOptions): Capability {
  let _storage: CapabilityStorage | undefined;

  const getStorage = (): CapabilityStorage => {
    if (!_storage) {
      throw new Error("Fleet not initialized — capability must be registered");
    }
    return _storage;
  };

  return {
    id: "agent-fleet",
    name: "Agent Fleet",
    description: "Agent lifecycle management — create, delete, and attach to other agents.",

    tools: (context) => {
      _storage = context.storage;
      const getSessionId = () => context.sessionId;
      return [
        createAgentListTool(options, getStorage),
        createAgentCreateTool(options, getStorage, getSessionId),
        createAgentDeleteTool(options, getStorage, getSessionId),
        createAgentAttachTool(options, getStorage, getSessionId),
        createAgentDetachTool(options, getStorage, getSessionId),
      ];
    },

    httpHandlers: (context) => {
      _storage = context.storage;
      return [
        {
          method: "POST" as const,
          path: "/agent-init",
          handler: async (request) => {
            const auth = getAuthFromRequest(request);
            if (!auth) {
              return new Response(JSON.stringify({ error: "Missing auth headers" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
              });
            }

            const payload = await verifyToken(auth.token, options.agentId, options.secret);
            if (!payload) {
              return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
              });
            }

            const body = (await request.json()) as {
              ownerId: string;
              parentAgentId: string;
            };

            const storage = getStorage();
            await storage.put("init:ownerId", body.ownerId);
            await storage.put("init:parentAgentId", body.parentAgentId);

            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      ];
    },

    promptSections: (context) => {
      _storage = context.storage;
      return [
        "You can manage other agents using agent_list, agent_create, agent_delete. Use agent_attach to configure a child agent.",
      ];
    },

    hooks: {
      beforeInference: async (messages, ctx) => {
        const attachedId = await getAttachedAgentId(ctx.storage, ctx.sessionId);
        if (!attachedId) {
          return messages;
        }

        const agent = await options.registry.get(attachedId);
        const agentLabel = agent ? `"${agent.name}" (${attachedId})` : attachedId;

        const systemNote: AgentMessage = {
          role: "user" as const,
          content: `[SYSTEM] You are currently attached to agent ${agentLabel}. All configuration actions apply to that agent. Use agent_detach to return to your own context.`,
          timestamp: Date.now(),
        };

        return [systemNote, ...messages];
      },
    },
  };
}
