import { agentFleet } from "@claw-for-cloudflare/agent-fleet";
import { agentPeering } from "@claw-for-cloudflare/agent-peering";
import { D1AgentRegistry } from "@claw-for-cloudflare/agent-registry";
import type {
  AgentConfig,
  AgentContext,
  AgentTool,
  Capability,
  PromptOptions,
  ScheduleManager,
} from "@claw-for-cloudflare/agent-runtime";
import {
  AgentDO,
  createCapabilityStorage,
  defineTool,
  resolveCapabilities,
  Type,
  Value,
} from "@claw-for-cloudflare/agent-runtime";
import { agentStorage } from "@claw-for-cloudflare/agent-storage";
import {
  CloudflareSandboxProvider,
  SandboxContainer,
  handlePreviewRequest,
} from "@claw-for-cloudflare/cloudflare-sandbox";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { credentialStore } from "@claw-for-cloudflare/credential-store";
import { heartbeat } from "@claw-for-cloudflare/heartbeat";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";
import { sandboxCapability } from "@claw-for-cloudflare/sandbox";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { vectorMemory } from "@claw-for-cloudflare/vector-memory";
import { handleDeployRequest, vibeCoder } from "@claw-for-cloudflare/vibe-coder";
import { debugInspector } from "./debug-capability";

interface Env {
  AGENT: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
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
}

/**
 * A minimal agent that can tell the time and do basic math.
 * Demonstrates extending AgentDO with custom tools.
 */
export class BasicAgent extends AgentDO<Env> {
  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "minimax/minimax-m2.7",
      apiKey: this.env.OPENROUTER_API_KEY,
      a2a: { discoverable: true },
    };
  }

  protected getCapabilities(): Capability[] {
    const storage = agentStorage({
      bucket: () => this.env.STORAGE_BUCKET,
      namespace: this.ctx.id.toString(),
    });

    return [
      compactionSummary({
        provider: "openrouter",
        modelId: "google/gemini-2.0-flash-001",
        getApiKey: () => this.env.OPENROUTER_API_KEY,
      }),
      tavilyWebSearch({
        tavilyApiKey: () => this.env.TAVILY_API_KEY,
      }),
      r2Storage({ storage }),
      vectorMemory({
        storage,
        vectorizeIndex: () => this.env.MEMORY_INDEX,
        ai: () => this.env.AI,
      }),
      promptScheduler(),
      credentialStore(),
      heartbeat({ every: "30m", enabled: false }),
      ...this.buildAgentOpsCapabilities(),
      sandboxCapability({
        provider: new CloudflareSandboxProvider({
          storage,
          getStub: () => {
            const id = this.env.SANDBOX_CONTAINER.idFromName(this.ctx.id.toString());
            return this.env.SANDBOX_CONTAINER.get(id);
          },
          containerMode: "dev",
        }),
      }),
      debugInspector(),
      vibeCoder({
        provider: new CloudflareSandboxProvider({
          storage,
          getStub: () => {
            const id = this.env.SANDBOX_CONTAINER.idFromName(this.ctx.id.toString());
            return this.env.SANDBOX_CONTAINER.get(id);
          },
          containerMode: "dev",
        }),
        deploy: { storage },
      }),
    ];
  }

  private buildAgentOpsCapabilities(): Capability[] {
    const agentId = this.ctx.id.toString();
    const getAgentStub = (id: string) => this.env.AGENT.get(this.env.AGENT.idFromName(id));
    // resolveDoId converts registry UUIDs to DO hex IDs for HMAC token signing,
    // ensuring the token target matches the receiving DO's this.ctx.id.toString().
    const resolveDoId = (id: string) => this.env.AGENT.idFromName(id).toString();
    const registry = new D1AgentRegistry(this.env.AGENT_DB);

    const peering = agentPeering({
      secret: this.env.AGENT_SECRET,
      getAgentStub,
      resolveDoId,
      agentId,
    });

    return [
      peering.capability,
      agentFleet({
        registry,
        secret: this.env.AGENT_SECRET,
        getAgentStub,
        resolveDoId,
        agentId,
        ownerId: "default",
      }),
    ];
  }

  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires explicit any
  getTools(_context: AgentContext): AgentTool<any>[] {
    return [
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
    ];
  }

  protected getA2AClientOptions() {
    return {
      getAgentStub: (id: string) => {
        // Support both DO names ("bob") and hex IDs ("fcc50dec...")
        const doId = /^[0-9a-f]{64}$/i.test(id)
          ? this.env.AGENT.idFromString(id)
          : this.env.AGENT.idFromName(id);
        return this.env.AGENT.get(doId);
      },
      resolveDoId: (id: string) => this.env.AGENT.idFromName(id).toString(),
      callbackBaseUrl: "https://agent",
    };
  }

  protected getPromptOptions(): PromptOptions {
    return {
      agentName: "Basic Agent",
      agentDescription: "A helpful agent that can search, compute, and manage files.",
      timezone: "UTC",
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/debug/execute-tool") {
      return this.handleDebugToolExecution(request);
    }
    return super.fetch(request);
  }

  private async handleDebugToolExecution(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sessionId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    };

    const { toolName, args = {} } = body;
    const sessionId =
      body.sessionId ?? this.sessionStore.list()[0]?.id ?? this.sessionStore.create().id;

    // Build a minimal AgentContext for tool resolution
    // biome-ignore lint/suspicious/noExplicitAny: Debug mock doesn't need real schedule returns
    const noopAsync = () => Promise.resolve(null as any);
    const noopSchedules: ScheduleManager = {
      create: noopAsync,
      update: noopAsync,
      delete: () => Promise.resolve(),
      list: () => [],
      get: () => null,
      setTimer: noopAsync,
      cancelTimer: noopAsync,
    };
    const context: AgentContext = {
      agentId: this.ctx.id.toString(),
      sessionId,
      stepNumber: 0,
      emitCost: () => {},
      broadcast: (name, data) =>
        this.transport.broadcastToSession(sessionId, {
          type: "custom_event",
          sessionId,
          event: { name, data },
        }),
      broadcastToAll: (name, data) => {
        for (const conn of this.transport.getConnections()) {
          conn.send({
            type: "custom_event",
            sessionId: conn.getSessionId(),
            event: { name, data },
          });
        }
      },
      requestFromClient: () => Promise.reject(new Error("Not available in debug mode")),
      schedules: noopSchedules,
    };

    // Resolve all tools (base + capabilities)
    const baseTools = this.getTools(context);
    const resolved = resolveCapabilities(this.getCapabilities(), context, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );
    const allTools = [...baseTools, ...resolved.tools];

    const tool = allTools.find((t) => t.name === toolName);
    if (!tool) {
      const available = allTools.map((t) => t.name);
      return Response.json({ error: `Tool "${toolName}" not found`, available }, { status: 404 });
    }

    // Validate args against the tool's TypeBox schema
    if (tool.parameters) {
      const errors = [...Value.Errors(tool.parameters, args)];
      if (errors.length > 0) {
        const issues = errors.map((e) => `${e.path || "/"}: ${e.message}`);
        return Response.json(
          {
            error: "Invalid tool arguments",
            issues,
            schema: tool.parameters,
          },
          { status: 400 },
        );
      }
    }

    const toolCallId = crypto.randomUUID();

    // Persist assistant message with tool_use block
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
        timestamp: Date.now(),
      },
    });

    // Broadcast tool_execution_start
    this.transport.broadcastToSession(sessionId, {
      type: "tool_event",
      sessionId,
      event: { type: "tool_execution_start", toolCallId, toolName, args },
    });

    // Execute the tool
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

    // Persist tool result
    this.sessionStore.appendEntry(sessionId, {
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

    // Broadcast tool_execution_end
    this.transport.broadcastToSession(sessionId, {
      type: "tool_event",
      sessionId,
      event: { type: "tool_execution_end", toolCallId, toolName, result, isError },
    });

    return Response.json({ sessionId, toolCallId, toolName, result, isError });
  }
}

