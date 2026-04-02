import { DurableObject } from "cloudflare:workers";
import type { A2AToolOptions } from "@claw-for-cloudflare/a2a";
import {
  A2AHandler,
  ClawExecutor,
  createCallAgentTool,
  createCancelTaskTool,
  createCheckTaskTool,
  createStartTaskTool,
  PendingTaskStore,
  TaskStore,
} from "@claw-for-cloudflare/a2a";
import type { AgentEvent, AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AssistantMessage, Message, Model } from "@claw-for-cloudflare/ai";
import type { ResolvedCapabilities } from "./capabilities/resolve.js";
import { resolveCapabilities } from "./capabilities/resolve.js";
import type { CapabilityStorage } from "./capabilities/storage.js";
import { createCapabilityStorage, createNoopStorage } from "./capabilities/storage.js";
import type {
  Capability,
  CapabilityHookContext,
  CapabilityHttpContext,
} from "./capabilities/types.js";
import type { Command, CommandContext, CommandResult } from "./commands/define-command.js";
import type { CompactionConfig as CompactionCfg } from "./compaction/types.js";
import { createConfigGet } from "./config/config-get.js";
import { createConfigSchema } from "./config/config-schema.js";
import { createConfigSet } from "./config/config-set.js";
import { ConfigStore } from "./config/config-store.js";
import type { ConfigNamespace } from "./config/types.js";
import type { CostEvent } from "./costs/types.js";
import { McpManager } from "./mcp/mcp-manager.js";
import {
  buildDefaultSystemPrompt,
  buildDefaultSystemPromptSections,
} from "./prompt/build-system-prompt.js";
import type { PromptOptions, PromptSection } from "./prompt/types.js";
import { buildToolPromptSections } from "./prompt/tool-sections.js";
import { createCfScheduler } from "./scheduling/cloudflare-scheduler.js";
import { expiresAtFromDuration, nextFireTime, validateCron } from "./scheduling/cron.js";
import { ScheduleStore } from "./scheduling/schedule-store.js";
import type { Scheduler } from "./scheduling/scheduler-types.js";
import type {
  PromptScheduleConfig,
  Schedule,
  ScheduleCallbackContext,
  ScheduleConfig,
} from "./scheduling/types.js";
import { SessionStore } from "./session/session-store.js";
import { createCfKvStore, createCfSqlStore } from "./storage/cloudflare.js";
import type { KvStore, SqlStore } from "./storage/types.js";
import { CfWebSocketTransport } from "./transport/cloudflare.js";
import { isRuntimeError } from "./errors/runtime-error.js";
import { applyDefaultTimeout } from "./tools/define-tool.js";
import { ErrorCodes } from "./transport/error-codes.js";
import type { Transport, TransportConnection } from "./transport/transport.js";
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

/** A2A protocol configuration. */
export interface A2AConfig {
  /** Serve agent card publicly at /.well-known/agent-card.json. Default: false */
  discoverable?: boolean;
  /** Accept A2A messages from other agents. Default: true */
  acceptMessages?: boolean;
  /** Base URL for this agent (used in agent card). */
  url?: string;
  /** Auth middleware for incoming A2A requests. Return null to allow, Response to reject. */
  authenticate?: (request: Request) => Promise<Response | null>;
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
  /** Default timeout in milliseconds for tool execution. Individual tools can override via defineTool({ timeout }). */
  defaultToolTimeout?: number;
  /** A2A protocol configuration. Controls discoverability and message acceptance. */
  a2a?: A2AConfig;
  /**
   * Compaction configuration.
   * @deprecated Use the compaction-summary capability via getCapabilities() instead.
   */
  compaction?: Partial<CompactionCfg>;
}

/** Operations for managing prompt-based schedules and one-shot timers. */
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
  /** Create a one-shot timer that fires after `delaySeconds` and self-deletes. */
  setTimer(
    id: string,
    delaySeconds: number,
    callback?: (ctx: ScheduleCallbackContext) => Promise<void>,
  ): Promise<void>;
  /** Cancel a pending timer by ID. */
  cancelTimer(id: string): Promise<void>;
}

/** Default timeout in milliseconds for requestFromClient. */
const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 5_000;

export interface AgentContext {
  /** The Durable Object ID of the agent (hex string). */
  agentId: string;
  sessionId: string;
  stepNumber: number;
  /** Emit a cost event. Persisted to session and broadcast to clients. */
  emitCost: (cost: CostEvent) => void;
  /** Broadcast a custom event to connected clients on the current session. */
  broadcast: (name: string, data: Record<string, unknown>) => void;
  /** Broadcast a custom event to ALL connected clients across all sessions. */
  broadcastToAll: (name: string, data: Record<string, unknown>) => void;
  /**
   * Send a custom event to the client and await a response.
   * The client must have an `onCustomRequest` handler configured.
   * Rejects on timeout or if no client responds.
   */
  requestFromClient: (
    eventName: string,
    eventData: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  /** Persistent key-value storage scoped to a capability. Only set for capability-contributed tools. */
  storage?: CapabilityStorage;
  /** Manage prompt-based schedules and one-shot timers. */
  schedules: ScheduleManager;
}

/**
 * Base Durable Object for pi-agent-core powered agents.
 * Consumers extend this and implement the abstract methods.
 */
export abstract class AgentDO<TEnv = Record<string, unknown>> extends DurableObject<TEnv> {
  /** Maximum client messages allowed per rate limit window. */
  private static readonly RATE_LIMIT_MAX = 30;
  /** Rate limit sliding window duration in milliseconds. */
  private static readonly RATE_LIMIT_WINDOW_MS = 10_000;

