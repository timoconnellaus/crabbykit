import { DurableObject } from "cloudflare:workers";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { ResolvedCapabilities } from "./capabilities/resolve.js";
import { resolveCapabilities } from "./capabilities/resolve.js";
import type { Capability, CapabilityHookContext } from "./capabilities/types.js";
import type { CompactionConfig as CompactionCfg } from "./compaction/types.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { SessionStore } from "./session/session-store.js";
import { ErrorCodes } from "./transport/error-codes.js";
import type { ClientMessage, ServerMessage } from "./transport/types.js";

// Lazy-loaded pi-* SDK (pi-agent-core imports pi-ai which has partial-json CJS issue in Workers test pool)
// biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - types unavailable at import time
let _PiAgent: any;
// biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - types unavailable at import time
let _getModel: any;
async function loadPiSdk() {
  if (!_PiAgent) {
    const core = await import("@mariozechner/pi-agent-core");
    _PiAgent = core.Agent;
    const ai = await import("@mariozechner/pi-ai");
    _getModel = ai.getModel;
  }
  return { piAgent: _PiAgent, getModel: _getModel };
}

export interface AgentConfig {
  /** Provider name (e.g., 'openrouter', 'anthropic') */
  provider: string;
  /** Model ID (e.g., 'google/gemini-2.5-flash') */
  modelId: string;
  /** API key for the provider */
  apiKey: string;
  /** Maximum agent loop steps (default 50) */
  maxSteps?: number;
  /**
   * Compaction configuration.
   * @deprecated Use the compaction-summary capability via getCapabilities() instead.
   */
  compaction?: Partial<CompactionCfg>;
}

export interface AgentContext {
  sessionId: string;
  stepNumber: number;
}

/**
 * Base Durable Object for pi-agent-core powered agents.
 * Consumers extend this and implement the abstract methods.
 */
