import { DurableObject } from "cloudflare:workers";
import type { AgentMessage, AnyAgentTool } from "@crabbykit/agent-core";
import type { TObject } from "@sinclair/typebox";
import type {
  A2AClientOptions,
  A2AConfig,
  AgentConfig,
  AgentContext,
  AgentRuntime,
  AgentRuntimeOptions,
  Logger,
  ScheduleManager,
} from "./agent-runtime.js";
import type { BundleConfig } from "./bundle-config.js";
import type { Capability } from "./capabilities/types.js";
import type { Command, CommandContext } from "./commands/define-command.js";
import type { ConfigNamespace } from "./config/types.js";
import type { Mode } from "./modes/define-mode.js";
import { buildDefaultSystemPromptSections, toPromptString } from "./prompt/build-system-prompt.js";
import type { PromptOptions, PromptSection } from "./prompt/types.js";
import { createCfRuntimeContext } from "./runtime-context-cloudflare.js";
import { type AgentDelegate, createDelegatingRuntime } from "./runtime-delegating.js";
import { createCfScheduler } from "./scheduling/cloudflare-scheduler.js";
import type { Schedule } from "./scheduling/types.js";
import type { SpineCaller, SpineHost } from "./spine-host.js";
import { createCfKvStore, createCfSqlStore } from "./storage/cloudflare.js";
import { CfWebSocketTransport } from "./transport/cloudflare.js";

