import { DurableObject } from "cloudflare:workers";
import type { AgentEvent, AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AssistantMessage, Message, Model } from "@claw-for-cloudflare/ai";
import type { ResolvedCapabilities } from "./capabilities/resolve.js";
import { resolveCapabilities } from "./capabilities/resolve.js";
import type { CapabilityStorage } from "./capabilities/storage.js";
import { createCapabilityStorage, createNoopStorage } from "./capabilities/storage.js";
import type { Capability, CapabilityHookContext } from "./capabilities/types.js";
import type { Command, CommandContext, CommandResult } from "./commands/define-command.js";
import type { CompactionConfig as CompactionCfg } from "./compaction/types.js";
import type { CostEvent } from "./costs/types.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { expiresAtFromDuration, nextFireTime } from "./scheduling/cron.js";
import { ScheduleStore } from "./scheduling/schedule-store.js";
import type {
  PromptScheduleConfig,
  Schedule,
  ScheduleCallbackContext,
  ScheduleConfig,
} from "./scheduling/types.js";
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
    const core = await import("@claw-for-cloudflare/agent-core");
    _PiAgent = core.Agent;
    const ai = await import("@claw-for-cloudflare/ai");
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

/** Operations for managing prompt-based schedules. */
export interface ScheduleManager {
  create(config: PromptScheduleConfig): Promise<Schedule>;
  update(
    id: string,
    updates: Partial<{
      name: string;
      cron: string;
      enabled: boolean;
      prompt: string;
      timezone: string | null;
      maxDuration: string;
      retention: number;
    }>,
  ): Promise<Schedule | null>;
  delete(id: string): Promise<void>;
  list(): Schedule[];
  get(id: string): Schedule | null;
}

export interface AgentContext {
  sessionId: string;
  stepNumber: number;
  /** Emit a cost event. Persisted to session and broadcast to clients. */
  emitCost: (cost: CostEvent) => void;
  /** Persistent key-value storage scoped to a capability. Only set for capability-contributed tools. */
  storage?: CapabilityStorage;
  /** Manage prompt-based schedules. */
  schedules: ScheduleManager;
}

/**
 * Base Durable Object for pi-agent-core powered agents.
 * Consumers extend this and implement the abstract methods.
 */