export abstract class AgentDO extends DurableObject {
  protected sessionStore: SessionStore;
  protected mcpManager: McpManager;
  // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - types unavailable at import time
  private agent: any | null = null; // PiAgent instance (lazy-loaded)
  private connections = new Map<WebSocket, { sessionId: string }>();
  private beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sessionStore = new SessionStore(ctx.storage.sql);
    this.mcpManager = new McpManager(ctx.storage.sql, () => this.broadcastMcpStatus());
  }

  // --- Abstract methods (consumers implement these) ---

  abstract getConfig(): AgentConfig;
  abstract getTools(context: AgentContext): AgentTool[];
  abstract buildSystemPrompt(context: AgentContext): string;

  /**
   * Override to register capabilities. Capabilities contribute tools,
   * prompt sections, MCP servers, and lifecycle hooks.
   * Registration order determines hook execution order.
   */
  protected getCapabilities(): Capability[] {
    return [];
  }

  // --- Optional lifecycle hooks ---

  protected onTurnEnd?(_messages: AgentMessage[], _toolResults: unknown[]): void | Promise<void>;
  protected onAgentEnd?(_messages: AgentMessage[]): void | Promise<void>;
  protected onSessionCreated?(_session: { id: string; name: string }): void | Promise<void>;

  /**
   * Override to inject custom Agent options (e.g., mock streamFn for testing).
   */
  protected getAgentOptions(): Record<string, unknown> {
    return {};
  }

  // --- WebSocket transport ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // HTTP POST fallback for prompting
    if (request.method === "POST" && url.pathname === "/prompt") {
      return this.handleHttpPrompt(request);
    }

    // MCP OAuth callback
    if (url.pathname === "/mcp/callback") {
      return this.handleMcpCallback(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Default to first session or create one
    const sessions = this.sessionStore.list();
    const sessionId = sessions[0]?.id ?? this.sessionStore.create().id;

    this.connections.set(server, { sessionId });

    // Send initial sync
    const session = this.sessionStore.get(sessionId);
    if (session) {
      this.sendToSocket(server, {
        type: "session_sync",
        sessionId,
        session,
        messages: this.sessionStore.buildContext(sessionId),
        streamMessage: this.agent?.state.streamMessage ?? null,
      });
    }

    // Send session list
    this.sendSessionList(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      this.sendToSocket(ws, {
        type: "error",
        code: ErrorCodes.PARSE_ERROR,
        message: "Invalid message format",
      });
      return;
    }

    this.handleClientMessage(ws, msg).catch((err) => {
      this.sendToSocket(ws, {
        type: "error",
        code: ErrorCodes.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : "An unexpected error occurred",
      });
    });
  }

  webSocketClose(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "prompt":
        await this.handlePrompt(msg.sessionId, msg.text);
        break;

      case "steer":
        this.handleSteer(msg.sessionId, msg.text);
        break;

      case "abort":
        this.agent?.abort();
        break;

      case "switch_session": {
        this.connections.set(ws, { sessionId: msg.sessionId });
        const session = this.sessionStore.get(msg.sessionId);
        if (session) {
          this.sendToSocket(ws, {
            type: "session_sync",
            sessionId: msg.sessionId,
            session,
            messages: this.sessionStore.buildContext(msg.sessionId),
            streamMessage: null,
          });
        }
        break;
      }

      case "new_session": {
        const session = this.sessionStore.create({ name: msg.name });
        this.connections.set(ws, { sessionId: session.id });
        this.onSessionCreated?.({ id: session.id, name: session.name });
        this.sendToSocket(ws, {
          type: "session_sync",
          sessionId: session.id,
          session,
          messages: [],
          streamMessage: null,
        });
        this.broadcastSessionList();
        break;
      }
    }
  }

  // --- Agent loop ---

  private async handlePrompt(sessionId: string, text: string): Promise<void> {
    // Persist user message
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp: Date.now() },
    });

    // Ensure agent is initialized
    await this.ensureAgent(sessionId);

    if (!this.agent) {
      throw new Error("Agent failed to initialize");
    }

    if (this.agent.state.isStreaming) {
      // Agent is busy — steer instead
      this.handleSteer(sessionId, text);
      return;
    }

    await this.agent.prompt(text);
  }

  private handleSteer(sessionId: string, text: string): void {
    if (!this.agent) return;

    // Persist steer message
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp: Date.now() },
    });

    this.agent.steer({
      role: "user",
      content: text,
      timestamp: Date.now(),
    } as AgentMessage);
  }

  protected async ensureAgent(sessionId: string): Promise<void> {
    const { piAgent, getModel } = await loadPiSdk();
    const config = this.getConfig();
    const context: AgentContext = { sessionId, stepNumber: 0 };
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai getModel has overly narrow provider type (KnownProvider)
    const model = getModel(config.provider as any, config.modelId);

    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }

    // Resolve capabilities
    const resolved = resolveCapabilities(this.getCapabilities(), context);
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;

    // Merge tools: getTools() first, then capability tools
    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

    // Build system prompt with capability sections appended
    let systemPrompt = this.buildSystemPrompt(context);
    if (resolved.promptSections.length > 0) {
      systemPrompt += `\n\n${resolved.promptSections.join("\n\n")}`;
    }

    if (!this.agent) {
      const messages = this.sessionStore.buildContext(sessionId);

      this.agent = new piAgent({
        initialState: {
          systemPrompt,
          // biome-ignore lint/suspicious/noExplicitAny: Model generic parameter is internal to pi-ai
          model: model as Model<any>,
          tools: allTools,
          messages,
        },
        getApiKey: () => config.apiKey,
        transformContext: (msgs: AgentMessage[]) => this.transformContext(msgs, sessionId),
        convertToLlm: (msgs: AgentMessage[]) => this.convertToLlm(msgs),
        ...this.getAgentOptions(),
      });

      this.agent.subscribe((event: AgentEvent) => this.handleAgentEvent(event, sessionId));
    } else {
      // Update agent state for this session
      this.agent.setSystemPrompt(systemPrompt);
      this.agent.setTools(allTools);

      // Reload messages from session
      const messages = this.sessionStore.buildContext(sessionId);
      this.agent.replaceMessages(messages);
    }
  }

  private async transformContext(
    messages: AgentMessage[],
    sessionId: string,
  ): Promise<AgentMessage[]> {
    let result = messages;

    const hookContext: CapabilityHookContext = {
      sessionId,
      sessionStore: this.sessionStore,
    };

    for (const hook of this.beforeInferenceHooks) {
      result = await hook(result, hookContext);
    }

    return result;
  }

  private convertToLlm(messages: AgentMessage[]): Message[] {
    // Pass through standard LLM messages, filter out any custom types
    return messages.filter((m): m is Message => {
      return (
        "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      );
    });
  }

  private handleAgentEvent(event: AgentEvent, sessionId: string): void {
    // Broadcast to connected clients on this session
    const serverMsg: ServerMessage =
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
        ? { type: "tool_event", sessionId, event }
        : { type: "agent_event", sessionId, event };

    this.broadcastToSession(sessionId, serverMsg);

    // Persist completed messages
    if (event.type === "message_end") {
      const msg = event.message;
      if ("role" in msg && msg.role === "assistant") {
        this.sessionStore.appendEntry(sessionId, {
          type: "message",
          data: {
            role: "assistant",
            content: msg.content,
            timestamp: Date.now(),
          },
        });
      }
    }

    // Persist tool results
    if (event.type === "tool_execution_end") {
      this.sessionStore.appendEntry(sessionId, {
        type: "message",
        data: {
          role: "toolResult",
          content: JSON.stringify(event.result),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          timestamp: Date.now(),
        },
      });
    }

    // Lifecycle hooks
    if (event.type === "turn_end") {
      this.onTurnEnd?.([event.message], event.toolResults);
    }
    if (event.type === "agent_end") {
      this.onAgentEnd?.(event.messages);
    }
  }

  // --- HTTP fallback ---

  private async handleHttpPrompt(request: Request): Promise<Response> {
    const body = (await request.json()) as { sessionId?: string; text: string };
    const sessionId =
      body.sessionId ?? this.sessionStore.list()[0]?.id ?? this.sessionStore.create().id;

    await this.handlePrompt(sessionId, body.text);

    // Wait for agent to finish
    await this.agent?.waitForIdle();

    const messages = this.sessionStore.buildContext(sessionId);
    return new Response(JSON.stringify({ messages }), {
      headers: { "content-type": "application/json" },
    });
  }

  private async handleMcpCallback(_request: Request): Promise<Response> {
    // TODO: Implement OAuth callback handling
    return new Response("OK");
  }

  // --- Broadcasting ---

  private broadcastToSession(sessionId: string, msg: ServerMessage): void {
    for (const [ws, state] of this.connections) {
      if (state.sessionId === sessionId) {
        this.sendToSocket(ws, msg);
      }
    }
  }

  private broadcastMcpStatus(): void {
    const servers = this.mcpManager.listServers();
    const msg: ServerMessage = {
      type: "mcp_status",
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        toolCount: s.toolCount,
        error: s.error,
      })),
    };
    for (const [ws] of this.connections) {
      this.sendToSocket(ws, msg);
    }
  }

  private broadcastSessionList(): void {
    const sessions = this.sessionStore.list();
    const msg: ServerMessage = {
      type: "session_list",
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        source: s.source,
        updatedAt: s.updatedAt,
      })),
    };
    for (const [ws] of this.connections) {
      this.sendToSocket(ws, msg);
    }
  }

  private sendSessionList(ws: WebSocket): void {
    const sessions = this.sessionStore.list();
    this.sendToSocket(ws, {
      type: "session_list",
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        source: s.source,
        updatedAt: s.updatedAt,
      })),
    });
  }

  private sendToSocket(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection may be closed
      this.connections.delete(ws);
    }
  }
}

export type { CompactionCfg as CompactionConfig };
