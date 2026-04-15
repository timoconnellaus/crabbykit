/**
 * BundleConfig — the config field consumers add to defineAgent to enable
 * bundle brain override.
 *
 * The authoritative type lives in `@claw-for-cloudflare/agent-runtime`
 * (`agent-runtime/src/bundle-config.ts`). The types were originally
 * declared there to break a circular workspace dependency between
 * `agent-runtime` and the old `agent-bundle` package. This file
 * re-exports them so `bundle-host` consumers can continue to import
 * `BundleConfig` from the host-side barrel.
 */

export type {
  BundleAutoRebuildConfig,
  BundleConfig,
  BundleRegistry,
  BundleSourceBucket,
  BundleVersionInfo,
  BundleVersionMetadata,
  CreateBundleVersionOpts,
} from "@claw-for-cloudflare/agent-runtime";

/**
 * State tracked per bundle-enabled agent for dispatch. Kept host-local
 * because the dispatcher owns this state and nothing in `agent-runtime`
 * references it.
 */
export interface BundleDispatchState {
  /** Cached active version ID from ctx.storage, or null. */
  activeVersionId: string | null;
  /** Consecutive load failure counter. */
  consecutiveFailures: number;
}
