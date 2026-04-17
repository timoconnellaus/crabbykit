/**
 * Types for bundle authoring.
 *
 * BundleEnv constrains the environment to only service bindings and
 * serializable values. The host's bundleEnv factory is the runtime gatekeeper;
 * type-level enforcement provides guidance but the host catches DataCloneError
 * for non-serializable values.
 */

import type { TObject } from "@sinclair/typebox";
import type { PromptOptions } from "./prompt/types.js";

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
}

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
   * Optional metadata about this bundle.
   */
  metadata?: BundleMetadata;
}

// --- Bundle capability (simplified for bundle-side) ---

export interface BundleCapability {
  id: string;
  name: string;
  description: string;
  configSchema?: TObject;
  tools?: (context: BundleContext) => unknown[];
  promptSections?: (context: BundleContext) => Array<string | BundlePromptSection>;
  hooks?: BundleCapabilityHooks;
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
 * - POST /smoke — load-time smoke test
 * - POST /metadata — return declared metadata as JSON
 */
export interface BundleExport {
  fetch(request: Request, env: BundleEnv): Promise<Response>;
}
