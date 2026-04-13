/**
 * BundleConfig — the config field consumers add to defineAgent to enable
 * bundle brain override.
 *
 * When present, the agent gains the ability to dispatch turns into a
 * registry-backed bundle while still serving the static brain whenever
 * no bundle is active.
 */

/**
 * Bundle registry interface. Consumers provide a registry implementation
 * (e.g., D1BundleRegistry from packages/bundle-registry) that stores
 * version metadata and active-version pointers.
 */
export interface BundleRegistry {
  /** Get the active bundle version ID for an agent, or null if no bundle is active. */
  getActiveForAgent(agentId: string): Promise<string | null>;
  /** Set the active bundle version for an agent. null clears the active bundle. */
  setActive(
    agentId: string,
    versionId: string | null,
    opts?: { rationale?: string; sessionId?: string },
  ): Promise<void>;
  /** Get compiled bundle bytes from KV by version ID. */
  getBytes(versionId: string): Promise<ArrayBuffer | null>;
}

/**
 * Configuration for bundle support on a defineAgent-produced DO.
 */
export interface BundleConfig<TEnv = Record<string, unknown>> {
  /**
   * Factory that returns a BundleRegistry instance.
   * Receives the env so it can access D1/KV bindings.
   */
  registry: (env: TEnv) => BundleRegistry;

  /**
   * The Worker Loader binding name. The factory receives env and returns
   * the LOADER binding.
   */
  loader: (env: TEnv) => WorkerLoader;

  /**
   * The master HMAC key for capability token minting.
   * Receives env so it can read from a secret binding.
   */
  authKey: (env: TEnv) => string;

  /**
   * Factory that projects the bundle's env from the host env.
   * Only service bindings and serializable values should be projected.
   * The __SPINE_TOKEN field is injected automatically per turn.
   * Native bindings that are not structured-cloneable will cause a
   * DataCloneError, falling back to the static brain.
   */
  bundleEnv: (env: TEnv) => Record<string, unknown>;

  /**
   * Number of consecutive load failures before auto-reverting to static brain.
   * Default: 3.
   */
  maxLoadFailures?: number;
}

/**
 * State tracked per bundle-enabled agent for dispatch.
 */
export interface BundleDispatchState {
  /** Cached active version ID from ctx.storage, or null. */
  activeVersionId: string | null;
  /** Consecutive load failure counter. */
  consecutiveFailures: number;
}
