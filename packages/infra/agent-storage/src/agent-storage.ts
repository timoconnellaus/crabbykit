import type { AgentStorage } from "./types.js";

export interface AgentStorageOptions {
  /** R2 bucket instance or getter. */
  bucket: R2Bucket | (() => R2Bucket);
  /**
   * Namespace string or getter. Used as R2 key prefix,
   * Vectorize namespace filter, and container agent ID.
   */
  namespace: string | (() => string);
}

/**
 * Create a shared storage identity for an agent.
 *
 * Pass the returned object to r2Storage, vectorMemory, and
 * CloudflareSandboxProvider to ensure they all operate on the
 * same R2 namespace.
 */
export function agentStorage(options: AgentStorageOptions): AgentStorage {
  const bucket =
    typeof options.bucket === "function" ? options.bucket : () => options.bucket as R2Bucket;
  const namespace =
    typeof options.namespace === "function" ? options.namespace : () => options.namespace as string;

  return { bucket, namespace };
}
