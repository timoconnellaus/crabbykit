/**
 * Types for bundle authoring.
 *
 * BundleEnv constrains the environment to only service bindings and
 * serializable values. The host's bundleEnv factory is the runtime gatekeeper;
 * type-level enforcement provides guidance but the host catches DataCloneError
 * for non-serializable values.
 */

import type { TObject } from "@sinclair/typebox";
import type { PromptOptions, PromptSection } from "./prompt/types.js";

// --- BundleEnv constraint ---

/**
 * Base type for bundle environments.
 *
 * Values must be either `Service<T>` (service bindings) or structurally-
 * serializable values (string, number, boolean, plain objects).
 *
 * Native Cloudflare bindings (Ai, R2Bucket, DurableObjectNamespace,
 * WorkerLoader, VectorizeIndex, D1Database, KVNamespace) are NOT allowed.
 * The host's `bundleEnv` factory catches non-serializable values at runtime
 * with a DataCloneError, falling back to the static brain.
 *
 * The `__BUNDLE_TOKEN` field is reserved and injected automatically by the
 * host dispatcher once per turn. It carries the unified per-turn HMAC token
 * whose payload `scope: string[]` lists which services the bundle is
 * authorized to call. Reserved scopes `"spine"` and `"llm"` are always
 * present; additional scopes come from the bundle's validated
 * `requiredCapabilities` catalog. Capability client subpaths read this
 * single field — no per-capability token naming convention required.
 */
export interface BundleEnv {
  __BUNDLE_TOKEN?: string;
  [key: string]: unknown;
}

/**
 * Nominal types the bundle runtime forbids in BundleEnv. These are the
 * native Cloudflare bindings that cannot cross the Worker Loader
 * structured-clone boundary.
 *
 * Used by {@link ValidateBundleEnv} as an opt-in compile-time check.
 */
export type ForbiddenBundleEnvValue =
  | Ai
  | R2Bucket
  | KVNamespace
  | D1Database
  | DurableObjectNamespace
  | VectorizeIndex
  | Queue
  | Hyperdrive
  | AnalyticsEngineDataset;

/**
 * Compile-time validator for bundle environments.
 *
 * Returns the env type `T` if every value is allowed, otherwise collapses
 * to `never` so downstream usage fails type-checking. Use in your bundle
 * code to opt into stricter checking:
 *
 * ```ts
 * interface MyEnv extends BundleEnv {
 *   TIMEZONE: string;
 *   LLM_SERVICE: Service<unknown>;
 * }
 * type _Check = ValidateBundleEnv<MyEnv>;  // OK
 *
 * interface BadEnv extends BundleEnv { AI: Ai }
 * type _Bad = ValidateBundleEnv<BadEnv>;   // never
 * ```
 */
export type ValidateBundleEnv<T> = {
  [K in keyof T]: T[K] extends ForbiddenBundleEnvValue ? never : T[K];
} extends infer Mapped
  ? Mapped extends T
    ? T
    : never
  : never;

// --- Bundle model config ---

/**
 * Model config for bundles. No `apiKey` — credentials are resolved
 * host-side via LlmService.
 */
export interface BundleModelConfig {
  provider: string;
  modelId: string;
  // apiKey is intentionally absent — bundles use LlmService for credentials
}

// --- Bundle prompt options ---

/**
 * Alias of the shared {@link PromptOptions}. Kept as a named re-export so
 * existing bundle code keeps compiling, but the single source of truth is
 * `./prompt/types.ts` — the same type the host runtime consumes.
 */
export type { PromptOptions as BundlePromptOptions } from "./prompt/types.js";

// --- Bundle capability requirement ---

/**
 * Declaration that a bundle requires a specific host-side capability.
 *
 * The `id` field matches a host-registered `Capability.id` (kebab-case,
 * 2..64 chars). Declarations are persisted into {@link BundleMetadata}
 * and validated against the host's registered capabilities at
 * `BundleRegistry.setActive` time (primary) and dispatch-time (backup).
 *
 * Declared requirements are a build-time-static contract — they must be
 * extractable from the bundle's metadata without running any bundle code.
 * Contrast with {@link BundleAgentSetup.capabilities}, the runtime factory
 * that needs `env` to construct bundle-side capability instances.
 */