// Re-export SandboxContainer for wrangler to bind as a DO
export { SandboxContainer };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const jsonHeaders = { "content-type": "application/json" };

    // GET /agents — list all agents from registry
    if (url.pathname === "/agents" && request.method === "GET") {
      const registry = new D1AgentRegistry(env.AGENT_DB);
      const agents = await registry.list("default");
      return new Response(JSON.stringify(agents), { headers: jsonHeaders });
    }

    // POST /agents — create a new root agent
    if (url.pathname === "/agents" && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      const registry = new D1AgentRegistry(env.AGENT_DB);
      const agent = await registry.create({
        id: crypto.randomUUID(),
        name: body.name,
        ownerId: "default",
        parentAgentId: null,
      });
      return new Response(JSON.stringify(agent), { headers: jsonHeaders, status: 201 });
    }

    // /deploy/:agentId/:deployId[/...] — serve deployed apps via worker loader
    const deployRes = handleDeployRequest({
      request,
      agentNamespace: env.AGENT,
      storageBucket: env.STORAGE_BUCKET,
      loader: env.LOADER,
    });
    if (deployRes) return deployRes;

    // /preview/:id[/...] — proxy to sandbox container for dev server preview
    const previewRes = handlePreviewRequest({
      request,
      agentNamespace: env.AGENT,
      containerNamespace: env.SANDBOX_CONTAINER,
    });
    if (previewRes) return previewRes;

    // /agent/:agentId[/...] — route to agent DO by ID
    const agentMatch = url.pathname.match(/^\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const id = env.AGENT.idFromName(agentId);
      const stub = env.AGENT.get(id);
      // Strip the /agent/:agentId prefix so the DO sees clean paths
      const doUrl = new URL(request.url);
      doUrl.pathname = agentMatch[2] || "/";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("Basic Agent Example", { status: 200 });
  },
};
