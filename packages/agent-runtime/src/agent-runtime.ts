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
import type { AgentEvent, AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type { AssistantMessage, Message, Model } from "@claw-for-cloudflare/ai";
import type { TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { extractFinalAssistantText, matchPathPattern } from "./agent-runtime-helpers.js";
import type { ResolvedCapabilities } from "./capabilities/resolve.js";
import { resolveCapabilities } from "./capabilities/resolve.js";
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
import { isRuntimeError } from "./errors/runtime-error.js";
import { McpManager } from "./mcp/mcp-manager.js";
import {
  buildDefaultSystemPromptSections,
  estimateTextTokens,
  toPromptString,
} from "./prompt/build-system-prompt.js";
import { buildToolPromptSections } from "./prompt/tool-sections.js";
import type { PromptOptions, PromptSection } from "./prompt/types.js";
import { QueueStore } from "./queue/queue-store.js";
import { SlidingWindowRateLimiter } from "./rate-limit/sliding-window.js";
import type { RateLimiter } from "./rate-limit/types.js";
import type { RuntimeContext } from "./runtime-context.js";
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
import type { KvStore, SqlStore } from "./storage/types.js";
import { applyDefaultTimeout } from "./tools/define-tool.js";
import { ErrorCodes } from "./transport/error-codes.js";
import type { Transport, TransportConnection } from "./transport/transport.js";
import type {
  CapabilityActionMessage,
  CapabilityStateMessage,
  ClientMessage,
  ServerMessage,
} from "./transport/types.js";

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

/** Options for constructing A2A client tools (used by getA2AClientOptions). */
export interface A2AClientOptions {
  getAgentStub: (id: string) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  /** Resolve a registry UUID or friendly name to the DO identifier used by getAgentStub. */
  resolveDoId?: (id: string) => string;
  /**
   * The name other agents can pass to getAgentStub to reach THIS agent.
   * Used in push notification callback URLs so the receiving agent can
   * route back via the stub. If not set, falls back to the runtime agent id.
   */
  callbackAgentName?: string;
  callbackBaseUrl?: string;
  maxDepth?: number;
  authHeaders?: (target: string) => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * Deep-equal check for capability-mapped config slices. JSON stringify
 * is sufficient — mapped slices are serializable-shaped data (no
 * functions, no cyclic refs). Order-sensitive by design: reshuffling
 * object key order should not be considered a meaningful change, so
 * callers that need that guarantee should produce stable output from
 * their mapping function.
 */
function sliceEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
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

/**
 * Coerce a public URL value into a trimmed, trailing-slash-free string, or
 * undefined. Accepts whatever consumers might hand in (raw env var, explicit
 * override, empty string) and normalizes once so downstream capabilities can
 * treat the value as a ready-to-concatenate base URL.
 */
function normalizePublicUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/\/$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A subagent profile defines the configuration for a child agent.
 * Defined here to avoid a circular dependency between agent-runtime and subagent packages.
 * The full SubagentProfile type in @claw-for-cloudflare/subagent extends this.
 */
export interface SubagentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | ((parentPrompt: string) => string);
  tools?: string[];
  model?: string;
}

export interface AgentContext {
  /** The unique identifier of the agent (platform-agnostic; hex string on Cloudflare DOs). */
  agentId: string;
  /**
   * Public base URL of the agent's host worker, if configured. Sourced from
   * `env.PUBLIC_URL` (or an explicit `AgentDefinition.publicUrl` override)
   * at runtime construction time. Undefined when unset. Capabilities that
   * need to register external webhooks or emit absolute URLs should read
   * this rather than accepting their own `publicUrl` option.
   */
  publicUrl?: string;
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
  /** Persistent key-value storage scoped to this capability. */
  storage: import("./capabilities/storage.js").CapabilityStorage;
  /**
   * Broadcast capability state to connected clients.
   * Emits a `capability_state` message with this capability's ID.
   * @param event Event name (e.g., "sync", "update", "remove")
   * @param data Payload
   * @param scope "session" (default) or "global"
   */
  broadcastState: (event: string, data: unknown, scope?: "session" | "global") => void;
  /** Manage prompt-based schedules and one-shot timers. */
  schedules: ScheduleManager;
  /**
   * Shared runtime rate limiter. Exposed on every `AgentContext` so that
   * any capability (not just channels) can apply atomic sliding-window
   * limits without implementing its own counters. The runtime holds a
   * single shared instance backed by the DO's SQL store.
   */
  rateLimit: RateLimiter;
  /**
   * Capability's mapped slice of the agent-level config, produced by the
   * capability's `agentConfigMapping` function against the current
   * `defineAgent`-declared agent config. Typed as `unknown` at the runtime
   * boundary — each capability narrows to the slice it requested via its
   * mapping function. `undefined` when the capability supplied no mapping
   * or the agent declared no `config`.
   */
  agentConfig?: unknown;
}

/**
 * Logger interface for runtime observability.
 *
 * Defaults to a no-op logger; the {@link defineAgent} factory and consumers
 * extending {@link AgentRuntime} may wire in a real implementation.
 */
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Source of an error surfaced to the onError boundary. */
export type ErrorSource = "tool" | "inference" | "hook" | "http";

/** Metadata passed to an onError handler. */
export interface ErrorInfo {
  source: ErrorSource;
  sessionId?: string;
  toolName?: string;
}

/**
 * Optional runtime configuration injected via the {@link defineAgent} factory
 * or supplied directly to {@link AgentRuntime} subclasses.
 */
export interface AgentRuntimeOptions {
  logger?: Logger;
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * Optional pre-routing HTTP handler. Called before the runtime's default
   * routing in {@link AgentRuntime.handleRequest}. Returning `null` falls
   * through to the default routing; returning a Response short-circuits it.
   */
  fetch?: (request: Request) => Promise<Response | null> | Response | null;
  /**
   * Public base URL of the agent's host worker. Surfaced on every
   * {@link AgentContext}, {@link CapabilityHookContext}, and
   * {@link CapabilityHttpContext} so capabilities that need to register
   * external webhooks (channels, A2A callbacks) can read it without
   * demanding their own option.
   *
   * Normally sourced from `env.PUBLIC_URL` by {@link defineAgent}. Subclasses
   * of {@link AgentRuntime} may pass an explicit value here instead.
   */
  publicUrl?: string;
}

/**
 * Platform-agnostic agent runtime. Contains all business logic (session
 * management, LLM loop, capabilities, scheduling, A2A, HTTP routing) behind
 * abstract platform adapters ({@link SqlStore}, {@link KvStore},
 * {@link Scheduler}, {@link Transport}, {@link RuntimeContext}).
 *
 * Subclasses (or the {@link createDelegatingRuntime} helper) implement the
 * abstract `getConfig()` / `getTools()` methods and may override the
 * optional `get*` hooks to customize behavior.
 */
export abstract class AgentRuntime<TEnv = Record<string, unknown>> {
  /** Maximum client messages allowed per rate limit window. */
  private static readonly RATE_LIMIT_MAX = 30;
  /** Rate limit sliding window duration in milliseconds. */
  private static readonly RATE_LIMIT_WINDOW_MS = 10_000;
  /** Dummy cron expression used for timer schedules (never evaluated). */
  private static readonly TIMER_DUMMY_CRON = "0 0 1 1 *";
  private static readonly MAX_SESSION_NAME_LENGTH = 50;
  private static readonly VALID_CLIENT_MESSAGE_TYPES = new Set([
    "prompt",
    "steer",
    "abort",
    "switch_session",
    "new_session",
    "delete_session",
    "command",
    "request_sync",
    "custom_response",
    "request_system_prompt",
    "capability_action",
    "ping",
  ]);

  readonly env: TEnv;
  readonly runtimeContext: RuntimeContext;
  readonly sqlStore: SqlStore;
  readonly kvStore: KvStore;
  readonly scheduler: Scheduler;
  readonly transport: Transport;
  /**
   * Public base URL of the agent's host worker, if configured. See
   * {@link AgentRuntimeOptions.publicUrl} for semantics. Propagated to
   * every `AgentContext` / `CapabilityHookContext` / `CapabilityHttpContext`
   * constructed by the runtime.
   */
  readonly publicUrl?: string;
  logger: Logger;
  onError?: (error: Error, info: ErrorInfo) => void;
  preFetchHandler?: AgentRuntimeOptions["fetch"];

  sessionStore: SessionStore;
  scheduleStore: ScheduleStore;
  configStore: ConfigStore;
  mcpManager: McpManager;
  taskStore: TaskStore;
  queueStore: QueueStore;
  /**
   * Shared runtime rate limiter. Constructed once per `AgentRuntime` and
   * passed into every `AgentContext` / `CapabilityHttpContext` construction
   * site. Backed by the runtime's SQL store; atomic under DO single-threaded
   * execution (see {@link SlidingWindowRateLimiter}).
   */
  rateLimiter: RateLimiter;

  /** Per-session agent instances. Present only while inference is active, cleaned up on agent_end. */
  // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - types unavailable at import time
  sessionAgents = new Map<string, any>();
  beforeInferenceHooks: ResolvedCapabilities["beforeInferenceHooks"] = [];
  beforeToolExecutionHooks: ResolvedCapabilities["beforeToolExecutionHooks"] = [];
  afterToolExecutionHooks: ResolvedCapabilities["afterToolExecutionHooks"] = [];
  capabilityDisposers: ResolvedCapabilities["disposers"] = [];
  scheduleCallbacks = new Map<string, (ctx: ScheduleCallbackContext) => Promise<void>>();
  /** Maps timer IDs to their owning capability ID (set during syncCapabilitySchedules). */
  timerOwners = new Map<string, string>();
  /** Cached resolved capabilities — populated in ensureAgent, cleared on agent_end. */
  resolvedCapabilitiesCache: ResolvedCapabilities | null = null;
  /** Cached result of getCapabilities() — cleared alongside resolvedCapabilitiesCache. */
  capabilitiesCache: Capability[] | null = null;
  /** Tracked fire-and-forget async operations (e.g., callback-triggered prompts). */
  pendingAsyncOps = new Set<Promise<unknown>>();

  connectionRateLimits = new Map<string, { count: number; windowStart: number }>();
  /** Cached A2A handler — lazily created on first A2A request. */
  private a2aHandler: A2AHandler | null = null;
  private a2aExecutor: ClawExecutor | null = null;
  /** Pending client request/response round-trips (requestId -> resolver). */
  private pendingClientRequests = new Map<
    string,
    { resolve: (data: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Cache for resolved HTTP handlers (lazily populated on first HTTP request). */
  private resolvedHttpHandlers: ResolvedCapabilities["httpHandlers"] | null = null;

  constructor(
    sqlStore: SqlStore,
    kvStore: KvStore,
    scheduler: Scheduler,
    transport: Transport,
    runtimeContext: RuntimeContext,
    env: TEnv,
    options: AgentRuntimeOptions = {},
  ) {
    this.sqlStore = sqlStore;
    this.kvStore = kvStore;
    this.scheduler = scheduler;
    this.transport = transport;
    this.runtimeContext = runtimeContext;
    this.env = env;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.onError = options.onError;
    this.preFetchHandler = options.fetch;
    this.publicUrl = normalizePublicUrl(options.publicUrl);

    this.sessionStore = new SessionStore(sqlStore);
    this.taskStore = new TaskStore(sqlStore);
    this.scheduleStore = new ScheduleStore(sqlStore);
    this.queueStore = new QueueStore(sqlStore);
    this.configStore = new ConfigStore(this.kvStore);
    this.mcpManager = new McpManager(sqlStore, () => this.broadcastMcpStatus());
    this.rateLimiter = new SlidingWindowRateLimiter(sqlStore);

    this.transport.onOpen((connection) => this.handleTransportOpen(connection));
    this.transport.onMessage((connection, data) => this.handleTransportMessage(connection, data));
    this.transport.onClose((connection) => this.handleTransportClose(connection));
  }

  // --- Abstract methods (consumers implement these) ---

  abstract getConfig(): AgentConfig;
  abstract getTools(context: AgentContext): AnyAgentTool[];

  /**
   * Build the **base** system prompt for this agent as structured sections.
   * Default implementation composes identity, safety, and runtime sections
   * from {@link getPromptOptions}. Tool sections and capability prompt
   * sections are appended automatically by the runtime after this.
   *
   * Override this method to customize the base sections with full metadata:
   * each section is tagged with a `source` and may declare itself
   * `included: false` with an `excludedReason` so the inspection UI can
   * surface conditional opt-outs.
   */
  buildSystemPromptSections(_context: AgentContext): PromptSection[] {
    return buildDefaultSystemPromptSections(this.getPromptOptions());
  }

  /**
   * Build the base system prompt as a string.
   *
   * @deprecated Prefer overriding {@link buildSystemPromptSections}. This
   * method is kept for back-compat: consumers who previously returned a
   * plain string get their output wrapped in a single "custom" section in
   * the inspection panel. When both methods are overridden,
   * `buildSystemPromptSections` wins.
   */
  buildSystemPrompt(context: AgentContext): string {
    return toPromptString(this.buildSystemPromptSections(context));
  }

  /**
   * Override to customize the default prompt sections without replacing
   * the entire system prompt. Configure agent name, timezone, safety, etc.
   */
  getPromptOptions(): PromptOptions {
    return {};
  }

  /**
   * Override to register capabilities. Capabilities contribute tools,
   * commands, prompt sections, MCP servers, and lifecycle hooks.
   */
  getCapabilities(): Capability[] {
    return [];
  }

  /** Returns cached getCapabilities() result. Cache is cleared on agent_end. */
  getCachedCapabilities(): Capability[] {
    if (!this.capabilitiesCache) {
      this.capabilitiesCache = this.getCapabilities();
    }
    return this.capabilitiesCache;
  }

  /** Returns the IDs of all registered capabilities. */
  private getCapabilityIds(): string[] {
    return this.getCachedCapabilities().map((c) => c.id);
  }

  /**
   * Override to register subagent profiles.
   */
  getSubagentProfiles(): SubagentProfile[] {
    return [];
  }

  /**
   * Override to register consumer config namespaces.
   */
  getConfigNamespaces(): ConfigNamespace[] {
    return [];
  }

  /**
   * Override (or populated via `defineAgent`'s `config` field) to declare
   * an agent-level config schema. Each top-level key in the returned
   * record is a namespace the agent can read/write through the config
   * tools. Defaults to empty.
   */
  getAgentConfigSchema(): Record<string, TObject> {
    return {};
  }

  /**
   * Cached agent-level config schema. Populated lazily on first access
   * and treated as stable for the lifetime of the runtime instance
   * (schemas are declarative).
   */
  private cachedAgentConfigSchema: Record<string, TObject> | null = null;

  getCachedAgentConfigSchema(): Record<string, TObject> {
    if (!this.cachedAgentConfigSchema) {
      this.cachedAgentConfigSchema = this.getAgentConfigSchema();
    }
    return this.cachedAgentConfigSchema;
  }

  /**
   * Current agent-level config snapshot: a flat record of
   * namespace → value. Populated by {@link ensureAgentConfigLoaded} and
   * mutated in place when `config_set` writes an agent-level namespace,
   * so resolveCapabilities always sees the latest values.
   */
  agentConfigSnapshot: Record<string, unknown> = {};
  private agentConfigLoaded = false;

  /**
   * Load the agent-level config snapshot from `ConfigStore`, filling
   * defaults from `Value.Create(schema)` for namespaces with no
   * persisted value. Idempotent — subsequent calls are no-ops once the
   * snapshot is loaded.
   */
  /**
   * React to a successful `config_set` on an agent-level namespace.
   * Fires `onAgentConfigChange` on every capability whose
   * `agentConfigMapping` produces a different slice than before, and
   * broadcasts the update to connected clients as a
   * `capability_state { capabilityId: "agent-config", event: "update" }`
   * message.
   *
   * `ctxSessionId` is the session that triggered the write. When the
   * capability change dispatch runs, each hook's context is filled with
   * that session so capabilities can broadcast to the caller.
   */
  /**
   * Apply an agent-level config write originating from the UI
   * (`capability_action { capabilityId: "agent-config", action: "set" }`).
   * Validates against the declared schema, persists to ConfigStore,
   * updates the in-memory snapshot, and delegates to
   * {@link handleAgentConfigSet} for hook dispatch + broadcast.
   *
   * Returns an error string on validation failure so the caller (the
   * runtime's capability_action dispatcher) can log it; UI originators
   * don't see a synchronous error today, matching how other
   * capability_action handlers behave.
   */
  private async applyAgentConfigSet(
    namespace: string,
    value: unknown,
    sessionId: string,
  ): Promise<string | null> {
    const schema = this.getCachedAgentConfigSchema()[namespace];
    if (!schema) {
      const msg = `Unknown agent-level config namespace: ${namespace}`;
      this.logger.warn(`[AgentRuntime] ${msg}`);
      return msg;
    }
    if (!Value.Check(schema, value)) {
      const msg = `Invalid agent config payload for namespace "${namespace}"`;
      this.logger.warn(`[AgentRuntime] ${msg}`);
      return msg;
    }
    await this.ensureAgentConfigLoaded();
    const oldValue =
      this.agentConfigSnapshot[namespace] !== undefined
        ? this.agentConfigSnapshot[namespace]
        : Value.Create(schema);
    await this.configStore.setAgentConfig(namespace, value);
    this.agentConfigSnapshot[namespace] = value;
    await this.handleAgentConfigSet(namespace, oldValue, value, sessionId);
    return null;
  }

  async handleAgentConfigSet(
    namespace: string,
    _oldValue: unknown,
    newValue: unknown,
    ctxSessionId: string,
  ): Promise<void> {
    // Snapshot was already updated in place by config_set before this
    // fires, so capability mappings see the new value.
    const capabilities = this.getCachedCapabilities();
    for (const cap of capabilities) {
      if (!cap.agentConfigMapping || !cap.hooks?.onAgentConfigChange) continue;
      // Compute old slice against a snapshot where this namespace holds
      // the previous value. Clone shallowly and overwrite the one key
      // so the mapping function sees the pre-change state.
      const priorSnapshot: Record<string, unknown> = { ...this.agentConfigSnapshot };
      priorSnapshot[namespace] = _oldValue;
      const oldSlice = cap.agentConfigMapping(priorSnapshot);
      const newSlice = cap.agentConfigMapping(this.agentConfigSnapshot);
      if (sliceEqual(oldSlice, newSlice)) continue;
      const hookContext: CapabilityHookContext = {
        agentId: this.runtimeContext.agentId,
        publicUrl: this.publicUrl,
        sessionId: ctxSessionId,
        sessionStore: this.sessionStore,
        storage: createCapabilityStorage(this.kvStore, cap.id),
        capabilityIds: capabilities.map((c) => c.id),
        broadcastState: this.createCapabilityBroadcastState(cap.id, ctxSessionId),
      };
      try {
        await cap.hooks.onAgentConfigChange(oldSlice, newSlice, hookContext);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[AgentRuntime] onAgentConfigChange hook error", {
          capabilityId: cap.id,
          message: error.message,
        });
        this.onError?.(error, { source: "hook", sessionId: ctxSessionId });
      }
    }

    // Re-sync capability schedules in case heartbeat-style capabilities
    // reshape a cron on change. Cheap when nothing changed.
    if (this.resolvedCapabilitiesCache?.schedules?.length) {
      await this.syncCapabilitySchedules(this.resolvedCapabilitiesCache.schedules);
    }

    // Broadcast the update to connected clients.
    this.broadcastCoreState(
      "agent-config",
      "update",
      { namespace, value: newValue },
      "global",
    );
  }

  async ensureAgentConfigLoaded(): Promise<void> {
    if (this.agentConfigLoaded) return;
    const schema = this.getCachedAgentConfigSchema();
    for (const [namespace, nsSchema] of Object.entries(schema)) {
      const stored = await this.configStore.getAgentConfig(namespace);
      this.agentConfigSnapshot[namespace] =
        stored !== undefined ? stored : Value.Create(nsSchema);
    }
    this.agentConfigLoaded = true;
  }

  /**
   * Override to configure how this agent calls other A2A agents.
   */
  getA2AClientOptions(): A2AClientOptions | null {
    return null;
  }

  /**
   * Override to register slash commands.
   */
  getCommands(_context: CommandContext): Command[] {
    return [];
  }

  // --- Optional lifecycle hooks ---

  /**
   * Override to validate authentication before accepting a WebSocket connection
   * or HTTP prompt. Return `true` to allow, `false` to reject with 401.
   */
  validateAuth?(request: Request): Promise<boolean> | boolean;
  onTurnEnd?(messages: AgentMessage[], toolResults: unknown[]): void | Promise<void>;
  onAgentEnd?(messages: AgentMessage[]): void | Promise<void>;
  onSessionCreated?(session: { id: string; name: string }): void | Promise<void>;
  /**
   * Called before a schedule fires. Return `{ skip: true }` to prevent execution,
   * or `{ prompt: "..." }` to override the prompt for prompt-based schedules.
   */
  onScheduleFire?(schedule: Schedule): Promise<{ skip?: boolean; prompt?: string } | undefined>;

  /**
   * Override to inject custom Agent options (e.g., mock streamFn for testing).
   */
  getAgentOptions(): Record<string, unknown> {
    return {};
  }

  /** Build a ScheduleManager that delegates to the protected methods. */
  buildScheduleManager(): ScheduleManager {
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
      cron: AgentRuntime.TIMER_DUMMY_CRON,
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

  // --- Schedule management ---

  async createSchedule(config: PromptScheduleConfig): Promise<Schedule> {
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

  async updateSchedule(
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

  async deleteSchedule(id: string): Promise<void> {
    const guard = this.scheduleStore.get(id);
    if (guard?.ownerId !== undefined && guard.ownerId !== null) return;

    this.scheduleStore.delete(id);
    this.scheduleCallbacks.delete(id);
    await this.refreshAlarm();
  }

  listSchedules(): Schedule[] {
    return this.scheduleStore.list().filter((s) => s.ownerId === null);
  }

  // --- Public entry points ---

  /**
   * Main HTTP entry point. Platform shells (e.g. `AgentDO.fetch`) delegate here.
   */
  async handleRequest(request: Request): Promise<Response> {
    try {
      // Pre-routing handler (from defineAgent's definition.fetch)
      if (this.preFetchHandler) {
        const early = await this.preFetchHandler(request);
        if (early) return early;
      }

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
              return new Response(
                JSON.stringify({ error: "name, cron, and prompt are required" }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              );
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
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Also log to console — the default logger is a noop, so without this
      // the error vanishes entirely and callers see a bare 500 with no clue.
      console.error("[AgentRuntime] handleRequest error:", error.stack ?? error.message);
      this.logger.error("[AgentRuntime] handleRequest error", { message: error.message });
      this.onError?.(error, { source: "http" });
      return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
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

    this.sendSessionList(connection);
    this.sendCommandList(connection, sessionId);
    this.broadcastScheduleList();
    this.broadcastQueueState(sessionId);

    this.fireOnConnectHooks(sessionId).catch((err) => {
      this.logger.error("[AgentRuntime] onConnect hooks error", { message: String(err) });
    });
  }

  private handleTransportMessage(connection: TransportConnection, data: string): void {
    const wasRecovery = connection.wasRestoredFromHibernation;
    if (wasRecovery) {
      connection.wasRestoredFromHibernation = false;
      this.fireOnConnectHooks(connection.getSessionId()).catch((err) => {
        this.logger.error("[AgentRuntime] onConnect hooks error (reconnect)", {
          message: String(err),
        });
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
    if (msg.type !== "ping" && msg.type !== "request_sync") {
      const now = Date.now();
      let rateLimit = this.connectionRateLimits.get(connection.id);
      if (!rateLimit || now - rateLimit.windowStart > AgentRuntime.RATE_LIMIT_WINDOW_MS) {
        rateLimit = { count: 0, windowStart: now };
        this.connectionRateLimits.set(connection.id, rateLimit);
      }
      rateLimit.count++;
      if (rateLimit.count > AgentRuntime.RATE_LIMIT_MAX) {
        connection.send({
          type: "error",
          code: ErrorCodes.RATE_LIMITED,
          message: "Too many messages — slow down",
        });
        return;
      }
    }

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
        // Re-send global capability state that session_sync clears on the client.
        this.sendCommandList(connection, sessionId);
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

  private handleTransportClose(connection: TransportConnection): void {
    this.connectionRateLimits.delete(connection.id);

    const remaining = [...this.transport.getConnections()];
    if (remaining.length === 0) {
      this.disposeCapabilities();
    }
  }

  /** Returns an error string if the message is invalid, or null if valid. */
  private validateClientMessage(msg: unknown): string | null {
    if (typeof msg !== "object" || msg === null) {
      return "Message must be an object";
    }

    const obj = msg as Record<string, unknown>;

    if (typeof obj.type !== "string" || !AgentRuntime.VALID_CLIENT_MESSAGE_TYPES.has(obj.type)) {
      return `Unknown message type: ${String(obj.type)}`;
    }

    if ((obj.type === "prompt" || obj.type === "steer") && typeof obj.text !== "string") {
      return `"${obj.type}" message requires a "text" string field`;
    }

    if (obj.type === "switch_session" && typeof obj.sessionId !== "string") {
      return '"switch_session" message requires a "sessionId" string field';
    }

    if (
      obj.type === "capability_action" &&
      (typeof obj.capabilityId !== "string" ||
        typeof obj.action !== "string" ||
        typeof obj.sessionId !== "string")
    ) {
      return '"capability_action" message requires "capabilityId", "action", and "sessionId" string fields';
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
          // Re-send global capability state that session_sync clears on the client.
          this.sendCommandList(connection, msg.sessionId);
        }

        this.fireOnConnectHooks(msg.sessionId).catch((err) => {
          this.logger.error("[AgentRuntime] onConnect hooks error (session switch)", {
            message: String(err),
          });
        });
        this.broadcastQueueState(msg.sessionId);
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
        // Re-send global capability state that session_sync clears on the client.
        this.sendCommandList(connection, session.id);
        this.broadcastSessionList();

        this.fireOnConnectHooks(session.id).catch((err) => {
          this.logger.error("[AgentRuntime] onConnect hooks error (new session)", {
            message: String(err),
          });
        });
        break;
      }

      case "delete_session": {
        const allSessions = this.sessionStore.list();
        if (allSessions.length <= 1) break;

        this.sessionAgents.get(msg.sessionId)?.abort();

        const affectedConnections = [...this.transport.getConnectionsForSession(msg.sessionId)];

        this.queueStore.deleteAll(msg.sessionId);
        this.sessionStore.delete(msg.sessionId);

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
              // Re-send global capability state that session_sync clears on the client.
              this.sendCommandList(conn, target.id);
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
        const raw = toPromptString(sections);
        connection.send({ type: "system_prompt", sections, raw } as ServerMessage);
        break;
      }

      case "capability_action": {
        await this.handleCapabilityAction(msg);
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
   * Delegates to {@link assembleAllSections} with a fresh inspection context
   * so that the inspection panel always matches what inference would see
   * (modulo session-state-dependent capability state).
   */
  private getSystemPromptSections(): PromptSection[] {
    const context = this.createInspectionContext();
    const capabilities = this.getCachedCapabilities();
    const resolved = resolveCapabilities(
      capabilities,
      context,
      undefined,
      undefined,
      this.agentConfigSnapshot,
    );
    return this.assembleAllSections(context, capabilities, resolved);
  }

  /**
   * Collect the exact tool list used at inference time. Shared between
   * inference (`ensureAgent`) and inspection (`getSystemPromptSections`) to
   * guarantee the inspection panel's tool section matches the tool list the
   * LLM actually sees.
   *
   * Returned tools are pre-timeout-wrapping: callers who need timeouts (the
   * inference path) should apply {@link applyDefaultTimeout} themselves.
   */
  private collectAllTools(
    context: AgentContext,
    capabilities: Capability[],
    resolved: ResolvedCapabilities,
  ): AnyAgentTool[] {
    const baseTools = this.getTools(context);
    const capabilityNamespaces = capabilities.flatMap(
      (cap) => cap.configNamespaces?.(context) ?? [],
    );
    const consumerNamespaces = this.getConfigNamespaces();
    const configContext = {
      agentId: this.runtimeContext.agentId,
      publicUrl: this.publicUrl,
      sessionId: context.sessionId,
      sessionStore: this.sessionStore,
      configStore: this.configStore,
      capabilities,
      namespaces: [...capabilityNamespaces, ...consumerNamespaces],
      agentConfigSchema: this.getCachedAgentConfigSchema(),
      agentConfigSnapshot: this.agentConfigSnapshot,
      onAgentConfigSet: (namespace: string, oldValue: unknown, newValue: unknown) =>
        this.handleAgentConfigSet(namespace, oldValue, newValue, context.sessionId),
    };
    const configTools = [
      createConfigGet(configContext),
      createConfigSet(configContext),
      createConfigSchema(configContext),
    ];
    const a2aClientTools = this.createA2AClientTools(context.sessionId);
    return [...baseTools, ...configTools, ...a2aClientTools, ...resolved.tools];
  }

  /**
   * Resolve the **base** prompt sections (identity / safety / runtime /
   * additional / custom override). Prefers the section-returning override
   * when provided; falls back to wrapping the legacy string-returning
   * `buildSystemPrompt()` in a single "custom" section when it was
   * independently overridden.
   */
  private resolveBaseSections(context: AgentContext): PromptSection[] {
    const sections = this.buildSystemPromptSections(context);
    const sectionsAsString = toPromptString(sections);
    const legacyString = this.buildSystemPrompt(context);
    // If the legacy string method was overridden independently of
    // buildSystemPromptSections, the two will disagree. Wrap the legacy
    // output as a single "custom" section so the inspection panel can
    // still attribute it. Consumers who override both methods should only
    // override one — in that case the sections method takes precedence when
    // the string output happens to match.
    if (legacyString !== sectionsAsString) {
      return [
        {
          name: "System Prompt",
          key: "custom",
          content: legacyString,
          lines: legacyString.split("\n").length,
          tokens: estimateTextTokens(legacyString),
          source: { type: "custom" },
          included: true,
        },
      ];
    }
    return sections;
  }

  /**
   * Assemble the full prompt section list used for inference and inspection.
   *
   * Section order: base (identity/safety/runtime/additional/custom) →
   * tool sections → capability sections. This ordering matches the on-wire
   * system prompt the LLM actually receives.
   */
  private assembleAllSections(
    context: AgentContext,
    capabilities: Capability[],
    resolved: ResolvedCapabilities,
  ): PromptSection[] {
    const baseSections = this.resolveBaseSections(context);
    const allTools = this.collectAllTools(context, capabilities, resolved);
    const toolSections = buildToolPromptSections(allTools);
    return [...baseSections, ...toolSections, ...resolved.promptSections];
  }

  /** Create a minimal AgentContext for prompt inspection (no active session). */
  private createInspectionContext(): AgentContext {
    return {
      agentId: this.runtimeContext.agentId,
      publicUrl: this.publicUrl,
      sessionId: "__inspection__",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available during inspection")),
      storage: createNoopStorage(),
      broadcastState: () => {},
      schedules: this.buildScheduleManager(),
      rateLimit: this.rateLimiter,
    };
  }

  // --- Capability action routing ---

  private async handleCapabilityAction(msg: CapabilityActionMessage): Promise<void> {
    const { capabilityId, action, data, sessionId } = msg;

    const resolved = this.resolvedCapabilitiesCache;
    if (resolved?.onActionHandlers.has(capabilityId)) {
      const handler = resolved.onActionHandlers.get(capabilityId)!;
      const hookCtx: CapabilityHookContext = {
        agentId: this.runtimeContext.agentId,
        publicUrl: this.publicUrl,
        sessionId,
        sessionStore: this.sessionStore,
        storage: createNoopStorage(),
        capabilityIds: this.getCachedCapabilities().map((c) => c.id),
      };
      await handler(action, data, hookCtx);
      return;
    }

    switch (capabilityId) {
      case "agent-config": {
        if (action === "set") {
          const { namespace, value } = data as { namespace: string; value: unknown };
          await this.applyAgentConfigSet(namespace, value, sessionId);
        }
        break;
      }
      case "schedules": {
        if (action === "toggle") {
          const { scheduleId, enabled } = data as { scheduleId: string; enabled: boolean };
          await this.updateSchedule(scheduleId, { enabled });
        }
        break;
      }
      case "queue": {
        if (action === "message") {
          const { text } = data as { text: string };
          const queueAgent = this.sessionAgents.get(sessionId);
          if (!queueAgent?.state.isStreaming) {
            await this.handlePrompt(sessionId, text);
          } else {
            this.queueStore.enqueue(sessionId, text);
            this.broadcastQueueState(sessionId);
          }
        } else if (action === "delete") {
          const { queueId } = data as { queueId: string };
          this.queueStore.delete(queueId);
          this.broadcastQueueState(sessionId);
        } else if (action === "steer") {
          const { queueId } = data as { queueId: string };
          const queueItem = this.queueStore.get(queueId);
          if (queueItem) {
            this.queueStore.delete(queueId);
            this.handleSteer(sessionId, queueItem.text);
            this.broadcastQueueState(sessionId);
          }
        }
        break;
      }
      default: {
        this.logger.warn(
          `[AgentRuntime] No handler for capability_action capabilityId="${capabilityId}"`,
        );
      }
    }
  }

  // --- Agent loop ---

  async handlePrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessionStore.get(sessionId);
    if (session && !session.name) {
      const name =
        text.length > AgentRuntime.MAX_SESSION_NAME_LENGTH
          ? `${text.slice(0, AgentRuntime.MAX_SESSION_NAME_LENGTH)}...`
          : text;
      this.sessionStore.rename(sessionId, name);
      this.broadcastSessionList();
    }

    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp: Date.now() },
    });

    const existingAgent = this.sessionAgents.get(sessionId);
    if (existingAgent?.state.isStreaming) {
      this.queueStore.enqueue(sessionId, text);
      this.broadcastQueueState(sessionId);
      return;
    }

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
      this.logger.error("[AgentRuntime] prompt failed", { message });
      const error = err instanceof Error ? err : new Error(message);
      this.onError?.(error, { source: "inference", sessionId });
      this.broadcastToSession(sessionId, {
        type: "error",
        code,
        message: `Agent error: ${message}`,
      });
    }
  }

  handleSteer(sessionId: string, text: string, broadcast = false): void {
    const timestamp = Date.now();

    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: text, timestamp },
    });
    if (broadcast) {
      this.broadcastToSession(sessionId, {
        type: "inject_message",
        sessionId,
        message: { role: "user", content: text, timestamp } as AgentMessage,
      });
    }

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

    const resolved =
      this.resolvedCapabilitiesCache ??
      resolveCapabilities(
        this.getCachedCapabilities(),
        {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
          sessionId,
          stepNumber: 0,
          emitCost: () => {},
          broadcast: () => {},
          broadcastToAll: () => {},
          requestFromClient: () => Promise.reject(new Error("Not available")),
          storage: createNoopStorage(),
          broadcastState: () => {},
          schedules: this.buildScheduleManager(),
          rateLimit: this.rateLimiter,
        },
        (capId) => createCapabilityStorage(this.kvStore, capId),
        undefined,
        this.agentConfigSnapshot,
      );

    const commandMap = new Map<string, Command>();

    commandMap.set("clear", {
      name: "clear",
      description: "Clear conversation and start fresh",
      execute: () => ({ text: "Cleared" }),
    });

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

  private handleClearCommand(connection: TransportConnection, sessionId: string): void {
    this.sessionAgents.get(sessionId)?.abort();

    const newSession = this.sessionStore.create({});
    connection.setSessionId(newSession.id);
    this.onSessionCreated?.({ id: newSession.id, name: newSession.name });

    connection.send({
      type: "session_sync",
      sessionId: newSession.id,
      session: newSession,
      messages: [],
      streamMessage: null,
    });
    // Re-send global capability state that session_sync clears on the client.
    this.sendCommandList(connection, newSession.id);

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

  async ensureAgent(sessionId: string): Promise<void> {
    const { piAgent, getModel } = await loadPiSdk();
    await this.ensureAgentConfigLoaded();
    const config = this.getConfig();
    const context: AgentContext = {
      agentId: this.runtimeContext.agentId,
      publicUrl: this.publicUrl,
      sessionId,
      stepNumber: 0,
      emitCost: (cost) => this.handleCostEvent(cost, sessionId),
      broadcast: this.createSessionBroadcast(sessionId),
      broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
      requestFromClient: (eventName, eventData, timeoutMs) =>
        this.requestFromClient(sessionId, eventName, eventData, timeoutMs),
      storage: createNoopStorage(),
      broadcastState: () => {},
      schedules: this.buildScheduleManager(),
      rateLimit: this.rateLimiter,
    };
    // biome-ignore lint/suspicious/noExplicitAny: pi-ai getModel has overly narrow provider type (KnownProvider)
    const model = getModel(config.provider as any, config.modelId);

    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }

    const capabilities = this.getCachedCapabilities();
    const resolved = resolveCapabilities(
      capabilities,
      context,
      (capId) => createCapabilityStorage(this.kvStore, capId),
      (capId) => this.createCapabilityBroadcastState(capId, sessionId),
      this.agentConfigSnapshot,
    );
    this.resolvedCapabilitiesCache = resolved;
    this.beforeInferenceHooks = resolved.beforeInferenceHooks;
    this.beforeToolExecutionHooks = resolved.beforeToolExecutionHooks;
    this.afterToolExecutionHooks = resolved.afterToolExecutionHooks;
    this.capabilityDisposers = resolved.disposers;

    if (resolved.schedules.length > 0) {
      await this.syncCapabilitySchedules(resolved.schedules);
    }

    // Build the full section list (base + tools + capabilities) and the
    // exact tool list via the shared helpers so inspection can reproduce it
    // byte-for-byte. Then apply defaultToolTimeout wrapping to the tools
    // that actually execute.
    const allSections = this.assembleAllSections(context, capabilities, resolved);
    const systemPrompt = toPromptString(allSections);
    let allTools = this.collectAllTools(context, capabilities, resolved);
    if (config.defaultToolTimeout) {
      allTools = applyDefaultTimeout(allTools, config.defaultToolTimeout);
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

      if (event.type === "agent_end") {
        this.sessionAgents.delete(sessionId);
        this.resolvedCapabilitiesCache = null;
        this.capabilitiesCache = null;
        this.disposeCapabilities();
        this.processQueue(sessionId).catch((err) => {
          this.logger.error("[AgentRuntime] processQueue error", { message: String(err) });
        });
      }
    });

    if (this.beforeToolExecutionHooks.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - beforeToolCall context type unavailable
      agent.setBeforeToolCall(async (btcContext: any) => {
        const hookContext: CapabilityHookContext = {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
          sessionId,
          sessionStore: this.sessionStore,
          storage: createNoopStorage(),
          capabilityIds: this.getCapabilityIds(),
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
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error("[capabilities] beforeToolExecution hook error", {
              message: error.message,
            });
            this.onError?.(error, { source: "hook", sessionId, toolName: event.toolName });
          }
        }
        return undefined;
      });
    }

    if (this.afterToolExecutionHooks.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: Lazy-loaded SDK - afterToolCall context type unavailable
      agent.setAfterToolCall(async (atcContext: any) => {
        const hookContext: CapabilityHookContext = {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
          sessionId,
          sessionStore: this.sessionStore,
          storage: createNoopStorage(),
          capabilityIds: this.getCapabilityIds(),
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
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error("[capabilities] afterToolExecution hook error", {
              message: error.message,
            });
            this.onError?.(error, { source: "hook", sessionId, toolName: event.toolName });
          }
        }
        return undefined;
      });
    }

    this.sessionAgents.set(sessionId, agent);
  }

  /**
   * Resolve all tools for a session (base + capability) with a proper AgentContext.
   */
  resolveToolsForSession(sessionId: string): {
    tools: AnyAgentTool[];
    context: AgentContext;
    resolved: ResolvedCapabilities;
  } {
    const context: AgentContext = {
      agentId: this.runtimeContext.agentId,
      publicUrl: this.publicUrl,
      sessionId,
      stepNumber: 0,
      emitCost: (cost) => this.handleCostEvent(cost, sessionId),
      broadcast: this.createSessionBroadcast(sessionId),
      broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      broadcastState: () => {},
      schedules: this.buildScheduleManager(),
      rateLimit: this.rateLimiter,
    };

    const resolved = resolveCapabilities(
      this.getCachedCapabilities(),
      context,
      (capId) => createCapabilityStorage(this.kvStore, capId),
      (capId) => this.createCapabilityBroadcastState(capId, sessionId),
      this.agentConfigSnapshot,
    );

    const baseTools = this.getTools(context);
    const allTools = [...baseTools, ...resolved.tools];

    return { tools: allTools, context, resolved };
  }

  async transformContext(messages: AgentMessage[], sessionId: string): Promise<AgentMessage[]> {
    let result = messages;

    const hookContext: CapabilityHookContext = {
      agentId: this.runtimeContext.agentId,
      publicUrl: this.publicUrl,
      sessionId,
      sessionStore: this.sessionStore,
      storage: createNoopStorage(),
      broadcastState: () => {},
      capabilityIds: this.getCapabilityIds(),
    };

    for (const hook of this.beforeInferenceHooks) {
      try {
        result = await hook(result, hookContext);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[AgentRuntime] beforeInference hook error", {
          message: error.message,
        });
        this.onError?.(error, { source: "hook", sessionId });
      }
    }

    return result;
  }

  disposeCapabilities(): void {
    for (const { capabilityId, dispose } of this.capabilityDisposers) {
      dispose().catch((err) => {
        this.logger.error(`[capabilities] dispose error from "${capabilityId}"`, {
          message: String(err),
        });
      });
    }
    this.capabilityDisposers = [];
  }

  /** Fire onConnect hooks for all registered capabilities. */
  async fireOnConnectHooks(sessionId: string): Promise<void> {
    await this.ensureAgentConfigLoaded();
    const resolved =
      this.resolvedCapabilitiesCache ??
      resolveCapabilities(
        this.getCachedCapabilities(),
        {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
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
          storage: createNoopStorage(),
          broadcastState: () => {},
          schedules: this.buildScheduleManager(),
          rateLimit: this.rateLimiter,
        },
        (capId) => createCapabilityStorage(this.kvStore, capId),
        undefined,
        this.agentConfigSnapshot,
      );

    const broadcastFn = this.createSessionBroadcast(sessionId);

    // Broadcast full agent-level config snapshot to the (re)connecting
    // client as a `capability_state { capabilityId: "agent-config",
    // event: "sync" }` message. The useAgentConfig() client hook
    // subscribes to this ID and hydrates from the sync payload.
    if (Object.keys(this.getCachedAgentConfigSchema()).length > 0) {
      this.broadcastCoreState(
        "agent-config",
        "sync",
        {
          schema: this.getCachedAgentConfigSchema(),
          values: this.agentConfigSnapshot,
        },
        "session",
        { sessionId },
      );
    }

    for (const { capabilityId, hook } of resolved.onConnectHooks) {
      try {
        const hookContext: CapabilityHookContext = {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
          sessionId,
          sessionStore: this.sessionStore,
          storage: createNoopStorage(),
          broadcastState: this.createCapabilityBroadcastState(capabilityId, sessionId),
          capabilityIds: this.getCapabilityIds(),
          broadcast: broadcastFn,
        };
        await hook(hookContext);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[capabilities] onConnect hook error", { message: error.message });
        this.onError?.(error, { source: "hook", sessionId });
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
      this.logger.error("[AgentRuntime] Failed to broadcast active A2A tasks", {
        message: String(err),
      });
    }
  }

  private convertToLlm(messages: AgentMessage[]): Message[] {
    return messages.filter((m): m is Message => {
      return (
        "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      );
    });
  }

  handleAgentEvent(event: AgentEvent, sessionId: string): void {
    const serverMsg: ServerMessage =
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
        ? { type: "tool_event", sessionId, event }
        : { type: "agent_event", sessionId, event };

    this.broadcastToSession(sessionId, serverMsg);

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

    if (event.type === "turn_end") {
      try {
        const res = this.onTurnEnd?.([event.message], event.toolResults);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error("[AgentRuntime] onTurnEnd hook error", { message: error.message });
            this.onError?.(error, { source: "hook", sessionId });
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[AgentRuntime] onTurnEnd hook error", { message: error.message });
        this.onError?.(error, { source: "hook", sessionId });
      }
    }
    if (event.type === "agent_end") {
      try {
        const res = this.onAgentEnd?.(event.messages);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error("[AgentRuntime] onAgentEnd hook error", { message: error.message });
            this.onError?.(error, { source: "hook", sessionId });
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[AgentRuntime] onAgentEnd hook error", { message: error.message });
        this.onError?.(error, { source: "hook", sessionId });
      }

      // ----- afterTurn dispatch site ---------------------------------------
      // Fire `Capability.afterTurn` hooks once per `handlePrompt` /
      // `handleAgentPrompt` invocation. The agent emits `agent_end` exactly
      // once regardless of termination mode (natural_stop, error, aborted,
      // max_iterations — see packages/agent-core/src/agent.ts and the
      // AgentEvent discriminated union in agent-core/src/types.ts). Firing
      // here therefore delivers a single dispatch per user message, which is
      // the only shape that makes sense for chat-like channels: a user
      // message produces intermediate assistant messages (tool calls,
      // tool-result replies) followed by one final assistant message, and
      // `afterTurn` delivers that final text exactly once.
      //
      // We run the dispatch work inside `runtimeContext.waitUntil(...)` so
      // the async outbound I/O (sendReply to Telegram, Discord, …) extends
      // past the current event-loop tick without blocking other
      // `handleAgentEvent` work. This matches the A2A callback pattern at
      // handleA2ACallbackPostNotification(~line 2490), which is the only
      // existing precedent for `waitUntil`-extended inference work inside
      // the runtime.
      //
      // Errors from individual capabilities are caught per-capability and
      // logged; one failing hook never prevents the others from running or
      // affects WebSocket broadcast (which has already been emitted at the
      // top of handleAgentEvent).
      const dispatchPromise = this.dispatchAfterTurn(sessionId, event.messages).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[AgentRuntime] afterTurn dispatch error", {
          message: error.message,
          sessionId,
        });
      });
      this.pendingAsyncOps.add(dispatchPromise);
      dispatchPromise.finally(() => this.pendingAsyncOps.delete(dispatchPromise));
      this.runtimeContext.waitUntil(dispatchPromise);
    }
  }

  /**
   * Invoke `afterTurn` on every resolved capability that defines it, once
   * per turn termination. Runs inside `waitUntil` via the caller and catches
   * per-capability errors so a single failing hook cannot block the others.
   *
   * `finalText` is computed from the final assistant message in the event
   * payload: if the last `assistant` entry in `messages` has string content
   * we use it directly; if the content is an array of blocks we concatenate
   * the `text` of every text block. If no assistant message was produced
   * (e.g., turn aborted before any assistant output), the empty string is
   * passed.
   */
  private async dispatchAfterTurn(sessionId: string, messages: AgentMessage[]): Promise<void> {
    // Snapshot the capability list *synchronously* — the caller invokes us
    // from inside `handleAgentEvent`'s `agent_end` branch, which runs
    // before the outer `agent.subscribe` callback clears
    // `capabilitiesCache`. Capturing here guarantees we see the same
    // capabilities that ran the turn.
    const capabilities = this.capabilitiesCache ?? this.getCachedCapabilities();

    // Fast path: skip all work when no capability defines afterTurn.
    const hooks = capabilities.filter((c) => typeof c.afterTurn === "function");
    if (hooks.length === 0) return;

    const finalText = extractFinalAssistantText(messages);

    // We need a CapabilityContext per capability, with its own scoped
    // storage and broadcast state callbacks — matching how `ensureAgent`
    // calls `resolveCapabilities`. Reuse the same `createCapabilityStorage`
    // factory so per-capability KV stays scoped.
    for (const cap of hooks) {
      try {
        const capStorage = createCapabilityStorage(this.kvStore, cap.id);
        const capBroadcastState = this.createCapabilityBroadcastState(cap.id, sessionId);
        const capContext: AgentContext = {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
          sessionId,
          stepNumber: 0,
          emitCost: (cost) => this.handleCostEvent(cost, sessionId),
          broadcast: this.createSessionBroadcast(sessionId),
          broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
          requestFromClient: (eventName, eventData, timeoutMs) =>
            this.requestFromClient(sessionId, eventName, eventData, timeoutMs),
          storage: capStorage,
          broadcastState: capBroadcastState,
          schedules: this.buildScheduleManager(),
          rateLimit: this.rateLimiter,
        };
        // biome-ignore lint/style/noNonNullAssertion: `hooks` filter guaranteed cap.afterTurn is defined
        await cap.afterTurn!(capContext, sessionId, finalText);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("[AgentRuntime] afterTurn hook error", {
          capabilityId: cap.id,
          sessionId,
          message: error.message,
        });
        this.onError?.(error, { source: "hook", sessionId });
      }
    }
  }

  handleCostEvent(cost: CostEvent, sessionId: string): void {
    this.sessionStore.appendEntry(sessionId, {
      type: "custom",
      data: {
        customType: "cost",
        payload: cost,
      },
    });

    this.broadcastToSession(sessionId, {
      type: "cost_event",
      sessionId,
      event: cost,
    });
  }

  // --- Scheduling ---

  /**
   * Process all due schedules and refresh the wake time.
   * Platform shells invoke this from their wake mechanism (DO alarm, node-cron, etc.).
   */
  async handleAlarmFired(): Promise<void> {
    const now = new Date();
    const dueSchedules = this.scheduleStore.getDueSchedules(now);

    for (const schedule of dueSchedules) {
      if (schedule.expiresAt && new Date(schedule.expiresAt) <= now) {
        this.scheduleStore.delete(schedule.id);
        this.scheduleCallbacks.delete(schedule.id);
        continue;
      }

      if (schedule.handlerType === "timer") {
        this.scheduleStore.markRunning(schedule.id);
        try {
          await this.executeScheduledCallback(schedule);
          this.scheduleStore.delete(schedule.id);
          this.scheduleCallbacks.delete(schedule.id);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`[AgentRuntime] Timer "${schedule.name}" failed`, { message });
          this.scheduleStore.markFailed(schedule.id, message);
        }
        continue;
      }

      const next = nextFireTime(schedule.cron, now, schedule.timezone ?? undefined);
      this.scheduleStore.update(schedule.id, { nextFireAt: next.toISOString() });

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
        this.logger.error(`[AgentRuntime] Schedule "${schedule.name}" failed`, { message });
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

    this.cleanupScheduleSessions(schedule);
  }

  private async executeScheduledCallback(schedule: Schedule): Promise<void> {
    await this.ensureScheduleCallbacks();

    const callback = this.scheduleCallbacks.get(schedule.id);
    if (!callback) {
      throw new Error(`No callback registered for schedule "${schedule.id}"`);
    }

    const ctx: ScheduleCallbackContext = {
      schedule,
      sessionStore: this.sessionStore,
      emitCost: (cost) => {
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
    await this.ensureAgentConfigLoaded();

    const resolved =
      this.resolvedCapabilitiesCache ??
      resolveCapabilities(
        this.getCachedCapabilities(),
        {
          agentId: this.runtimeContext.agentId,
          publicUrl: this.publicUrl,
          sessionId: "",
          stepNumber: 0,
          emitCost: () => {},
          broadcast: () => {},
          broadcastToAll: () => {},
          requestFromClient: () => Promise.reject(new Error("Not available")),
          storage: createNoopStorage(),
          broadcastState: () => {},
          schedules: this.buildScheduleManager(),
          rateLimit: this.rateLimiter,
        },
        (capId) => createCapabilityStorage(this.kvStore, capId),
        undefined,
        this.agentConfigSnapshot,
      );

    for (const { config } of resolved.schedules) {
      if ("callback" in config) {
        this.scheduleCallbacks.set(config.id, config.callback);
      }
    }
  }

  /** Sync capability-declared schedules: create if missing, update cron if changed. */
  async syncCapabilitySchedules(
    declarations: Array<{ config: ScheduleConfig; ownerId: string }>,
  ): Promise<void> {
    for (const { config, ownerId } of declarations) {
      const existing = this.scheduleStore.get(config.id);

      if ("callback" in config) {
        this.scheduleCallbacks.set(config.id, config.callback);
      }

      if ("delaySeconds" in config) {
        this.timerOwners.set(config.id, ownerId);
        if (existing && existing.handlerType === "timer") {
          this.scheduleCallbacks.set(config.id, config.callback);
        }
        continue;
      }

      const tz = config.timezone ?? undefined;

      if (existing) {
        if (existing.cron !== config.cron || existing.timezone !== (config.timezone ?? null)) {
          const next = nextFireTime(config.cron, undefined, tz);
          this.scheduleStore.update(config.id, {
            cron: config.cron,
            timezone: config.timezone ?? null,
            nextFireAt: next.toISOString(),
          });
        }
      } else {
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

  /** Set the wake time to the earliest pending schedule fire time and notify clients. */
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
      const toDelete = allSessions.slice(0, allSessions.length - schedule.retention);
      for (const s of toDelete) {
        this.sessionStore.delete(s.id);
      }
    }
  }

  // --- Capability HTTP handlers ---

  private resolveHttpHandlers(): ResolvedCapabilities["httpHandlers"] {
    if (this.resolvedHttpHandlers) return this.resolvedHttpHandlers;

    const capabilities = this.getCachedCapabilities();
    const baseContext: AgentContext = {
      agentId: this.runtimeContext.agentId,
      publicUrl: this.publicUrl,
      sessionId: "",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      broadcastState: () => {},
      schedules: this.buildScheduleManager(),
      rateLimit: this.rateLimiter,
    };

    const resolved = resolveCapabilities(
      capabilities,
      baseContext,
      (capId) => createCapabilityStorage(this.kvStore, capId),
      undefined,
      this.agentConfigSnapshot,
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
      if (h.method !== method) continue;
      const params = matchPathPattern(h.path, pathname);
      if (params === null) continue;
      await this.ensureAgentConfigLoaded();
      const cap = this.getCachedCapabilities().find((c) => c.id === h.capabilityId);
      const agentConfig = cap?.agentConfigMapping
        ? cap.agentConfigMapping(this.agentConfigSnapshot)
        : undefined;
      const ctx: CapabilityHttpContext = {
        sessionStore: this.sessionStore,
        storage: h.storage,
        publicUrl: this.publicUrl,
        agentConfig,
        broadcastToAll: (name, data) => this.broadcastCustomToAll(name, data),
        broadcastState: (event, data, scope) =>
          this.broadcastCoreState(h.capabilityId, event, data, scope ?? "session"),
        params,
        rateLimit: this.rateLimiter,
        sendPrompt: (opts) => this.handleAgentPrompt(opts),
      };
      return { handler: h.handler, ctx };
    }
    return null;
  }

  /**
   * Get a handle to a session's running agent for external control (e.g., abort).
   */
  getSessionAgentHandle(sessionId: string): { abort: () => void; isStreaming: boolean } | null {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return null;
    return {
      abort: () => agent.abort(),
      isStreaming: agent.state.isStreaming,
    };
  }

  async handleAgentPrompt(opts: {
    text: string;
    sessionId?: string;
    sessionName?: string;
    source?: string;
    /**
     * Remote identity for channel-routed sessions. When `sessionId` is
     * absent and `source` + `sender` are both present, the runtime resolves
     * the session via {@link SessionStore.findBySourceAndSender}, creating a
     * new session if none exists. This runs under the DO's single-threaded
     * execution so no explicit transaction is required.
     */
    sender?: string;
  }): Promise<{ sessionId: string; response: string }> {
    let sessionId = opts.sessionId;
    if (!sessionId) {
      if (opts.source && opts.sender) {
        // Channel-routing path: look up an existing session for this
        // (source, sender) pair, otherwise create one with the sender
        // persisted so subsequent inbounds reuse it.
        const existing = this.sessionStore.findBySourceAndSender(opts.source, opts.sender);
        sessionId =
          existing?.id ??
          this.sessionStore.create({
            name: opts.sessionName ?? "Agent message",
            source: opts.source,
            sender: opts.sender,
          }).id;
      } else {
        sessionId = this.sessionStore.create({
          name: opts.sessionName ?? "Agent message",
          source: opts.source ?? "agent",
        }).id;
      }
    }

    const existingAgent = this.sessionAgents.get(sessionId);
    if (existingAgent?.state.isStreaming) {
      throw new Error("Agent is busy on this session");
    }

    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: opts.text, timestamp: Date.now() },
    });

    await this.ensureAgent(sessionId);
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) throw new Error("Agent failed to initialize");

    await agent.prompt(opts.text);
    await agent.waitForIdle();

    const messages = this.sessionStore.buildContext(sessionId);
    let response = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          response = msg.content;
        } else if (Array.isArray(msg.content)) {
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

  private createA2AClientTools(sessionId: string): AnyAgentTool[] {
    const clientOpts = this.getA2AClientOptions();
    if (!clientOpts) return [];

    const storage = createCapabilityStorage(this.kvStore, "a2a-client");
    const getStorage = () => storage;
    const getSessionId = () => sessionId;

    const toolOpts: A2AToolOptions = {
      agentId: clientOpts.callbackAgentName ?? this.runtimeContext.agentId,
      agentName: this.getPromptOptions().agentName,
      getAgentStub: clientOpts.getAgentStub,
      resolveDoId: clientOpts.resolveDoId,
      callbackBaseUrl: clientOpts.callbackBaseUrl ?? "https://agent",
      maxDepth: clientOpts.maxDepth ?? 5,
      authHeaders: clientOpts.authHeaders,
      broadcast: this.createSessionBroadcast(sessionId),
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
   * agent stubs for same-platform agents.
   */
  private buildA2AStubFetch():
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined {
    const clientOpts = this.getA2AClientOptions();
    if (!clientOpts) return undefined;

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      const callbackMatch = url.match(/\/a2a-callback\/([^/?]+)/);
      if (callbackMatch) {
        const callbackAgentId = callbackMatch[1];
        const stub = clientOpts.getAgentStub(callbackAgentId);
        const stubUrl = url.replace(`/a2a-callback/${callbackAgentId}`, "/a2a-callback");
        return stub.fetch(stubUrl, init);
      }

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

    if (request.method === "POST" && url.pathname === "/a2a") {
      if (config.a2a?.acceptMessages === false) {
        return new Response(JSON.stringify({ error: "A2A messages not accepted" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

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

      if (config.a2a?.authenticate) {
        const authResponse = await config.a2a.authenticate(request);
        if (authResponse) return authResponse;
      }

      const { handler, executor } = this.ensureA2AHandler();

      executor.setContext({
        sendPrompt: (opts) => this.handleAgentPrompt(opts),
        sessionStore: this.sessionStore,
        fetchFn: this.buildA2AStubFetch(),
      });

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

    const storage = createCapabilityStorage(this.kvStore, "a2a-client");
    const pendingStore = new PendingTaskStore(storage);
    const pending = await pendingStore.get(update.taskId);
    if (!pending) {
      return new Response(JSON.stringify({ error: "Unknown task" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${pending.webhookToken}`) {
      return new Response(JSON.stringify({ error: "Invalid webhook token" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const { isTerminalState } = await import("@claw-for-cloudflare/a2a");
    const state = update.status.state as string;
    await pendingStore.updateState(
      update.taskId,
      state as Parameters<typeof pendingStore.updateState>[1],
    );

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
      const agent = this.sessionAgents.get(pending.originSessionId);
      const isStreaming = agent?.state.isStreaming ?? false;

      if (isStreaming) {
        this.handleSteer(pending.originSessionId, resultText, true);
      } else {
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
          .catch((err) =>
            this.logger.error("[a2a] callback prompt failed", { message: String(err) }),
          )
          .finally(() => this.pendingAsyncOps.delete(op));
        this.pendingAsyncOps.add(op);
        this.runtimeContext.waitUntil(op);
      }

      await pendingStore.delete(update.taskId);
    }

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

  broadcastToSession(sessionId: string, msg: ServerMessage): void {
    this.transport.broadcastToSession(sessionId, msg);
  }

  private broadcastCoreState(
    capabilityId: string,
    event: string,
    data: unknown,
    scope: "session" | "global",
    target?: { sessionId?: string; connection?: TransportConnection },
  ): void {
    const msg: CapabilityStateMessage = {
      type: "capability_state",
      capabilityId,
      scope,
      event,
      data,
      ...(target?.sessionId ? { sessionId: target.sessionId } : {}),
    };
    if (target?.connection) {
      target.connection.send(msg);
    } else if (scope === "session" && target?.sessionId) {
      this.broadcastToSession(target.sessionId, msg);
    } else {
      this.transport.broadcast(msg);
    }
  }

  private createCapabilityBroadcastState(
    capabilityId: string,
    sessionId: string,
  ): AgentContext["broadcastState"] {
    return (event: string, data: unknown, scope?: "session" | "global") => {
      const effectiveScope = scope ?? "session";
      this.broadcastCoreState(capabilityId, event, data, effectiveScope, {
        sessionId: effectiveScope === "session" ? sessionId : undefined,
      });
    };
  }

  private broadcastQueueState(sessionId: string): void {
    const items = this.queueStore.list(sessionId).map(({ id, text, createdAt }) => ({
      id,
      text,
      createdAt,
    }));
    this.broadcastCoreState("queue", "sync", { items }, "session", { sessionId });
  }

  private async processQueue(sessionId: string): Promise<void> {
    const next = this.queueStore.dequeue(sessionId);
    if (!next) return;
    this.broadcastQueueState(sessionId);
    this.broadcastToSession(sessionId, {
      type: "inject_message",
      sessionId,
      message: { role: "user", content: next.text, timestamp: Date.now() } as AgentMessage,
    });
    await this.handlePrompt(sessionId, next.text);
  }

  private createSessionBroadcast(
    sessionId: string,
  ): (name: string, data: Record<string, unknown>) => void {
    return (name, data) => {
      this.broadcastToSession(sessionId, {
        type: "custom_event",
        sessionId,
        event: { name, data },
      });
    };
  }

  broadcastCustomToAll(name: string, data: Record<string, unknown>): void {
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
    this.broadcastCoreState(
      "schedules",
      "sync",
      {
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
      },
      "global",
    );
  }

  private broadcastMcpStatus(): void {
    const servers = this.mcpManager.listServers();
    this.broadcastCoreState(
      "mcp",
      "sync",
      {
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          toolCount: s.toolCount,
          error: s.error,
        })),
      },
      "global",
    );
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
    this.broadcastCoreState(
      "commands",
      "sync",
      {
        commands: Array.from(commands.values()).map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
        })),
      },
      "global",
      { connection },
    );
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