export interface BundleCapabilityRequirement {
  /** Capability id, must match a host-registered capability's id.
   *  Kebab-case, charset `/^[a-z][a-z0-9-]*[a-z0-9]$/`, 2..64 chars. */
  id: string;
}

// --- Bundle metadata ---

export interface BundleMetadata {
  id?: string;
  name?: string;
  description?: string;
  declaredModel?: string;
  capabilityIds?: string[];
  authoredBy?: string;
  version?: string;
  buildTimestamp?: number;
  /**
   * Host-side capabilities this bundle requires to be bound in the host
   * worker's env. Populated by {@link defineBundleAgent} from
   * `setup.requiredCapabilities` after build-time input validation.
   *
   * Consumers needing only the id projection can call
   * `meta.requiredCapabilities?.map(r => r.id) ?? []` at the call site.
   */
  requiredCapabilities?: BundleCapabilityRequirement[];
  /**
   * Build-time declaration of which lifecycle hook endpoints the bundle
   * implements. Populated automatically by `defineBundleAgent` from
   * `setup.{onAlarm,onSessionCreated,onClientEvent}` field presence.
   * Host reads this at dispatch time and skips Worker Loader
   * instantiation entirely for hooks the bundle does not declare —
   * bundles published before Phase 2 (where this field is absent) are
   * treated as all-false and receive no host-driven dispatches.
   */
  lifecycleHooks?: {
    onAlarm?: boolean;
    onSessionCreated?: boolean;
    onClientEvent?: boolean;
  };
  /**
   * Build-time declaration of which HTTP routes and `onAction`-bearing
   * capabilities the bundle exposes. Populated by `defineBundleAgent` by
   * walking `setup.capabilities(probeEnv)` once with a minimal probe env.
   * Host reads this at dispatch time to decide whether to forward an
   * incoming HTTP request or `capability_action` message into the
   * bundle isolate. Absent on bundles published before this field
   * landed — treated as "no surfaces declared" (host falls through).
   *
   * Intentionally a separate top-level field (not nested under
   * `lifecycleHooks`) — HTTP routes and action ids are router declarations,
   * not lifecycle hooks.
   */
  surfaces?: {
    /** Routes contributed by `BundleCapability.httpHandlers` factories. */
    httpRoutes?: BundleRouteDeclaration[];
    /** Capability ids whose `BundleCapability` declared an `onAction` handler. */
    actionCapabilityIds?: string[];
  };
}

/**
 * Build-time declaration of a single HTTP route a bundle capability has
 * registered. Stored on {@link BundleMetadata.surfaces.httpRoutes} so the
 * host can answer "does any active bundle own this method+path" without
 * instantiating the bundle isolate.
 */
export interface BundleRouteDeclaration {
  /** HTTP method. Limited to GET/POST/PUT/DELETE in v1. */
  method: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Path the bundle registered. May contain `:name` wildcard segments
   * (matched by the same `matchPathPattern` helper the static handler
   * resolver uses).
   */
  path: string;
  /** Capability id that owns the handler — used for dispatch lookup. */
  capabilityId: string;
}

// --- Bundle lifecycle hook contexts (Phase 2) ---

/**
 * Minimal Schedule shape exposed to bundle `onAlarm` handlers. Mirrors
 * the host's `Schedule` from `agent-runtime/src/scheduling/types.ts`
 * (kept as a structural duplicate to avoid a value edge from bundle-sdk
 * into agent-runtime). Type-only imports from agent-runtime would also
 * work but the bundle SDK keeps its own copy so type-checking inside
 * the isolate has no cross-package dep.
 */
