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
 * Registry interface for bundle version management. Consumers provide a
 * registry implementation (e.g., D1BundleRegistry, InMemoryBundleRegistry).
 */
export interface BundleRegistry {
  getActiveForAgent(agentId: string): Promise<string | null>;
  setActive(
    agentId: string,
    versionId: string | null,
    opts?: { rationale?: string; sessionId?: string },
  ): Promise<void>;
  getBytes(versionId: string): Promise<ArrayBuffer | null>;
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
}
