/**
 * Credential isolation in bundle-side source (tasks 4.18, 4.32).
 *
 * Runs a static grep against the bundle-authoring source set that ships in
 * the sandbox container, asserting that secrets never appear in bundle
 * code paths. This catches the worst kind of regression: a developer
 * accidentally wiring a credential into bundle code where it would land
 * in the compiled bundle artifact.
 *
 * Lives in agent-bundle (plain vitest) rather than tavily-web-search
 * (pool-workers) so it has Node fs access.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const Dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(Dirname, "../../../../..");

const BUNDLE_SIDE_FILES = [
  // agent-bundle authoring surface
  "packages/agent-bundle/src/bundle/define.ts",
  "packages/agent-bundle/src/bundle/types.ts",
  "packages/agent-bundle/src/bundle/runtime.ts",
  "packages/agent-bundle/src/bundle/spine-clients.ts",
  // Tavily client (ships in the vendored /opt/claw-sdk/ snapshot)
  "packages/tavily-web-search/src/client.ts",
  "packages/tavily-web-search/src/schemas.ts",
];

const FORBIDDEN_TOKENS = [
  // Tavily
  "TAVILY_API_KEY",
  "api.tavily.com",
  "tvly-",
  // OpenRouter
  "OPENROUTER_API_KEY",
  "sk-or-",
  // Anthropic / OpenAI
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "sk-ant-",
];

describe("Bundle-side credential isolation", () => {
  it.each(BUNDLE_SIDE_FILES)("%s contains no secret names or URL strings", async (rel) => {
    const content = await readFile(resolve(WORKSPACE_ROOT, rel), "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      expect(content.includes(token), `forbidden token '${token}' found in ${rel}`).toBe(false);
    }
  });

  it("tavily client.ts uses 'import type' for TavilyService (never a value import)", async () => {
    const content = await readFile(
      resolve(WORKSPACE_ROOT, "packages/tavily-web-search/src/client.ts"),
      "utf8",
    );
    // A value import from ./service would pull credentials into the bundle
    expect(content).not.toMatch(/^import\s*\{\s*TavilyService\s*\}/m);
    expect(content).not.toMatch(/^import\s+TavilyService\s+from/m);
    // The type-only form is required
    if (content.includes("TavilyService")) {
      expect(content).toMatch(/import\s+type\s*\{[^}]*TavilyService/);
    }
  });

  it("bundle-side BundleModelConfig interface has no apiKey field", async () => {
    const types = await readFile(
      resolve(WORKSPACE_ROOT, "packages/agent-bundle/src/bundle/types.ts"),
      "utf8",
    );
    const match = types.match(/interface BundleModelConfig[\s\S]*?\n\}/);
    expect(match).toBeTruthy();
    expect(match![0]).not.toMatch(/^\s*apiKey[?:]/m);
  });
});
