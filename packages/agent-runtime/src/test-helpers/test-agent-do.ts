/**
 * Test AgentDO subclass with mocked LLM for integration tests.
 * Bypasses pi-ai entirely to avoid partial-json CJS issue in Workers test pool.
 */

import type { AgentEvent, AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import { Type } from "@sinclair/typebox";
import type { AgentConfig, AgentContext } from "../agent-do.js";
import { AgentDO } from "../agent-do.js";
import { resolveCapabilities } from "../capabilities/resolve.js";
import { createCapabilityStorage } from "../capabilities/storage.js";
import type { Capability, CapabilityHookContext } from "../capabilities/types.js";
import { compactSession, estimateMessagesTokens } from "../compaction/compaction.js";
import type { CompactionConfig, SummarizeFn } from "../compaction/types.js";
import { defineTool } from "../tools/define-tool.js";

const DEFAULT_COMPACTION_THRESHOLD = 0.75;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** Configurable mock responses for the test agent */
export interface MockResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  /** Delay in ms before emitting events (for testing steer/abort mid-run) */
  delay?: number;
}

let mockResponseQueue: MockResponse[] = [];

export function setMockResponses(responses: MockResponse[]) {
  mockResponseQueue = [...responses];
}

export function clearMockResponses() {
  mockResponseQueue = [];
}

/**
 * A lightweight mock Agent that mimics pi-agent-core's Agent interface
 * without actually importing it (avoids partial-json CJS issue).
 */
class MockPiAgent {
  private listeners: Array<(e: AgentEvent) => void> = [];
  private _state: any;
  private tools: Map<string, AgentTool> = new Map();
  private aborted = false;
  private _idleResolvers: Array<() => void> = [];
  private transformContext?: (msgs: AgentMessage[]) => Promise<AgentMessage[]>;
  steeredMessages: AgentMessage[] = [];

