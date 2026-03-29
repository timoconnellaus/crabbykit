import type { Capability } from "@claw-for-cloudflare/agent-runtime";
import type { AgentSkill, SecurityScheme } from "../types.js";
import type { AgentCardConfig } from "./claw-executor.js";
import { ClawExecutor } from "./claw-executor.js";
import { A2AHandler } from "./handler.js";
import type { TaskStore } from "./task-store.js";
import { createA2AServerHandlers } from "./transport.js";

// ============================================================================
// Options
// ============================================================================

export interface A2AServerOptions {
  /** Base URL for this agent (used in agent card). */
  url: string;
  /** Agent name (used in agent card). */
  name: string;
  /** Agent description (used in agent card). */
  description?: string;
  /** Agent version (used in agent card). Default: "1.0.0". */
  version?: string;
  /** Skills to advertise in the agent card. */
  skills?: AgentSkill[];
  /** Provider info for the agent card. */
  provider?: { organization: string; url?: string };
  /** Security schemes for the agent card. */
  securitySchemes?: Record<string, SecurityScheme>;
  /** Security requirements for the agent card. */
  security?: Array<Record<string, string[]>>;
  /** Task store — consumer creates from ctx.storage.sql in their DO constructor. */
  taskStore: TaskStore;
  /** Optional auth middleware. Return null to allow, or a Response to reject. */
  authenticate?: (request: Request) => Promise<Response | null>;
  /** Access to session agent handles for task cancellation. */
  getSessionAgentHandle?: (sessionId: string) => { abort: () => void; isStreaming: boolean } | null;
}

// ============================================================================
// Capability Factory
// ============================================================================

/**
 * Create the A2A server capability.
 *
 * Registers HTTP handlers for:
 *   GET  /.well-known/agent-card.json
 *   POST /a2a
 */
export function a2aServer(options: A2AServerOptions): Capability {
  const agentCardConfig: AgentCardConfig = {
    name: options.name,
    description: options.description,
    url: options.url,
    version: options.version,
    skills: options.skills,
    provider: options.provider,
    securitySchemes: options.securitySchemes,
    security: options.security,
  };

  const executor = new ClawExecutor({
    agentCardConfig,
    getSessionAgentHandle: options.getSessionAgentHandle,
  });

  const handler = new A2AHandler({
    executor,
    taskStore: options.taskStore,
  });

  const transportHandlers = createA2AServerHandlers({
    handler,
    executor,
    authenticate: options.authenticate,
  });

  return {
    id: "a2a-server",
    name: "A2A Protocol Server",
    description: "Agent-to-Agent protocol v1.0 server.",

    httpHandlers: () =>
      transportHandlers.map((h) => ({
        ...h,
        handler: async (request: Request, ctx: Parameters<typeof h.handler>[1]) => {
          // Wire the executor to the current request's context
          executor.setContext({
            sendPrompt: ctx.sendPrompt,
            sessionStore: ctx.sessionStore,
          });
          return h.handler(request, ctx);
        },
      })),

    promptSections: () => [
      "This agent supports the A2A (Agent-to-Agent) protocol v1.0. " +
        "Other agents can discover this agent via the Agent Card at " +
        "/.well-known/agent-card.json and send messages via POST /a2a.",
    ],
  };
}
