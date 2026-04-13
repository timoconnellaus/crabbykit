/**
 * Types for bundle authoring.
 *
 * BundleEnv constrains the environment to only service bindings and
 * serializable values. The host's bundleEnv factory is the runtime gatekeeper;
 * type-level enforcement provides guidance but the host catches DataCloneError
 * for non-serializable values.
 */

import type { TObject } from "@sinclair/typebox";

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
 * The `__SPINE_TOKEN` field is reserved and injected by the host dispatcher.
 */
export interface BundleEnv {
  __SPINE_TOKEN?: string;
  [key: string]: unknown;
}

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

export interface BundlePromptOptions {
  agentName?: string;
  agentDescription?: string;
  identity?: string | false;
  safety?: string | false;
  timezone?: string;
  runtime?: string | false;
  additionalSections?: string[];
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
  prompt?: string | BundlePromptOptions;

  /**
   * Tool factories for this bundle's brain.
   */
  tools?: (env: TEnv) => unknown[];

  /**
   * Capability factories for this bundle's brain.
   */
  capabilities?: (env: TEnv) => BundleCapability[];

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