  protected sessionStore: SessionStore;
  protected scheduleStore: ScheduleStore;
  protected configStore: ConfigStore;
  protected mcpManager: McpManager;
  /** Per-session agent instances. Present only while inference is active, cleaned up on agent_end. */
  // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - types unavailable at import time
  protected sessionAgents = new Map<string, any>();
  protected transport: Transport;
  private connectionRateLimits = new Map<string, { count: number; windowStart: number }>();
  protected beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];
  private beforeToolExecutionHooks: ResolvedCapabilities["beforeToolExecutionHooks"] = [];
  private afterToolExecutionHooks: ResolvedCapabilities["afterToolExecutionHooks"] = [];
  private capabilityDisposers: ResolvedCapabilities["disposers"] = [];
  private scheduleCallbacks = new Map<string, (ctx: ScheduleCallbackContext) => Promise<void>>();
  /** Maps timer IDs to their owning capability ID (set during syncCapabilitySchedules). */
  private timerOwners = new Map<string, string>();
  /** Cached resolved capabilities — populated in ensureAgent, cleared on agent_end. */
  protected resolvedCapabilitiesCache: ResolvedCapabilities | null = null;
  /** Cached result of getCapabilities() — cleared alongside resolvedCapabilitiesCache. */
  protected capabilitiesCache: Capability[] | null = null;
  /** A2A task store — always initialized alongside SessionStore. */
  protected taskStore: TaskStore;
  /** Cached A2A handler — lazily created on first A2A request. */
  private a2aHandler: A2AHandler | null = null;
  private a2aExecutor: ClawExecutor | null = null;
  /** Tracked fire-and-forget async operations (e.g., callback-triggered prompts). */
  protected pendingAsyncOps = new Set<Promise<unknown>>();
  /** Pending client request/response round-trips (requestId -> resolver). */
  private pendingClientRequests = new Map<
    string,
    { resolve: (data: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** Platform-agnostic KV store adapter, created from CF storage in constructor. */
  protected kvStore: KvStore;
  /** Platform-agnostic scheduler adapter, created from CF storage in constructor. */
  protected scheduler: Scheduler;

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
    const sqlStore: SqlStore = createCfSqlStore(ctx.storage.sql);
    this.kvStore = createCfKvStore(ctx.storage);
    this.scheduler = createCfScheduler(ctx.storage);
    this.sessionStore = new SessionStore(sqlStore);
    this.taskStore = new TaskStore(sqlStore);
    this.scheduleStore = new ScheduleStore(sqlStore);
    this.configStore = new ConfigStore(this.kvStore);
    this.mcpManager = new McpManager(sqlStore, () => this.broadcastMcpStatus());
    this.transport = new CfWebSocketTransport(ctx);
    this.transport.onOpen((connection) => this.handleTransportOpen(connection));
    this.transport.onMessage((connection, data) => this.handleTransportMessage(connection, data));
    this.transport.onClose((connection) => this.handleTransportClose(connection));
  }

  // --- Abstract methods (consumers implement these) ---

  abstract getConfig(): AgentConfig;
  abstract getTools(context: AgentContext): AgentTool[];

  /**
   * Build the system prompt for this agent. Default implementation composes
   * identity, safety, and runtime sections from {@link getPromptOptions}.
   * Capability prompt sections are appended automatically after this.
   *
   * Override to fully replace the system prompt. Or override
   * {@link getPromptOptions} for lighter customization of the defaults.
   */
  buildSystemPrompt(_context: AgentContext): string {
    return buildDefaultSystemPrompt(this.getPromptOptions());
  }

  /**
   * Override to customize the default prompt sections without replacing
   * the entire system prompt. Configure agent name, timezone, safety, etc.
   * Only used when {@link buildSystemPrompt} is not overridden.
   */
  protected getPromptOptions(): PromptOptions {
    return {};
  }

  /**
   * Override to register capabilities. Capabilities contribute tools,
   * commands, prompt sections, MCP servers, and lifecycle hooks.
   * Registration order determines hook execution order.
   */
  protected getCapabilities(): Capability[] {
    return [];
  }

  /** Returns cached getCapabilities() result. Cache is cleared on agent_end. */
  protected getCachedCapabilities(): Capability[] {
    if (!this.capabilitiesCache) {
      this.capabilitiesCache = this.getCapabilities();
    }
    return this.capabilitiesCache;
  }

  /**
   * Override to register consumer config namespaces.
   * Config tools (config_get, config_set, config_schema) will include
   * these alongside the built-in namespaces (capability:{id}, schedules, session).
   */
  protected getConfigNamespaces(): ConfigNamespace[] {
    return [];
  }

  /**
   * Override to configure how this agent calls other A2A agents.
   * Requires a DO namespace binding to resolve agent stubs.
   * Returns null (default) if this agent should not have agent-calling tools.
   */
  protected getA2AClientOptions(): {
    getAgentStub: (id: string) => {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    };
    /** Resolve a registry UUID or friendly name to the DO identifier used by getAgentStub. */
    resolveDoId?: (id: string) => string;
    /**
     * The name other agents can pass to getAgentStub to reach THIS DO.
     * Used in push notification callback URLs so the receiving agent can
     * route back via the DO stub. If not set, falls back to ctx.id hex string
     * (which won't work with idFromName-based stubs).
     */
    callbackAgentName?: string;
    callbackBaseUrl?: string;
    maxDepth?: number;
    authHeaders?: (target: string) => Record<string, string> | Promise<Record<string, string>>;
  } | null {
    return null;
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

  /**
   * Override to validate authentication before accepting a WebSocket connection
   * or HTTP prompt. Return `true` to allow, `false` to reject with 401.
   */
  protected validateAuth?(_request: Request): Promise<boolean> | boolean;

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

  /** Dummy cron expression used for timer schedules (never evaluated). */
  private static readonly TIMER_DUMMY_CRON = "0 0 1 1 *";

  /** Build a ScheduleManager that delegates to the protected methods. */
  protected buildScheduleManager(): ScheduleManager {
    return {
      create: (config) => this.createSchedule(config),
      update: (id, updates) => this.updateSchedule(id, updates),
      delete: (id) => this.deleteSchedule(id),
      list: () => this.listSchedules(),
      get: (id) => {
        const s = this.scheduleStore.get(id);
        return s && s.ownerId !== null ? null : s;
      },
      setTimer: (id, delaySeconds, callback) => this.setTimer(id, delaySeconds, callback),
      cancelTimer: (id) => this.cancelTimer(id),
    };
  }

  /** Create a one-shot timer that fires after `delaySeconds` and self-deletes. */
  private async setTimer(
    id: string,
    delaySeconds: number,
    callback?: (ctx: ScheduleCallbackContext) => Promise<void>,
  ): Promise<void> {
    // Remove any existing timer with the same ID, preserving callback if not replaced
    const existing = this.scheduleStore.get(id);
    const existingCallback = this.scheduleCallbacks.get(id);
    if (existing) {
      this.scheduleStore.delete(id);
    }

    const resolved = callback ?? existingCallback;
    if (!resolved) {
      throw new Error(`setTimer("${id}"): no callback provided and no existing callback found`);
    }

    const firesAt = new Date(Date.now() + delaySeconds * 1000);
    this.scheduleStore.create({
      id,
      name: id,
      cron: AgentDO.TIMER_DUMMY_CRON,
      handlerType: "timer",
      nextFireAt: firesAt.toISOString(),
      ownerId: this.timerOwners.get(id),
    });
    this.scheduleCallbacks.set(id, resolved);
    await this.refreshAlarm();
  }

  /** Cancel a pending timer by ID. */
  private async cancelTimer(id: string): Promise<void> {
    const existing = this.scheduleStore.get(id);
    if (existing && existing.handlerType === "timer") {
      this.scheduleStore.delete(id);
    }
    this.scheduleCallbacks.delete(id);
    await this.refreshAlarm();
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
    // Reject updates to internal (capability-owned) schedules
    const guard = this.scheduleStore.get(id);
    if (guard?.ownerId !== undefined && guard.ownerId !== null) return null;

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
    // Reject deletion of internal (capability-owned) schedules
    const guard = this.scheduleStore.get(id);
    if (guard?.ownerId !== undefined && guard.ownerId !== null) return;

    this.scheduleStore.delete(id);
    this.scheduleCallbacks.delete(id);
    await this.refreshAlarm();
  }

  /** List user-facing schedules (excludes internal capability-owned schedules). */
  protected listSchedules(): Schedule[] {
    return this.scheduleStore.list().filter((s) => s.ownerId === null);
  }

  // --- WebSocket transport ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Auth validation (if implemented by subclass)
    if (this.validateAuth) {
      const allowed = await this.validateAuth(request);
      if (!allowed) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // WebSocket upgrade
    if (request.headers.get("upgrade") === "websocket") {
      return this.transport.handleUpgrade(request);
    }

    // HTTP POST fallback for prompting
    if (request.method === "POST" && url.pathname === "/prompt") {
      return this.handleHttpPrompt(request);
    }

    // Schedule management HTTP API
    if (url.pathname === "/schedules") {
      if (request.method === "GET") {
        return new Response(JSON.stringify(this.listSchedules()), {
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "POST") {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          if (!body.name || !body.cron || !body.prompt) {
            return new Response(JSON.stringify({ error: "name, cron, and prompt are required" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          if (!validateCron(body.cron as string)) {
            return new Response(
              JSON.stringify({ error: `Invalid cron expression: ${body.cron}` }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          const schedule = await this.createSchedule({
            id: (body.id as string) || crypto.randomUUID(),
            name: body.name as string,
            cron: body.cron as string,
            prompt: body.prompt as string,
            enabled: body.enabled !== false,
            timezone: (body.timezone as string) || undefined,
            maxDuration: (body.maxDuration as string) || undefined,
            retention: (body.retention as number) || undefined,
          });
          return new Response(JSON.stringify(schedule), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
      }
    }

    const scheduleMatch = url.pathname.match(/^\/schedules\/(.+)$/);
    if (scheduleMatch) {
      const scheduleId = scheduleMatch[1];
      if (request.method === "GET") {
        const schedule = this.scheduleStore.get(scheduleId);
        if (!schedule || schedule.ownerId !== null) {
          return new Response(JSON.stringify({ error: "Schedule not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(schedule), {
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "PUT") {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          if (body.cron && !validateCron(body.cron as string)) {
            return new Response(
              JSON.stringify({ error: `Invalid cron expression: ${body.cron}` }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          const updates: Record<string, unknown> = {};
          for (const key of ["name", "cron", "prompt", "enabled", "timezone", "retention"]) {
            if (body[key] !== undefined) updates[key] = body[key];
          }
          const updated = await this.updateSchedule(
            scheduleId,
            updates as Parameters<typeof this.updateSchedule>[1],
          );
          if (!updated) {
            return new Response(JSON.stringify({ error: "Schedule not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(updated), {
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (request.method === "DELETE") {
        await this.deleteSchedule(scheduleId);
        return new Response(null, { status: 204 });
      }
    }

    // MCP OAuth callback
    if (url.pathname === "/mcp/callback") {
      return this.handleMcpCallback(request);
    }

    // A2A protocol endpoints (built-in)
    const a2aResponse = await this.handleA2ARequest(request, url);
    if (a2aResponse) return a2aResponse;

    // Capability-contributed HTTP handlers
    const httpMatch = await this.matchHttpHandler(request.method, url.pathname);
    if (httpMatch) {
      return httpMatch.handler(request, httpMatch.ctx);
    }

    return new Response("Not found", { status: 404 });
  }

  private handleTransportOpen(connection: TransportConnection): void {
    // Default to first session or create one
    const sessions = this.sessionStore.list();
    const sessionId = sessions[0]?.id ?? this.sessionStore.create().id;

    connection.setSessionId(sessionId);

    // Send initial sync (paginated)
    const session = this.sessionStore.get(sessionId);
    if (session) {
      const { entries, hasMore } = this.sessionStore.getEntriesPaginated(sessionId);
      const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : undefined;
      const contextMessages = this.sessionStore.buildContext(sessionId);
      connection.send({
        type: "session_sync",
        sessionId,
        session,
        messages: contextMessages,
        streamMessage: this.sessionAgents.get(sessionId)?.state.isStreaming
          ? (this.sessionAgents.get(sessionId)?.state.streamMessage ?? null)
          : null,
        cursor: lastSeq,
        hasMore,
      });
    }

    // Send session list, schedule list, and command list
    this.sendSessionList(connection);
    this.sendCommandList(connection, sessionId);
    this.broadcastScheduleList();

    // Fire onConnect hooks asynchronously (don't block WS handshake)
    this.fireOnConnectHooks(sessionId).catch((err) => {
      console.error("[AgentDO] onConnect hooks error:", err);
    });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    (this.transport as CfWebSocketTransport).handleMessage(ws, data);
  }

  private handleTransportMessage(connection: TransportConnection, data: string): void {
    // Capture and clear hibernation flag up front so hooks fire exactly once.
    // The flag is consumed here; session_sync logic below uses the local variable.
    const wasRecovery = connection.wasRestoredFromHibernation;
    if (wasRecovery) {
      connection.wasRestoredFromHibernation = false;
      this.fireOnConnectHooks(connection.getSessionId()).catch((err) => {
        console.error("[AgentDO] onConnect hooks error (reconnect):", err);
      });
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      connection.send({
        type: "error",
        code: ErrorCodes.PARSE_ERROR,
        message: "Invalid message format",
      });
      return;
    }

    // Validate message structure before dispatching
    const validationError = this.validateClientMessage(msg);
    if (validationError) {
      connection.send({
        type: "error",
        code: ErrorCodes.PARSE_ERROR,
        message: validationError,
      });
      return;
    }

    // Rate limiting: sliding window per connection.
    // Exempt protocol messages (ping, request_sync) — they're automatic,
    // not user-initiated, and can't be used for abuse.
    if (msg.type !== "ping" && msg.type !== "request_sync") {
      const now = Date.now();
      let rateLimit = this.connectionRateLimits.get(connection.id);
      if (!rateLimit || now - rateLimit.windowStart > AgentDO.RATE_LIMIT_WINDOW_MS) {
        rateLimit = { count: 0, windowStart: now };
        this.connectionRateLimits.set(connection.id, rateLimit);
      }
      rateLimit.count++;
      if (rateLimit.count > AgentDO.RATE_LIMIT_MAX) {
        connection.send({
          type: "error",
          code: ErrorCodes.RATE_LIMITED,
          message: "Too many messages — slow down",
        });
        return;
      }
    }

    // After hibernation, in-memory state (sessionAgents) is lost.
    // Send a session_sync so the client gets fresh state and knows
    // the agent is no longer streaming (agentStatus resets to idle).
    // Skip for prompt/steer — those persist the user message first and then
    // trigger agent events, so a sync here would race with the optimistic
    // client-side message and overwrite it with stale server state.
    if (wasRecovery && msg.type !== "prompt" && msg.type !== "steer") {
      const sessionId = connection.getSessionId();
      const session = this.sessionStore.get(sessionId);
      if (session) {
        const { entries, hasMore } = this.sessionStore.getEntriesPaginated(sessionId);
        const messages = this.sessionStore.buildContext(sessionId);
        const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : undefined;
        connection.send({
          type: "session_sync",
          sessionId,
          session,
          messages,
          streamMessage: null,
          cursor: lastSeq,
          hasMore,
        });
      }
    }

    this.handleClientMessage(connection, msg).catch((err) => {
      connection.send({
        type: "error",
        code: ErrorCodes.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : "An unexpected error occurred",
      });
    });
  }

  webSocketClose(ws: WebSocket): void {
    (this.transport as CfWebSocketTransport).handleClose(ws);
  }

  private handleTransportClose(connection: TransportConnection): void {
    this.connectionRateLimits.delete(connection.id);

    // Dispose capability resources when the last connection closes
    const remaining = [...this.transport.getConnections()];
    if (remaining.length === 0) {
      this.disposeCapabilities();
    }
  }

  private static readonly VALID_CLIENT_MESSAGE_TYPES = new Set([
    "prompt",
    "steer",
    "abort",
    "switch_session",
    "new_session",
    "delete_session",
    "command",
    "request_sync",
    "toggle_schedule",
    "custom_response",
    "request_system_prompt",
    "ping",
  ]);

  /** Returns an error string if the message is invalid, or null if valid. */
  private validateClientMessage(msg: unknown): string | null {
    if (typeof msg !== "object" || msg === null) {
      return "Message must be an object";
    }

    const obj = msg as Record<string, unknown>;

    if (typeof obj.type !== "string" || !AgentDO.VALID_CLIENT_MESSAGE_TYPES.has(obj.type)) {
      return `Unknown message type: ${String(obj.type)}`;
    }

    // Validate required fields per message type
    if ((obj.type === "prompt" || obj.type === "steer") && typeof obj.text !== "string") {
      return `"${obj.type}" message requires a "text" string field`;
    }

    if (obj.type === "switch_session" && typeof obj.sessionId !== "string") {
      return '"switch_session" message requires a "sessionId" string field';
    }

    if (
      obj.type === "toggle_schedule" &&
      (typeof obj.scheduleId !== "string" || typeof obj.enabled !== "boolean")
    ) {
      return '"toggle_schedule" message requires a "scheduleId" string and "enabled" boolean field';
    }

    return null;
  }

  private async handleClientMessage(
    connection: TransportConnection,
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
        this.sessionAgents.get(msg.sessionId)?.abort();
        break;

      case "switch_session": {
        connection.setSessionId(msg.sessionId);
        const session = this.sessionStore.get(msg.sessionId);
        if (session) {
          const sessionAgent = this.sessionAgents.get(msg.sessionId);
          const { entries, hasMore } = this.sessionStore.getEntriesPaginated(msg.sessionId);
          const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : undefined;
          connection.send({
            type: "session_sync",
            sessionId: msg.sessionId,
            session,
            messages: this.sessionStore.buildContext(msg.sessionId),
            streamMessage: sessionAgent?.state.isStreaming
              ? (sessionAgent.state.streamMessage ?? null)
              : null,
            cursor: lastSeq,
            hasMore,
          });
        }

        // Fire onConnect hooks so capabilities can reconcile session-scoped state
        this.fireOnConnectHooks(msg.sessionId).catch((err) => {
          console.error("[AgentDO] onConnect hooks error (session switch):", err);
        });
        break;
      }

      case "new_session": {
        const session = this.sessionStore.create({ name: msg.name });
        connection.setSessionId(session.id);
        this.onSessionCreated?.({ id: session.id, name: session.name });
        connection.send({
          type: "session_sync",
          sessionId: session.id,
          session,
          messages: [],
          streamMessage: null,
        });
        this.broadcastSessionList();

        // Fire onConnect hooks so capabilities can reconcile session-scoped state
        this.fireOnConnectHooks(session.id).catch((err) => {
          console.error("[AgentDO] onConnect hooks error (new session):", err);
        });
        break;
      }

      case "delete_session": {
        // Don't delete the session if it's the only one
        const allSessions = this.sessionStore.list();
        if (allSessions.length <= 1) break;

        // Abort any running inference on this session
        this.sessionAgents.get(msg.sessionId)?.abort();

        // Collect ALL connections on the doomed session BEFORE deleting it,
        // so getConnectionsForSession still matches on the old sessionId.
        const affectedConnections = [...this.transport.getConnectionsForSession(msg.sessionId)];

        this.sessionStore.delete(msg.sessionId);

        // Redirect every connection that was on the deleted session
        if (affectedConnections.length > 0) {
          const remaining = this.sessionStore.list();
          if (remaining.length > 0) {
            const target = remaining[0];
            const { entries: delEntries, hasMore: delHasMore } =
              this.sessionStore.getEntriesPaginated(target.id);
            const delLastSeq =
              delEntries.length > 0 ? delEntries[delEntries.length - 1].seq : undefined;
            const delMessages = this.sessionStore.buildContext(target.id);

            for (const conn of affectedConnections) {
              conn.setSessionId(target.id);
              conn.send({
                type: "session_sync",
                sessionId: target.id,
                session: target,
                messages: delMessages,
                streamMessage: null,
                cursor: delLastSeq,
                hasMore: delHasMore,
              });
            }
          }
        }

        this.broadcastSessionList();
        break;
      }

      case "command": {
        await this.handleCommand(connection, msg.sessionId, msg.name, msg.args);
        break;
      }

      case "request_sync": {
        const syncSession = this.sessionStore.get(msg.sessionId);
        if (!syncSession) {
          connection.send({
            type: "error",
            code: ErrorCodes.SESSION_NOT_FOUND,
            message: `Session not found: ${msg.sessionId}`,
          });
          break;
        }
        const { entries: pageEntries, hasMore: pageHasMore } =
          this.sessionStore.getEntriesPaginated(msg.sessionId, {
            afterSeq: msg.afterSeq,
          });
        const pageLastSeq =
          pageEntries.length > 0 ? pageEntries[pageEntries.length - 1].seq : msg.afterSeq;
        const sessionAgent = this.sessionAgents.get(msg.sessionId);
        connection.send({
          type: "session_sync",
          sessionId: msg.sessionId,
          session: syncSession,
          messages: this.sessionStore.buildContext(msg.sessionId),
          streamMessage: sessionAgent?.state.isStreaming
            ? (sessionAgent.state.streamMessage ?? null)
            : null,
          cursor: pageLastSeq,
          hasMore: pageHasMore,
        });
        break;
      }

      case "toggle_schedule": {
        await this.updateSchedule(msg.scheduleId, { enabled: msg.enabled });
        break;
      }

      case "custom_response": {
        const pending = this.pendingClientRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingClientRequests.delete(msg.requestId);
          pending.resolve(msg.data);
        }
        break;
      }

      case "request_system_prompt": {
        const sections = this.getSystemPromptSections();
        const raw = sections.map((s) => s.content).join("\n\n");
        connection.send({ type: "system_prompt", sections, raw } as ServerMessage);
        break;
      }

      case "ping": {
        connection.send({ type: "pong" } as ServerMessage);
        break;
      }
    }
  }

  /**
   * Build the system prompt as structured sections for inspection.
   * Returns default sections + named capability sections.
   */
  private getSystemPromptSections(): PromptSection[] {
    // Check if the consumer overrode buildSystemPrompt
    const isOverridden =
      Object.getPrototypeOf(this).buildSystemPrompt !== AgentDO.prototype.buildSystemPrompt;

    let baseSections: PromptSection[];
    if (isOverridden) {
      // Can't decompose a custom prompt — return as a single section
      const context = this.createInspectionContext();
      const raw = this.buildSystemPrompt(context);
      baseSections = [
        { name: "System Prompt", key: "custom", content: raw, lines: raw.split("\n").length },
      ];
    } else {
      baseSections = buildDefaultSystemPromptSections(this.getPromptOptions());
    }

    // Resolve capabilities for their prompt sections and tools
    const context = this.createInspectionContext();
    const capabilities = this.getCachedCapabilities();
    const resolved = resolveCapabilities(capabilities, context);

    // Include base tools + capability tools for tool prompt sections
    const baseTools = this.getTools(context);
    const inspectionTools = [...baseTools, ...resolved.tools];
    const toolSections = buildToolPromptSections(inspectionTools);

    return [...baseSections, ...toolSections, ...resolved.promptSections];
  }

  /** Create a minimal AgentContext for prompt inspection (no active session). */
  private createInspectionContext(): AgentContext {
    return {
      agentId: this.ctx.id.toString(),
      sessionId: "__inspection__",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available during inspection")),
      schedules: this.buildScheduleManager(),
    };
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

    // If this session already has an active agent streaming, steer instead
    const existingAgent = this.sessionAgents.get(sessionId);
    if (existingAgent?.state.isStreaming) {
      this.broadcastToSession(sessionId, {
        type: "error",
        code: ErrorCodes.AGENT_BUSY,
        message: "Agent is busy — message will be injected as a steer",
      });
      this.handleSteer(sessionId, text);
      return;
    }

    // Create a fresh agent for this session (no cross-session blocking)
    await this.ensureAgent(sessionId);

    const agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      throw new Error("Agent failed to initialize");
    }

    try {
      await agent.prompt(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = isRuntimeError(err) ? err.errorCode : ErrorCodes.INTERNAL_ERROR;
      console.error("[AgentDO] prompt failed:", message);
      this.broadcastToSession(sessionId, {
        type: "error",
        code,
        message: `Agent error: ${message}`,
      });
    }
  }

  private handleSteer(sessionId: string, text: string, broadcast = false): void {
    const timestamp = Date.now();

    // Persist steer message to session store
    const steerEntry = this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp },
    });
    // Broadcast to clients so the message appears immediately.
    // Only enabled for server-originated steers (e.g. A2A callbacks) — for
    // human steers the client already optimistically added the message.
    if (broadcast) {
      this.broadcastToSession(sessionId, {
        type: "inject_message",
        sessionId,
        message: { role: "user", content: text, timestamp } as AgentMessage,
      });
    }

    // Inject into this session's agent if it's actively streaming
    const agent = this.sessionAgents.get(sessionId);
    if (agent?.state.isStreaming) {
      agent.steer({
        role: "user",
        content: text,
        timestamp,
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

    // Use cached capabilities if available, otherwise resolve fresh
    const resolved =
      this.resolvedCapabilitiesCache ??
      resolveCapabilities(
        this.getCachedCapabilities(),
        {
          agentId: this.ctx.id.toString(),
          sessionId,
          stepNumber: 0,
          emitCost: () => {},
          broadcast: () => {},
          broadcastToAll: () => {},
          requestFromClient: () => Promise.reject(new Error("Not available")),
          schedules: this.buildScheduleManager(),
        },
        (capId) => createCapabilityStorage(this.kvStore, capId),
      );

    const commandMap = new Map<string, Command>();

    // Built-in commands (can be overridden by consumer or capability commands)
    commandMap.set("clear", {
      name: "clear",
      description: "Clear conversation and start fresh",
      execute: () => ({ text: "Cleared" }),
    });

    // Consumer commands override built-ins
    for (const cmd of baseCommands) {
      commandMap.set(cmd.name, cmd);
    }
    // Capability commands fill in gaps
    for (const cmd of resolved.commands) {
      if (!commandMap.has(cmd.name)) {
        commandMap.set(cmd.name, cmd);
      }
    }
    return commandMap;
  }

  private handleClearCommand(connection: TransportConnection, sessionId: string): void {
    // Abort any running inference on the current session
    this.sessionAgents.get(sessionId)?.abort();

    // Create a fresh session
    const newSession = this.sessionStore.create({});
    connection.setSessionId(newSession.id);
    this.onSessionCreated?.({ id: newSession.id, name: newSession.name });

    // Sync client to the new empty session
    connection.send({
      type: "session_sync",
      sessionId: newSession.id,
      session: newSession,
      messages: [],
      streamMessage: null,
    });

    // Delete the old session if it's not the only one
    const allSessions = this.sessionStore.list();
    if (allSessions.length > 1) {
      this.sessionStore.delete(sessionId);
    }

    this.broadcastSessionList();
  }

  private async handleCommand(
    connection: TransportConnection,
    sessionId: string,
    name: string,
    rawArgs?: string,
  ): Promise<void> {
    // Built-in commands that need connection access
    if (name === "clear") {
      return this.handleClearCommand(connection, sessionId);
    }

    const commands = this.resolveCommands(sessionId);
    const command = commands.get(name);

    if (!command) {
      connection.send({
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

      connection.send({
        type: "command_result",
        sessionId,
        name,
        result: { text: result.text, data: result.data },
        isError: false,
      });
    } catch (err: unknown) {
      connection.send({
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
      agentId: this.ctx.id.toString(),
      sessionId,
      stepNumber: 0,
      emitCost: (cost) => this.handleCostEvent(cost, sessionId),
      broadcast: (name, data) =>
        this.broadcastToSession(sessionId, {
          type: "custom_event",
          sessionId,
          event: { name, data },
        }),
      broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
      requestFromClient: (eventName, eventData, timeoutMs) =>
        this.requestFromClient(sessionId, eventName, eventData, timeoutMs),
      schedules: this.buildScheduleManager(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai getModel has overly narrow provider type (KnownProvider)
    const model = getModel(config.provider as any, config.modelId);

    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }

    // Resolve capabilities with scoped storage per capability (and cache the result)
    const capabilities = this.getCachedCapabilities();
    const resolved = resolveCapabilities(capabilities, context, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );
    this.resolvedCapabilitiesCache = resolved;
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;
    this.beforeToolExecutionHooks = resolved.beforeToolExecutionHooks;
    this.afterToolExecutionHooks = resolved.afterToolExecutionHooks;
    this.capabilityDisposers = resolved.disposers;

    // Sync capability-declared schedules
    if (resolved.schedules.length > 0) {
      await this.syncCapabilitySchedules(resolved.schedules);
    }

    // Build config tools (always available)
    // Collect config namespaces from capabilities + consumer overrides
    const capabilityNamespaces = capabilities.flatMap(
      (cap) => cap.configNamespaces?.(context) ?? [],
    );
    const consumerNamespaces = this.getConfigNamespaces();
    const configContext = {
      agentId: this.ctx.id.toString(),
      sessionId,
      sessionStore: this.sessionStore,
      configStore: this.configStore,
      capabilities,
      namespaces: [...capabilityNamespaces, ...consumerNamespaces],
    };
    const configTools = [
      createConfigGet(configContext),
      createConfigSet(configContext),
      createConfigSchema(configContext),
    ];

    // A2A client tools (if configured)
    const a2aClientTools = this.createA2AClientTools(sessionId);

    // Merge tools: getTools() first, then config tools, then A2A tools, then capability tools
    const baseTools = this.getTools(context);
    let allTools = [...baseTools, ...configTools, ...a2aClientTools, ...resolved.tools];

    // Apply global default timeout if configured
    if (config.defaultToolTimeout) {
      allTools = applyDefaultTimeout(allTools, config.defaultToolTimeout);
    }

    // Build system prompt with tool sections and capability sections appended
    const toolSections = buildToolPromptSections(allTools);
    const allPromptSections = [...toolSections, ...resolved.promptSections];
    let systemPrompt = this.buildSystemPrompt(context);
    if (allPromptSections.length > 0) {
      systemPrompt += `\n\n${allPromptSections.map((s) => s.content).join("\n\n")}`;
    }

    const messages = this.sessionStore.buildContext(sessionId);

    const agent = new piAgent({
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

    agent.subscribe((event: AgentEvent) => {
      this.handleAgentEvent(event, sessionId);

      // Clean up agent instance and capability cache when inference completes
      if (event.type === "agent_end") {
        this.sessionAgents.delete(sessionId);
        this.resolvedCapabilitiesCache = null;
        this.capabilitiesCache = null;
        this.disposeCapabilities();
      }
    });

    // Wire beforeToolExecution hooks
    if (this.beforeToolExecutionHooks.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - beforeToolCall context type unavailable
      agent.setBeforeToolCall(async (btcContext: any) => {
        const hookContext: CapabilityHookContext = {
          agentId: this.ctx.id.toString(),
          sessionId,
          sessionStore: this.sessionStore,
          storage: createNoopStorage(),
        };
        const event = {
          toolName: btcContext.toolCall.name as string,
          args: btcContext.args,
          toolCallId: btcContext.toolCall.id as string,
        };
        for (const hook of this.beforeToolExecutionHooks) {
          try {
            const result = await hook(event, hookContext);
            if (result?.block) {
              return { block: true, reason: result.reason };
            }
          } catch (err) {
            console.error("[capabilities] beforeToolExecution hook error:", err);
          }
        }
        return undefined;
      });
    }

    // Wire afterToolExecution hooks
    if (this.afterToolExecutionHooks.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - afterToolCall context type unavailable
      agent.setAfterToolCall(async (atcContext: any) => {
        const hookContext: CapabilityHookContext = {
          agentId: this.ctx.id.toString(),
          sessionId,
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

    this.sessionAgents.set(sessionId, agent);
  }

  /**
   * Resolve all tools for a session (base + capability) with a proper AgentContext.
   * Useful for subclasses that need to execute tools outside the normal inference loop
   * (e.g., debug tool execution, test harnesses).
   */
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires explicit any
  protected resolveToolsForSession(sessionId: string): {
    tools: AgentTool<any>[];
    context: AgentContext;
    resolved: ResolvedCapabilities;
  } {
    const context: AgentContext = {
      agentId: this.ctx.id.toString(),
      sessionId,
      stepNumber: 0,
      emitCost: (cost) => this.handleCostEvent(cost, sessionId),
      broadcast: (name, data) =>
        this.broadcastToSession(sessionId, {
          type: "custom_event",
          sessionId,
          event: { name, data },
        }),
      broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
      requestFromClient: () => Promise.reject(new Error("Not available")),
      schedules: this.buildScheduleManager(),
    };

    const resolved = resolveCapabilities(this.getCachedCapabilities(), context, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );

    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

    return { tools: allTools, context, resolved };
  }

  protected async transformContext(
    messages: AgentMessage[],
    sessionId: string,
  ): Promise<AgentMessage[]> {
    let result = messages;

    const hookContext: CapabilityHookContext = {
      agentId: this.ctx.id.toString(),
      sessionId,
      sessionStore: this.sessionStore,
      storage: createNoopStorage(), // Each wrapped hook overrides with its scoped storage
    };

    for (const hook of this.beforeInferenceHooks) {
      try {
        result = await hook(result, hookContext);
      } catch (err) {
        console.error("[AgentDO] beforeInference hook error:", err);
      }
    }

    return result;
  }

  /**
   * Call dispose() on all capabilities that registered a disposer.
   * Errors are caught per-capability and logged — they do not propagate.
   */
  private disposeCapabilities(): void {
    for (const { capabilityId, dispose } of this.capabilityDisposers) {
      dispose().catch((err) => {
        console.error(`[capabilities] dispose error from "${capabilityId}":`, err);
      });
    }
    this.capabilityDisposers = [];
  }

  /** Fire onConnect hooks for all registered capabilities. */
  private async fireOnConnectHooks(sessionId: string): Promise<void> {
    // Use cached capabilities if available, otherwise resolve fresh
    const resolved =
      this.resolvedCapabilitiesCache ??
      resolveCapabilities(
        this.getCachedCapabilities(),
        {
          agentId: this.ctx.id.toString(),
          sessionId,
          stepNumber: 0,
          emitCost: () => {},
          broadcast: (name, data) =>
            this.broadcastToSession(sessionId, {
              type: "custom_event",
              sessionId,
              event: { name, data },
            }),
          broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
          requestFromClient: (eventName, eventData, timeoutMs) =>
            this.requestFromClient(sessionId, eventName, eventData, timeoutMs),
          schedules: this.buildScheduleManager(),
        },
        (capId) => createCapabilityStorage(this.kvStore, capId),
      );

    const broadcastFn = (name: string, data: Record<string, unknown>) =>
      this.broadcastToSession(sessionId, {
        type: "custom_event",
        sessionId,
        event: { name, data },
      });

    for (const hook of resolved.onConnectHooks) {
      try {
        const hookContext: CapabilityHookContext = {
          agentId: this.ctx.id.toString(),
          sessionId,
          sessionStore: this.sessionStore,
          storage: createNoopStorage(), // Each wrapped hook overrides with its scoped storage
          broadcast: broadcastFn,
        };
        await hook(hookContext);
      } catch (err) {
        console.error("[capabilities] onConnect hook error:", err);
      }
    }

    // Broadcast active pending A2A tasks for this session
    try {
      const a2aStorage = createCapabilityStorage(this.kvStore, "a2a-client");
      const pendingStore = new PendingTaskStore(a2aStorage);
      const activeTasks = await pendingStore.listActive();
      const sessionTasks = activeTasks.filter((t) => t.originSessionId === sessionId);
      if (sessionTasks.length > 0) {
        broadcastFn("a2a_active_tasks", {
          tasks: sessionTasks.map((t) => ({
            taskId: t.taskId,
            targetAgent: t.targetAgent,
            targetAgentName: t.targetAgentName,
            state: t.state,
            originalRequest: t.originalRequest,
          })),
        });
      }
    } catch (err) {
      console.error("[AgentDO] Failed to broadcast active A2A tasks:", err);
    }
  }

  private convertToLlm(messages: AgentMessage[]): Message[] {
    // Pass through standard LLM messages, filter out any custom types
    return messages.filter((m): m is Message => {
      return (
        "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      );
    });
  }

  protected handleAgentEvent(event: AgentEvent, sessionId: string): void {
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

  protected handleCostEvent(cost: CostEvent, sessionId: string): void {
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

  /** DO alarm lifecycle handler. Delegates to handleAlarmFired(). */
  async alarm(): Promise<void> {
    await this.handleAlarmFired();
  }

  /**
   * Process all due schedules and refresh the wake time.
   * Called by the DO alarm() lifecycle method. Non-DO platform base classes
   * can call this from their own wake mechanism (e.g., setTimeout, node-cron).
   */
  protected async handleAlarmFired(): Promise<void> {
    const now = new Date();
    const dueSchedules = this.scheduleStore.getDueSchedules(now);

    for (const schedule of dueSchedules) {
      // Auto-delete expired schedules
      if (schedule.expiresAt && new Date(schedule.expiresAt) <= now) {
        this.scheduleStore.delete(schedule.id);
        this.scheduleCallbacks.delete(schedule.id);
        continue;
      }

      // Timers: execute callback then self-delete (no cron recomputation)
      if (schedule.handlerType === "timer") {
        this.scheduleStore.markRunning(schedule.id);
        try {
          await this.executeScheduledCallback(schedule);
          this.scheduleStore.delete(schedule.id);
          this.scheduleCallbacks.delete(schedule.id);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[AgentDO] Timer "${schedule.name}" failed:`, message);
          this.scheduleStore.markFailed(schedule.id, message);
        }
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
    await this.sessionAgents.get(session.id)?.waitForIdle();

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
      abortAllSessions: () => {
        for (const agent of this.sessionAgents.values()) {
          if (agent.state.isStreaming) {
            agent.abort();
          }
        }
      },
    };

    await callback(ctx);
  }

  /** Ensure capability schedule callbacks are registered (lightweight, no agent creation). */
  private async ensureScheduleCallbacks(): Promise<void> {
    if (this.scheduleCallbacks.size > 0) return;

    // Use cached capabilities if available, otherwise resolve fresh
    const resolved =
      this.resolvedCapabilitiesCache ??
      resolveCapabilities(
        this.getCachedCapabilities(),
        {
          agentId: this.ctx.id.toString(),
          sessionId: "",
          stepNumber: 0,
          emitCost: () => {},
          broadcast: () => {},
          broadcastToAll: () => {},
          requestFromClient: () => Promise.reject(new Error("Not available")),
          schedules: this.buildScheduleManager(),
        },
        (capId) => createCapabilityStorage(this.kvStore, capId),
      );

    for (const { config } of resolved.schedules) {
      if ("callback" in config) {
        this.scheduleCallbacks.set(config.id, config.callback);
      }
    }
  }

  /** Sync capability-declared schedules: create if missing, update cron if changed. */
  protected async syncCapabilitySchedules(
    declarations: Array<{ config: ScheduleConfig; ownerId: string }>,
  ): Promise<void> {
    for (const { config, ownerId } of declarations) {
      const existing = this.scheduleStore.get(config.id);

      if ("callback" in config) {
        this.scheduleCallbacks.set(config.id, config.callback);
      }

      // Timer configs: only re-register the callback if the timer still exists in DB.
      // Timers are created at runtime (via setTimer), not declared statically.
      if ("delaySeconds" in config) {
        // Track ownership so setTimer() can tag the record as internal
        this.timerOwners.set(config.id, ownerId);
        // Re-register callback for hibernation resilience
        if (existing && existing.handlerType === "timer") {
          this.scheduleCallbacks.set(config.id, config.callback);
        }
        continue;
      }

      const tz = config.timezone ?? undefined;

      if (existing) {
        // Update cron/timezone if changed (enabled is user-owned via toggleSchedule, not reconciled)
        if (existing.cron !== config.cron || existing.timezone !== (config.timezone ?? null)) {
          const next = nextFireTime(config.cron, undefined, tz);
          this.scheduleStore.update(config.id, {
            cron: config.cron,
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
      await this.scheduler.setWakeTime(earliest);
    } else {
      await this.scheduler.cancelWakeTime();
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

  // --- Capability HTTP handlers ---

  /** Cache for resolved HTTP handlers (lazily populated on first HTTP request). */
  private resolvedHttpHandlers: ResolvedCapabilities["httpHandlers"] | null = null;

  private resolveHttpHandlers(): ResolvedCapabilities["httpHandlers"] {
    if (this.resolvedHttpHandlers) return this.resolvedHttpHandlers;

    const capabilities = this.getCachedCapabilities();
    const baseContext: AgentContext = {
      agentId: this.ctx.id.toString(),
      sessionId: "",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
      requestFromClient: () => Promise.reject(new Error("Not available")),
      schedules: this.buildScheduleManager(),
    };

    const resolved = resolveCapabilities(capabilities, baseContext, (capId) =>
      createCapabilityStorage(this.kvStore, capId),
    );
    this.resolvedHttpHandlers = resolved.httpHandlers;
    return this.resolvedHttpHandlers;
  }

  private async matchHttpHandler(
    method: string,
    pathname: string,
  ): Promise<{
    handler: (request: Request, ctx: CapabilityHttpContext) => Promise<Response>;
    ctx: CapabilityHttpContext;
  } | null> {
    const handlers = this.resolveHttpHandlers();
    for (const h of handlers) {
      if (h.method === method && h.path === pathname) {
        const ctx: CapabilityHttpContext = {
          sessionStore: this.sessionStore,
          storage: h.storage,
          broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
          sendPrompt: (opts) => this.handleAgentPrompt(opts),
        };
        return { handler: h.handler, ctx };
      }
    }
    return null;
  }

  /**
   * Programmatic inference entry point for inter-agent communication.
   * Unlike handlePrompt(), this does NOT auto-name sessions, does NOT steer
   * on busy agents (rejects with error instead), and creates sessions with
   * source: "agent".
   */

  /**
   * Get a handle to a session's running agent for external control (e.g., abort).
   * Returns null if no agent is running for the session.
   */
  protected getSessionAgentHandle(
    sessionId: string,
  ): { abort: () => void; isStreaming: boolean } | null {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return null;
    return {
      abort: () => agent.abort(),
      isStreaming: agent.state.isStreaming,
    };
  }

  protected async handleAgentPrompt(opts: {
    text: string;
    sessionId?: string;
    sessionName?: string;
    source?: string;
  }): Promise<{ sessionId: string; response: string }> {
    const sessionId =
      opts.sessionId ??
      this.sessionStore.create({
        name: opts.sessionName ?? "Agent message",
        source: opts.source ?? "agent",
      }).id;

    // Reject if the session's agent is already busy
    const existingAgent = this.sessionAgents.get(sessionId);
    if (existingAgent?.state.isStreaming) {
      throw new Error("Agent is busy on this session");
    }

    // Persist user message
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: opts.text, timestamp: Date.now() },
    });

    // Create agent and run inference
    await this.ensureAgent(sessionId);
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) throw new Error("Agent failed to initialize");

    await agent.prompt(opts.text);
    await agent.waitForIdle();

    // Extract last assistant message text
    const messages = this.sessionStore.buildContext(sessionId);
    let response = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          response = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Content blocks from LLM: extract text from TextContent items
          response = (msg.content as Array<{ type?: string; text?: string }>)
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("");
        }
        break;
      }
    }

    return { sessionId, response };
  }

  // --- A2A Protocol ---

  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  private createA2AClientTools(sessionId: string): AgentTool<any>[] {
    const clientOpts = this.getA2AClientOptions();
    if (!clientOpts) return [];

    const storage = createCapabilityStorage(this.kvStore, "a2a-client");
    const getStorage = () => storage;
    const getSessionId = () => sessionId;

    const toolOpts: A2AToolOptions = {
      agentId: clientOpts.callbackAgentName ?? this.ctx.id.toString(),
      agentName: this.getPromptOptions().agentName,
      getAgentStub: clientOpts.getAgentStub,
      resolveDoId: clientOpts.resolveDoId,
      callbackBaseUrl: clientOpts.callbackBaseUrl ?? "https://agent",
      maxDepth: clientOpts.maxDepth ?? 5,
      authHeaders: clientOpts.authHeaders,
      broadcast: (name, data) =>
        this.broadcastToSession(sessionId, {
          type: "custom_event",
          sessionId,
          event: { name, data },
        }),
    };

    return [
      createCallAgentTool(toolOpts, getStorage, getSessionId),
      createStartTaskTool(toolOpts, getStorage, getSessionId),
      createCheckTaskTool(toolOpts, getStorage),
      createCancelTaskTool(toolOpts, getStorage),
    ];
  }

  /**
   * Build a fetch function that routes push notification callbacks through
   * DO stubs for same-platform agents. Falls back to global fetch for external URLs.
   *
   * The callback URL format is: `{baseUrl}/a2a-callback/{agentId}`
   * This extracts the agentId and uses getAgentStub to reach the target DO.
   */
  private buildA2AStubFetch():
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined {
    const clientOpts = this.getA2AClientOptions();
    if (!clientOpts) return undefined;

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // Match callback URLs with embedded agent ID: .../a2a-callback/{agentId}
      // The agentId here is whatever start_task embedded — pass directly to getAgentStub.
      // Do NOT use resolveDoId here (that's for outbound registry UUID resolution).
      const callbackMatch = url.match(/\/a2a-callback\/([^/?]+)/);
      if (callbackMatch) {
        const callbackAgentId = callbackMatch[1];
        const stub = clientOpts.getAgentStub(callbackAgentId);
        // Rewrite URL to the stub's perspective (strip the agent ID segment)
        const stubUrl = url.replace(`/a2a-callback/${callbackAgentId}`, "/a2a-callback");
        return stub.fetch(stubUrl, init);
      }

      // Fallback to global fetch for external URLs
      return fetch(input, init);
    };
  }

  private ensureA2AHandler(): { handler: A2AHandler; executor: ClawExecutor } {
    if (this.a2aHandler && this.a2aExecutor) {
      return { handler: this.a2aHandler, executor: this.a2aExecutor };
    }

    const promptOpts = this.getPromptOptions();
    const config = this.getConfig();

    this.a2aExecutor = new ClawExecutor({
      agentCardConfig: {
        name: promptOpts.agentName ?? "Agent",
        description: promptOpts.agentDescription ?? "An A2A-compatible agent.",
        url: config.a2a?.url ?? "",
        skills: promptOpts.agentSkills,
      },
      getSessionAgentHandle: (sid) => this.getSessionAgentHandle(sid),
    });

    this.a2aHandler = new A2AHandler({
      executor: this.a2aExecutor,
      taskStore: this.taskStore,
    });

    return { handler: this.a2aHandler, executor: this.a2aExecutor };
  }

  private async handleA2ARequest(request: Request, url: URL): Promise<Response | null> {
    const config = this.getConfig();

    // Agent Card
    if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      if (config.a2a?.discoverable === false) {
        return new Response("Not found", { status: 404 });
      }
      const { executor } = this.ensureA2AHandler();
      const card = executor.getAgentCard();
      return new Response(JSON.stringify(card), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "A2A-Version": "1.0",
        },
      });
    }

    // JSON-RPC endpoint
    if (request.method === "POST" && url.pathname === "/a2a") {
      if (config.a2a?.acceptMessages === false) {
        return new Response(JSON.stringify({ error: "A2A messages not accepted" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Version negotiation
      const a2aVersion = request.headers.get("A2A-Version") ?? "1.0";
      if (a2aVersion !== "1.0") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32009, message: `A2A version not supported: ${a2aVersion}` },
          }),
          { status: 400, headers: { "Content-Type": "application/json", "A2A-Version": "1.0" } },
        );
      }

      // Optional auth
      if (config.a2a?.authenticate) {
        const authResponse = await config.a2a.authenticate(request);
        if (authResponse) return authResponse;
      }

      const { handler, executor } = this.ensureA2AHandler();

      // Wire executor context for this request
      executor.setContext({
        sendPrompt: (opts) => this.handleAgentPrompt(opts),
        sessionStore: this.sessionStore,
        fetchFn: this.buildA2AStubFetch(),
      });

      // Parse and validate JSON-RPC
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const rpcRequest = body as { jsonrpc?: string; method?: string; id?: unknown };
      if (
        !rpcRequest ||
        rpcRequest.jsonrpc !== "2.0" ||
        !rpcRequest.method ||
        rpcRequest.id === undefined
      ) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid request" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC request is loosely typed from parsed body
      const result = await handler.handleRequest(rpcRequest as any);

      if (result instanceof ReadableStream) {
        return new Response(result, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "A2A-Version": "1.0",
          },
        });
      }

      if ("error" in result) {
        const { httpStatusForError } = await import("@claw-for-cloudflare/a2a");
        const status = httpStatusForError((result as { error: { code: number } }).error.code);
        return new Response(JSON.stringify(result), {
          status,
          headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      });
    }

    // A2A callback for push notifications (client side)
    // Matches /a2a-callback or /a2a-callback/{agentId}
    if (request.method === "POST" && url.pathname.startsWith("/a2a-callback")) {
      return this.handleA2ACallback(request);
    }

    return null;
  }

  private async handleA2ACallback(request: Request): Promise<Response> {
    const jsonHeaders = { "Content-Type": "application/json" };

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    // Extract task status update
    const update = body as {
      taskId?: string;
      status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
    };
    if (!update?.taskId || !update?.status) {
      return new Response(JSON.stringify({ error: "Missing taskId or status" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    // Look up pending task from client storage
    const storage = createCapabilityStorage(this.kvStore, "a2a-client");
    const pendingStore = new PendingTaskStore(storage);
    const pending = await pendingStore.get(update.taskId);
    if (!pending) {
      return new Response(JSON.stringify({ error: "Unknown task" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    // Verify webhook token
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${pending.webhookToken}`) {
      return new Response(JSON.stringify({ error: "Invalid webhook token" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    // Update pending task state
    const { isTerminalState } = await import("@claw-for-cloudflare/a2a");
    const state = update.status.state as string;
    await pendingStore.updateState(
      update.taskId,
      state as Parameters<typeof pendingStore.updateState>[1],
    );

    // Extract result text from the status message
    const resultParts = update.status.message?.parts ?? [];
    const resultTexts = resultParts
      .filter((p): p is { text: string } => typeof p.text === "string")
      .map((p) => p.text);

    const resultText =
      state === "completed"
        ? `[A2A Task Complete] Agent "${pending.targetAgentName}" finished.\nOriginal request: ${pending.originalRequest}\nResult: ${resultTexts.join("\n") || "No response text"}`
        : state === "failed"
          ? `[A2A Task Failed] Agent "${pending.targetAgentName}" failed.\nOriginal request: ${pending.originalRequest}\nError: ${resultTexts.join("\n") || "Unknown error"}`
          : `[A2A Task ${state}] Agent "${pending.targetAgentName}"\nOriginal request: ${pending.originalRequest}`;

    if (isTerminalState(state as "completed")) {
      // Check if agent is currently running
      const agent = this.sessionAgents.get(pending.originSessionId);
      const isStreaming = agent?.state.isStreaming ?? false;

      if (isStreaming) {
        // Agent is busy — steer the result in so it can respond about it.
        // handleSteer persists, broadcasts inject_message to clients, and steers.
        this.handleSteer(pending.originSessionId, resultText, true);
      } else {
        // Agent is idle — handleAgentPrompt will persist the message AND trigger inference.
        // Broadcast the note to clients before handleAgentPrompt persists + runs inference.
        // handleAgentPrompt will persist it, but the client needs to see it now.
        this.broadcastToSession(pending.originSessionId, {
          type: "inject_message",
          sessionId: pending.originSessionId,
          message: { role: "user", content: resultText, timestamp: Date.now() } as AgentMessage,
        });
        const op = this.handleAgentPrompt({
          text: resultText,
          sessionId: pending.originSessionId,
          source: "a2a-callback",
        })
          .catch((err) => console.error("[a2a] callback prompt failed:", err))
          .finally(() => this.pendingAsyncOps.delete(op));
        this.pendingAsyncOps.add(op);
        this.ctx.waitUntil(op);
      }

      // Clean up pending task
      await pendingStore.delete(update.taskId);
    }

    // Broadcast to WebSocket clients
    this.broadcastCustomToAll("a2a_task_update", {
      taskId: pending.taskId,
      targetAgent: pending.targetAgent,
      targetAgentName: pending.targetAgentName,
      state,
      originalRequest: pending.originalRequest,
      resultText: isTerminalState(state as "completed") ? resultText : undefined,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  // --- HTTP fallback ---

  private async handleHttpPrompt(request: Request): Promise<Response> {
    const body = (await request.json()) as { sessionId?: string; text: string };
    const sessionId =
      body.sessionId ?? this.sessionStore.list()[0]?.id ?? this.sessionStore.create().id;

    await this.handlePrompt(sessionId, body.text);

    // Wait for this session's agent to finish
    await this.sessionAgents.get(sessionId)?.waitForIdle();

    const messages = this.sessionStore.buildContext(sessionId);
    return new Response(JSON.stringify({ messages }), {
      headers: { "content-type": "application/json" },
    });
  }

  private async handleMcpCallback(_request: Request): Promise<Response> {
    // TODO: Implement OAuth callback handling
    return new Response("OK");
  }

  // --- Client request/response ---

  /**
   * Send a custom event to a session's connected clients and await a response.
   * The first client to reply resolves the promise.
   */
  private requestFromClient(
    sessionId: string,
    eventName: string,
    eventData: Record<string, unknown>,
    timeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(requestId);
        reject(new Error(`Client request "${eventName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingClientRequests.set(requestId, { resolve, timer });

      // Broadcast a custom_event with _requestId so the client knows to respond
      this.broadcastToSession(sessionId, {
        type: "custom_event",
        sessionId,
        event: {
          name: eventName,
          data: { ...eventData, _requestId: requestId },
        },
      });
    });
  }

  // --- Broadcasting ---

  protected broadcastToSession(sessionId: string, msg: ServerMessage): void {
    this.transport.broadcastToSession(sessionId, msg);
  }

  protected broadcastCustomToAll(name: string, data: Record<string, unknown>): void {
    for (const connection of this.transport.getConnections()) {
      connection.send({
        type: "custom_event",
        sessionId: connection.getSessionId(),
        event: { name, data },
      });
    }
  }

  private broadcastScheduleList(): void {
    const schedules = this.scheduleStore.list().filter((s) => s.ownerId === null);
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
    this.transport.broadcast(msg);
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
    this.transport.broadcast(msg);
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
    this.transport.broadcast(msg);
  }

  private sendCommandList(connection: TransportConnection, sessionId: string): void {
    const commands = this.resolveCommands(sessionId);
    connection.send({
      type: "command_list",
      commands: Array.from(commands.values()).map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
      })),
    });
  }

  private sendSessionList(connection: TransportConnection): void {
    const sessions = this.sessionStore.list();
    connection.send({
      type: "session_list",
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        source: s.source,
        updatedAt: s.updatedAt,
      })),
    });
  }
}

export type { CompactionCfg as CompactionConfig };
