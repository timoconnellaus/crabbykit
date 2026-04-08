import { agentFleet } from "@claw-for-cloudflare/agent-fleet";
import { agentPeering } from "@claw-for-cloudflare/agent-peering";
import { D1AgentRegistry } from "@claw-for-cloudflare/agent-registry";
import type { AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineAgent, defineTool, Type, Value } from "@claw-for-cloudflare/agent-runtime";
import { agentStorage } from "@claw-for-cloudflare/agent-storage";
import { AiService, aiProxy } from "@claw-for-cloudflare/ai-proxy";
import { appRegistry } from "@claw-for-cloudflare/app-registry";
import { batchTool } from "@claw-for-cloudflare/batch-tool";
import { browserbase } from "@claw-for-cloudflare/browserbase";
import {
  CloudflareSandboxProvider,
  SandboxContainer,
} from "@claw-for-cloudflare/cloudflare-sandbox";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { credentialStore } from "@claw-for-cloudflare/credential-store";
import { doomLoopDetection } from "@claw-for-cloudflare/doom-loop-detection";
import { heartbeat } from "@claw-for-cloudflare/heartbeat";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";
import { sandboxCapability } from "@claw-for-cloudflare/sandbox";
import { D1SkillRegistry, parseSkillFile } from "@claw-for-cloudflare/skill-registry";
import { skills } from "@claw-for-cloudflare/skills";
import { explorer } from "@claw-for-cloudflare/subagent-explorer";
import { taskTracker } from "@claw-for-cloudflare/task-tracker";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { toolOutputTruncation } from "@claw-for-cloudflare/tool-output-truncation";
import { vectorMemory } from "@claw-for-cloudflare/vector-memory";
import { BackendStorage, DbService, vibeCoder } from "@claw-for-cloudflare/vibe-coder";
import codeReviewSkillMd from "../skills/code-review/SKILL.md?raw";
import debugSystematicSkillMd from "../skills/debug-systematic/SKILL.md?raw";
import vibeWebappSkillMd from "../skills/vibe-webapp/SKILL.md?raw";
import { debugInspector } from "./debug-capability";

export interface Env {
  AGENT: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  BACKEND_STORAGE: DurableObjectNamespace;
  DB_SERVICE: Service<DbService>;
  AI_SERVICE: Service<AiService>;
  STORAGE_BUCKET: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  LOADER: WorkerLoader;
  OPENROUTER_API_KEY: string;
  TAVILY_API_KEY: string;
  // R2 credentials for container FUSE mount (set via wrangler secret put)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  // Agent-ops (set via wrangler secret put)
  AGENT_SECRET: string;
  AGENT_DB: D1Database;
  SKILL_DB: D1Database;
  // Browserbase (set via .dev.vars or wrangler secret put)
  BROWSERBASE_API_KEY: string;
  BROWSERBASE_PROJECT_ID: string;
}

const EXAMPLE_SKILL_SEEDS = [
  parseSkillFile("vibe-webapp", vibeWebappSkillMd),
  parseSkillFile("code-review", codeReviewSkillMd),
  parseSkillFile("debug-systematic", debugSystematicSkillMd),
];

/**
 * Minimal agent built with the declarative `defineAgent` factory.
 *
 * Demonstrates how consumers can wire up capabilities, tools, A2A, hooks,
 * and custom HTTP routes without subclassing {@link AgentDO}. For cases that
 * need direct `this.ctx` access or bespoke constructor logic, consumers can
 * still `class MyAgent extends AgentDO { ... }` as the escape hatch.
 */