export interface BundleSchedule {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  handlerType: "prompt" | "callback" | "timer";
  prompt: string | null;
  sessionPrefix: string | null;
  ownerId: string | null;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  timezone: string | null;
  expiresAt: string | null;
  status: "idle" | "running" | "failed";
  lastError: string | null;
  retention: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Discriminated union for bundle client events (steer/abort and
 * future kinds). The wire shape is intentionally loose — handlers
 * branch on `kind` and treat `payload` as kind-specific.
 */
export interface BundleClientEvent {
  kind: "steer" | "abort" | string;
  payload: unknown;
}

/** Context for `setup.onAlarm`. */
export interface BundleAlarmContext {
  schedule: BundleSchedule;
  spine: BundleSpineClientLifecycle;
}

/** Context for `setup.onSessionCreated`. */
export interface BundleSessionContext {
  sessionId: string;
  spine: BundleSpineClientLifecycle;
}

/** Context for `setup.onClientEvent`. */
export interface BundleClientEventContext {
  sessionId: string;
  event: BundleClientEvent;
  spine: BundleSpineClientLifecycle;
}

/**
 * Minimal spine surface exposed to lifecycle hook contexts. Excludes
 * `hookBridge` for semantic reasons (turn-loop concept; firing
 * `recordToolExecution` outside a turn would generate a phantom event)
 * — see Decision 8 in the bundle-runtime-surface design.
 */
export interface BundleSpineClientLifecycle {
  appendEntry(entry: unknown): Promise<void>;
  getEntries(options?: unknown): Promise<unknown[]>;
  buildContext(): Promise<unknown>;
  broadcast(event: unknown): Promise<void>;
}

export type OnAlarmReturn =
  | void
  | Promise<void>
  | Promise<{ skip?: boolean; prompt?: string } | void>;

export type OnAlarmHandler<TEnv extends BundleEnv> = (
  env: TEnv,
  ctx: BundleAlarmContext,
) => OnAlarmReturn;

export type OnSessionCreatedHandler<TEnv extends BundleEnv> = (
  env: TEnv,
  session: { id: string; name: string },
  ctx: BundleSessionContext,
) => void | Promise<void>;

export type OnClientEventHandler<TEnv extends BundleEnv> = (
  env: TEnv,
  event: BundleClientEvent,
  ctx: BundleClientEventContext,
) => void | Promise<void>;

// --- Bundle setup (input to defineBundleAgent) ---

export interface BundleAgentSetup<TEnv extends BundleEnv = BundleEnv> {
  /**
   * Model configuration. No apiKey — resolved host-side via LlmService.
   */
  model: BundleModelConfig | (() => BundleModelConfig);

  /**
   * Prompt configuration or a full string replacement.
   */
  prompt?: string | PromptOptions;

  /**
   * Tool factories for this bundle's brain.
   */
  tools?: (env: TEnv) => unknown[];

  /**
   * Capability factories for this bundle's brain. Runtime factory —
   * evaluated inside the bundle isolate when the bundle boots, with
   * access to the bundle's projected `env`. Produces bundle-side
   * capability instances (e.g. `tavilyClient({ service: env.TAVILY })`).
   *
   * Phase-incompatible with {@link BundleAgentSetup.requiredCapabilities},
   * which is a build-time-static declaration extracted into metadata
   * without running any bundle code.
   */
  capabilities?: (env: TEnv) => BundleCapability[];

  /**
   * Host-side capabilities this bundle requires. Build-time-static
   * declaration — extractable from metadata without running any bundle
   * code. Validated against the host's registered capabilities at
   * `BundleRegistry.setActive` time (promotion rejected on mismatch) and
   * at dispatch time (pointer cleared on mismatch).
   *
   * Phase-incompatible with {@link BundleAgentSetup.capabilities}, the
   * runtime factory that needs `env` to construct bundle-side capability
   * instances.
   */
  requiredCapabilities?: BundleCapabilityRequirement[];

  /**
   * Per-due-schedule alarm hook (Phase 2). Fires once per due
   * schedule on the host's alarm wake. Return `{ skip: true }` to
   * cancel that schedule's normal dispatch; return `{ prompt: "..." }`
   * to override the stored prompt for the dispatched turn. Awaited
   * with a per-handler timeout (default 5s, configurable host-side);
   * timeouts are treated as `{}` and the schedule's stored prompt
   * dispatches normally. Matches static `onScheduleFire` semantics —
   * see Decision 6 in bundle-runtime-surface design.
   */
  onAlarm?: OnAlarmHandler<TEnv>;

  /**
   * Per-session-creation hook (Phase 2). Observation-only — the
   * return value is ignored. The host fires this alongside any
   * static `onSessionCreated` and proceeds regardless of bundle
   * handler outcome. Errors surface in structured telemetry but
   * never block host event handling.
   */
  onSessionCreated?: OnSessionCreatedHandler<TEnv>;

