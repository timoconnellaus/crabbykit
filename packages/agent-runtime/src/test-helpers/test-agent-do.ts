/**
 * Test AgentDO subclass with mocked LLM for integration tests.
 * Bypasses pi-ai entirely to avoid partial-json CJS issue in Workers test pool.
 */
import { AgentDO } from "../agent-do.js";
import type { AgentConfig, AgentContext } from "../agent-do.js";
import type { AgentTool, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../tools/define-tool.js";

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

  get state() { return this._state; }

  subscribe(fn: (e: AgentEvent) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(event: AgentEvent) {
    for (const fn of this.listeners) fn(event);
  }

  setSystemPrompt(v: string) { this._state.systemPrompt = v; }
  setTools(t: AgentTool[]) {
    this._state.tools = t;
    this.tools.clear();
    for (const tool of t) this.tools.set(tool.name, tool);
  }
  replaceMessages(msgs: AgentMessage[]) { this._state.messages = msgs; }

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

  async prompt(input: string | AgentMessage | AgentMessage[]) {
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

    // Support delays for testing steer/abort mid-run
    if (response.delay) {
      await new Promise((r) => setTimeout(r, response.delay));
    }

    // Check if aborted during delay
    if (this.aborted) {
      const partialMsg: any = {
        role: "assistant",
        content: [{ type: "text", text: response.text ? response.text.slice(0, Math.ceil(response.text.length / 2)) : "" }],
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

    this.emit({ type: "message_start", message: assistantMsg } as AgentEvent);
    this.emit({ type: "message_end", message: assistantMsg } as AgentEvent);

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
            ? await tool.execute(toolCallId, tc.args)
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
  execute: async (_id, args) => ({
    content: [{ type: "text" as const, text: `Echo: ${args.text}` }],
    details: { echoed: args.text },
  }),
});

/** Allow tests to override compaction config per DO name */
let compactionOverrides: Record<string, Partial<AgentConfig["compaction"]>> = {};

export function setCompactionOverride(
  doName: string,
  config: Partial<NonNullable<AgentConfig["compaction"]>>,
) {
  compactionOverrides[doName] = config;
}

export function clearCompactionOverrides() {
  compactionOverrides = {};
}

export class TestAgentDO extends AgentDO {
  getConfig(): AgentConfig {
    // Check for per-DO overrides (uses the session to infer DO name)
    const override = Object.values(compactionOverrides)[0];
    return {
      provider: "openrouter",
      modelId: "openrouter/auto",
      apiKey: "test-key",
      maxSteps: 10,
      compaction: {
        threshold: override?.threshold ?? 0.75,
        contextWindowTokens: override?.contextWindowTokens ?? 200_000,
        keepRecentTokens: override?.keepRecentTokens ?? 20_000,
        ...override,
      },
    };
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
      const tools = body.tools.map((t) =>
        defineTool({
          name: t.name,
          description: t.description,
          parameters: Type.Object({
            query: Type.String({ description: "Query input" }),
          }),
          execute: async (_id, args) => ({
            content: [
              { type: "text" as const, text: `MCP result for: ${args.query}` },
            ],
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
      const agent = (this as any).agent as MockPiAgent | null;
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
      const agent = (this as any).agent as MockPiAgent | null;
      if (agent) {
        agent.abort();
      }
      return new Response(JSON.stringify({ aborted: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Get steer history
    if (request.method === "GET" && url.pathname === "/steer-history") {
      const agent = (this as any).agent as MockPiAgent | null;
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

    return super.fetch(request);
  }

  /**
   * Override ensureAgent to use MockPiAgent instead of the real pi-agent-core Agent.
   * This avoids importing pi-ai (which has partial-json CJS issues in Workers).
   */
  protected async ensureAgent(sessionId: string): Promise<void> {
    const agentField = "agent" as any;
    if (!(this as any)[agentField]) {
      const messages = this.sessionStore.buildContext(sessionId);
      const context: AgentContext = { sessionId, stepNumber: 0 };
      const config = this.getConfig();

      const agent = new MockPiAgent({
        initialState: {
          systemPrompt: this.buildSystemPrompt(context),
          model: { id: "test/mock" },
          tools: this.getTools(context),
          messages,
        },
        transformContext: (msgs: AgentMessage[]) =>
          (this as any).transformContext(msgs, sessionId, config),
      });

      agent.subscribe((event: AgentEvent) =>
        (this as any).handleAgentEvent(event, sessionId),
      );

      (this as any)[agentField] = agent;
    } else {
      const context: AgentContext = { sessionId, stepNumber: 0 };
      const agent = (this as any)[agentField] as MockPiAgent;
      agent.setSystemPrompt(this.buildSystemPrompt(context));
      agent.setTools(this.getTools(context));
      agent.replaceMessages(this.sessionStore.buildContext(sessionId));
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Test worker");
  },
};