export const BasicAgent = defineAgent<Env>({
  model: (env) => ({
    provider: "openrouter",
    modelId: "minimax/minimax-m2.7",
    apiKey: env.OPENROUTER_API_KEY,
    a2a: { discoverable: true },
  }),

  prompt: {
    agentName: "Basic Agent",
    agentDescription: "A helpful agent that can search, compute, and manage files.",
    timezone: "UTC",
  },

  tools: () => [
    defineTool({
      name: "get_current_time",
      description: "Get the current date and time in ISO format.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: new Date().toISOString() }],
        details: null,
      }),
    }),
    defineTool({
      name: "calculate",
      description: "Evaluate a math expression.",
      parameters: Type.Object({
        expression: Type.String({ description: "The math expression to evaluate" }),
      }),
      execute: async ({ expression }) => {
        try {
          const result = Function(`"use strict"; return (${expression})`)();
          return {
            content: [{ type: "text" as const, text: String(result) }],
            details: { expression, result },
          };
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
            details: { expression, error: errorMessage },
          };
        }
      },
    }),
  ],

  capabilities: ({ env, agentId, sqlStore, sessionStore, resolveToolsForSession }) => {
    const storage = agentStorage({
      bucket: () => env.STORAGE_BUCKET,
      namespace: agentId,
    });

    // Share a single sandbox provider across capabilities so env var
    // injection (e.g. AI proxy token) reaches the same container.
    const sandboxProvider = new CloudflareSandboxProvider({
      storage,
      getStub: () => env.SANDBOX_CONTAINER.get(env.SANDBOX_CONTAINER.idFromName(agentId)),
      containerMode: "dev",
    });

    // Agent-ops: fleet + peering wiring with shared identity.
    const getAgentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
    const resolveDoId = (id: string) => env.AGENT.idFromName(id).toString();
    const agentRegistry = new D1AgentRegistry(env.AGENT_DB);
    const peering = agentPeering({
      secret: env.AGENT_SECRET,
      getAgentStub,
      resolveDoId,
      agentId,
    });

    return [
      compactionSummary({
        provider: "openrouter",
        modelId: "google/gemini-2.0-flash-001",
        getApiKey: () => env.OPENROUTER_API_KEY,
        pruneBudget: 40_000,
      }),
      tavilyWebSearch({ tavilyApiKey: () => env.TAVILY_API_KEY }),
      r2Storage({ storage }),
      vectorMemory({
        storage,
        vectorizeIndex: () => env.MEMORY_INDEX,
        ai: () => env.AI,
      }),
      promptScheduler(),
      credentialStore(),
      heartbeat({ every: "30m", enabled: false }),
      peering.capability,
      agentFleet({
        registry: agentRegistry,
        secret: env.AGENT_SECRET,
        getAgentStub,
        resolveDoId,
        agentId,
        ownerId: "default",
      }),
      sandboxCapability({ provider: sandboxProvider }),
      doomLoopDetection(),
      toolOutputTruncation(),
      batchTool({
        getTools: () => resolveToolsForSession(sessionStore.list()[0]?.id ?? "").tools,
      }),
      taskTracker({ sql: sqlStore }),
      browserbase({
        apiKey: env.BROWSERBASE_API_KEY,
        projectId: env.BROWSERBASE_PROJECT_ID,
      }),
      debugInspector(),
      vibeCoder({
        provider: sandboxProvider,
        backend: {
          loader: env.LOADER,
          dbService: env.DB_SERVICE,
          aiService: env.AI_SERVICE,
        },
      }),
      appRegistry({
        provider: sandboxProvider,
        sql: sqlStore,
        storage,
        backend: {
          loader: env.LOADER,
          dbService: env.DB_SERVICE,
        },
      }),
      aiProxy({ apiKey: () => env.OPENROUTER_API_KEY }),
      skills({
        storage,
        registry: new D1SkillRegistry(env.SKILL_DB, { seeds: EXAMPLE_SKILL_SEEDS }),
        skills: [
          { id: "vibe-webapp", enabled: true },
          { id: "code-review", enabled: true },
        ],
      }),
    ];
  },

  subagentProfiles: () => [explorer({ model: "google/gemini-2.5-flash" })],

  a2a: ({ env }) => ({
    getAgentStub: (id: string) => {
      // Support both DO names ("bob") and hex IDs ("fcc50dec...")
      const doId = /^[0-9a-f]{64}$/i.test(id)
        ? env.AGENT.idFromString(id)
        : env.AGENT.idFromName(id);
      return env.AGENT.get(doId);
    },
    resolveDoId: (id: string) => env.AGENT.idFromName(id).toString(),
    callbackBaseUrl: "https://agent",
  }),

  // Custom debug route: execute a tool out-of-band from the normal
  // inference loop. Returns null for non-debug paths so AgentRuntime's
  // default routing can take over.
  fetch: async (request, { sessionStore, transport, resolveToolsForSession }) => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/debug/execute-tool") {
      return null;
    }

    const body = (await request.json()) as {
      sessionId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    };
    const { toolName, args = {} } = body;
    const sessionId = body.sessionId ?? sessionStore.list()[0]?.id ?? sessionStore.create().id;

    const { tools: allTools } = resolveToolsForSession(sessionId);
    const tool = allTools.find((t) => t.name === toolName);
    if (!tool) {
      const available = allTools.map((t) => t.name);
      return Response.json({ error: `Tool "${toolName}" not found`, available }, { status: 404 });
    }

    if (tool.parameters) {
      const errors = [...Value.Errors(tool.parameters, args)];
      if (errors.length > 0) {
        const issues = errors.map((e) => `${e.path || "/"}: ${e.message}`);
        return Response.json(
          { error: "Invalid tool arguments", issues, schema: tool.parameters },
          { status: 400 },
        );
      }
    }

    const toolCallId = crypto.randomUUID();

    sessionStore.appendEntry(sessionId, {
      type: "message",
      data: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
        timestamp: Date.now(),
      },
    });

    transport.broadcastToSession(sessionId, {
      type: "tool_event",
      sessionId,
      event: { type: "tool_execution_start", toolCallId, toolName, args },
    });

    let result: { content: unknown[]; details: unknown };
    let isError = false;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: tool.execute args type varies per tool
      result = await (tool as AgentTool<any>).execute(args, {
        toolCallId,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: unknown) {
      isError = true;
      const message = e instanceof Error ? e.message : String(e);
      result = {
        content: [{ type: "text", text: `Error: ${message}` }],
        details: { error: message },
      };
    }

    sessionStore.appendEntry(sessionId, {
      type: "message",
      data: {
        role: "toolResult",
        content: result.content,
        details: result.details ?? null,
        toolCallId,
        toolName,
        isError,
        timestamp: Date.now(),
      },
    });

    transport.broadcastToSession(sessionId, {
      type: "tool_event",
      sessionId,
      event: { type: "tool_execution_end", toolCallId, toolName, result, isError },
    });

    return Response.json({ sessionId, toolCallId, toolName, result, isError });
  },
});

// Re-export DOs and entrypoints for wrangler to bind
export { AiService, BackendStorage, DbService, SandboxContainer };
