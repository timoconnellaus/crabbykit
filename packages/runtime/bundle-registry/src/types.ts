/**
 * BundleRegistry types — shared between D1 and in-memory implementations.
 */

import type { BundleRegistry, SetActiveOptions } from "@crabbykit/agent-runtime";

export type { BundleRegistry, SetActiveOptions };

/**
 * Extended registry interface for code paths that must persist bytes
 * (e.g., workshop_deploy). The narrow runtime `BundleRegistry` is
 * read-only — it can flip pointers but has no way to store a version
 * blob, so a `setActive` call against a never-persisted version would
 * leave the next dispatch turn looking up bytes that don't exist.
 *
 * `D1BundleRegistry` satisfies this wider interface by virtue of its
 * `createVersion` method, which writes bytes to KV and inserts the
 * corresponding D1 row.
 */
export interface BundleRegistryWriter extends BundleRegistry {
  createVersion(opts: CreateVersionOpts): Promise<BundleVersion>;
}

export interface BundleVersion {
  versionId: string;
  kvKey: string;
  sizeBytes: number;
  createdAt: number;
  createdBy: string | null;
  metadata: BundleMetadata | null;
}

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
   * SHA-256 hex of the `BUNDLE_RUNTIME_SOURCE` that was injected into this
   * bundle at build time. Drift between this value and the currently loaded
   * runtime hash indicates the bundle is running old runtime bytes and
   * should be auto-rebuilt.
   */
  runtimeHash?: string;
  /**
   * R2 source directory name (e.g. the workshop bundle workspace name). Used
   * by the auto-rebuild path to locate the authored source files so a new
   * envelope can be produced with the current runtime injected.
   */
  sourceName?: string;
  /**
   * Host-side capabilities this bundle declared via `defineBundleAgent`'s
   * `requiredCapabilities` field. Read by `BundleRegistry.setActive` and
   * the dispatch-time guard to validate that the host's registered
   * capability set satisfies the bundle's declaration. Absent on legacy
   * bundles — treated as "no requirements" (always passes).
   */
  requiredCapabilities?: Array<{ id: string }>;
}

export interface AgentBundle {
  agentId: string;
  activeVersionId: string | null;
  previousVersionId: string | null;
  updatedAt: number;
}

export interface BundleDeployment {
  id: number;
  agentId: string;
  versionId: string | null;
  deployedAt: number;
  deployedBySessionId: string | null;
  rationale: string | null;
}

export interface CreateVersionOpts {
  bytes: ArrayBuffer;
  createdBy?: string;
  metadata?: BundleMetadata;
}

/**
 * Extended registry interface for writers (workshop tools). The narrow
 * `BundleRegistry` (re-exported from agent-runtime) is the *reader* surface
 * the runtime needs at dispatch time. Tools that mutate the registry —
 * notably `workshop_deploy` — need this wider surface so they can write
 * bundle bytes via `createVersion` before flipping the pointer with
 * `setActive`. Implementations that satisfy `BundleRegistryWriter` are also
 * valid `BundleRegistry` instances.
 */
export interface BundleRegistryWriter extends BundleRegistry {
  /**
   * Write a new bundle version: stores `opts.bytes` in KV under
   * `bundle:{versionId}`, verifies readback, and inserts a row in the
   * `bundle_versions` D1 table. Content-addressed: writing the same bytes
   * twice returns the same `versionId` and is a no-op for the second call.
   */
  createVersion(opts: CreateVersionOpts): Promise<BundleVersion>;
}

/** Maximum bundle size per KV value (Cloudflare KV limit). */
export const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB

/** KV readback verification polling schedule (ms). */
export const READBACK_DELAYS = [50, 100, 200, 400, 800, 1600, 2000];

/** Allowed top-level metadata keys. */
export const METADATA_KEYS = new Set([
  "id",
  "name",
  "description",
  "declaredModel",
  "capabilityIds",
  "authoredBy",
  "version",
  "buildTimestamp",
  "runtimeHash",
  "sourceName",
  "requiredCapabilities",
]);

/** Max length for string metadata fields. */
export const METADATA_STRING_MAX = 256;
/** Max length for description field. */
export const METADATA_DESCRIPTION_MAX = 1024;
/** Max entries for capabilityIds array. */
export const METADATA_CAPABILITY_IDS_MAX = 32;
