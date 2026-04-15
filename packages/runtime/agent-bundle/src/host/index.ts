/**
 * Host-side entry point.
 *
 * This subpath exports WorkerEntrypoint classes and host utilities:
 *   import { SpineService, BundleDispatcher } from "@claw-for-cloudflare/agent-bundle/host";
 *
 * It does NOT export bundle authoring symbols (defineBundleAgent, etc.).
 */

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
} from "./bundle-config.js";
export type { BundleAgentEvent, BundlePayload, DispatchResult } from "./bundle-dispatcher.js";
export { BundleDispatcher, decodeBundlePayload } from "./bundle-dispatcher.js";
export { InMemoryBundleRegistry } from "./in-memory-registry.js";
export type { InferRequest, InferResponse, LlmEnv } from "./llm-service.js";
export { LlmService } from "./llm-service.js";
export type { SpineBudgetConfig, SpineEnv, SpineErrorCode, SpineHost } from "./spine-service.js";
export { SpineError, SpineService } from "./spine-service.js";
