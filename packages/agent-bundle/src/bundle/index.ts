/**
 * Bundle authoring entry point.
 *
 * This subpath is what bundle authors import from:
 *   import { defineBundleAgent } from "@claw-for-cloudflare/agent-bundle/bundle";
 *
 * It does NOT export host-side symbols (LlmService, SpineService, etc.).
 */

export { defineBundleAgent } from "./define.js";
export { createServiceLlmProvider } from "./llm/service-provider.js";
export { buildBundleContext } from "./runtime.js";
export {
  createCostEmitter,
  createKvStoreClient,
  createSchedulerClient,
  createSessionChannel,
  createSessionStoreClient,
} from "./spine-clients.js";

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

export type {
  BundleAgentSetup,
  BundleCapability,
  BundleCapabilityHooks,
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
export type { PromptOptions, PromptSection, PromptSectionSource } from "./prompt/types.js";