  constructor(opts: any) {
    this._state = {
      systemPrompt: opts.initialState?.systemPrompt ?? "",
      model: opts.initialState?.model ?? {},
      tools: opts.initialState?.tools ?? [],
      messages: opts.initialState?.messages ?? [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set(),
    };
    this.transformContext = opts.transformContext;

    for (const tool of this._state.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get state() {
    return this._state;
  }

  subscribe(fn: (e: AgentEvent) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(event: AgentEvent) {
    for (const fn of this.listeners) fn(event);
  }

  setSystemPrompt(v: string) {
    this._state.systemPrompt = v;
  }
  setTools(t: AgentTool[]) {
    this._state.tools = t;
    this.tools.clear();
    for (const tool of t) this.tools.set(tool.name, tool);
  }
  replaceMessages(msgs: AgentMessage[]) {
    this._state.messages = msgs;
  }

  abort() {
    this.aborted = true;
  }

  async waitForIdle() {
    if (!this._state.isStreaming) return;
    return new Promise<void>((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  steer(m: AgentMessage) {
    this._state.messages.push(m);
    this.steeredMessages.push(m);
  }

  private resolveIdle() {
    for (const resolve of this._idleResolvers) resolve();
    this._idleResolvers = [];
  }

  async prompt(_input: string | AgentMessage | AgentMessage[]) {
    // Note: we do NOT push the user message here because the DO's handlePrompt
    // already persists it to session store, and ensureAgent calls replaceMessages
    // with the full context including the user message.

    // Run transformContext hook (triggers compaction when threshold reached)
    if (this.transformContext) {
      this._state.messages = await this.transformContext(this._state.messages);
    }

    this.aborted = false;
    this._state.isStreaming = true;
    this.emit({ type: "agent_start" } as AgentEvent);
    this.emit({ type: "turn_start" } as AgentEvent);

    const response = mockResponseQueue.shift() ?? { text: "Mock response" };

    // Support delays for testing steer/abort mid-run.
    // Set streamMessage during the delay to simulate a real streaming model
    // so that new connections can see the in-progress message.
    if (response.delay) {
      const partialStreamMsg: any = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: Date.now(),
      };
      this._state.streamMessage = partialStreamMsg;
      this.emit({ type: "message_start", message: partialStreamMsg } as AgentEvent);
      await new Promise((r) => setTimeout(r, response.delay));
    }

    // Check if aborted during delay
    if (this.aborted) {
      const partialMsg: any = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: response.text ? response.text.slice(0, Math.ceil(response.text.length / 2)) : "",
          },
        ],
        timestamp: Date.now(),
      };
      this.emit({ type: "message_start", message: partialMsg } as AgentEvent);
      this.emit({ type: "message_end", message: partialMsg } as AgentEvent);
      this.emit({
        type: "turn_end",
        message: partialMsg,
        toolResults: [],
      } as AgentEvent);
      this._state.isStreaming = false;
      this.emit({
        type: "agent_end",
        messages: this._state.messages,
      } as AgentEvent);
      this.resolveIdle();
      return;
    }

    // Build assistant message
    const content: any[] = [];
    if (response.text) {
      content.push({ type: "text", text: response.text });
    }

    const assistantMsg: any = {
      role: "assistant",
      content,
      timestamp: Date.now(),
    };

    this._state.streamMessage = assistantMsg;
    if (!response.delay) {
      // Only emit message_start for non-delay responses (delay path already emitted it)
      this.emit({ type: "message_start", message: assistantMsg } as AgentEvent);
    }
    this.emit({ type: "message_end", message: assistantMsg } as AgentEvent);
    this._state.streamMessage = null;

    // Handle tool calls
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        if (this.aborted) break;

        const tool = this.tools.get(tc.name);
        const toolCallId = `call_${Math.random().toString(36).slice(2, 10)}`;

        this.emit({
          type: "tool_execution_start",
          toolCallId,
          toolName: tc.name,
          args: tc.args,
        } as AgentEvent);

        let result: any;
        let isError = false;
        try {
          result = tool
            ? await tool.execute(tc.args, { toolCallId })
            : { content: [{ type: "text", text: "Unknown tool" }], details: {} };
        } catch (err: any) {
          result = { content: [{ type: "text", text: err.message }], details: {} };
          isError = true;
        }

        this.emit({
          type: "tool_execution_end",
          toolCallId,
          toolName: tc.name,
          result,
          isError,
        } as AgentEvent);
      }

      // If there's a follow-up response in the queue, process it
      if (mockResponseQueue.length > 0 && !this.aborted) {
        const followUp = mockResponseQueue.shift()!;
        const followUpMsg: any = {
          role: "assistant",
          content: [{ type: "text", text: followUp.text }],
          timestamp: Date.now(),
        };

        this.emit({ type: "turn_start" } as AgentEvent);
        this.emit({ type: "message_start", message: followUpMsg } as AgentEvent);
        this.emit({ type: "message_end", message: followUpMsg } as AgentEvent);
        this.emit({
          type: "turn_end",
          message: followUpMsg,
          toolResults: [],
        } as AgentEvent);
      }
    }

    this.emit({
      type: "turn_end",
      message: assistantMsg,
      toolResults: [],
    } as AgentEvent);

    this._state.isStreaming = false;
    this.emit({
      type: "agent_end",
      messages: this._state.messages,
    } as AgentEvent);

    this.resolveIdle();
  }
}

// Test tool
const echoTool = defineTool({
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

/** Allow tests to override compaction config per DO name */
let compactionOverrides: Record<string, Partial<CompactionConfig>> = {};

export function setCompactionOverride(doName: string, config: Partial<CompactionConfig>) {
  compactionOverrides[doName] = config;
}

export function clearCompactionOverrides() {
  compactionOverrides = {};
}

/**
 * Build a mock compaction capability for testing.
 * Uses a dummy summarizer (no LLM call) matching the old inline behavior.
 */
function buildMockCompactionCapability(compactionConfig: CompactionConfig): Capability {
  const dummySummarize: SummarizeFn = async (msgs, prevSummary) => {
    const content = msgs
      .map((m) => {
        const c = (m as any).content;
        return typeof c === "string" ? c : JSON.stringify(c);
      })
      .join("\n");
    return prevSummary
      ? `${prevSummary}\n\n[Continued]\n${content.slice(0, 500)}`
      : content.slice(0, 1000);
  };

  return {
    id: "compaction-summary",
    name: "Test Compaction",
    description: "Mock compaction for testing",
    hooks: {
      beforeInference: async (
        messages: AgentMessage[],
        ctx: CapabilityHookContext,
      ): Promise<AgentMessage[]> => {
        const totalTokens = estimateMessagesTokens(messages);

        if (totalTokens <= compactionConfig.threshold * compactionConfig.contextWindowTokens) {
          return messages;
        }

        const entries = ctx.sessionStore.getEntries(ctx.sessionId);
        const entryIds = entries.filter((e) => e.type === "message").map((e) => e.id);

        const result = await compactSession(messages, entryIds, compactionConfig, dummySummarize);

        if (result) {
          ctx.sessionStore.appendEntry(ctx.sessionId, {
            type: "compaction",
            data: {
              summary: result.summary,
              firstKeptEntryId: result.firstKeptEntryId,
              tokensBefore: result.tokensBefore,
            },
          });

          return ctx.sessionStore.buildContext(ctx.sessionId);
        }

        return messages;
      },
    },
  };
}

export class TestAgentDO extends AgentDO {
  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "openrouter/auto",
      apiKey: "test-key",
      maxSteps: 10,
      a2a: {
        discoverable: true,
        acceptMessages: true,
      },
    };
  }

  protected getCapabilities(): Capability[] {
    const override = Object.values(compactionOverrides)[0];
    const compactionConfig: CompactionConfig = {
      threshold: override?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
      contextWindowTokens: override?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      keepRecentTokens: override?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    };
    return [buildMockCompactionCapability(compactionConfig)];
  }

  /** Additional tools injected for testing (e.g., mock MCP tools) */
  private extraTools: AgentTool[] = [];

  /**
   * Register a mock MCP tool directly (bypasses real MCP connection).
   * Call via HTTP: POST /register-mock-mcp with { tools: [...] }
   */
  addMockMcpTools(tools: AgentTool[]) {
    this.extraTools.push(...tools);
  }

  getTools(_context: AgentContext): AgentTool[] {
    return [echoTool as unknown as AgentTool, ...this.extraTools];
  }

  buildSystemPrompt(_context: AgentContext): string {
    return "You are a test agent. Respond concisely.";
  }

  protected getA2AClientOptions() {
    // biome-ignore lint/suspicious/noExplicitAny: Test environment — env is Record<string, unknown>
    const agentNs = (this.env as any).AGENT as DurableObjectNamespace;
    return {
      getAgentStub: (id: string) => agentNs.get(agentNs.idFromName(id)),
      resolveDoId: (id: string) => agentNs.idFromName(id).toString(),
      callbackBaseUrl: "https://agent",
    };
  }

  /**
   * Override fetch to add test-specific endpoints.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Register mock MCP tools
    if (request.method === "POST" && url.pathname === "/register-mock-mcp") {
      const body = (await request.json()) as {
        tools: Array<{ name: string; description: string }>;
      };
      const tools = body.tools.map(
        (t) =>
          defineTool({
            name: t.name,
            description: t.description,
            parameters: Type.Object({
              query: Type.String({ description: "Query input" }),
            }),
            execute: async (args) => ({
              content: [{ type: "text" as const, text: `MCP result for: ${args.query}` }],
              details: { source: "mock-mcp", toolName: t.name },
            }),
          }) as unknown as AgentTool,
      );
      this.addMockMcpTools(tools);
      return new Response(JSON.stringify({ registered: tools.length }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Steer endpoint (for testing steer mid-run)
    if (request.method === "POST" && url.pathname === "/steer") {
      const body = (await request.json()) as {
        sessionId: string;
        text: string;
      };
      const agents = this.sessionAgents as Map<string, MockPiAgent>;
      const agent = body.sessionId ? agents.get(body.sessionId) : agents.values().next().value;
      if (agent) {
        agent.steer({
          role: "user",
          content: body.text,
          timestamp: Date.now(),
        } as AgentMessage);
      }
      return new Response(JSON.stringify({ steered: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Abort endpoint
    if (request.method === "POST" && url.pathname === "/abort") {
      const body = (await request.json()) as { sessionId?: string };
      const agents = this.sessionAgents as Map<string, MockPiAgent>;
      const agent = body.sessionId ? agents.get(body.sessionId) : agents.values().next().value;
      if (agent) {
        agent.abort();
      }
      return new Response(JSON.stringify({ aborted: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Get steer history
    if (request.method === "GET" && url.pathname === "/steer-history") {
      const sessionId = url.searchParams.get("sessionId");
      const agents = this.sessionAgents as Map<string, MockPiAgent>;
      const agent = sessionId ? agents.get(sessionId) : agents.values().next().value;
      return new Response(
        JSON.stringify({
          steeredMessages: agent?.steeredMessages ?? [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // Session entries (for inspecting raw entries in tests)
    if (request.method === "GET" && url.pathname === "/entries") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        const sessions = this.sessionStore.list();
        if (sessions.length === 0) {
          return new Response(JSON.stringify({ entries: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        const entries = this.sessionStore.getEntries(sessions[0].id);
        return new Response(JSON.stringify({ entries }), {
          headers: { "content-type": "application/json" },
        });
      }
      const entries = this.sessionStore.getEntries(sessionId);
      return new Response(JSON.stringify({ entries }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Wait for all pending async operations (e.g., fire-and-forget callback prompts)
    if (request.method === "POST" && url.pathname === "/wait-idle") {
      await Promise.all(this.pendingAsyncOps);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Register a pending A2A task for testing callback injection
    if (request.method === "POST" && url.pathname === "/register-pending-task") {
      const { PendingTaskStore } = await import("@claw-for-cloudflare/a2a");
      const { createCapabilityStorage } = await import("../capabilities/storage.js");
      const storage = createCapabilityStorage(this.kvStore, "a2a-client");
      const store = new PendingTaskStore(storage);
      const task = (await request.json()) as Record<string, unknown>;
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      await store.save(task as any);
      return new Response(JSON.stringify({ registered: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return super.fetch(request);
  }

  /**
   * Override ensureAgent to use MockPiAgent instead of the real pi-agent-core Agent.
   * This avoids importing pi-ai (which has partial-json CJS issues in Workers).
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
      schedules: this.buildScheduleManager(),
    };

    // Resolve capabilities with scoped storage (same as base class)
    const resolved = resolveCapabilities(this.getCapabilities(), context, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;

    // Sync capability-declared schedules (same as base class)
    if (resolved.schedules.length > 0) {
      await this.syncCapabilitySchedules(resolved.schedules);
    }

    // Merge tools
    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

    // Build system prompt
    let systemPrompt = this.buildSystemPrompt(context);
    if (resolved.promptSections.length > 0) {
      systemPrompt += `\n\n${resolved.promptSections.join("\n\n")}`;
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

      // Clean up agent instance when inference completes
      if (event.type === "agent_end") {
        this.sessionAgents.delete(sessionId);
      }
    });

    this.sessionAgents.set(sessionId, agent);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Test worker");
  },
};
