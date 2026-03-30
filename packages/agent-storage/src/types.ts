/**
 * Shared storage identity that multiple capabilities can reference
 * to ensure they operate on the same R2 namespace.
 *
 * Created via `agentStorage()`. Pass to r2Storage, vectorMemory,
 * and CloudflareSandboxProvider to unify bucket + namespace config.
 */
export interface AgentStorage {
  /** R2 bucket accessor. */
  readonly bucket: () => R2Bucket;
  /**
   * Namespace string used as:
   * - R2 key prefix for r2Storage and vectorMemory (`{namespace}/path`)
   * - Vectorize namespace filter for vectorMemory
   * - FUSE mount prefix (AGENT_ID) for cloudflare-sandbox containers
   * - x-agent-id header value for sandbox RPC
   */
  readonly namespace: () => string;
}
