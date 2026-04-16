/**
 * Test AgentDO subclass with bundle dispatch enabled + mocked LLM for
 * integration tests. Paired with `TestAgentDO` (which has no bundle config)
 * to exercise both the static brain and bundle-override code paths.
 *
 * The bundle registry and fake WorkerLoader are injected via module-level
 * holders (`setTestBundleRegistry` / `setTestBundleLoader`). Tests set them
 * before asking for a DO stub, and the DO's BundleConfig factories read
 * them at `initBundleDispatch` time. Each test uses a unique DO name so
 * construction — and therefore config capture — is per-test.
 */

import type { AgentEvent, AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import { Type } from "@sinclair/typebox";
import type { AgentConfig, AgentContext } from "../agent-do.js";
import { AgentDO } from "../agent-do.js";
import type { BundleConfig, BundleRegistry } from "../bundle-config.js";
import { resolveCapabilities } from "../capabilities/resolve.js";
import { createCapabilityStorage, createNoopStorage } from "../capabilities/storage.js";
import type { Capability } from "../capabilities/types.js";
import type { CompactionConfig } from "../compaction/types.js";
import { defineTool } from "../tools/define-tool.js";
import { buildMockCompactionCapability, MockPiAgent } from "./test-agent-do.js";

const DEFAULT_COMPACTION_THRESHOLD = 0.75;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const TEST_BUNDLE_AUTH_KEY = "test-bundle-auth-master-key-0123456789";

// --- Module-level test fixtures -------------------------------------------------

let currentRegistry: BundleRegistry | null = null;
let currentLoader: WorkerLoader | null = null;
let currentBundleEnv: Record<string, unknown> = {};
let currentMaxLoadFailures: number | undefined;

export function setTestBundleRegistry(registry: BundleRegistry | null): void {
  currentRegistry = registry;
}

export function setTestBundleLoader(loader: WorkerLoader | null): void {
  currentLoader = loader;
}

export function setTestBundleEnv(env: Record<string, unknown>): void {
  currentBundleEnv = env;
}

export function setTestBundleMaxLoadFailures(n: number | undefined): void {
  currentMaxLoadFailures = n;
}

export function resetTestBundleHolders(): void {
  currentRegistry = null;
  currentLoader = null;
  currentBundleEnv = {};
  currentMaxLoadFailures = undefined;
}

// --- Test tool ---
// MockPiAgent's internal response queue lives in test-agent-do.ts and is
// controlled via its exported setMockResponses()/clearMockResponses() helpers.
// Bundle tests reuse those directly — no separate queue here.

const echoBundleTool = defineTool({
  name: "echo",
  description: "Returns the input text back",
  parameters: Type.Object({
    text: Type.String({ description: "Text to echo" }),
  }),
  execute: async (args) => ({
    content: [{ type: "text" as const, text: `Echo: ${args.text}` }],
    details: { echoed: args.text },
  }),
});

// --- The DO --------------------------------------------------------------------

export class TestBundleAgentDO extends AgentDO {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);

    const bundleConfig: BundleConfig<Record<string, unknown>> = {
      registry: () => {
        if (!currentRegistry) {
          throw new Error(
            "TestBundleAgentDO: no registry installed — call setTestBundleRegistry(...) before stubbing the DO",
          );
        }
        return currentRegistry;
      },
      loader: () => {
        if (!currentLoader) {
          throw new Error(
            "TestBundleAgentDO: no loader installed — call setTestBundleLoader(...) before stubbing the DO",
          );
        }
        return currentLoader;
      },
      authKey: () => TEST_BUNDLE_AUTH_KEY,
      bundleEnv: () => ({ ...currentBundleEnv }),
      maxLoadFailures: currentMaxLoadFailures,
    };

    // Install bundle dispatch on this instance using the shared AgentDO method.
    this.initBundleDispatch(ctx, env, bundleConfig);
  }

  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "openrouter/auto",
      apiKey: "test-key",
      maxSteps: 10,
    };
  }

  getTools(_context: AgentContext): AgentTool[] {
    return [echoBundleTool as unknown as AgentTool];
  }

  getCapabilities(): Capability[] {
    const compactionConfig: CompactionConfig = {
      threshold: DEFAULT_COMPACTION_THRESHOLD,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    };
    return [buildMockCompactionCapability(compactionConfig)];
  }

  buildSystemPrompt(_context: AgentContext): string {
    return "You are a test bundle agent. Respond concisely.";
  }

  override validateAuth(request: Request): boolean {
    // For the /bundle/disable auth tests, require a bearer token.
    const auth = request.headers.get("authorization");
    return auth === "Bearer test-token";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Wait-idle: drain fire-and-forget async ops before assertions.
    if (request.method === "POST" && url.pathname === "/wait-idle") {
      await Promise.all(this.pendingAsyncOps);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Read raw session entries for assertions.
    if (request.method === "GET" && url.pathname === "/entries") {
      const sessionId = url.searchParams.get("sessionId");
      const sessions = this.sessionStore.list();
      const sid = sessionId ?? sessions[0]?.id;
      if (!sid) {
        return new Response(JSON.stringify({ entries: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      const entries = this.sessionStore.getEntries(sid);
      return new Response(JSON.stringify({ entries }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Read the current cached bundle pointer (for assertions).
    if (request.method === "GET" && url.pathname === "/bundle/cache") {
      const cached = await this.ctx.storage.get<string | null>("activeBundleVersionId");
      return new Response(JSON.stringify({ cached: cached ?? null }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Force cache write (used by the /bundle/refresh out-of-band test).
    if (request.method === "POST" && url.pathname === "/bundle/cache-write") {
      const body = (await request.json()) as { versionId: string | null };
      await this.ctx.storage.put("activeBundleVersionId", body.versionId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Drive a turn without needing a WebSocket. Creates a fresh session
    // if none exists, then handlePrompts directly. Awaits pendingAsyncOps.
    if (request.method === "POST" && url.pathname === "/test-turn") {
      const body = (await request.json()) as { sessionId?: string; prompt: string };
      let sid = body.sessionId;
      if (!sid) {
        const session = this.sessionStore.create({ name: "test-session" });
        sid = session.id;
      }
      await (this as unknown as { handlePrompt(s: string, t: string): Promise<void> }).handlePrompt(
        sid,
        body.prompt,
      );
      await Promise.all(this.pendingAsyncOps);
      return new Response(JSON.stringify({ sessionId: sid }), {
        headers: { "content-type": "application/json" },
      });
    }

    return super.fetch(request);
  }

  /**
   * Override ensureAgent with MockPiAgent so the static brain fallback
   * produces deterministic events without pulling in pi-agent-core.
   */
  protected async ensureAgent(sessionId: string): Promise<void> {
    const context: AgentContext = {
      agentId: this.ctx.id.toString(),
      sessionId,
      stepNumber: 0,
      emitCost: (cost) => this.handleCostEvent(cost, sessionId),
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      broadcastState: () => {},
      schedules: this.buildScheduleManager(),
      rateLimit: this.rateLimiter,
      notifyBundlePointerChanged: async () => {
        await this.runtime.bundlePointerRefresher?.();
      },
      getBundleHostCapabilityIds: () => this.getBundleHostCapabilityIds(),
    };

    const resolved = resolveCapabilities(this.getCapabilities(), context, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );
    this.resolvedCapabilitiesCache = resolved;
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;
    this.beforeToolExecutionHooks = resolved.beforeToolExecutionHooks;
    this.afterToolExecutionHooks = resolved.afterToolExecutionHooks;

    if (resolved.schedules.length > 0) {
      await this.syncCapabilitySchedules(resolved.schedules);
    }

    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

    let systemPrompt = this.buildSystemPrompt(context);
    if (resolved.promptSections.length > 0) {
      systemPrompt += `\n\n${resolved.promptSections.map((s) => s.content).join("\n\n")}`;
    }

    const messages = this.sessionStore.buildContext(sessionId);

    const agent = new MockPiAgent({
      initialState: {
        systemPrompt,
        model: { id: "test/mock" },
        tools: allTools,
        messages,
      },
      transformContext: (msgs: AgentMessage[]) => this.transformContext(msgs, sessionId),
    });

    agent.subscribe((event: AgentEvent) => {
      this.handleAgentEvent(event, sessionId);
      if (event.type === "agent_end") {
        this.sessionAgents.delete(sessionId);
      }
    });

    this.sessionAgents.set(sessionId, agent);
  }
}