  /**
   * Per-client-event hook (Phase 2). Observation-only — the return
   * value is ignored. Fires for every steer/abort event the host
   * routes for an active bundle session, alongside the host's
   * existing transport client-event subscribers.
   */
  onClientEvent?: OnClientEventHandler<TEnv>;

  /**
   * Optional metadata about this bundle.
   */
  metadata?: BundleMetadata;
}

// --- Bundle capability (simplified for bundle-side) ---

export interface BundleCapability {
  id: string;
  name: string;
  description: string;
  /**
   * @deferred — no consumer in v2; planned for the
   * `bundle-config-namespaces` follow-up. Field is kept on the type so
   * forward-looking bundle authors who already populate it do not break
   * when the consumer lands.
   */
  configSchema?: TObject;
  tools?: (context: BundleContext) => unknown[];
  /**
   * Per-turn prompt sections. Phase 1 widens the return type to also
   * accept full {@link PromptSection} entries — host normalization
   * (see `normalizeBundlePromptSection`) attributes each entry to a
   * source for inspection. Bare `string` entries normalize to
   * `{ source: { type: "custom" } }`; `BundlePromptSection` entries
   * normalize to `{ source: { type: "capability", capabilityId,
   * capabilityName } }`.
   */
  promptSections?: (context: BundleContext) => Array<string | BundlePromptSection | PromptSection>;
  hooks?: BundleCapabilityHooks;
  /**
   * HTTP routes this capability mounts on the agent's fetch surface.
   * Resolved per turn from the bundle context. Walked once at build time
   * by `defineBundleAgent` to populate {@link BundleMetadata.surfaces.httpRoutes}
   * — the host uses that declaration to decide whether to forward an
   * incoming request to the bundle isolate.
   *
   * `sendPrompt` is intentionally NOT exposed on `BundleHttpContext` in
   * v1 (see the `bundle-http-and-ui-surface` proposal Non-Goals).
   * Webhook handlers that need to trigger a prompt return the prompt
   * text in the response body and let the upstream caller route it.
   */
  httpHandlers?: (context: BundleContext) => BundleHttpHandler[];
  /**
   * UI bridge action handler. Invoked when the host receives a
   * `capability_action` ClientMessage whose `capabilityId` matches this
   * capability's `id` AND no static handler shadows it. Static
   * handlers always win on collision; promotion-time and dispatch-time
   * guards prevent declared-id collisions with host capabilities.
   */
  onAction?: (action: string, data: unknown, ctx: BundleActionContext) => Promise<void>;
}

/**
 * HTTP handler declaration for a bundle capability. Same `{method, path,
 * handler}` shape as the static `Capability.httpHandlers` entries.
 *
 * `path` may contain `:name` wildcard segments — extracted into
 * `BundleHttpContext.params` by the host's `matchPathPattern` before
 * dispatch. Allowed methods are limited to `GET/POST/PUT/DELETE` in v1.
 */
export interface BundleHttpHandler {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (request: BundleHttpRequest, ctx: BundleHttpContext) => Promise<BundleHttpResponse>;
}

/**
 * Buffered HTTP request handed to a bundle capability's handler.
 * v1 carries the full request body as `Uint8Array` (decoded from base64
 * on the bundle side) — streaming is a documented Non-Goal.
 */
export interface BundleHttpRequest {
  method: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** Parsed query string. */
  query: Record<string, string>;
  /** Request body as raw bytes; `null` when no body was sent. */
  body: Uint8Array | null;
}

/**
 * Buffered HTTP response a bundle handler returns. Body is `Uint8Array`
 * or `null`; the host base64-encodes the bytes for the JSON envelope and
 * reconstructs a `Response` from `{status, headers, bodyBase64}`.
 */
export interface BundleHttpResponse {
  status: number;
  /** Lowercased header names; serialized to the response. */
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}

/**
 * Context handed to a bundle capability's HTTP handler. Mirrors the
 * subset of `CapabilityHttpContext` the v1 cross-isolate surface can
 * safely forward — see Decision 6 in the design.
 *
 * Documented v1 parity gaps (NOT present): `sessionStore` raw access,
 * `rateLimit`, `agentConfig`, `sendPrompt`. Each has a workaround in
 * the bundle authoring guide; their absence is documented, not a bug.
 */
export interface BundleHttpContext {
  capabilityId: string;
  agentId: string;
  /** `null` for session-less HTTP routes. v1 always passes `null`. */
  sessionId: string | null;
  /**
   * Public base URL of the host worker. Sourced from the host
   * `RuntimeContext.publicUrl` and injected into the bundle env at
   * dispatch time as `__BUNDLE_PUBLIC_URL`. Required for any bundle
   * webhook capability per the project convention that webhook
   * capabilities MUST read `ctx.publicUrl` rather than accept it as a
   * per-capability option.
   */
  publicUrl?: string;
  /** Path parameters extracted from `:name` wildcards. */
  params: Record<string, string>;
  /** Parsed query string (mirrors `BundleHttpRequest.query`). */
  query: Record<string, string>;
  /** Lowercased request header names (mirrors `BundleHttpRequest.headers`). */
  headers: Record<string, string>;
  /** Capability-scoped KV. */
  kvStore: BundleKvStoreClient;
  /** Session-scoped channel. `broadcast` is a no-op when `sessionId` is `null`. */
  channel: BundleSessionChannel;
  /** Emit a cost event — persisted to the session and broadcast as `cost_event`. */
  emitCost: (cost: BundleCostEvent) => Promise<void>;
}

/**
 * Context handed to a bundle capability's `onAction` handler.
 *
 * Documented v1 parity gaps (NOT present): `sessionStore` raw access,
 * `rateLimit`, `agentConfig`, `sendPrompt`. Spine lifecycle methods
 * (`appendEntry`, `getEntries`, `buildContext`, `broadcast`) are
 * available via {@link BundleSpineClientLifecycle}.
 */
export interface BundleActionContext {
  capabilityId: string;
  agentId: string;
  sessionId: string;
  publicUrl?: string;
  /** Capability-scoped KV. */
  kvStore: BundleKvStoreClient;
  /** Session-scoped channel for broadcast back to the originating session. */
  channel: BundleSessionChannel;
  /** Spine lifecycle client (`appendEntry`, `getEntries`, `buildContext`, `broadcast`). */
  spine: BundleSpineClientLifecycle;
  /** Emit a cost event — persisted to the session and broadcast as `cost_event`. */
  emitCost: (cost: BundleCostEvent) => Promise<void>;
}

export interface BundlePromptSection {
  kind: "included" | "excluded";
  name?: string;
  content?: string;
  reason?: string;
}

export interface BundleCapabilityHooks {
  beforeInference?: (messages: unknown[], ctx: BundleHookContext) => Promise<unknown[]>;
  afterToolExecution?: (event: unknown, ctx: BundleHookContext) => Promise<void>;
}

// --- Bundle context (async, spine-backed) ---

export interface BundleContext {
  agentId: string;
  sessionId: string;
  env: BundleEnv;
  sessionStore: BundleSessionStoreClient;
  kvStore: BundleKvStoreClient;
  scheduler: BundleSchedulerClient;
  channel: BundleSessionChannel;
  emitCost: (cost: BundleCostEvent) => Promise<void>;
  /**
   * Host-hook-bus bridge. Bundle runtime calls `recordToolExecution`
   * after every tool and `processBeforeInference` before every model
   * call so the host's hook chains fire against bundle-originated events.
   */
  hookBridge: BundleHookBridge;
  /**
   * Active mode identity (Phase 3). Populated by the dispatcher when
   * the session has an `activeModeId` matching a registered Mode.
   * Bundle code reads `ctx.activeMode?.id` to branch on which mode is
   * active. Allow/deny lists stay host-side — bundle never sees mode
   * internals (defense in depth, see Decision 9).
   */
  activeMode?: { id: string; name: string };
}

/**
 * Mode filter shape passed to the bundle via `__BUNDLE_ACTIVE_MODE`
 * env injection. The bundle applies these allow/deny lists to its
 * resolved tool + capability sets before composing the LLM call.
 * Defense-in-depth note (Decision 9): the bundle controls execution,
 * so the filter is enforced here as the recommendation surfaced to
 * the LLM rather than as a security boundary.
 */
export interface BundleActiveModeEnv {
  id: string;
  name: string;
  tools?: { allow?: string[]; deny?: string[] };
  capabilities?: { allow?: string[]; deny?: string[] };
}

export interface BundleHookContext extends BundleContext {
  capabilityId: string;
}

// --- Async adapter clients (bundle-side) ---

export interface BundleSessionStoreClient {
  appendEntry(entry: unknown): Promise<void>;
  getEntries(options?: unknown): Promise<unknown[]>;
  getSession(): Promise<unknown>;
  createSession(init?: unknown): Promise<unknown>;
  listSessions(filter?: unknown): Promise<unknown[]>;
  buildContext(): Promise<unknown>;
  getCompactionCheckpoint(): Promise<unknown>;
}

export interface BundleKvStoreClient {
  get(capabilityId: string, key: string): Promise<unknown>;
  put(capabilityId: string, key: string, value: unknown, options?: unknown): Promise<void>;
  delete(capabilityId: string, key: string): Promise<void>;
  list(capabilityId: string, prefix?: string): Promise<unknown[]>;
}

export interface BundleSchedulerClient {
  create(schedule: unknown): Promise<unknown>;
  update(scheduleId: string, patch: unknown): Promise<void>;
  delete(scheduleId: string): Promise<void>;
  list(): Promise<unknown[]>;
  setAlarm(timestamp: number): Promise<void>;
}

/**
 * Send-only channel — bundles can broadcast but not receive via channel.
 * Incoming client events arrive at POST /client-event, not via channel callbacks.
 */
export interface BundleSessionChannel {
  broadcast(event: unknown): Promise<void>;
  broadcastGlobal(event: unknown): Promise<void>;
}

export interface BundleCostEvent {
  capabilityId: string;
  toolName: string;
  amount: number;
  currency: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Tool-execution event payload the bundle SDK forwards to the host via
 * the hook bridge. Shape mirrors agent-runtime's `ToolExecutionEvent`
 * (`toolName`, `args`, `isError`); kept structural rather than imported
 * to keep the bundle runtime free of cross-package type edges.
 */
export interface BundleToolExecutionEvent {
  toolName: string;
  args: unknown;
  isError: boolean;
}

/**
 * Before-tool-execution event payload the bundle SDK forwards to the
 * host via the hook bridge. Shape mirrors agent-runtime's
 * `BeforeToolExecutionEvent` (`toolName`, `args`, `toolCallId`); kept
 * structural rather than imported to keep the bundle runtime free of
 * cross-package type edges.
 */
export interface BundleBeforeToolExecutionEvent {
  toolName: string;
  args: unknown;
  toolCallId: string;
}

/**
 * Result of the `beforeToolExecution` hook chain as observed by the
 * bundle. When `block: true`, the bundle MUST skip tool execution and
 * surface `reason` to the model as a tool error.
 */
export interface BundleBeforeToolExecutionResult {
  block?: boolean;
  reason?: string;
}

/**
 * Bundle-side hook bridge client. Calls SpineService's
 * `recordToolExecution` (observer), `processBeforeInference` (mutator),
 * and `processBeforeToolExecution` (pre-tool gate). Messages cross the
 * RPC boundary as `unknown[]` — the host verifies and narrows to
 * `AgentMessage[]` inside its hook chain.
 */
export interface BundleHookBridge {
  recordToolExecution(event: BundleToolExecutionEvent): Promise<void>;
  processBeforeInference(messages: unknown[]): Promise<unknown[]>;
  processBeforeToolExecution(
    event: BundleBeforeToolExecutionEvent,
  ): Promise<BundleBeforeToolExecutionResult | undefined>;
}

// --- Bundle default-export contract ---

/**
 * The shape of a compiled bundle's default export (fetch handler).
 * Discriminates on URL path:
 * - POST /turn — handle a prompt turn
 * - POST /client-event — handle a WebSocket message routed from host
 * - POST /alarm — handle an alarm fire
 * - POST /session-created — handle session initialization
 * - POST /http — handle a bundle-routed HTTP request
 * - POST /action — handle a bundle-routed `capability_action` dispatch
 * - POST /smoke — load-time smoke test
 * - POST /metadata — return declared metadata as JSON
 */
export interface BundleExport {
  fetch(request: Request, env: BundleEnv): Promise<Response>;
}
