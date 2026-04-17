import { agentFleet } from "@claw-for-cloudflare/agent-fleet";
import { agentPeering } from "@claw-for-cloudflare/agent-peering";
import { D1AgentRegistry } from "@claw-for-cloudflare/agent-registry";
import type { AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineAgent, defineTool, Type, Value } from "@claw-for-cloudflare/agent-runtime";
import { defineMode } from "@claw-for-cloudflare/agent-runtime/modes";
import { agentStorage } from "@claw-for-cloudflare/agent-storage";
import { agentWorkshop } from "@claw-for-cloudflare/agent-workshop";
import { AiService, aiProxy } from "@claw-for-cloudflare/ai-proxy";
import { appRegistry } from "@claw-for-cloudflare/app-registry";
import { batchTool } from "@claw-for-cloudflare/batch-tool";
import { browserbase } from "@claw-for-cloudflare/browserbase";
import { LlmService, SpineService } from "@claw-for-cloudflare/bundle-host";
import { D1BundleRegistry } from "@claw-for-cloudflare/bundle-registry";
import { defineTelegramChannel } from "@claw-for-cloudflare/channel-telegram";
import {
  CloudflareSandboxProvider,
  ContainerProxy,
  SandboxContainer,
} from "@claw-for-cloudflare/cloudflare-sandbox";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { credentialStore } from "@claw-for-cloudflare/credential-store";
import { doomLoopDetection } from "@claw-for-cloudflare/doom-loop-detection";
import { fileTools } from "@claw-for-cloudflare/file-tools";
import { FileToolsService } from "@claw-for-cloudflare/file-tools/service";
import { HeartbeatConfigSchema, heartbeat } from "@claw-for-cloudflare/heartbeat";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { sandboxCapability } from "@claw-for-cloudflare/sandbox";
import { D1SkillRegistry, parseSkillFile } from "@claw-for-cloudflare/skill-registry";
import { skills } from "@claw-for-cloudflare/skills";
import { SkillsService } from "@claw-for-cloudflare/skills/service";
import { explorer } from "@claw-for-cloudflare/subagent-explorer";
import { taskTracker } from "@claw-for-cloudflare/task-tracker";
import { TavilyConfigSchema, tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { toolOutputTruncation } from "@claw-for-cloudflare/tool-output-truncation";
import { vectorMemory } from "@claw-for-cloudflare/vector-memory";
import { VectorMemoryService } from "@claw-for-cloudflare/vector-memory/service";
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
  // Bundle brain override
  BUNDLE_DB: D1Database;
  BUNDLE_KV: KVNamespace;
  AGENT_AUTH_KEY: string;
  SPINE_SERVICE: Fetcher;
  LLM_SERVICE: Fetcher;
  SKILLS_SERVICE: Service<SkillsService>;
  VECTOR_MEMORY_SERVICE: Service<VectorMemoryService>;
  FILE_TOOLS_SERVICE: Service<FileToolsService>;
  // Default public URL used by channels (e.g. Telegram) when registering
  // webhooks. Optional — the add-account flow falls back to deriving one
  // from the incoming request origin when this isn't set.
  PUBLIC_URL?: string;
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
/**
 * Agent-level config surface. Flat record of TypeBox schemas keyed by
 * namespace; each key becomes a namespace the agent can read/write via
 * `config_get` / `config_set` / `config_schema` tools and the UI's
 * `useAgentConfig()` hook. Capability schemas migrate in here; custom
 * consumer config (e.g. `personality`) sits alongside.
 */
const agentConfig = {
  personality: Type.Object({
    tone: Type.Union([Type.Literal("formal"), Type.Literal("casual"), Type.Literal("terse")], {
      default: "casual",
    }),
    verbosity: Type.Integer({ default: 3, minimum: 1, maximum: 5 }),
  }),
  heartbeat: HeartbeatConfigSchema,
  search: TavilyConfigSchema,
};

export const BasicAgent = defineAgent<Env>({
  model: (env) => ({
    provider: "openrouter",
    modelId: "minimax/minimax-m2.7",
    apiKey: env.OPENROUTER_API_KEY,
    a2a: { discoverable: true },
  }),

  config: agentConfig,

  prompt: {
    agentName: "Basic Agent",
    agentDescription: "A helpful agent that can search, compute, and manage files.",
    timezone: "UTC",
  },

  // Bundle brain override — opt-in. When a bundle is registered via the
  // workshop tools, turns dispatch into it. Static brain above is always
  // the fallback.
  bundle: {
    registry: (env) => new D1BundleRegistry(env.BUNDLE_DB, env.BUNDLE_KV),
    loader: (env) => env.LOADER,
    authKey: (env) => env.AGENT_AUTH_KEY,
    bundleEnv: (env) => ({
      LLM: env.LLM_SERVICE,
      SPINE: env.SPINE_SERVICE,
      SKILLS: env.SKILLS_SERVICE,
      VECTOR_MEMORY: env.VECTOR_MEMORY_SERVICE,
      FILE_TOOLS: env.FILE_TOOLS_SERVICE,
    }),
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
      tavilyWebSearch({
        tavilyApiKey: () => env.TAVILY_API_KEY,
        config: (c) => c.search as import("@claw-for-cloudflare/tavily-web-search").TavilyConfig,
      }),
      fileTools({ storage }),
      vectorMemory({
        storage,
        vectorizeIndex: () => env.MEMORY_INDEX,
        ai: () => env.AI,
      }),
      promptScheduler(),
      credentialStore(),
      heartbeat({
        config: (c) => c.heartbeat as import("@claw-for-cloudflare/heartbeat").HeartbeatConfig,
      }),
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
      // Telegram channel. Registered unconditionally — accounts are
      // managed at runtime from the Channels UI (or via the
      // `telegram-accounts` config namespace), not via env vars.
      // The public base URL for `setWebhook` is sourced by the
      // runtime from `env.PUBLIC_URL` and surfaced on every capability
      // context — the channel reads it from there, not from this
      // option bag. `agentId` is embedded in the registered webhook URL
      // (`/telegram/webhook/<agentId>/<accountId>`) so the top-level
      // proxy route can resolve the right DO in a multi-tenant
      // deployment.
      defineTelegramChannel({ agentId }),
      skills({
        storage,
        registry: new D1SkillRegistry(env.SKILL_DB, { seeds: EXAMPLE_SKILL_SEEDS }),
        skills: [
          { id: "vibe-webapp", enabled: true },
          { id: "code-review", enabled: true },
        ],
      }),
      // Agent workshop — author, build, test, deploy bundle brains.
      // Build runs in-process via @cloudflare/worker-bundler; source files
      // live in R2 under `{namespace}/workshop/bundles/{name}/` via the
      // shared AgentStorage handle. No container required.
      agentWorkshop({
        registry: new D1BundleRegistry(env.BUNDLE_DB, env.BUNDLE_KV),
        storage,
      }),
    ];
  },

  subagentModes: () => [explorer({ model: "google/gemini-2.5-flash" })],

  // A single registered mode gives us two effective states — "in plan
  // mode" and "out of plan mode (null)" — so the /mode toggle is
  // meaningful with just one entry.
  modes: () => [
    defineMode({
      id: "plan",
      name: "Planning",
      description:
        "Read-only exploration mode. Investigate the task and produce a plan before executing changes.",
      // Allow-list: only read/query/delegate tools. Everything not
      // listed here (writes, exec, container/preview, browser
      // interaction, bundle authoring, agent mutation, config mutation,
      // …) is filtered out.
      tools: {
        allow: [
          // Web search & fetch
          "web_search",
          "web_fetch",
          // Read-only file operations
          "file_read",
          "file_list",
          "file_tree",
          "file_find",
          // Semantic memory
          "memory_search",
          "memory_get",
          // Agent management — list + delegate (call/start), no create/delete/attach
          "agent_list",
          "call_agent",
          "start_task",
          "check_task",
          // Mode transition
          "exit_mode",
        ],
      },
      promptAppend: `# Planning mode

You are operating in planning mode. Your goal is to investigate and produce a concrete plan, not to execute changes. Rules:

- Your tool surface is restricted to read-only tools (web search, file read/list/find, memory search, agent delegation, task tracking).
- Gather context via web_search, file_read, and memory_search. Delegate investigation to subagents via call_agent / start_task when useful.
- Produce a concrete plan: files to touch, changes to make, risks, verification steps.
- When the plan is ready, stop and present it. Wait for the user to confirm before leaving planning mode via \`/mode\` or \`exit_mode\`.`,
    }),
  ],

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

// Re-export DOs and entrypoints for wrangler to bind. ContainerProxy is
// required by @cloudflare/containers 0.2.x when SandboxContainer intercepts
// outbound HTTP via `outboundByHost` — the container runtime reaches into
// `ctx.exports.ContainerProxy` at startup and throws if it isn't bound.
export {
  AiService,
  BackendStorage,
  ContainerProxy,
  DbService,
  FileToolsService,
  LlmService,
  SandboxContainer,
  SkillsService,
  SpineService,
  VectorMemoryService,
};
