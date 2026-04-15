import { DurableObject } from "cloudflare:workers";
import type { AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
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
    let spineSubkeyPromise: Promise<CryptoKey> | null = null;
    let llmSubkeyPromise: Promise<CryptoKey> | null = null;

    const getSpineSubkey = async (): Promise<CryptoKey> => {
      if (!spineSubkeyPromise) {
        spineSubkeyPromise = (async () => {
          const { deriveMintSubkey } = await import("@claw-for-cloudflare/bundle-host");
          return deriveMintSubkey(masterKey, "claw/spine-v1");
        })();
      }
      return spineSubkeyPromise;
    };

    const getLlmSubkey = async (): Promise<CryptoKey> => {
      if (!llmSubkeyPromise) {
        llmSubkeyPromise = (async () => {
          const { deriveMintSubkey } = await import("@claw-for-cloudflare/bundle-host");
          return deriveMintSubkey(masterKey, "claw/llm-v1");
        })();
      }
      return llmSubkeyPromise;
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
            "@claw-for-cloudflare/bundle-host"
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
      const id = await registry.getActiveForAgent(agentId);
      await ctx.storage.put("activeBundleVersionId", id);
      consecutiveFailures = 0;
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

      try {
        const [spineSubkey, llmSubkey] = await Promise.all([getSpineSubkey(), getLlmSubkey()]);
        const { mintToken } = await import("@claw-for-cloudflare/bundle-host");
        // Separate token per service (same payload, different HKDF
        // subkeys) so SpineService and LlmService verify independently.
        const [spineToken, llmToken] = await Promise.all([
          mintToken({ agentId, sessionId }, spineSubkey),
          mintToken({ agentId, sessionId }, llmSubkey),
        ]);

        const projectedEnv = bundleConfig.bundleEnv(env);

        const worker = loader.get(versionId, async () => {
          const bytes = await registry.getBytes(versionId);
          if (!bytes) {
            throw new Error(`Bundle bytes not found for version ${versionId}`);
          }
          const source = new TextDecoder().decode(bytes);
          // Workshop writes a v1 envelope (`{v:1, mainModule, modules}`)
          // via `@cloudflare/worker-bundler#createWorker`. Legacy bundles
          // were raw single-file JS; `decodeBundlePayload` handles both.
          // Without this decode, envelope bytes get fed to the loader as
          // raw JS and workerd fails with "Unexpected token ':'" on the
          // opening `{"v":1,…}`.
          const { decodeBundlePayload } = await import("@claw-for-cloudflare/bundle-host");
          const { mainModule, modules } = decodeBundlePayload(source);
          return {
            compatibilityDate: "2025-12-01",
            compatibilityFlags: ["nodejs_compat"],
            mainModule,
            modules,
            env: {
              ...projectedEnv,
              __SPINE_TOKEN: spineToken,
              __LLM_TOKEN: llmToken,
            },
            globalOutbound: null,
          };
        });

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
        // Bundle broadcasts streaming events live via SpineService →
        // transport.broadcastToSession; the HTTP body itself is a short ack.
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
            });
          } catch (revertErr) {
            this.runtime.logger.error("[BundleDispatch] Failed to auto-revert", {
              error: revertErr instanceof Error ? revertErr.message : String(revertErr),
            });
          }
          consecutiveFailures = 0;
          await ctx.storage.put("activeBundleVersionId", null);
        }

        return false; // Fall through to static brain
      }
    };

    // Install the client event handler for steer/abort during bundle turns.
    this.runtime.bundleClientEventHandler = async (
      sessionId: string,
      event: unknown,
    ): Promise<void> => {
      const versionId = await checkActiveBundle();
      if (!versionId) return;

      try {
        const [spineSubkey, llmSubkey] = await Promise.all([getSpineSubkey(), getLlmSubkey()]);
        const { mintToken: mint } = await import("@claw-for-cloudflare/bundle-host");
        const [spineToken, llmToken] = await Promise.all([
          mint({ agentId, sessionId }, spineSubkey),
          mint({ agentId, sessionId }, llmSubkey),
        ]);
        const projectedEnv = bundleConfig.bundleEnv(env);

        const worker = loader.get(versionId, async () => {
          const bytes = await registry.getBytes(versionId);
          if (!bytes) throw new Error("Bundle bytes not found");
          const source = new TextDecoder().decode(bytes);
          return {
            compatibilityDate: "2025-12-01",
            compatibilityFlags: ["nodejs_compat"],
            mainModule: "bundle.js",
            modules: { "bundle.js": source },
            env: {
              ...projectedEnv,
              __SPINE_TOKEN: spineToken,
              __LLM_TOKEN: llmToken,
            },
            globalOutbound: null,
          };
        });

        await worker.getEntrypoint().fetch(
          new Request("https://bundle/client-event", {
            method: "POST",
            body: JSON.stringify(event),
          }),
        );
      } catch (err) {
        // Client event delivery is best-effort
        this.runtime.logger.warn("[BundleDispatch] Client event delivery failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
        });
        consecutiveFailures = 0;
        await ctx.storage.put("activeBundleVersionId", null);

        return Response.json({ status: "disabled" });
      }

      // POST /bundle/refresh — re-read the active pointer from the
      // registry. Out-of-band escape hatch for mutations that happened
      // outside this DO process.
      if (url.pathname === "/bundle/refresh" && request.method === "POST") {
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
