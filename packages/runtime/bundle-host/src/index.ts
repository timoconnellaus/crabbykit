/**
 * `@crabbykit/bundle-host` — host-side bundle dispatch plumbing.
 *
 * Exports the per-turn dispatcher, `SpineService` and `LlmService`
 * WorkerEntrypoints, the budget tracker, and the in-memory registry
 * test helper. Also exports the mint-side token primitives under
 * `./security/mint.js` (re-exported here) — the only package in the
 * workspace that may import them.
 */

// Re-export catalog validation helper + error class so consumers that
// already depend on bundle-host (e.g. agent-runtime) don't need an
// additional workspace edge to bundle-registry just for the guard.
export {
  type CapabilityRequirementLike,
  type CatalogValidationResult,
  validateCatalogAgainstKnownIds,
} from "@crabbykit/bundle-registry";
export type {
  BudgetCategory,
  SpineBudgetConfig,
} from "./budget-tracker.js";
export { BudgetExceededError, BudgetTracker, DEFAULT_BUDGET } from "./budget-tracker.js";
export type {
  BuildBundleOptions,
  BuildBundleResult,
  BundleSourceBucket,
  LoadBundleFilesOptions,
  LoadedBundleFiles,
} from "./bundle-builder.js";
export {
  BUNDLE_ENVELOPE_VERSION,
  BUNDLE_RUNTIME_HASH,
  BUNDLE_RUNTIME_SOURCE,
  buildBundle,
  bundleFileR2Key,
  bundlePrefix,
  encodeEnvelope,
  loadBundleFiles,
  RELATIVE_RUNTIME_PATHS,
  WORKSHOP_BUNDLE_PREFIX,
} from "./bundle-builder.js";
export type {
  BundleConfig,
  BundleDispatchState,
  BundleRegistry,
  SetActiveOptions,
} from "./bundle-config.js";
export { CapabilityMismatchError } from "./bundle-config.js";
export type { BundleAgentEvent, BundlePayload, DispatchResult } from "./dispatcher.js";
export { BundleDispatcher, decodeBundlePayload } from "./dispatcher.js";
export { InMemoryBundleRegistry } from "./in-memory-registry.js";
export {
  type ComposedLoaderConfig,
  composeWorkerLoaderConfig,
} from "./loader-config.js";
export { BUNDLE_SUBKEY_LABEL, deriveMintSubkey, mintToken } from "./security/mint.js";
export {
  type BundleActionResponseEnvelope,
  type BundleHttpResponseEnvelope,
  type BundleToolResultProjection,
  deserializeResponseFromBundle,
  type HostActionEnvelope,
  type HostHttpEnvelope,
  projectToolResultsForBundle,
  serializeActionForBundle,
  serializeRequestForBundle,
} from "./serialization.js";
export type { InferRequest, InferResponse, LlmEnv } from "./services/llm-service.js";
export { LlmService } from "./services/llm-service.js";
export type { SpineEnv, SpineErrorCode, SpineHost } from "./services/spine-service.js";
export { requireSession, SpineError, SpineService } from "./services/spine-service.js";
export {
  AgentConfigCollisionError,
  type AgentConfigValidationResult,
  CapabilityConfigCollisionError,
  type CapabilityConfigValidationResult,
  ConfigNamespaceCollisionError,
  type ConfigNamespaceValidationResult,
  validateBundleAgentConfigsAgainstKnownIds,
  validateBundleCapabilityConfigsAgainstKnownIds,
  validateBundleConfigNamespacesAgainstKnownIds,
} from "./validate-config.js";
export {
  ActionIdCollisionError,
  type ActionIdValidationResult,
  RouteCollisionError,
  type RouteSpec,
  type RouteValidationResult,
  validateBundleActionIdsAgainstKnownIds,
  validateBundleRoutesAgainstKnownRoutes,
} from "./validate-routes.js";
