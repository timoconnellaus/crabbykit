import type { Capability, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { Type } from "@sinclair/typebox";
import type { AgentCardConfig } from "./claw-executor.js";
import { ClawExecutor } from "./claw-executor.js";
import { A2AHandler } from "./handler.js";
import type { TaskStore } from "./task-store.js";
import { createA2AServerHandlers } from "./transport.js";

// ============================================================================
// Config Schema (editable via config_set capability:a2a-server)
// ============================================================================

const AGENT_CARD_CONFIG_SCHEMA = Type.Object({
  name: Type.String({ description: "Agent name displayed in the Agent Card." }),
  description: Type.String({ description: "Agent description displayed in the Agent Card." }),
  url: Type.String({ description: "Base URL where this agent is reachable." }),
  version: Type.Optional(Type.String({ description: 'Agent version. Default: "1.0.0".' })),
  provider: Type.Optional(
    Type.Object({
      organization: Type.String(),
      url: Type.Optional(Type.String()),
    }),
  ),
  skills: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        description: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
        examples: Type.Optional(Type.Array(Type.String())),
      }),
    ),
  ),
});

type AgentCardConfigValue = {
  name: string;
  description: string;
  url: string;
  version?: string;
  provider?: { organization: string; url?: string };
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
    examples?: string[];
  }>;
};

// ============================================================================
// Options
// ============================================================================

export interface A2AServerOptions {
  /** Default agent name. The agent can update this via config_set. */
  name?: string;
  /** Default description. The agent can update this via config_set. */
  description?: string;
  /** Default base URL. The agent can update this via config_set. */
  url?: string;
  /** Default version. Default: "1.0.0". */
  version?: string;
  /** Default provider info. */
  provider?: { organization: string; url?: string };
  /** Task store — consumer creates from ctx.storage.sql in their DO constructor. */
  taskStore: TaskStore;
  /** Optional auth middleware. Return null to allow, or a Response to reject. */
  authenticate?: (request: Request) => Promise<Response | null>;
  /** Access to session agent handles for task cancellation. */
  getSessionAgentHandle?: (sessionId: string) => { abort: () => void; isStreaming: boolean } | null;
}

// ============================================================================

// ============================================================================
// Capability Factory
// ============================================================================

/**
 * Create the A2A server capability.
 *
 * Agent Card configuration is editable via `config_set capability:a2a-server`.
 * Sensible defaults are provided from the options.
 *
 * Registers HTTP handlers for:
 *   GET  /.well-known/agent-card.json
 *   POST /a2a
 */
export function a2aServer(options: A2AServerOptions): Capability {
  const defaultConfig: AgentCardConfigValue = {
    name: options.name ?? "Agent",
    description: options.description ?? "An A2A-compatible agent.",
    url: options.url ?? "",
    version: options.version,
    provider: options.provider,
  };

  // Mutable refs
  let _storage: CapabilityStorage | undefined;
  let currentConfig: AgentCardConfigValue = { ...defaultConfig };
  let configLoaded = false;

  const getStorage = (): CapabilityStorage => {
    if (!_storage) throw new Error("A2A server not initialized — capability must be registered");
    return _storage;
  };

  const agentCardConfig: AgentCardConfig = {
    name: currentConfig.name,
    description: currentConfig.description,
    url: currentConfig.url,
    version: currentConfig.version,
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

  /** Load persisted config from the config store, falling back to defaults. */
  async function loadConfig(storage: CapabilityStorage): Promise<AgentCardConfigValue> {
    if (configLoaded) return currentConfig;
    const stored = await storage.get<AgentCardConfigValue>("agent-card-config");
    if (stored) {
      currentConfig = stored;
    }
    configLoaded = true;
    syncExecutorCard();
    return currentConfig;
  }

  /** Keep the executor's agent card in sync with the current config. */
  function syncExecutorCard(): void {
    agentCardConfig.name = currentConfig.name;
    agentCardConfig.description = currentConfig.description;
    agentCardConfig.url = currentConfig.url;
    agentCardConfig.version = currentConfig.version;
    agentCardConfig.skills = currentConfig.skills;
    agentCardConfig.provider = currentConfig.provider;
  }

  return {
    id: "a2a-server",
    name: "A2A Protocol Server",
    description: "Agent-to-Agent protocol v1.0 server.",

    configSchema: AGENT_CARD_CONFIG_SCHEMA,
    configDefault: defaultConfig as Record<string, unknown>,

    httpHandlers: (context) => {
      _storage = context.storage;

      return transportHandlers.map((h) => ({
        ...h,
        handler: async (request: Request, ctx: Parameters<typeof h.handler>[1]) => {
          await loadConfig(getStorage());
          executor.setContext({
            sendPrompt: ctx.sendPrompt,
            sessionStore: ctx.sessionStore,
          });
          return h.handler(request, ctx);
        },
      }));
    },

    hooks: {
      onConfigChange: async (_oldConfig, newConfig, ctx) => {
        const config = newConfig as AgentCardConfigValue;
        currentConfig = config;
        syncExecutorCard();
        // Persist to capability storage for the HTTP handlers to read
        await ctx.storage.put("agent-card-config", config);
      },
    },

    promptSections: () => [
      "This agent supports the A2A (Agent-to-Agent) protocol v1.0. " +
        "Other agents can discover this agent via the Agent Card at " +
        "/.well-known/agent-card.json and send messages via POST /a2a. " +
        "You can update your Agent Card (name, description, skills) via " +
        "config_set with namespace 'capability:a2a-server'.",
    ],
  };
}
