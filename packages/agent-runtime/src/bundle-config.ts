/**
 * Bundle brain override configuration shared by {@link AgentDO.initBundleDispatch}
 * and {@link defineAgent}'s `bundle` field.
 *
 * Inlined here (rather than imported from `@claw-for-cloudflare/agent-bundle`)
 * to avoid a circular workspace dependency: agent-bundle depends on
 * agent-runtime for the DO surface, so agent-runtime cannot depend on
 * agent-bundle for its public types.
 */

/**
 * Metadata fields the auto-rebuild path reads off a bundle version. A subset
 * of `BundleMetadata` from `@claw-for-cloudflare/bundle-registry`, redeclared
 * here to keep this package dependency-free.
 */
export interface BundleVersionMetadata {
  /** SHA-256 hex of the runtime source injected when the bundle was built. */
  runtimeHash?: string;
  /** R2 source directory name, required for rebuild. */
  sourceName?: string;
  /** Millisecond timestamp of the last build. */
  buildTimestamp?: number;
}

/** Shape returned from `BundleRegistry.getVersion` used by drift detection. */
export interface BundleVersionInfo {
  versionId: string;
  metadata: BundleVersionMetadata | null;
}

/**
 * Options accepted by `BundleRegistry.createVersion` when the auto-rebuild
 * path writes a regenerated bundle.
 */
export interface CreateBundleVersionOpts {
  bytes: ArrayBuffer;
  createdBy?: string;
  metadata?: BundleVersionMetadata;
}

/**
 * Registry interface for bundle version management. Consumers provide a
 * registry implementation (e.g., D1BundleRegistry, InMemoryBundleRegistry).
 *
 * The three required methods are the minimum dispatch surface. The two
 * optional methods (`getVersion`, `createVersion`) enable auto-rebuild on
 * runtime source drift — when both are present AND {@link BundleConfig.autoRebuild}
 * is configured, the DO will regenerate stale bundles on startup.
 */
export interface BundleRegistry {
  getActiveForAgent(agentId: string): Promise<string | null>;
  setActive(
    agentId: string,
    versionId: string | null,
    opts?: { rationale?: string; sessionId?: string },
  ): Promise<void>;
  getBytes(versionId: string): Promise<ArrayBuffer | null>;
  /**
   * Read the metadata row for a specific bundle version. Required for
   * auto-rebuild to compare the stored `runtimeHash` against the current
   * loaded runtime. Optional — absence disables drift detection.
   */
  getVersion?(versionId: string): Promise<BundleVersionInfo | null>;
  /**
   * Persist a newly-built bundle envelope. Required for auto-rebuild to
   * write the regenerated version before flipping the active pointer.
   * Optional — absence disables drift detection.
   */
  createVersion?(opts: CreateBundleVersionOpts): Promise<BundleVersionInfo>;
}

/**
 * Narrow R2 surface required by the auto-rebuild path. Mirrors the
 * `BundleSourceBucket` type exported from `@claw-for-cloudflare/agent-bundle/host`
 * but kept local so this package has no import-time dependency on agent-bundle.
 */
export interface BundleSourceBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(opts: { prefix: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

/**
 * Auto-rebuild source resolution. When present on {@link BundleConfig.autoRebuild},
 * the DO compares the active version's recorded `runtimeHash` against the
 * currently-loaded runtime hash at startup. On mismatch, it rebuilds the
 * bundle from source files under
 * `{namespace}/workshop/bundles/{sourceName}/` and auto-promotes the new
 * version.
 */
export interface BundleAutoRebuildConfig<TEnv = Record<string, unknown>> {
  /** R2 bucket holding authored source files. */
  bucket: (env: TEnv) => BundleSourceBucket;
  /** Namespace prefix keyed under `{namespace}/workshop/bundles/{name}/...`. */
  namespace: (env: TEnv) => string;
}

/**
 * Bundle brain override config. When provided to {@link defineAgent} or
 * installed via {@link AgentDO.initBundleDispatch}, the agent gains the
 * ability to dispatch turns into a registry-backed bundle loaded via
 * Worker Loader. When omitted, the agent is purely static — no new code
 * paths, no new dependencies, no overhead.
 */
export interface BundleConfig<TEnv = Record<string, unknown>> {
  /** Factory returning a BundleRegistry instance. */
  registry: (env: TEnv) => BundleRegistry;
  /** Factory returning the Worker Loader binding. */
  loader: (env: TEnv) => WorkerLoader;
  /** Factory returning the master HMAC key for capability token minting. */
  authKey: (env: TEnv) => string;
  /**
   * Factory projecting the bundle's env from the host env.
   * Only service bindings and serializable values. __SPINE_TOKEN and
   * __LLM_TOKEN are injected automatically. Native bindings that aren't
   * structured-cloneable cause DataCloneError → fallback to static brain.
   */
  bundleEnv: (env: TEnv) => Record<string, unknown>;
  /** Consecutive load failures before auto-revert to static. Default: 3. */
  maxLoadFailures?: number;
  /**
   * Optional auto-rebuild support. When present, stale bundles (those built
   * against an older runtime source) are regenerated on DO startup from the
   * authored source files in R2. Requires the registry to also implement
   * `getVersion` and `createVersion`.
   */
  autoRebuild?: BundleAutoRebuildConfig<TEnv>;
}