export abstract class AgentDO extends DurableObject {
  protected sessionStore: SessionStore;
  protected scheduleStore: ScheduleStore;
  protected mcpManager: McpManager;
  // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - types unavailable at import time
  private agent: any | null = null; // PiAgent instance (lazy-loaded)
  private activeSessionId: string | null = null;
  /** The session that owns the currently running inference. Set before agent.prompt(), cleared on agent_end. */
  private inferringSessionId: string | null = null;
  private connections = new Map<WebSocket, { sessionId: string }>();
  private beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];
  private afterToolExecutionHooks: ResolvedCapabilities["afterToolExecutionHooks"] = [];
  private scheduleCallbacks = new Map<string, (ctx: ScheduleCallbackContext) => Promise<void>>();

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sessionStore = new SessionStore(ctx.storage.sql);
    this.scheduleStore = new ScheduleStore(ctx.storage.sql);
    this.mcpManager = new McpManager(ctx.storage.sql, () => this.broadcastMcpStatus());
  }

  // --- Abstract methods (consumers implement these) ---

  abstract getConfig(): AgentConfig;
  abstract getTools(context: AgentContext): AgentTool[];
  abstract buildSystemPrompt(context: AgentContext): string;

  /**
   * Override to register capabilities. Capabilities contribute tools,
   * commands, prompt sections, MCP servers, and lifecycle hooks.
   * Registration order determines hook execution order.
   */
  protected getCapabilities(): Capability[] {
    return [];
  }

  /**
   * Override to register slash commands. Commands bypass the LLM
   * and execute directly when a user sends `/commandName`.
   * Capabilities can also contribute commands via `commands()`.
   */
  protected getCommands(_context: CommandContext): Command[] {
    return [];
  }

  // --- Optional lifecycle hooks ---

  protected onTurnEnd?(_messages: AgentMessage[], _toolResults: unknown[]): void | Promise<void>;
  protected onAgentEnd?(_messages: AgentMessage[]): void | Promise<void>;
  protected onSessionCreated?(_session: { id: string; name: string }): void | Promise<void>;

  /**
   * Called before a schedule fires. Return `{ skip: true }` to prevent execution,
   * or `{ prompt: "..." }` to override the prompt for prompt-based schedules.
   */
  protected onScheduleFire?(
    _schedule: Schedule,
  ): Promise<{ skip?: boolean; prompt?: string } | undefined>;

  /**
   * Override to inject custom Agent options (e.g., mock streamFn for testing).
   */
  protected getAgentOptions(): Record<string, unknown> {
    return {};
  }

  /** Build a ScheduleManager that delegates to the protected methods. */
  private buildScheduleManager(): ScheduleManager {
    return {
      create: (config) => this.createSchedule(config),
      update: (id, updates) => this.updateSchedule(id, updates),
      delete: (id) => this.deleteSchedule(id),
      list: () => this.listSchedules(),
      get: (id) => this.scheduleStore.get(id),
    };
  }

  // --- Schedule management (protected for consumers) ---

  /** Create a prompt-based schedule. Sets the next alarm automatically. */
  protected async createSchedule(config: PromptScheduleConfig): Promise<Schedule> {
    const tz = config.timezone ?? undefined;
    const next = nextFireTime(config.cron, undefined, tz);
    const schedule = this.scheduleStore.create({
      id: config.id,
      name: config.name,
      cron: config.cron,
      enabled: config.enabled,
      handlerType: "prompt",
      prompt: config.prompt,
      sessionPrefix: config.sessionPrefix,
      timezone: config.timezone,
      expiresAt: config.maxDuration
        ? expiresAtFromDuration(config.maxDuration).toISOString()
        : undefined,
      nextFireAt: next.toISOString(),
      retention: config.retention,
    });
    await this.refreshAlarm();
    return schedule;
  }

  /** Update an existing schedule. Refreshes the alarm if cron or enabled changed. */
  protected async updateSchedule(
    id: string,
    updates: Partial<{
      name: string;
      cron: string;
      enabled: boolean;
      prompt: string;
      sessionPrefix: string;
      timezone: string | null;
      retention: number;
    }>,
  ): Promise<Schedule | null> {
    let nextFireAt: string | undefined;
    if (updates.cron || updates.timezone !== undefined) {
      const existing = this.scheduleStore.get(id);
      const cron = updates.cron ?? existing?.cron ?? "* * * * *";
      const tz = updates.timezone !== undefined ? updates.timezone : existing?.timezone;
      nextFireAt = nextFireTime(cron, undefined, tz ?? undefined).toISOString();
    }
    const result = this.scheduleStore.update(id, {
      ...updates,
      ...(nextFireAt ? { nextFireAt } : {}),
    });
    if (result) await this.refreshAlarm();
    return result;
  }

  /** Delete a schedule. Refreshes the alarm. */
  protected async deleteSchedule(id: string): Promise<void> {
    this.scheduleStore.delete(id);
    this.scheduleCallbacks.delete(id);
    await this.refreshAlarm();
  }

  /** List all schedules. */
  protected listSchedules(): Schedule[] {
    return this.scheduleStore.list();
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
    server.serializeAttachment({ sessionId });

    // Send initial sync
    const session = this.sessionStore.get(sessionId);
    if (session) {
      this.sendToSocket(server, {
        type: "session_sync",
        sessionId,
        session,
        messages: this.sessionStore.buildContext(sessionId),
        streamMessage:
          this.inferringSessionId === sessionId
            ? (this.agent?.state.streamMessage ?? null)
            : null,
      });
    }

    // Send session list, schedule list, and command list
    this.sendSessionList(server);
    this.sendCommandList(server, sessionId);
    this.broadcastScheduleList();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    // Restore connection mapping after DO hibernation/eviction.
    // The in-memory connections Map is lost, but the WebSocket and its
    // serialized attachment survive via Cloudflare's hibernation API.
    if (!this.connections.has(ws)) {
      const attachment = ws.deserializeAttachment() as { sessionId: string } | null;
      if (attachment?.sessionId) {
        this.connections.set(ws, { sessionId: attachment.sessionId });
        // Don't send session_sync here — the client's state is still intact
        // (the WS stayed open through hibernation). Sending a sync now would
        // race with any in-flight prompt and wipe the optimistic user message.
      }
    }

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
        // Only abort if the requesting session matches the running inference
        if (this.inferringSessionId && this.inferringSessionId === msg.sessionId) {
          this.agent?.abort();
        }
        break;

      case "switch_session": {
        this.connections.set(ws, { sessionId: msg.sessionId });
        ws.serializeAttachment({ sessionId: msg.sessionId });
        const session = this.sessionStore.get(msg.sessionId);
        if (session) {
          // Include streamMessage if the target session has an active inference
          const isStreaming = this.inferringSessionId === msg.sessionId;
          this.sendToSocket(ws, {
            type: "session_sync",
            sessionId: msg.sessionId,
            session,
            messages: this.sessionStore.buildContext(msg.sessionId),
            streamMessage: isStreaming ? (this.agent?.state.streamMessage ?? null) : null,
          });
        }
        break;
      }

      case "new_session": {
        const session = this.sessionStore.create({ name: msg.name });
        this.connections.set(ws, { sessionId: session.id });
        ws.serializeAttachment({ sessionId: session.id });
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

      case "delete_session": {
        // Don't delete the session if it's the only one
        const allSessions = this.sessionStore.list();
        if (allSessions.length <= 1) break;

        this.sessionStore.delete(msg.sessionId);

        // If the client was on the deleted session, switch them to another
        const conn = this.connections.get(ws);
        if (conn?.sessionId === msg.sessionId) {
          const remaining = this.sessionStore.list();
          if (remaining.length > 0) {
            const target = remaining[0];
            this.connections.set(ws, { sessionId: target.id });
            ws.serializeAttachment({ sessionId: target.id });
            this.sendToSocket(ws, {
              type: "session_sync",
              sessionId: target.id,
              session: target,
              messages: this.sessionStore.buildContext(target.id),
              streamMessage: null,
            });
          }
        }

        this.broadcastSessionList();
        break;
      }

      case "command": {
        await this.handleCommand(ws, msg.sessionId, msg.name, msg.args);
        break;
      }
    }
  }

  // --- Agent loop ---

  private static readonly MAX_SESSION_NAME_LENGTH = 50;

  private async handlePrompt(sessionId: string, text: string): Promise<void> {
    // Auto-name untitled sessions from first message
    const session = this.sessionStore.get(sessionId);
    if (session && !session.name) {
      const name =
        text.length > AgentDO.MAX_SESSION_NAME_LENGTH
          ? `${text.slice(0, AgentDO.MAX_SESSION_NAME_LENGTH)}...`
          : text;
      this.sessionStore.rename(sessionId, name);
      this.broadcastSessionList();
    }

    // Persist user message
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp: Date.now() },
    });

    // If agent is busy on a different session, reject instead of corrupting state
    if (this.agent?.state.isStreaming && this.inferringSessionId !== sessionId) {
      this.broadcastToSession(sessionId, {
        type: "error",
        code: ErrorCodes.AGENT_BUSY,
        message: "Agent is busy with another session. Please wait or abort the other session first.",
      });
      return;
    }

    // If agent is busy on the SAME session, steer instead
    if (this.agent?.state.isStreaming && this.inferringSessionId === sessionId) {
      this.handleSteer(sessionId, text);
      return;
    }

    // Ensure agent is initialized (safe — no inference in flight)
    await this.ensureAgent(sessionId);

    if (!this.agent) {
      throw new Error("Agent failed to initialize");
    }

    try {
      this.inferringSessionId = sessionId;
      await this.agent.prompt(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[AgentDO] prompt failed:", message);
      this.broadcastToSession(sessionId, {
        type: "error",
        code: ErrorCodes.INTERNAL_ERROR,
        message: `Agent error: ${message}`,
      });
    }
  }

  private handleSteer(sessionId: string, text: string): void {
    if (!this.agent) return;

    // Persist steer message to session store
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp: Date.now() },
    });

    // Only inject into the agent if this session owns the running inference
    if (this.inferringSessionId === sessionId) {
      this.agent.steer({
        role: "user",
        content: text,
        timestamp: Date.now(),
      } as AgentMessage);
    }
  }

  private resolveCommands(sessionId: string): Map<string, Command> {
    const context: CommandContext = {
      sessionId,
      sessionStore: this.sessionStore,
      schedules: this.buildScheduleManager(),
    };
    const baseCommands = this.getCommands(context);

    // Also resolve capability-contributed commands
    const agentContext: AgentContext = {
      sessionId,
      stepNumber: 0,
      emitCost: () => {},
      schedules: this.buildScheduleManager(),
    };
    const resolved = resolveCapabilities(this.getCapabilities(), agentContext, (capId) =>
      createCapabilityStorage(this.ctx.storage, capId),
    );

    const commandMap = new Map<string, Command>();
    for (const cmd of baseCommands) {
      commandMap.set(cmd.name, cmd);
    }
    for (const cmd of resolved.commands) {
      if (!commandMap.has(cmd.name)) {
        commandMap.set(cmd.name, cmd);
      }
    }
    return commandMap;
  }

  private async handleCommand(
    ws: WebSocket,
    sessionId: string,
    name: string,
    rawArgs?: string,
  ): Promise<void> {
    const commands = this.resolveCommands(sessionId);
    const command = commands.get(name);

    if (!command) {
      this.sendToSocket(ws, {
        type: "error",
        code: ErrorCodes.COMMAND_NOT_FOUND,
        message: `Unknown command: /${name}`,
      });
      return;
    }

    try {
      let parsedArgs: unknown;
      if (command.parameters && rawArgs) {
        // Try JSON first, fall back to wrapping as first string property
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch {
          parsedArgs = rawArgs;
        }
      }

      const context: CommandContext = {
        sessionId,
        sessionStore: this.sessionStore,
        schedules: this.buildScheduleManager(),
      };

      const result: CommandResult = await command.execute(
        parsedArgs as Record<string, unknown>,
        context,
      );

      this.sendToSocket(ws, {
        type: "command_result",
        sessionId,
        name,
        result: { text: result.text, data: result.data },
        isError: false,
      });
    } catch (err: unknown) {
      this.sendToSocket(ws, {
        type: "command_result",
        sessionId,
        name,
        result: { text: err instanceof Error ? err.message : String(err) },
        isError: true,
      });
    }
  }

  protected async ensureAgent(sessionId: string): Promise<void> {
    const { piAgent, getModel } = await loadPiSdk();
    const config = this.getConfig();
    const context: AgentContext = {
      sessionId,
      stepNumber: 0,
      emitCost: (cost) => this.handleCostEvent(cost, sessionId),
      schedules: this.buildScheduleManager(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai getModel has overly narrow provider type (KnownProvider)
    const model = getModel(config.provider as any, config.modelId);

    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }

    // Resolve capabilities with scoped storage per capability
    const resolved = resolveCapabilities(this.getCapabilities(), context, (capId) =>
      createCapabilityStorage(this.ctx.storage, capId),
    );
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;
    this.afterToolExecutionHooks = resolved.afterToolExecutionHooks;

    // Sync capability-declared schedules
    if (resolved.schedules.length > 0) {
      await this.syncCapabilitySchedules(resolved.schedules);
    }

    // Merge tools: getTools() first, then capability tools
    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

    // Build system prompt with capability sections appended
    let systemPrompt = this.buildSystemPrompt(context);
    if (resolved.promptSections.length > 0) {
      systemPrompt += `\n\n${resolved.promptSections.join("\n\n")}`;
    }

    this.activeSessionId = sessionId;

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
        transformContext: (msgs: AgentMessage[]) =>
          this.transformContext(msgs, this.inferringSessionId ?? this.activeSessionId ?? sessionId),
        convertToLlm: (msgs: AgentMessage[]) => this.convertToLlm(msgs),
        ...this.getAgentOptions(),
      });

      this.agent.subscribe((event: AgentEvent) => {
        // Use inferringSessionId to route events to the session that started
        // the current inference, regardless of any subsequent ensureAgent calls.
        const sid = this.inferringSessionId ?? this.activeSessionId ?? sessionId;
        this.handleAgentEvent(event, sid);

        // Clear inferringSessionId when inference completes
        if (event.type === "agent_end") {
          this.inferringSessionId = null;
        }
      });
    } else {
      // Update agent state for this session
      this.agent.setSystemPrompt(systemPrompt);
      this.agent.setTools(allTools);

      // Reload messages from session
      const messages = this.sessionStore.buildContext(sessionId);
      this.agent.replaceMessages(messages);
    }

    // Wire afterToolExecution hooks (must update each time since sessionId may change)
    if (this.afterToolExecutionHooks.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - afterToolCall context type unavailable
      this.agent.setAfterToolCall(async (atcContext: any) => {
        const hookContext: CapabilityHookContext = {
          sessionId: this.inferringSessionId ?? sessionId,
          sessionStore: this.sessionStore,
          storage: createNoopStorage(),
        };
        const event = {
          toolName: atcContext.toolCall.name as string,
          args: atcContext.args,
          isError: atcContext.isError as boolean,
        };
        for (const hook of this.afterToolExecutionHooks) {
          try {
            await hook(event, hookContext);
          } catch (err) {
            console.error("[capabilities] afterToolExecution hook error:", err);
          }
        }
        return undefined;
      });
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
      storage: createNoopStorage(), // Each wrapped hook overrides with its scoped storage
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

    // Persist completed messages and emit inference costs
    if (event.type === "message_end") {
      const msg = event.message;
      if ("role" in msg && msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage;

        this.sessionStore.appendEntry(sessionId, {
          type: "message",
          data: {
            role: "assistant",
            content: assistantMsg.content,
            timestamp: Date.now(),
          },
        });

        // Emit LLM inference cost if non-zero
        if (assistantMsg.usage?.cost?.total > 0) {
          this.handleCostEvent(
            {
              capabilityId: "llm-inference",
              amount: assistantMsg.usage.cost.total,
              currency: "USD",
              detail: `${assistantMsg.provider}/${assistantMsg.model}`,
              metadata: {
                provider: assistantMsg.provider,
                model: assistantMsg.model,
                inputTokens: assistantMsg.usage.input,
                outputTokens: assistantMsg.usage.output,
                cacheReadTokens: assistantMsg.usage.cacheRead,
                cacheWriteTokens: assistantMsg.usage.cacheWrite,
                inputCost: assistantMsg.usage.cost.input,
                outputCost: assistantMsg.usage.cost.output,
              },
            },
            sessionId,
          );
        }
      }
    }

    // Persist tool results
    if (event.type === "tool_execution_end") {
      this.sessionStore.appendEntry(sessionId, {
        type: "message",
        data: {
          role: "toolResult",
          content: event.result.content,
          details: event.result.details ?? null,
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

  private handleCostEvent(cost: CostEvent, sessionId: string): void {
    // Persist as custom session entry
    this.sessionStore.appendEntry(sessionId, {
      type: "custom",
      data: {
        customType: "cost",
        payload: cost,
      },
    });

    // Broadcast to connected clients
    this.broadcastToSession(sessionId, {
      type: "cost_event",
      sessionId,
      event: cost,
    });
  }

  // --- Scheduling ---

  /** DO alarm handler. Dispatches all due schedules and refreshes the alarm. */
  async alarm(): Promise<void> {
    const now = new Date();
    const dueSchedules = this.scheduleStore.getDueSchedules(now);

    for (const schedule of dueSchedules) {
      // Auto-delete expired schedules
      if (schedule.expiresAt && new Date(schedule.expiresAt) <= now) {
        this.scheduleStore.delete(schedule.id);
        this.scheduleCallbacks.delete(schedule.id);
        continue;
      }

      // Compute and persist next fire time BEFORE execution (crash-safe)
      const next = nextFireTime(schedule.cron, now, schedule.timezone ?? undefined);
      this.scheduleStore.update(schedule.id, { nextFireAt: next.toISOString() });

      // Check lifecycle hook
      const hookResult = await this.onScheduleFire?.(schedule);
      if (hookResult?.skip) continue;

      this.scheduleStore.markRunning(schedule.id);

      try {
        if (schedule.handlerType === "prompt") {
          const prompt = hookResult?.prompt ?? schedule.prompt;
          if (prompt) {
            await this.executeScheduledPrompt(schedule, prompt);
          }
        } else {
          await this.executeScheduledCallback(schedule);
        }
        this.scheduleStore.markIdle(schedule.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[AgentDO] Schedule "${schedule.name}" failed:`, message);
        this.scheduleStore.markFailed(schedule.id, message);
      }
    }

    await this.refreshAlarm();
  }

  private async executeScheduledPrompt(schedule: Schedule, prompt: string): Promise<void> {
    const now = new Date();
    const sessionName = `${schedule.sessionPrefix ?? schedule.name} ${now.toLocaleString()}`;
    const session = this.sessionStore.create({
      name: sessionName,
      source: "scheduled",
    });

    await this.handlePrompt(session.id, prompt);
    await this.agent?.waitForIdle();

    // Session retention: delete oldest scheduled sessions beyond the limit
    this.cleanupScheduleSessions(schedule);
  }

  private async executeScheduledCallback(schedule: Schedule): Promise<void> {
    // Ensure callbacks are registered from capabilities
    await this.ensureScheduleCallbacks();

    const callback = this.scheduleCallbacks.get(schedule.id);
    if (!callback) {
      throw new Error(`No callback registered for schedule "${schedule.id}"`);
    }

    const ctx: ScheduleCallbackContext = {
      schedule,
      sessionStore: this.sessionStore,
      emitCost: (cost) => {
        // Callback costs are not tied to a session — persist as a global custom entry
        const sessions = this.sessionStore.list();
        if (sessions.length > 0) {
          this.handleCostEvent(cost, sessions[0].id);
        }
      },
    };

    await callback(ctx);
  }

  /** Ensure capability schedule callbacks are registered (lightweight, no agent creation). */
  private async ensureScheduleCallbacks(): Promise<void> {
    if (this.scheduleCallbacks.size > 0) return;

    const context: AgentContext = {
      sessionId: "",
      stepNumber: 0,
      emitCost: () => {},
      schedules: this.buildScheduleManager(),
    };
    const resolved = resolveCapabilities(this.getCapabilities(), context, (capId) =>
      createCapabilityStorage(this.ctx.storage, capId),
    );

    for (const { config } of resolved.schedules) {
      if ("callback" in config) {
        this.scheduleCallbacks.set(config.id, config.callback);
      }
    }
  }

  /** Sync capability-declared schedules: create if missing, update cron if changed. */
  private async syncCapabilitySchedules(
    declarations: Array<{ config: ScheduleConfig; ownerId: string }>,
  ): Promise<void> {
    for (const { config, ownerId } of declarations) {
      const existing = this.scheduleStore.get(config.id);

      if ("callback" in config) {
        this.scheduleCallbacks.set(config.id, config.callback);
      }

      const tz = config.timezone ?? undefined;

      if (existing) {
        // Update cron/timezone if changed
        if (
          existing.cron !== config.cron ||
          existing.enabled !== (config.enabled ?? true) ||
          existing.timezone !== (config.timezone ?? null)
        ) {
          const next = nextFireTime(config.cron, undefined, tz);
          this.scheduleStore.update(config.id, {
            cron: config.cron,
            enabled: config.enabled ?? true,
            timezone: config.timezone ?? null,
            nextFireAt: next.toISOString(),
          });
        }
      } else {
        // Create new schedule
        const isPrompt = "prompt" in config;
        const next = nextFireTime(config.cron, undefined, tz);
        this.scheduleStore.create({
          id: config.id,
          name: config.name,
          cron: config.cron,
          enabled: config.enabled ?? true,
          handlerType: isPrompt ? "prompt" : "callback",
          prompt: isPrompt ? (config as PromptScheduleConfig).prompt : undefined,
          sessionPrefix: isPrompt ? (config as PromptScheduleConfig).sessionPrefix : undefined,
          ownerId,
          timezone: config.timezone,
          expiresAt: config.maxDuration
            ? expiresAtFromDuration(config.maxDuration).toISOString()
            : undefined,
          nextFireAt: next.toISOString(),
          retention: config.retention,
        });
      }
    }

    await this.refreshAlarm();
  }

  /** Set the DO alarm to the earliest pending schedule fire time and notify clients. */
  private async refreshAlarm(): Promise<void> {
    const earliest = this.scheduleStore.getEarliestFireTime();
    if (earliest) {
      await this.ctx.storage.setAlarm(earliest);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    this.broadcastScheduleList();
  }

  /** Delete oldest scheduled sessions for a schedule, keeping up to retention count. */
  private cleanupScheduleSessions(schedule: Schedule): void {
    const prefix = schedule.sessionPrefix ?? schedule.name;
    const allSessions = this.sessionStore
      .list()
      .filter((s) => s.source === "scheduled" && s.name.startsWith(prefix));

    if (allSessions.length > schedule.retention) {
      // Sessions are ordered by created_at ASC, so oldest are first
      const toDelete = allSessions.slice(0, allSessions.length - schedule.retention);
      for (const s of toDelete) {
        this.sessionStore.delete(s.id);
      }
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

  private broadcastScheduleList(): void {
    const schedules = this.scheduleStore.list();
    const msg: ServerMessage = {
      type: "schedule_list",
      schedules: schedules.map((s) => ({
        id: s.id,
        name: s.name,
        cron: s.cron,
        enabled: s.enabled,
        status: s.status,
        nextFireAt: s.nextFireAt,
        expiresAt: s.expiresAt,
        lastFiredAt: s.lastFiredAt,
      })),
    };
    for (const [ws] of this.connections) {
      this.sendToSocket(ws, msg);
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

  private sendCommandList(ws: WebSocket, sessionId: string): void {
    const commands = this.resolveCommands(sessionId);
    this.sendToSocket(ws, {
      type: "command_list",
      commands: Array.from(commands.values()).map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
      })),
    });
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