export type { A2AClientOptions, A2AConfig, AgentConfig, AgentContext, Logger, ScheduleManager };

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
    // Pull optional spine budget config from the DO env if present. The
    // budget tracker itself lives on AgentRuntime — see
    // openspec/changes/move-spine-budget-into-do/. The binding is a plain
    // object on TEnv (not a wrangler binding), so a narrow cast is safe.
    const envWithBudget = env as TEnv & { SPINE_BUDGET?: AgentRuntimeOptions["spineBudget"] };
    const mergedOptions: AgentRuntimeOptions = {
      ...options,
      spineBudget: options.spineBudget ?? envWithBudget.SPINE_BUDGET,
      // Bundle inspection cache (Phase 1) defaults the version on
      // version-less reads to whatever the per-DO hot-path cache holds.
      // The cache is `ctx.storage.activeBundleVersionId` — single-writer
      // owned by `_initBundleDispatch` (see CLAUDE.md). Returning `null`
      // for static-only DOs is the documented behavior.
      getActiveBundleVersionId:
        options.getActiveBundleVersionId ??
        (async () => (await ctx.storage.get<string | null>("activeBundleVersionId")) ?? null),
    };
    this.runtime = createDelegatingRuntime<TEnv>(this, {
      sqlStore,
      kvStore,
      scheduler,
      transport: this.cfTransport,
      runtimeContext,
      env,
      options: mergedOptions,
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
   * Override to register session-level modes. When the returned array
   * has one or more modes, `/mode`, `enter_mode`, and `exit_mode` are
   * conditionally registered. An empty array keeps the feature
   * dormant; a single mode still yields a meaningful in/out toggle.
   */
  getModes(): Mode[] {
    return [];
  }

  /**
   * Override to register subagent spawn modes. Each mode is a named
   * {@link Mode} (shared type with {@link getModes}) that `call_subagent`
   * and `start_subagent` can reference to spawn a scoped child.
   */
  getSubagentModes(): Mode[] {
    return [];
  }

  /**
   * Override to register consumer config namespaces.
   */
  getConfigNamespaces(): ConfigNamespace[] {
    return [];
  }

  /**
   * Override to declare an agent-level config schema. `defineAgent` sets
   * this via its `config` field; subclassers who want agent-level config
   * without `defineAgent` can override this directly. Defaults to an
   * empty record (no agent-level config namespaces).
   */
  getAgentConfigSchema(): Record<string, TObject> {
    return {};
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

  /**
   * Returns the host's registered capability ids, used by the bundle
   * catalog validation paths. Delegates to the runtime; exposed on the DO
   * so subclasses and the `initBundleDispatch` wiring can read it without
   * reaching into the runtime directly.
   */
  getBundleHostCapabilityIds(): string[] {
    return this.runtime.getBundleHostCapabilityIds();
  }

  // --- Spine host surface ---
  //
  // Public forwarders that expose every `SpineHost` method on the DO's RPC
  // surface. `SpineService` calls these directly on a typed
  // `DurableObjectStub<SpineHost>`; each forwarder delegates to the
  // identically-named method on the composed runtime, which owns the real
  // implementation. Keeping the forwarders here (rather than only on the
  // runtime) is what makes `AgentDO` structurally satisfy `SpineHost` —
  // the DO stub RPC surface only sees methods declared on the DO class.
  //
  // Every method takes a `SpineCaller` context as its first argument —
  // a trusted `{aid, sid, nonce}` object constructed by SpineService from
  // a verified capability token. Budget enforcement happens inside the
  // runtime's `withSpineBudget` helper; the forwarders just pass through.

  spineAppendEntry(
    caller: SpineCaller,
    entry: Parameters<AgentRuntime<TEnv>["spineAppendEntry"]>[1],
  ): Promise<unknown> {
    return this.runtime.spineAppendEntry(caller, entry);
  }

  spineGetEntries(caller: SpineCaller, options?: unknown): Promise<unknown[]> {
    return this.runtime.spineGetEntries(caller, options);
  }

  spineGetSession(caller: SpineCaller): Promise<unknown> {
    return this.runtime.spineGetSession(caller);
  }

  spineCreateSession(
    caller: SpineCaller,
    init?: Parameters<AgentRuntime<TEnv>["spineCreateSession"]>[1],
  ): Promise<unknown> {
    return this.runtime.spineCreateSession(caller, init);
  }

  spineListSessions(caller: SpineCaller, filter?: unknown): Promise<unknown[]> {
    return this.runtime.spineListSessions(caller, filter);
  }

  spineBuildContext(caller: SpineCaller): Promise<unknown> {
    return this.runtime.spineBuildContext(caller);
  }

  spineGetCompactionCheckpoint(caller: SpineCaller): Promise<unknown> {
    return this.runtime.spineGetCompactionCheckpoint(caller);
  }

  spineKvGet(caller: SpineCaller, capabilityId: string, key: string): Promise<unknown> {
    return this.runtime.spineKvGet(caller, capabilityId, key);
  }

  spineKvPut(
    caller: SpineCaller,
    capabilityId: string,
    key: string,
    value: unknown,
    options?: unknown,
  ): Promise<void> {
    return this.runtime.spineKvPut(caller, capabilityId, key, value, options);
  }

  spineKvDelete(caller: SpineCaller, capabilityId: string, key: string): Promise<void> {
    return this.runtime.spineKvDelete(caller, capabilityId, key);
  }

  spineKvList(caller: SpineCaller, capabilityId: string, prefix?: string): Promise<unknown[]> {
    return this.runtime.spineKvList(caller, capabilityId, prefix);
  }

  spineScheduleCreate(caller: SpineCaller, schedule: unknown): Promise<unknown> {
    return this.runtime.spineScheduleCreate(caller, schedule);
  }

  spineScheduleUpdate(caller: SpineCaller, scheduleId: string, patch: unknown): Promise<void> {
    return this.runtime.spineScheduleUpdate(caller, scheduleId, patch);
  }

  spineScheduleDelete(caller: SpineCaller, scheduleId: string): Promise<void> {
    return this.runtime.spineScheduleDelete(caller, scheduleId);
  }

  spineScheduleList(caller: SpineCaller): Promise<unknown[]> {
    return this.runtime.spineScheduleList(caller);
  }

  spineAlarmSet(caller: SpineCaller, timestamp: number): Promise<void> {
    return this.runtime.spineAlarmSet(caller, timestamp);
  }

  spineBroadcast(caller: SpineCaller, event: unknown): Promise<void> {
    return this.runtime.spineBroadcast(caller, event);
  }

  spineBroadcastGlobal(caller: SpineCaller, event: unknown): Promise<void> {
    return this.runtime.spineBroadcastGlobal(caller, event);
  }

  spineEmitCost(caller: SpineCaller, costEvent: unknown): Promise<void> {
    return this.runtime.spineEmitCost(caller, costEvent);
  }

  spineRecordToolExecution(caller: SpineCaller, event: unknown): Promise<void> {
    return this.runtime.spineRecordToolExecution(caller, event);
  }

  spineProcessBeforeInference(caller: SpineCaller, messages: unknown[]): Promise<unknown[]> {
    return this.runtime.spineProcessBeforeInference(caller, messages);
  }

  spineProcessBeforeToolExecution(caller: SpineCaller, event: unknown): Promise<unknown> {
    return this.runtime.spineProcessBeforeToolExecution(caller, event);
  }

  spineRecordBundlePromptSections(
    caller: SpineCaller,
    sessionId: string,
    sections: unknown[],
    bundleVersionId: string,
  ): Promise<void> {
    return this.runtime.spineRecordBundlePromptSections(
      caller,
      sessionId,
      sections,
      bundleVersionId,
    );
  }

  spineGetBundlePromptSections(
    caller: SpineCaller,
    sessionId: string,
    bundleVersionId?: string,
  ): Promise<unknown[]> {
    return this.runtime.spineGetBundlePromptSections(caller, sessionId, bundleVersionId);
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

  /**
   * Install bundle dispatch on the runtime. Wires `bundlePromptHandler`,
   * `bundlePointerRefresher`, `bundleClientEventHandler`, and a pre-fetch
   * handler serving `POST /bundle/disable` and `POST /bundle/refresh`.
   *
   * Call this exactly once from a subclass constructor (or from
   * `defineAgent`'s generated class) when bundle config is present. The
   * implementation is shared here so both `defineAgent` and hand-rolled
   * `AgentDO` subclasses exercise the same production code path — critical
   * for integration tests that need to drive bundle dispatch without
   * going through `defineAgent`.
   *
   * `ctx.storage.activeBundleVersionId` is the single-writer hot-path
   * cache. In-process mutations to the pointer MUST go through
   * `AgentContext.notifyBundlePointerChanged()` (which delegates to the
   * installed `bundlePointerRefresher`). Out-of-process mutations MUST
   * POST `/bundle/refresh`.
   */
  protected initBundleDispatch(
    ctx: DurableObjectState,
    env: TEnv,
    bundleConfig: BundleConfig<TEnv>,
  ): void {
    const agentId = this.runtime.runtimeContext.agentId;
    const registry = bundleConfig.registry(env);
    const loader = bundleConfig.loader(env);
    const masterKey = bundleConfig.authKey(env);
    const maxLoadFailures = bundleConfig.maxLoadFailures ?? 3;

    // Mutable dispatch state
    let consecutiveFailures = 0;
    let bundleSubkeyPromise: Promise<CryptoKey> | null = null;
    // Last active version id whose catalog we validated against the
    // current host. Resets on pointer change (bundlePointerRefresher,
    // catalog-mismatch disable) and on cold start (new DO instance).
    // Used by the dispatch-time guard to short-circuit revalidation in
    // the steady state. See Phase 5 in
    // openspec/changes/define-bundle-capability-catalog/.
    let validatedVersionId: string | null = null;

    const getBundleSubkey = async (): Promise<CryptoKey> => {
      if (!bundleSubkeyPromise) {
        bundleSubkeyPromise = (async () => {
          const { deriveMintSubkey, BUNDLE_SUBKEY_LABEL } = await import("@crabbykit/bundle-host");
          return deriveMintSubkey(masterKey, BUNDLE_SUBKEY_LABEL);
        })();
      }
      return bundleSubkeyPromise;
    };

    /**
     * Build the `loader.get` second arg for a single dispatch. Centralizes
     * envelope decode + env composition across `bundlePromptHandler`,
     * `dispatchLifecycle`, `dispatchHttp`, `dispatchAction` so drift
     * between dispatch paths is structurally impossible.
     */
    const buildLoaderConfigGetter = (
      versionId: string,
      bundleToken: string,
      extras?: Record<string, unknown>,
    ) => {
      return async () => {
        const bytes = await registry.getBytes(versionId);
        if (!bytes) {
          throw new Error(`Bundle bytes not found for version ${versionId}`);
        }
        const { composeWorkerLoaderConfig } = await import("@crabbykit/bundle-host");
        return composeWorkerLoaderConfig({
          bytes,
          projectedEnv: bundleConfig.bundleEnv(env),
          bundleToken,
          versionId,
          extras: {
            // bundle-http-and-ui-surface: inject the host's public URL
            // so `BundleHttpContext.publicUrl` / `BundleActionContext.publicUrl`
            // surface the same value the static `CapabilityHttpContext`
            // exposes via `RuntimeContext.publicUrl`.
            ...(this.runtime.publicUrl ? { __BUNDLE_PUBLIC_URL: this.runtime.publicUrl } : {}),
            ...(extras ?? {}),
          },
        });
      };
    };

    /**
     * Compute the per-turn token scope from the active version's
     * declared `requiredCapabilities`. Reserved scopes `"spine"` /
     * `"llm"` are unconditionally prepended.
     */
    const computeTokenScope = async (versionId: string): Promise<string[]> => {
      const version = await registry.getVersion?.(versionId);
      const catalogIds = (version?.metadata?.requiredCapabilities ?? []).map(
        (r: { id: string }) => r.id,
      );
      return ["spine", "llm", ...catalogIds];
    };

    const checkActiveBundle = async (): Promise<string | null> => {
      // Warm path: ctx.storage
      const cached = await ctx.storage.get<string | null>("activeBundleVersionId");
      if (cached !== undefined) {
        return cached;
      }
      // Cold path: registry query
      const id = await registry.getActiveForAgent(agentId);
      await ctx.storage.put("activeBundleVersionId", id);
      return id;
    };

    /**
     * Dispatch-time catalog guard. When the active version id differs
     * from the dispatcher's last-validated id (pointer changed, cold
     * start, out-of-band write), read the version metadata and compare
     * declared `requiredCapabilities` against the host's registered
     * capability set. Returns `{ valid: true }` when the declaration is
     * empty/undefined or the host satisfies it; otherwise the caller
     * routes through `disableForCatalogMismatch`.
     *
     * Registry implementations without `getVersion` (narrow read-only
     * stubs) short-circuit to valid — matches legacy behavior for
     * bundles that cannot introspect metadata.
     */
    const validateCatalogCached = async (
      versionId: string,
    ): Promise<
      | { valid: true }
      | { valid: false; kind: "catalog"; missingIds: string[] }
      | { valid: false; kind: "route"; collisions: Array<{ method: string; path: string }> }
      | { valid: false; kind: "action"; collidingIds: string[] }
    > => {
      const {
        validateCatalogAgainstKnownIds,
        validateBundleRoutesAgainstKnownRoutes,
        validateBundleActionIdsAgainstKnownIds,
      } = await import("@crabbykit/bundle-host");
      if (!registry.getVersion) {
        validatedVersionId = versionId;
        return { valid: true };
      }
      const version = await registry.getVersion(versionId);
      const required = version?.metadata?.requiredCapabilities;
      const knownIdsArr = this.getBundleHostCapabilityIds();
      const knownIds = new Set(knownIdsArr);
      const catalogResult = validateCatalogAgainstKnownIds(required, knownIds);
      if (!catalogResult.valid) {
        return { valid: false, kind: "catalog", missingIds: catalogResult.missingIds };
      }
      // bundle-http-and-ui-surface: extend the cached guard with the
      // route + action-id collision checks. Both run only when the
      // version's metadata declares the corresponding `surfaces.*`
      // field; absent declaration → no check (legacy bundles
      // round-trip unchanged).
      const surfaces = version?.metadata?.surfaces;
      if (surfaces?.httpRoutes) {
        const routeResult = validateBundleRoutesAgainstKnownRoutes(
          surfaces.httpRoutes,
          this.runtime.getResolvedHttpHandlerSpecs(),
        );
        if (!routeResult.valid) {
          return { valid: false, kind: "route", collisions: routeResult.collisions };
        }
      }
      if (surfaces?.actionCapabilityIds) {
        const actionResult = validateBundleActionIdsAgainstKnownIds(
          surfaces.actionCapabilityIds,
          knownIds,
        );
        if (!actionResult.valid) {
          return { valid: false, kind: "action", collidingIds: actionResult.collidingIds };
        }
      }
      validatedVersionId = versionId;
      return { valid: true };
    };

    /**
     * Handle a dispatch-time catalog mismatch: clear the pointer via
     * `setActive(..., null, { skipCatalogCheck: true })`, reset the
     * cached pointer + the failure counter, and broadcast a structured
     * `bundle_disabled` event to the affected session so the client UI
     * can surface a diagnostic naming the missing ids. Does NOT
     * increment `consecutiveFailures` — catalog mismatches are
     * deterministic and orthogonal to the transient-failure counter.
     */
    const disableForCatalogMismatch = async (
      missingIds: string[],
      versionId: string,
      sessionId: string,
    ): Promise<void> => {
      const rationale = `catalog mismatch: missing [${missingIds.join(", ")}] declared by version '${versionId}'`;
      this.runtime.logger.warn("[BundleDispatch] Disabling bundle for catalog mismatch", {
        agentId,
        versionId,
        missingIds,
      });
      try {
        await registry.setActive(agentId, null, {
          rationale,
          sessionId,
          skipCatalogCheck: true,
        });
      } catch (err) {
        this.runtime.logger.error(
          "[BundleDispatch] Failed to clear registry pointer on catalog mismatch",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
      validatedVersionId = null;
      consecutiveFailures = 0;
      await ctx.storage.put("activeBundleVersionId", null);
      this.runtime.broadcastBundleDisabled?.(sessionId, {
        rationale,
        versionId,
        sessionId,
        reason: {
          code: "ERR_CAPABILITY_MISMATCH",
          missingIds,
          versionId,
        },
      });
    };

    /**
     * Dispatch-time route collision handler. Mirrors
     * `disableForCatalogMismatch` — clears the pointer, broadcasts
     * `bundle_disabled` with structured reason, falls back to static.
     */
    const disableForRouteCollision = async (
      collisions: Array<{ method: string; path: string }>,
      versionId: string,
      sessionId: string,
    ): Promise<void> => {
      const rationale = `route collision: bundle '${versionId}' declares routes overlapping host static handlers: ${collisions
        .map((c) => `${c.method} ${c.path}`)
        .join(", ")}`;
      this.runtime.logger.warn("[BundleDispatch] route-collision-disable", {
        agentId,
        versionId,
        collisions,
      });
      try {
        await registry.setActive(agentId, null, {
          rationale,
          sessionId,
          skipCatalogCheck: true,
        });
      } catch (err) {
        this.runtime.logger.error(
          "[BundleDispatch] Failed to clear registry pointer on route collision",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
      validatedVersionId = null;
      consecutiveFailures = 0;
      await ctx.storage.put("activeBundleVersionId", null);
      this.runtime.broadcastBundleDisabled?.(sessionId, {
        rationale,
        versionId,
        sessionId,
        reason: {
          code: "ERR_HTTP_ROUTE_COLLISION",
          collisions,
          versionId,
        },
      });
    };

    /**
     * Dispatch-time action-id collision handler. Same shape as
     * route-collision; broadcasts `ERR_ACTION_ID_COLLISION`.
     */
    const disableForActionIdCollision = async (
      collidingIds: string[],
      versionId: string,
      sessionId: string,
    ): Promise<void> => {
      const rationale = `action-id collision: bundle '${versionId}' declares onAction on host-registered ids: ${collidingIds.join(", ")}`;
      this.runtime.logger.warn("[BundleDispatch] action-id-collision-disable", {
        agentId,
        versionId,
        collidingIds,
      });
      try {
        await registry.setActive(agentId, null, {
          rationale,
          sessionId,
          skipCatalogCheck: true,
        });
      } catch (err) {
        this.runtime.logger.error(
          "[BundleDispatch] Failed to clear registry pointer on action-id collision",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
      validatedVersionId = null;
      consecutiveFailures = 0;
      await ctx.storage.put("activeBundleVersionId", null);
      this.runtime.broadcastBundleDisabled?.(sessionId, {
        rationale,
        versionId,
        sessionId,
        reason: {
          code: "ERR_ACTION_ID_COLLISION",
          collidingIds,
          versionId,
        },
      });
    };

    /**
     * Run the dispatch-time guard for the given version+sessionId. On
     * collision, route through the appropriate disable helper and
     * return `false` to signal the caller to fall through to static.
     * Returns `true` when the guard passed (or was a no-op).
     */
    const runDispatchGuard = async (versionId: string, sessionId: string): Promise<boolean> => {
      if (versionId === validatedVersionId) return true;
      const guard = await validateCatalogCached(versionId);
      if (guard.valid) return true;
      if (guard.kind === "catalog") {
        await disableForCatalogMismatch(guard.missingIds, versionId, sessionId);
      } else if (guard.kind === "route") {
        await disableForRouteCollision(guard.collisions, versionId, sessionId);
      } else {
        await disableForActionIdCollision(guard.collidingIds, versionId, sessionId);
      }
      return false;
    };

    // Drift check state. `autoRebuildAttempted` ensures we do the hash
    // comparison at most once per DO wake — it's a cold-path check guarded
    // by a hot-path short-circuit so steady-state dispatch pays a single
    // boolean compare. `autoRebuildInFlight` collapses concurrent first-turn
    // triggers into one rebuild.
    let autoRebuildAttempted = false;
    let autoRebuildInFlight: Promise<void> | null = null;

    const maybeAutoRebuild = async (versionId: string): Promise<void> => {
      if (autoRebuildAttempted) return;
      if (!bundleConfig.autoRebuild) {
        autoRebuildAttempted = true;
        return;
      }
      if (!registry.getVersion || !registry.createVersion) {
        autoRebuildAttempted = true;
        return;
      }
      if (autoRebuildInFlight) {
        await autoRebuildInFlight;
        return;
      }
      autoRebuildInFlight = (async () => {
        try {
          const { BUNDLE_RUNTIME_HASH, buildBundle, encodeEnvelope } = await import(
            "@crabbykit/bundle-host"
          );
          const version = await registry.getVersion!(versionId);
          const storedHash = version?.metadata?.runtimeHash;
          const sourceName = version?.metadata?.sourceName;
          if (!storedHash || storedHash === BUNDLE_RUNTIME_HASH) {
            return; // Up-to-date or legacy metadata missing hash — nothing to do.
          }
          if (!sourceName) {
            this.runtime.logger.warn(
              "[BundleDispatch] auto-rebuild skipped: version metadata missing sourceName",
              { agentId, versionId, storedHash, currentHash: BUNDLE_RUNTIME_HASH },
            );
            return;
          }
          this.runtime.logger.info("[BundleDispatch] auto-rebuild triggered: runtime drift", {
            agentId,
            oldVersionId: versionId,
            oldHash: storedHash,
            currentHash: BUNDLE_RUNTIME_HASH,
          });
          const started = Date.now();
          const autoBucket = bundleConfig.autoRebuild!.bucket(env);
          const autoNamespace = bundleConfig.autoRebuild!.namespace(env);
          const built = await buildBundle({
            bucket: autoBucket,
            namespace: autoNamespace,
            name: sourceName,
          });
          const envelope = encodeEnvelope(built.mainModule, built.modules);
          const newVersion = await registry.createVersion!({
            bytes: envelope,
            createdBy: "system:auto-rebuild",
            metadata: {
              runtimeHash: BUNDLE_RUNTIME_HASH,
              sourceName,
              buildTimestamp: Date.now(),
            },
          });
          if (newVersion.versionId === versionId) {
            this.runtime.logger.info(
              "[BundleDispatch] auto-rebuild produced identical bytes; nothing to promote",
              { agentId, versionId },
            );
            return;
          }
          await registry.setActive(agentId, newVersion.versionId, {
            rationale: "auto-rebuild: runtime hash drift",
            knownCapabilityIds: this.getBundleHostCapabilityIds(),
          });
          await this.runtime.bundlePointerRefresher?.();
          this.runtime.logger.info("[BundleDispatch] auto-rebuild completed", {
            agentId,
            oldVersionId: versionId,
            newVersionId: newVersion.versionId,
            durationMs: Date.now() - started,
          });
        } catch (err) {
          this.runtime.logger.error("[BundleDispatch] auto-rebuild failed", {
            agentId,
            versionId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Never wedge dispatch: fall through with the stale bundle still active.
        } finally {
          autoRebuildAttempted = true;
          autoRebuildInFlight = null;
        }
      })();
      await autoRebuildInFlight;
    };

    // Install the bundle pointer refresher on the runtime. Single
    // authoritative writer of `ctx.storage.activeBundleVersionId` for
    // in-process mutations. Workshop tools (and any other capability that
    // calls `bundle-registry.setActive`) MUST call
    // `AgentContext.notifyBundlePointerChanged()` after mutating — which
    // runs through here.
    this.runtime.bundlePointerRefresher = async () => {
      // Invalidate the validation cache BEFORE re-reading — the new
      // pointer may reference a version with a different catalog
      // declaration and needs fresh validation on the next turn.
      validatedVersionId = null;
      const id = await registry.getActiveForAgent(agentId);
      await ctx.storage.put("activeBundleVersionId", id);
      consecutiveFailures = 0;
    };

    // Install the `bundle_disabled` broadcaster so the catalog guard
    // (and future disable paths) can surface structured reason payloads
    // to connected clients.
    this.runtime.broadcastBundleDisabled = (sessionId: string, data) => {
      this.runtime.broadcastToSession(sessionId, {
        type: "bundle_disabled",
        sessionId,
        data,
      });
    };

    // Install the bundle prompt handler on the runtime
    this.runtime.bundlePromptHandler = async (
      sessionId: string,
      promptText: string,
    ): Promise<boolean> => {
      let versionId = await checkActiveBundle();
      if (!versionId) {
        return false; // No active bundle → static brain
      }

      // One-shot drift check per DO wake. Rebuilds the bundle if the
      // injected runtime source hash has advanced past the hash stamped
      // onto the currently-active version at deploy time. After a
      // successful rebuild, re-read the active pointer so the turn
      // executes on the new bytes.
      if (!autoRebuildAttempted) {
        await maybeAutoRebuild(versionId);
        const refreshed = await checkActiveBundle();
        if (refreshed) versionId = refreshed;
      }

      // Dispatch-time guard chain. Protects against out-of-band
      // pointer mutations, cold-start with stale cached pointer, and
      // host redeploys where capabilities, routes, or action ids
      // diverged from the bundle's declared metadata.
      // bundle-http-and-ui-surface: extends the catalog guard with
      // route + action-id collision checks (Decision 2 / Decision 5).
      if (!(await runDispatchGuard(versionId, sessionId))) {
        return false;
      }

      try {
        const bundleSubkey = await getBundleSubkey();
        const { mintToken } = await import("@crabbykit/bundle-host");
        const scope = await computeTokenScope(versionId);
        const bundleToken = await mintToken({ agentId, sessionId, scope }, bundleSubkey);

        // Phase 3: resolve active mode and project to the bundle env
        // shape. Bundle filter applies only when an active mode is
        // resolvable to a registered Mode.
        const activeMode = this.runtime.readActiveModeForSession(sessionId);
        const activeModeEnv = activeMode
          ? {
              id: activeMode.id,
              name: activeMode.name,
              tools: activeMode.tools,
              capabilities: activeMode.capabilities,
            }
          : undefined;

        if (activeMode) {
          const warningKey = `bundle:mode-warning-emitted:${agentId}:${versionId}`;
          const alreadyEmitted = await ctx.storage.get<boolean>(warningKey);
          if (!alreadyEmitted) {
            await ctx.storage.put(warningKey, true);
            this.runtime.logger.warn("[BundleDispatch] mode-aware filtering active for bundle", {
              agentId,
              bundleVersionId: versionId,
              modeId: activeMode.id,
              toolFilter: activeMode.tools,
              capabilityFilter: activeMode.capabilities,
            });
          }
        }

        const worker = loader.get(
          versionId,
          buildLoaderConfigGetter(
            versionId,
            bundleToken,
            activeModeEnv ? { __BUNDLE_ACTIVE_MODE: activeModeEnv } : undefined,
          ),
        );

        const res = await worker.getEntrypoint().fetch(
          new Request("https://bundle/turn", {
            method: "POST",
            body: JSON.stringify({ prompt: promptText, agentId, sessionId }),
          }),
        );

        if (!res.ok) {
          throw new Error(`Bundle turn returned ${res.status}`);
        }

        // Drain the body so the bundle's ReadableStream work() promise
        // resolves and finally{} broadcasts agent_end before we return.
        await res.text();

        consecutiveFailures = 0;
        return true;
      } catch (err) {
        consecutiveFailures++;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.runtime.logger.error(
          `[BundleDispatch] Failure ${consecutiveFailures}/${maxLoadFailures}: ${errMsg}`,
        );

        if (consecutiveFailures >= maxLoadFailures) {
          this.runtime.logger.warn("[BundleDispatch] Auto-reverting to static brain");
          try {
            await registry.setActive(agentId, null, {
              rationale: "auto-revert: poison bundle",
              skipCatalogCheck: true,
            });
          } catch (revertErr) {
            this.runtime.logger.error("[BundleDispatch] Failed to auto-revert", {
              error: revertErr instanceof Error ? revertErr.message : String(revertErr),
            });
          }
          consecutiveFailures = 0;
          validatedVersionId = null;
          await ctx.storage.put("activeBundleVersionId", null);
        }

        return false; // Fall through to static brain
      }
    };

    // Phase 2: shared lifecycle dispatcher used by /alarm,
    // /session-created, /client-event. Mints a token, decodes the
    // envelope via the shared loader-config helper, and POSTs the
    // supplied body. Returns the parsed JSON response from the bundle
    // (or null on transport error).
    const dispatchLifecycle = async (
      sessionId: string,
      path: "/alarm" | "/session-created" | "/client-event",
      body: unknown,
    ): Promise<Record<string, unknown> | null> => {
      const versionId = await checkActiveBundle();
      if (!versionId) return null;

      try {
        const bundleSubkey = await getBundleSubkey();
        const { mintToken: mint } = await import("@crabbykit/bundle-host");
        const scope = await computeTokenScope(versionId);
        const bundleToken = await mint({ agentId, sessionId, scope }, bundleSubkey);

        const worker = loader.get(versionId, buildLoaderConfigGetter(versionId, bundleToken));

        const res = await worker.getEntrypoint().fetch(
          new Request(`https://bundle${path}`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
        );
        if (!res.ok) {
          this.runtime.logger.warn(`[BundleDispatch] ${path} returned ${res.status}`);
          return null;
        }
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        this.runtime.logger.warn(`[BundleDispatch] ${path} dispatch failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };

    // bundle-http-and-ui-surface: HTTP dispatch into the bundle.
    // Mirrors `dispatchLifecycle` but adds:
    //  - a body cap check (413 on exceed, default 256 KiB, configurable
    //    via `BundleConfig.maxRequestBodyBytes` up to 1 MiB),
    //  - a per-dispatch timeout (504 on timeout, default 30 000 ms,
    //    configurable via `BundleConfig.httpDispatchTimeoutMs`).
    // Streaming bodies are a documented Non-Goal (v1).
    const DEFAULT_HTTP_BODY_CAP = 262_144;
    const HTTP_BODY_CAP_HARD_LIMIT = 1_048_576;
    const DEFAULT_HTTP_DISPATCH_TIMEOUT_MS = 30_000;

    const dispatchHttp = async (
      request: Request,
      capabilityId: string,
      declaredPath: string,
      sessionId: string | null,
    ): Promise<Response> => {
      const versionId = await checkActiveBundle();
      if (!versionId) {
        this.runtime.logger.info("[BundleDispatch] /http miss-no-bundle", {
          method: request.method,
          path: new URL(request.url).pathname,
        });
        return new Response("Not found", { status: 404 });
      }

      const bodyCap = Math.min(
        bundleConfig.maxRequestBodyBytes ?? DEFAULT_HTTP_BODY_CAP,
        HTTP_BODY_CAP_HARD_LIMIT,
      );
      const timeoutMs = bundleConfig.httpDispatchTimeoutMs ?? DEFAULT_HTTP_DISPATCH_TIMEOUT_MS;

      // Buffer the body once host-side and enforce the cap before
      // dispatching. ArrayBuffer round-trip avoids streaming.
      let bodyBytes: Uint8Array | null = null;
      if (request.body) {
        try {
          const buf = await request.arrayBuffer();
          if (buf.byteLength > 0) {
            if (buf.byteLength > bodyCap) {
              this.runtime.logger.warn("[BundleDispatch] /http body-cap exceeded", {
                method: request.method,
                path: declaredPath,
                received: buf.byteLength,
                cap: bodyCap,
              });
              return Response.json(
                {
                  error: "Payload Too Large",
                  cap: bodyCap,
                  received: buf.byteLength,
                },
                { status: 413 },
              );
            }
            bodyBytes = new Uint8Array(buf);
          }
        } catch (err) {
          this.runtime.logger.warn("[BundleDispatch] /http body buffering failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response("Bad Request", { status: 400 });
        }
      }

      const startedAt = Date.now();
      try {
        const bundleSubkey = await getBundleSubkey();
        const {
          mintToken: mint,
          serializeRequestForBundle,
          deserializeResponseFromBundle,
        } = await import("@crabbykit/bundle-host");
        const scope = await computeTokenScope(versionId);
        const bundleToken = await mint(
          { agentId, sessionId: sessionId ?? "", scope },
          bundleSubkey,
        );

        const envelope = serializeRequestForBundle({
          request,
          capabilityId,
          declaredPath,
          sessionId,
          bodyBytes,
        });

        const worker = loader.get(versionId, buildLoaderConfigGetter(versionId, bundleToken));

        const dispatchPromise = worker.getEntrypoint().fetch(
          new Request("https://bundle/http", {
            method: "POST",
            body: JSON.stringify(envelope),
          }),
        );
        const result = await Promise.race([
          dispatchPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (result === null) {
          this.runtime.logger.warn("[BundleDispatch] /http timeout", {
            method: request.method,
            path: declaredPath,
            timeoutMs,
          });
          return new Response("Gateway Timeout", { status: 504 });
        }

        const envelopeJson = (await result.json()) as Parameters<
          typeof deserializeResponseFromBundle
        >[0];
        const response = deserializeResponseFromBundle(envelopeJson);
        this.runtime.logger.info("[BundleDispatch] /http hit", {
          agentId,
          capabilityId,
          method: request.method,
          path: declaredPath,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (err) {
        this.runtime.logger.warn("[BundleDispatch] /http dispatch failed", {
          method: request.method,
          path: declaredPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return new Response("Bad Gateway", { status: 502 });
      }
    };

    const dispatchAction = async (
      capabilityId: string,
      action: string,
      data: unknown,
      sessionId: string,
    ): Promise<boolean> => {
      const versionId = await checkActiveBundle();
      if (!versionId) return false;

      try {
        const bundleSubkey = await getBundleSubkey();
        const { mintToken: mint, serializeActionForBundle } = await import(
          "@crabbykit/bundle-host"
        );
        const scope = await computeTokenScope(versionId);
        const bundleToken = await mint({ agentId, sessionId, scope }, bundleSubkey);

        const envelope = serializeActionForBundle({ capabilityId, action, data, sessionId });

        const worker = loader.get(versionId, buildLoaderConfigGetter(versionId, bundleToken));
        const res = await worker.getEntrypoint().fetch(
          new Request("https://bundle/action", {
            method: "POST",
            body: JSON.stringify(envelope),
          }),
        );
        if (!res.ok) {
          this.runtime.logger.warn(`[BundleDispatch] /action returned ${res.status}`);
          return false;
        }
        const result = (await res.json()) as { status?: string };
        this.runtime.logger.info("[BundleDispatch] /action hit", {
          agentId,
          capabilityId,
          action,
          sessionId,
          status: result.status ?? "unknown",
        });
        if (result.status === "noop") {
          this.runtime.logger.info("[BundleDispatch] /action no-onAction", {
            capabilityId,
            action,
          });
          return false;
        }
        return result.status === "ok";
      } catch (err) {
        this.runtime.logger.warn("[BundleDispatch] /action dispatch failed", {
          capabilityId,
          action,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    };

    // Install the bundle HTTP dispatcher. Reads the active version's
    // metadata, walks declared `surfaces.httpRoutes`, runs
    // `matchPathPattern` to extract params, runs the dispatch-time
    // guard, then dispatches into the bundle isolate.
    this.runtime.bundleHttpDispatcher = async (
      request: Request,
      sessionId: string | null,
    ): Promise<Response | null> => {
      const versionId = await checkActiveBundle();
      if (!versionId) return null;
      const version = await registry.getVersion?.(versionId);
      const declared = version?.metadata?.surfaces?.httpRoutes;
      if (!declared || declared.length === 0) return null;
      const { matchPathPattern } = await import("./agent-runtime-helpers.js");
      const url = new URL(request.url);
      let match: { capabilityId: string; declaredPath: string } | null = null;
      for (const decl of declared) {
        if (decl.method !== request.method) continue;
        const params = matchPathPattern(decl.path, url.pathname);
        if (params === null) continue;
        if (typeof decl.capabilityId !== "string" || decl.capabilityId.length === 0) continue;
        match = { capabilityId: decl.capabilityId, declaredPath: decl.path };
        break;
      }
      if (!match) return null;
      // Run the dispatch-time guard with a synthetic session id since
      // bundle HTTP routes are session-less in v1. The guard's
      // broadcast lands on no live transport when sessionId is "" —
      // that's acceptable: HTTP-route operators see the disable in
      // server logs.
      if (!(await runDispatchGuard(versionId, sessionId ?? ""))) {
        return null;
      }
      return dispatchHttp(request, match.capabilityId, match.declaredPath, sessionId);
    };

    this.runtime.bundleActionDispatcher = async (
      capabilityId: string,
      action: string,
      data: unknown,
      sessionId: string,
    ): Promise<boolean> => {
      const versionId = await checkActiveBundle();
      if (!versionId) return false;
      const version = await registry.getVersion?.(versionId);
      const declared = version?.metadata?.surfaces?.actionCapabilityIds;
      if (!declared || !declared.includes(capabilityId)) return false;
      if (!(await runDispatchGuard(versionId, sessionId))) {
        return false;
      }
      return dispatchAction(capabilityId, action, data, sessionId);
    };

    // Read the bundle's lifecycleHooks declaration so we can skip
    // Worker Loader instantiation entirely for hooks the bundle did
    // not register (Phase 2 metadata gate).
    const bundleHasLifecycleHook = async (
      kind: "onAlarm" | "onSessionCreated" | "onClientEvent",
    ): Promise<boolean> => {
      const versionId = await checkActiveBundle();
      if (!versionId) return false;
      const version = await registry.getVersion?.(versionId);
      const hooks = version?.metadata?.lifecycleHooks;
      if (!hooks) return false;
      return hooks[kind] === true;
    };

    // Install the client event handler for steer/abort during bundle turns.
    this.runtime.bundleClientEventHandler = async (
      sessionId: string,
      event: unknown,
    ): Promise<void> => {
      if (!(await bundleHasLifecycleHook("onClientEvent"))) return;
      await dispatchLifecycle(sessionId, "/client-event", { sessionId, event });
    };

    // Install the alarm handler. Per-handler 5s timeout bounds the
    // worst case if a bundle handler hangs; on timeout we treat as
    // `{}` (no skip, no prompt override) so the schedule's stored
    // prompt dispatches normally.
    this.runtime.bundleAlarmHandler = async (
      schedule,
    ): Promise<{ skip?: boolean; prompt?: string } | undefined> => {
      if (!(await bundleHasLifecycleHook("onAlarm"))) return undefined;
      const sessionId = `alarm-${schedule.id}`;
      const dispatchPromise = dispatchLifecycle(sessionId, "/alarm", { schedule });
      const timeoutMs = 5_000;
      const result = await Promise.race([
        dispatchPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (!result || result.status !== "ok") return undefined;
      const r = result.result as { skip?: boolean; prompt?: string } | undefined | null;
      if (!r || typeof r !== "object") return undefined;
      return r;
    };

    // Install the session-created handler. Fire-and-forget; static
    // onSessionCreated still fires regardless of bundle outcome.
    this.runtime.bundleSessionCreatedHandler = async (session): Promise<void> => {
      if (!(await bundleHasLifecycleHook("onSessionCreated"))) return;
      await dispatchLifecycle(session.id, "/session-created", { session });
    };

    // Install the pre-fetch handler for bundle HTTP endpoints.
    // Chain with any existing pre-fetch handler.
    const existingPreFetch = this.runtime.preFetchHandler;
    this.runtime.preFetchHandler = async (request: Request) => {
      const url = new URL(request.url);

      // POST /bundle/disable — out-of-band privileged endpoint
      if (url.pathname === "/bundle/disable" && request.method === "POST") {
        if (this.runtime.validateAuth) {
          const allowed = await this.runtime.validateAuth(request);
          if (!allowed) {
            return new Response("Unauthorized", { status: 401 });
          }
        }

        await registry.setActive(agentId, null, {
          rationale: "out-of-band disable",
          skipCatalogCheck: true,
        });
        consecutiveFailures = 0;
        validatedVersionId = null;
        await ctx.storage.put("activeBundleVersionId", null);

        return Response.json({ status: "disabled" });
      }

      // POST /bundle/refresh — re-read the active pointer from the
      // registry. Out-of-band escape hatch for mutations that happened
      // outside this DO process. Self-auths via `validateAuth`
      // (matches /bundle/disable). preFetch runs BEFORE the
      // handleRequest auth gate; without this self-check an
      // unauthenticated caller could force a registry round-trip on
      // every request (review m4).
      if (url.pathname === "/bundle/refresh" && request.method === "POST") {
        if (this.runtime.validateAuth) {
          const allowed = await this.runtime.validateAuth(request);
          if (!allowed) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
        await this.runtime.bundlePointerRefresher?.();
        const id = (await ctx.storage.get<string | null>("activeBundleVersionId")) ?? null;
        return Response.json({ status: "refreshed", activeVersionId: id });
      }

      // Reserve /bundle/* paths — never forward to bundle
      if (url.pathname.startsWith("/bundle/")) {
        return new Response("Not found", { status: 404 });
      }

      // Fall through to existing pre-fetch handler
      if (existingPreFetch) {
        return existingPreFetch(request);
      }
      return null;
    };
  }
}

export type { CompactionConfig } from "./agent-runtime.js";

// Compile-time assertion that `AgentDO` structurally satisfies
// `SpineHost`. If this type alias fails to resolve (or the helper
// function below fails to type-check), a spine method has been added,
// removed, renamed, or had its signature changed on `SpineHost`
// without a corresponding change on `AgentDO` / `AgentRuntime`. Fix
// the drift at the call site — do not weaken this check. The helper
// is exported under a `_` prefix so downstream packages compiled with
// `noUnusedLocals: true` don't trip on an unused local — it also
// doubles as a doc-visible "this is a static guard" marker.
//
// Every spine method takes `SpineCaller` as its first argument —
// the assertion catches both missing methods and argument-shape drift
// (e.g. forgetting to add the `caller` parameter on a new method).
//
// We use a generic helper rather than `const x: SpineHost = y` so the
// assertion applies to *every* `AgentDO<TEnv>` instance regardless of
// `TEnv`; the class's generic parameter would otherwise need a
// concrete substitution.
export function _assertSpineHost<TEnv>(x: AgentDO<TEnv>): SpineHost {
  return x;
}
