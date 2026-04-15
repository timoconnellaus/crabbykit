/**
 * Test bundle brain for Phase 2 demo.
 * This is compiled via `bun build` and loaded via Worker Loader.
 */

import { defineBundleAgent } from "@claw-for-cloudflare/bundle-sdk";

export default defineBundleAgent({
  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
  prompt: { agentName: "BundleBrain" },
  metadata: {
    name: "TestBundleBrain",
    description: "Phase 2 demo bundle — echoes prompts with bundle identity",
  },
});
