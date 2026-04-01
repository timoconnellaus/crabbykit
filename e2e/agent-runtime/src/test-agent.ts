/**
 * E2E test agent with mock LLM but real capabilities.
 *
 * Uses the same MockPiAgent pattern as the runtime's TestAgentDO,
 * but wires up real capability packages (r2-storage, prompt-scheduler)
 * against real local bindings (R2 via miniflare, DO SQLite).
 */

import type { AgentEvent, AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type {
  AgentConfig,
  AgentContext,
  Capability,
  CapabilityHookContext,
} from "@claw-for-cloudflare/agent-runtime";
import {
  AgentDO,
  Type,
  createCapabilityStorage,
  defineTool,
  resolveCapabilities,
} from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import { agentStorage } from "@claw-for-cloudflare/agent-storage";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";

// --- Mock LLM infrastructure ---

export interface MockResponse {
  text: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
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
 * Lightweight mock that replaces pi-agent-core's Agent.
 * Emits the same events the real agent would, executes tools for real,
 * but returns canned text responses instead of calling an LLM.
 */
class MockPiAgent {
  private listeners: Array<(e: AgentEvent) => void> = [];
  // biome-ignore lint/suspicious/noExplicitAny: Mock agent state mirrors pi-agent-core internals
  private _state: any;
  private tools: Map<string, AgentTool> = new Map();
  private aborted = false;
  private _idleResolvers: Array<() => void> = [];
  private transformContext?: (msgs: AgentMessage[]) => Promise<AgentMessage[]>;

  // biome-ignore lint/suspicious/noExplicitAny: Constructor mirrors pi-agent-core Agent options
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
  }

  private resolveIdle() {
    for (const resolve of this._idleResolvers) resolve();
    this._idleResolvers = [];
  }

  async prompt(_input: string | AgentMessage | AgentMessage[]) {
    if (this.transformContext) {
      this._state.messages = await this.transformContext(this._state.messages);
    }

    this.aborted = false;
    this._state.isStreaming = true;
    this.emit({ type: "agent_start" } as AgentEvent);
    this.emit({ type: "turn_start" } as AgentEvent);

    const response = mockResponseQueue.shift() ?? { text: "Mock response" };

    if (response.delay) {
      const partialStreamMsg = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: Date.now(),
      };
      this._state.streamMessage = partialStreamMsg;
      this.emit({ type: "message_start", message: partialStreamMsg } as AgentEvent);
      await new Promise((r) => setTimeout(r, response.delay));
    }

    if (this.aborted) {
      this._state.isStreaming = false;
      this.emit({ type: "agent_end", messages: this._state.messages } as AgentEvent);
      this.resolveIdle();
      return;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Building message content dynamically
    const content: any[] = [];
    if (response.text) {
      content.push({ type: "text", text: response.text });
    }

    const assistantMsg = { role: "assistant", content, timestamp: Date.now() };
    this._state.streamMessage = assistantMsg;
    if (!response.delay) {
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

        // biome-ignore lint/suspicious/noExplicitAny: Tool result type varies per tool
        let result: any;
        let isError = false;
        try {
          result = tool
            ? await (tool as AgentTool).execute(tc.args, { toolCallId })
            : { content: [{ type: "text", text: "Unknown tool" }], details: {} };
        } catch (err: unknown) {
          result = {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            details: {},
          };
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

      // Process follow-up response after tool calls
      if (mockResponseQueue.length > 0 && !this.aborted) {
        const followUp = mockResponseQueue.shift()!;
        const followUpMsg = {
          role: "assistant",
          content: [{ type: "text", text: followUp.text }],
          timestamp: Date.now(),
        };
        this.emit({ type: "turn_start" } as AgentEvent);
        this.emit({ type: "message_start", message: followUpMsg } as AgentEvent);
        this.emit({ type: "message_end", message: followUpMsg } as AgentEvent);
        this.emit({ type: "turn_end", message: followUpMsg, toolResults: [] } as AgentEvent);
      }
    }

    this.emit({ type: "turn_end", message: assistantMsg, toolResults: [] } as AgentEvent);
    this._state.isStreaming = false;
    this.emit({ type: "agent_end", messages: this._state.messages } as AgentEvent);
    this.resolveIdle();
  }
}

// --- E2E Agent DO ---

interface Env {
  AGENT: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  STORAGE_BUCKET: R2Bucket;
}

export class E2EAgent extends AgentDO<Env> {
  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "test/mock",
      apiKey: "e2e-test-key",
    };
  }

  protected getCapabilities(): Capability[] {
    const storage = agentStorage({
      bucket: () => this.env.STORAGE_BUCKET,
      namespace: this.ctx.id.toString(),
    });

    const capabilities: Capability[] = [r2Storage({ storage }), promptScheduler()];

    // Sandbox capability is added by the dev entry point (test-agent-dev.ts)
    // which can import @cloudflare/containers. Pool-workers can't load that module.
    capabilities.push(...this.getExtraCapabilities(storage));

    return capabilities;
  }

  /**
   * Extension point for subclasses to add capabilities that require
   * bindings unavailable in pool-workers (e.g., containers).
   */
  protected getExtraCapabilities(_storage: AgentStorage): Capability[] {
    return [];
  }

  getTools(_context: AgentContext): AgentTool[] {
    return [
      defineTool({
        name: "echo",
        description: "Returns the input text back.",
        parameters: Type.Object({
          text: Type.String({ description: "Text to echo" }),
        }),
        execute: async (args) => ({
          content: [{ type: "text" as const, text: `Echo: ${args.text}` }],
          details: { echoed: args.text },
        }),
      }),
      defineTool({
        name: "get_current_time",
        description: "Get the current date and time in ISO format.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: new Date().toISOString() }],
          details: null,
        }),
      }),
    ];
  }

  buildSystemPrompt(_context: AgentContext): string {
    return "You are an e2e test agent.";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Session entries inspection
    if (request.method === "GET" && url.pathname === "/entries") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        const sessions = this.sessionStore.list();
        if (sessions.length === 0) {
          return Response.json({ entries: [] });
        }
        const entries = this.sessionStore.getEntries(sessions[0].id);
        return Response.json({ entries });
      }
      const entries = this.sessionStore.getEntries(sessionId);
      return Response.json({ entries });
    }

    // List sessions
    if (request.method === "GET" && url.pathname === "/sessions") {
      return Response.json({ sessions: this.sessionStore.list() });
    }

    // Send prompt
    if (request.method === "POST" && url.pathname === "/prompt") {
      const body = (await request.json()) as { text: string; sessionId?: string };
      const sessionId =
        body.sessionId ?? this.sessionStore.list()[0]?.id ?? this.sessionStore.create().id;

      // Persist user message (mirrors AgentDO.handlePrompt)
      this.sessionStore.appendEntry(sessionId, {
        type: "message",
        data: { role: "user", content: body.text, timestamp: Date.now() },
      });

      // Ensure agent exists, then prompt
      await this.ensureAgent(sessionId);
      const agents = this.sessionAgents as Map<string, MockPiAgent>;
      const agent = agents.get(sessionId);
      if (!agent) {
        return Response.json({ error: "Agent not found" }, { status: 500 });
      }
      await agent.prompt(body.text);
      const { entries } = this.sessionStore.getEntriesPaginated(sessionId, { limit: 100 });
      return Response.json({ sessionId, entries });
    }

    // Execute a tool directly (bypasses LLM)
    if (request.method === "POST" && url.pathname === "/execute-tool") {
      return this.handleToolExecution(request);
    }

    return super.fetch(request);
  }

  private async handleToolExecution(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sessionId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    };

    const { toolName, args = {} } = body;
    const sessionId =
      body.sessionId ?? this.sessionStore.list()[0]?.id ?? this.sessionStore.create().id;

    const { tools: allTools } = this.resolveToolsForSession(sessionId);

    const tool = allTools.find((t) => t.name === toolName);
    if (!tool) {
      const available = allTools.map((t) => t.name);
      return Response.json({ error: `Tool "${toolName}" not found`, available }, { status: 404 });
    }

    // biome-ignore lint/suspicious/noExplicitAny: Tool execute args type varies per tool
    const result = await (tool as AgentTool<any>).execute(args, {
      toolCallId: crypto.randomUUID(),
      signal: AbortSignal.timeout(30_000),
    });

    return Response.json({ sessionId, toolName, result });
  }

  /**
   * Override ensureAgent to use MockPiAgent instead of the real pi-agent-core Agent.
   */
  protected async ensureAgent(sessionId: string): Promise<void> {
    if (this.sessionAgents.has(sessionId)) return;

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

    const resolved = resolveCapabilities(this.getCapabilities(), context, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;

    if (resolved.schedules.length > 0) {
      await this.syncCapabilitySchedules(resolved.schedules);
    }

    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

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
      if (event.type === "agent_end") {
        this.sessionAgents.delete(sessionId);
      }
    });

    this.sessionAgents.set(sessionId, agent);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // /agent/:agentId[/...] — route to agent DO
    const agentMatch = url.pathname.match(/^\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const id = env.AGENT.idFromName(agentId);
      const stub = env.AGENT.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = agentMatch[2] || "/";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("E2E Agent Runtime");
  },
};
