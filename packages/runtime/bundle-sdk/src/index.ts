/**
 * `@crabbykit/bundle-sdk` — bundle authoring entry point.
 *
 * Bundle authors import from here:
 *
 *   import { defineBundleAgent } from "@crabbykit/bundle-sdk";
 *
 * This package intentionally contains no host-side symbols (no
 * `SpineService`, `LlmService`, `BundleDispatcher`, `mintToken`). Host
 * plumbing lives in `@crabbykit/bundle-host`; the shared
 * verify-only token surface lives in `@crabbykit/bundle-token`.
 * The mint-side subkey and `mintToken` are unreachable from this package
 * graph by construction.
 */

export { evaluateAgentConfigPath } from "./config-path.js";
export { defineBundleAgent } from "./define.js";
export { createServiceLlmProvider } from "./llm/service-provider.js";
// Single source of truth for the system-prompt builder, re-exported by
// `@crabbykit/agent-runtime` so both the host runtime and the
// bundle runtime compose the same sections from the same code.
export {
  buildDefaultSystemPrompt,
  buildDefaultSystemPromptSections,
  estimateTextTokens,
  toPromptString,
} from "./prompt/build-system-prompt.js";
export { identitySection, runtimeSection, safetySection } from "./prompt/sections.js";
export type { PromptOptions, PromptSection, PromptSectionSource } from "./prompt/types.js";
export { buildBundleContext } from "./runtime.js";
export { hydrateBundleSchema, serializeBundleSchema } from "./schema-serialize.js";
export {
  createCostEmitter,
  createHookBridge,
  createKvStoreClient,
  createSchedulerClient,
  createSessionChannel,
  createSessionStoreClient,
} from "./spine-clients.js";
export type {
  BundleActionContext,
  BundleAgentConfigChangeEvent,
  BundleAgentSetup,
  BundleBeforeToolExecutionEvent,
  BundleBeforeToolExecutionResult,
  BundleCapability,
  BundleCapabilityHooks,
  BundleCapabilityRequirement,
  BundleConfigChangeEvent,
  BundleConfigNamespace,
  BundleContext,
  BundleCostEvent,
  BundleEnv,
  BundleExport,
  BundleHookBridge,
  BundleHookContext,
  BundleHttpContext,
  BundleHttpHandler,
  BundleHttpRequest,
  BundleHttpResponse,
  BundleKvStoreClient,
  BundleMetadata,
  BundleModelConfig,
  BundlePromptOptions,
  BundlePromptSection,
  BundleRouteDeclaration,
  BundleSchedulerClient,
  BundleSessionChannel,
  BundleSessionStoreClient,
  BundleToolExecutionEvent,
} from "./types.js";
export {
  BundleMetadataExtractionError,
  type CapabilityConfigEntry,
  validateActionCapabilityIds,
  validateAgentConfigPaths,
  validateAgentConfigSchemas,
  validateBundleCapabilityConfigsAgainstBundleCaps,
  validateCapabilityConfigs,
  validateConfigNamespaces,
  validateHttpRoutes,
  validateRequirements,
} from "./validate.js";
