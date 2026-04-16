/**
 * `@claw-for-cloudflare/bundle-sdk` — bundle authoring entry point.
 *
 * Bundle authors import from here:
 *
 *   import { defineBundleAgent } from "@claw-for-cloudflare/bundle-sdk";
 *
 * This package intentionally contains no host-side symbols (no
 * `SpineService`, `LlmService`, `BundleDispatcher`, `mintToken`). Host
 * plumbing lives in `@claw-for-cloudflare/bundle-host`; the shared
 * verify-only token surface lives in `@claw-for-cloudflare/bundle-token`.
 * The mint-side subkey and `mintToken` are unreachable from this package
 * graph by construction.
 */

export { defineBundleAgent } from "./define.js";
export { createServiceLlmProvider } from "./llm/service-provider.js";
// Single source of truth for the system-prompt builder, re-exported by
// `@claw-for-cloudflare/agent-runtime` so both the host runtime and the
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
export {
  createCostEmitter,
  createKvStoreClient,
  createSchedulerClient,
  createSessionChannel,
  createSessionStoreClient,
} from "./spine-clients.js";
export type {
  BundleAgentSetup,
  BundleCapability,
  BundleCapabilityHooks,
  BundleCapabilityRequirement,
  BundleContext,
  BundleCostEvent,
  BundleEnv,
  BundleExport,
  BundleHookContext,
  BundleKvStoreClient,
  BundleMetadata,
  BundleModelConfig,
  BundlePromptOptions,
  BundlePromptSection,
  BundleSchedulerClient,
  BundleSessionChannel,
  BundleSessionStoreClient,
} from "./types.js";
export { validateRequirements } from "./validate.js";
