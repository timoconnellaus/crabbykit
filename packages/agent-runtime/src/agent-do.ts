import { DurableObject } from "cloudflare:workers";
import type { AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type {
  A2AClientOptions,
  A2AConfig,
  AgentConfig,
  AgentContext,
  AgentRuntime,
  AgentRuntimeOptions,
  Logger,
  ScheduleManager,
  SubagentProfile,
} from "./agent-runtime.js";
import type { Capability } from "./capabilities/types.js";
import type { Command, CommandContext } from "./commands/define-command.js";
import type { ConfigNamespace } from "./config/types.js";
import { buildDefaultSystemPromptSections, toPromptString } from "./prompt/build-system-prompt.js";
import type { PromptOptions, PromptSection } from "./prompt/types.js";
import { createCfRuntimeContext } from "./runtime-context-cloudflare.js";
import { type AgentDelegate, createDelegatingRuntime } from "./runtime-delegating.js";
import { createCfScheduler } from "./scheduling/cloudflare-scheduler.js";
import type { Schedule } from "./scheduling/types.js";
import { createCfKvStore, createCfSqlStore } from "./storage/cloudflare.js";
import { CfWebSocketTransport } from "./transport/cloudflare.js";

export type {
  A2AClientOptions,
  A2AConfig,
  AgentConfig,
  AgentContext,
  Logger,
  ScheduleManager,
  SubagentProfile,
};

/**
 * Thin Cloudflare shell around {@link AgentRuntime}. Consumers extend this
 * class, implement `getConfig()` / `getTools()`, and optionally override
 * the same protected methods as before. The shell wires in Cloudflare
 * adapters ({@link CfWebSocketTransport}, SqlStore, KvStore, scheduler,
 * RuntimeContext) and delegates DO lifecycle calls to the runtime.
 *
 * Consumers who want a flat configuration object instead of class
 * inheritance should prefer {@link defineAgent}. This class remains the
 * escape hatch for advanced use cases (custom routes, direct ctx access,
 * bespoke constructor logic).
 */
export abstract class AgentDO<TEnv = Record<string, unknown>>
  extends DurableObject<TEnv>
  implements AgentDelegate<TEnv>
{
  /** Cloudflare-specific WebSocket transport. Held separately from the runtime's abstract `transport` so that `webSocketMessage`/`webSocketClose` can call CF-specific handlers without casting. */
  protected readonly cfTransport: CfWebSocketTransport;
  /** Composed runtime that owns the business logic. */
  protected readonly runtime: AgentRuntime<TEnv>;

  constructor(ctx: DurableObjectState, env: TEnv, options: AgentRuntimeOptions = {}) {
    super(ctx, env);
    const sqlStore = createCfSqlStore(ctx.storage.sql);
    const kvStore = createCfKvStore(ctx.storage);
    const scheduler = createCfScheduler(ctx.storage);
    this.cfTransport = new CfWebSocketTransport(ctx);
    const runtimeContext = createCfRuntimeContext(ctx);
    this.runtime = createDelegatingRuntime<TEnv>(this, {
      sqlStore,
      kvStore,
      scheduler,
      transport: this.cfTransport,
      runtimeContext,
      env,
      options,
    });
  }

  // --- Abstract methods (consumers implement these) ---

  abstract getConfig(): AgentConfig;
  abstract getTools(context: AgentContext): AnyAgentTool[];

  /**
   * Build the **base** system prompt as structured sections. Default
   * composes identity, safety, and runtime sections from
   * {@link getPromptOptions}. Tool sections and capability prompt sections
   * are appended automatically by the runtime after this.
   *
   * Override this method (preferred) to customize the base sections with
   * full structural metadata — each section carries a `source` tag and
   * can declare itself `included: false` with an `excludedReason` to
   * surface conditional opt-outs in the inspection UI.
   */
  buildSystemPromptSections(_context: AgentContext): PromptSection[] {
    return buildDefaultSystemPromptSections(this.getPromptOptions());
  }

  /**
   * Build the base system prompt as a string.
   *
   * @deprecated Prefer overriding {@link buildSystemPromptSections}, which
   * lets you attribute sections to a source and surface conditional
   * exclusions in the inspection panel. Existing overrides of this method
   * continue to work — the runtime wraps the returned string in a single
   * "custom" section when the section-returning method is not overridden.
   */
  buildSystemPrompt(context: AgentContext): string {
    return toPromptString(this.buildSystemPromptSections(context));
  }

  /**
   * Override to customize the default prompt sections.
   */
  getPromptOptions(): PromptOptions {
    return {};
  }

  /**
   * Override to register capabilities.
   */
  getCapabilities(): Capability[] {
    return [];
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

  /**
   * Override to inject custom Agent options (e.g., mock streamFn for testing).
   */
  getAgentOptions(): Record<string, unknown> {
    return {};
  }

  // --- Optional lifecycle hooks ---

  validateAuth?(request: Request): Promise<boolean> | boolean;
  onTurnEnd?(messages: AgentMessage[], toolResults: unknown[]): void | Promise<void>;
  onAgentEnd?(messages: AgentMessage[]): void | Promise<void>;
  onSessionCreated?(session: { id: string; name: string }): void | Promise<void>;
  onScheduleFire?(schedule: Schedule): Promise<{ skip?: boolean; prompt?: string } | undefined>;

  // --- DO lifecycle delegators ---

  async fetch(request: Request): Promise<Response> {
    return this.runtime.handleRequest(request);
  }

  async alarm(): Promise<void> {
    return this.runtime.handleAlarmFired();
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    this.cfTransport.handleMessage(ws, data);
  }

  webSocketClose(ws: WebSocket): void {
    this.cfTransport.handleClose(ws);
  }

  // --- Protected getters/setters that forward to the composed runtime ---
  //
  // These preserve the legacy `this.sessionStore`, `this.kvStore`, etc.
  // access pattern for subclasses (and test helpers) that were written
  // against the old monolithic AgentDO.

  protected get sessionStore() {
    return this.runtime.sessionStore;
  }
  protected get scheduleStore() {
    return this.runtime.scheduleStore;
  }
  protected get configStore() {
    return this.runtime.configStore;
  }
  protected get mcpManager() {
    return this.runtime.mcpManager;
  }
  protected get taskStore() {
    return this.runtime.taskStore;
  }
  protected get queueStore() {
    return this.runtime.queueStore;
  }
  protected get kvStore() {
    return this.runtime.kvStore;
  }
  protected get scheduler() {
    return this.runtime.scheduler;
  }
  protected get transport() {
    return this.runtime.transport;
  }
  protected get rateLimiter() {
    return this.runtime.rateLimiter;
  }
  protected get sessionAgents() {
    return this.runtime.sessionAgents;
  }
  protected get pendingAsyncOps() {
    return this.runtime.pendingAsyncOps;
  }
  protected get beforeInferenceHooks() {
    return this.runtime.beforeInferenceHooks;
  }
  protected set beforeInferenceHooks(value) {
    this.runtime.beforeInferenceHooks = value;
  }
  protected get beforeToolExecutionHooks() {
    return this.runtime.beforeToolExecutionHooks;
  }
  protected set beforeToolExecutionHooks(value) {
    this.runtime.beforeToolExecutionHooks = value;
  }
  protected get afterToolExecutionHooks() {
    return this.runtime.afterToolExecutionHooks;
  }
  protected set afterToolExecutionHooks(value) {
    this.runtime.afterToolExecutionHooks = value;
  }
  protected get resolvedCapabilitiesCache() {
    return this.runtime.resolvedCapabilitiesCache;
  }
  protected set resolvedCapabilitiesCache(value) {
    this.runtime.resolvedCapabilitiesCache = value;
  }
  protected get capabilitiesCache() {
    return this.runtime.capabilitiesCache;
  }
  protected set capabilitiesCache(value) {
    this.runtime.capabilitiesCache = value;
  }
  protected get connectionRateLimits() {
    return this.runtime.connectionRateLimits;
  }
  protected get scheduleCallbacks() {
    return this.runtime.scheduleCallbacks;
  }
  protected get timerOwners() {
    return this.runtime.timerOwners;
  }
  protected get capabilityDisposers() {
    return this.runtime.capabilityDisposers;
  }
  protected set capabilityDisposers(value) {
    this.runtime.capabilityDisposers = value;
  }

  // --- Protected method delegators for subclass convenience ---

  protected buildScheduleManager(): ScheduleManager {
    return this.runtime.buildScheduleManager();
  }

  protected async handlePrompt(sessionId: string, text: string): Promise<void> {
    return this.runtime.handlePrompt(sessionId, text);
  }

  protected handleSteer(sessionId: string, text: string, broadcast = false): void {
    this.runtime.handleSteer(sessionId, text, broadcast);
  }

  protected handleCostEvent(
    cost: Parameters<AgentRuntime<TEnv>["handleCostEvent"]>[0],
    sessionId: string,
  ): void {
    this.runtime.handleCostEvent(cost, sessionId);
  }

  protected handleAgentEvent(
    event: Parameters<AgentRuntime<TEnv>["handleAgentEvent"]>[0],
    sessionId: string,
  ): void {
    this.runtime.handleAgentEvent(event, sessionId);
  }

  protected async transformContext(
    messages: AgentMessage[],
    sessionId: string,
  ): Promise<AgentMessage[]> {
    return this.runtime.transformContext(messages, sessionId);
  }

  protected async syncCapabilitySchedules(
    declarations: Parameters<AgentRuntime<TEnv>["syncCapabilitySchedules"]>[0],
  ): Promise<void> {
    return this.runtime.syncCapabilitySchedules(declarations);
  }

  protected async handleAgentPrompt(
    opts: Parameters<AgentRuntime<TEnv>["handleAgentPrompt"]>[0],
  ): Promise<{ sessionId: string; response: string }> {
    return this.runtime.handleAgentPrompt(opts);
  }

  protected resolveToolsForSession(sessionId: string) {
    return this.runtime.resolveToolsForSession(sessionId);
  }

  protected getCachedCapabilities(): Capability[] {
    return this.runtime.getCachedCapabilities();
  }
}

export type { CompactionConfig } from "./agent-runtime.js";
