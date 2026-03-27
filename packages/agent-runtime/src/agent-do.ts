import { DurableObject } from "cloudflare:workers";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { SessionStore } from "./session/session-store.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { compactSession, estimateMessagesTokens } from "./compaction/compaction.js";
import type { CompactionConfig as CompactionCfg, SummarizeFn } from "./compaction/types.js";
import type { ClientMessage, ServerMessage } from "./transport/types.js";

// Lazy-loaded pi-* SDK (pi-agent-core imports pi-ai which has partial-json CJS issue in Workers test pool)
let _PiAgent: any;
let _getModel: any;
async function loadPiSdk() {
  if (!_PiAgent) {
    const core = await import("@mariozechner/pi-agent-core");
    _PiAgent = core.Agent;
    const ai = await import("@mariozechner/pi-ai");
    _getModel = ai.getModel;
  }
  return { PiAgent: _PiAgent, getModel: _getModel };
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
  /** Compaction configuration */
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
  private agent: any | null = null; // PiAgent instance (lazy-loaded)
  private connections = new Map<WebSocket, { sessionId: string }>();
  private activeSessionId: string | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sessionStore = new SessionStore(ctx.storage.sql);
    this.mcpManager = new McpManager(ctx.storage.sql, () =>
      this.broadcastMcpStatus(),
    );
  }

  // --- Abstract methods (consumers implement these) ---

  abstract getConfig(): AgentConfig;
  abstract getTools(context: AgentContext): AgentTool[];
  abstract buildSystemPrompt(context: AgentContext): string;

  // --- Optional lifecycle hooks ---

  protected onTurnEnd?(
    _messages: AgentMessage[],
    _toolResults: unknown[],
  ): void | Promise<void>;
  protected onAgentEnd?(_messages: AgentMessage[]): void | Promise<void>;
  protected onSessionCreated?(_session: {
    id: string;
    name: string;
  }): void | Promise<void>;

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
    this.activeSessionId = sessionId;

    // Send initial sync
    this.sendToSocket(server, {
      type: "session_sync",
      sessionId,
      session: this.sessionStore.get(sessionId)!,
      messages: this.sessionStore.buildContext(sessionId),
      streamMessage: this.agent?.state.streamMessage ?? null,
    });

    // Send session list
    this.sendSessionList(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    try {
      const msg: ClientMessage = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      );
      this.handleClientMessage(ws, msg);
    } catch {
      this.sendToSocket(ws, {
        type: "error",
        code: "PARSE_ERROR",
        message: "Invalid message format",
      });
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  private async handleClientMessage(
    ws: WebSocket,
    msg: ClientMessage,
  ): Promise<void> {
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
        this.activeSessionId = session.id;
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

  private async handlePrompt(
    sessionId: string,
    text: string,
  ): Promise<void> {
    this.activeSessionId = sessionId;

    // Persist user message
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp: Date.now() },
    });

    // Ensure agent is initialized
    await this.ensureAgent(sessionId);

    if (this.agent!.state.isStreaming) {
      // Agent is busy — steer instead
      this.handleSteer(sessionId, text);
      return;
    }

    await this.agent!.prompt(text);
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
    const { PiAgent, getModel } = await loadPiSdk();
    const config = this.getConfig();
    const context: AgentContext = { sessionId, stepNumber: 0 };
    const model = getModel(config.provider as any, config.modelId);

    if (!model) {
      throw new Error(
        `Model not found: ${config.provider}/${config.modelId}`,
      );
    }

    if (!this.agent) {
      const messages = this.sessionStore.buildContext(sessionId);

      this.agent = new PiAgent({
        initialState: {
          systemPrompt: this.buildSystemPrompt(context),
          model: model as Model<any>,
          tools: this.getTools(context),
          messages,
        },
        getApiKey: () => config.apiKey,
        transformContext: (msgs: AgentMessage[]) =>
          this.transformContext(msgs, sessionId, config),
        convertToLlm: (msgs: AgentMessage[]) => this.convertToLlm(msgs),
        ...this.getAgentOptions(),
      });

      this.agent.subscribe((event: AgentEvent) =>
        this.handleAgentEvent(event, sessionId),
      );
    } else {
      // Update agent state for this session
      this.agent.setSystemPrompt(this.buildSystemPrompt(context));
      this.agent.setTools(this.getTools(context));

      // Reload messages from session
      const messages = this.sessionStore.buildContext(sessionId);
      this.agent.replaceMessages(messages);
    }
  }

  private async transformContext(
    messages: AgentMessage[],
    sessionId: string,
    config: AgentConfig,
  ): Promise<AgentMessage[]> {
    const compactionConfig: CompactionCfg = {
      threshold: config.compaction?.threshold ?? 0.75,
      contextWindowTokens:
        config.compaction?.contextWindowTokens ?? 200_000,
      keepRecentTokens: config.compaction?.keepRecentTokens ?? 20_000,
    };

    const totalTokens = estimateMessagesTokens(messages);

    if (totalTokens > compactionConfig.threshold * compactionConfig.contextWindowTokens) {
      // Build a summarizer using the agent's model
      const summarize: SummarizeFn = async (msgs, prevSummary, signal) => {
        // TODO: Use streamSimple for real summarization
        // For now, return a placeholder that will be replaced in task 3.5
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

      // Get entry IDs for mapping
      const entries = this.sessionStore.getEntries(sessionId);
      const entryIds = entries
        .filter((e) => e.type === "message")
        .map((e) => e.id);

      const result = await compactSession(
        messages,
        entryIds,
        compactionConfig,
        summarize,
      );

      if (result) {
        // Persist compaction entry
        this.sessionStore.appendEntry(sessionId, {
          type: "compaction",
          data: {
            summary: result.summary,
            firstKeptEntryId: result.firstKeptEntryId,
            tokensBefore: result.tokensBefore,
          },
        });

        // Rebuild context with compaction
        return this.sessionStore.buildContext(sessionId);
      }
    }

    return messages;
  }

  private convertToLlm(messages: AgentMessage[]): any[] {
    // Pass through standard LLM messages, filter out any custom types
    return messages.filter((m) => {
      const role = (m as any).role;
      return role === "user" || role === "assistant" || role === "toolResult";
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
      const msg = event.message as any;
      if (msg.role === "assistant") {
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
      this.onTurnEnd?.(
        [event.message],
        event.toolResults,
      );
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
