/**
 * Bundle brain override configuration shared by {@link AgentDO.initBundleDispatch}
 * and {@link defineAgent}'s `bundle` field.
 *
 * Inlined here (rather than imported from `@claw-for-cloudflare/bundle-host`)
 * to avoid a circular workspace dependency: bundle-host depends on
 * agent-runtime for the DO surface, so agent-runtime cannot depend on
 * bundle-host for its public types. `@claw-for-cloudflare/bundle-host`
 * re-exports these types from its own `bundle-config.ts` barrel so
 * host-side consumers still import them from the host package.
 */

/**
 * Metadata fields the auto-rebuild and catalog-validation paths read off
 * a bundle version. A subset of `BundleMetadata` from
 * `@claw-for-cloudflare/bundle-sdk` / `@claw-for-cloudflare/bundle-registry`,
 * redeclared here to keep this package dependency-free.
 */
export interface BundleVersionMetadata {
  /** SHA-256 hex of the runtime source injected when the bundle was built. */
  runtimeHash?: string;
  /** R2 source directory name, required for rebuild. */
  sourceName?: string;
  /** Millisecond timestamp of the last build. */
  buildTimestamp?: number;
  /**
   * Host-side capabilities this bundle declared via
   * `defineBundleAgent({ requiredCapabilities: [...] })`. Read by
   * `BundleRegistry.setActive` and the dispatch-time guard to validate
   * that the host's registered capability set satisfies the bundle's
   * declaration. Absent on legacy bundles authored before the catalog
   * field landed — treated as "no requirements" (always passes).
   */
  requiredCapabilities?: Array<{ id: string }>;
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
 * Options accepted by `BundleRegistry.setActive`. Authoritative type for
 * both `D1BundleRegistry` (in `@claw-for-cloudflare/bundle-registry`) and
 * `InMemoryBundleRegistry` (in `@claw-for-cloudflare/bundle-host`).
 *
 * When `versionId !== null` AND `skipCatalogCheck !== true`, the registry
 * validates the bundle's `requiredCapabilities` declaration against
 * `knownCapabilityIds` before flipping the pointer. A mismatch throws
 * `CapabilityMismatchError`; the pointer is not flipped. Missing
 * `knownCapabilityIds` with validation enabled throws `TypeError` to
 * force the caller to make the decision explicit.
 *
 * When `versionId === null` OR `skipCatalogCheck === true`, validation
 * is skipped. Clearing the pointer always skips validation because
 * there is nothing to validate.
 */
export interface SetActiveOptions {
  /** Human-readable rationale recorded in the deployment log. */
  rationale?: string;
  /** Session id that initiated the promotion (for attribution). */
  sessionId?: string;
  /**
   * Pre-computed set of host-known capability ids. Required when
   * `skipCatalogCheck` is not `true` and `versionId` is non-null;
   * missing it is a programmer error and throws `TypeError`.
   */
  knownCapabilityIds?: string[];
  /**
   * Skip catalog validation. Supported use cases:
   *
   * - Cross-deployment promotions where the source host's capability
   *   set is not authoritative (workshop deploying to a different
   *   target worker).
   * - Clearing the pointer (`versionId: null`) — always skips
   *   internally; passing this flag is documentation.
   * - Internal auto-revert and catalog-mismatch-disable paths, where
   *   the dispatcher has already decided to disable and the registry
   *   should not re-validate.
   */
  skipCatalogCheck?: boolean;
}

/**
 * Thrown by `BundleRegistry.setActive` (and by `BundleDispatcher`'s
 * dispatch-time guard) when a bundle's declared `requiredCapabilities`
 * include ids that are not registered on the host.
 *
 * The `code` field survives structured-clone boundaries even when class
 * identity is lost across RPC frames, so cross-isolate consumers should
 * discriminate on `code === "ERR_CAPABILITY_MISMATCH"` rather than
 * `error instanceof CapabilityMismatchError`.
 */
export class CapabilityMismatchError extends Error {
  readonly code = "ERR_CAPABILITY_MISMATCH" as const;
  readonly missingIds: string[];
  readonly versionId: string;

  constructor(args: { missingIds: string[]; versionId: string; message?: string }) {
    const msg =
      args.message ??
      `bundle version '${args.versionId}' requires capabilities not registered on this host: ${args.missingIds.join(", ")}`;
    super(msg);
    this.name = "CapabilityMismatchError";
    this.missingIds = args.missingIds;
    this.versionId = args.versionId;
  }
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
  /**
   * Flip the active bundle pointer for an agent. Validates the bundle's
   * declared `requiredCapabilities` against `options.knownCapabilityIds`
   * by default; pass `skipCatalogCheck: true` to bypass. Throws
   * `CapabilityMismatchError` on catalog mismatch (pointer unchanged)
   * and `TypeError` when `versionId` is non-null, `skipCatalogCheck` is
   * not `true`, and `knownCapabilityIds` is missing.
   */
  setActive(
    agentId: string,
    versionId: string | null,
    options?: SetActiveOptions,
  ): Promise<void>;
  getBytes(versionId: string): Promise<ArrayBuffer | null>;
  /**
   * Read the metadata row for a specific bundle version. Required for
   * auto-rebuild to compare the stored `runtimeHash` against the current
   * loaded runtime, and for catalog validation to read the declared
   * `requiredCapabilities`. Optional — absence disables both.
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
 * `BundleSourceBucket` type exported from `@claw-for-cloudflare/bundle-host`
 * but kept local so this package has no import-time dependency on bundle-host.
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
