/**
 * Phase 2 demo: bundle-enabled defineAgent with in-memory registry.
 *
 * The agent has both a static brain (fallback) and the ability to
 * dispatch turns into a pre-compiled bundle loaded via Worker Loader.
 *
 * Demo endpoints:
 *   GET  /              — info page
 *   POST /prompt        — send a prompt (auto-creates session)
 *   POST /seed-bundle   — register the pre-compiled bundle as active
 *   POST /disable       — disable the bundle, reverting to static brain
 *   GET  /status        — show current bundle state
 */

import { InMemoryBundleRegistry } from "@claw-for-cloudflare/agent-bundle/host";
import { defineAgent } from "@claw-for-cloudflare/agent-runtime";

// Pre-compiled bundle loaded as text via wrangler rules
// @ts-expect-error — text module import
import bundleSource from "../dist/test.bundle.js";

interface Env {
  AGENT: DurableObjectNamespace;
  LOADER: WorkerLoader;
}

// A global in-memory registry for the demo.
// In production this would be D1-backed.
const registry = new InMemoryBundleRegistry();

// Hash the bundle bytes for content-addressed versioning
async function hashBundle(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const BundleTestAgent = defineAgent<Env>({
  // --- Static brain (always-available fallback) ---
  model: {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
    apiKey: "static-brain-key",
  },
  prompt: { agentName: "StaticBrain" },

  // --- Bundle config (opt-in) ---
  bundle: {
    registry: () => registry,
    loader: (env) => env.LOADER,
    authKey: () => "demo-auth-key-not-for-production",
    bundleEnv: () => ({}),
  },
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(
        [
          "Phase 2 Demo: Bundle Brain Override",
          "",
          "POST /prompt          — send a prompt (body: {text})",
          "POST /seed-bundle     — register the pre-compiled bundle",
          "POST /disable         — disable bundle, revert to static",
          "GET  /status          — bundle state",
          "",
          "Flow:",
          "  1. POST /prompt   → static brain responds",
          "  2. POST /seed-bundle → register bundle",
          "  3. POST /prompt   → bundle brain responds",
          "  4. POST /disable  → revert to static",
          "  5. POST /prompt   → static brain responds again",
        ].join("\n"),
      );
    }

    if (url.pathname === "/seed-bundle" && req.method === "POST") {
      const versionId = await hashBundle(bundleSource);
      registry.seed(versionId, bundleSource);
      registry.setActiveSync("default", versionId);
      return Response.json({
        status: "seeded",
        versionId,
        bundleSize: bundleSource.length,
      });
    }

    if (url.pathname === "/disable" && req.method === "POST") {
      await registry.setActive("default", null, { rationale: "manual demo disable" });
      // Also signal the DO to refresh its cached pointer
      const id = env.AGENT.idFromName("default");
      await env.AGENT.get(id).fetch(
        new Request("https://internal/bundle/refresh", { method: "POST" }),
      );
      return Response.json({ status: "disabled" });
    }

    if (url.pathname === "/status" && req.method === "GET") {
      const pointer = registry.getPointer("default");
      const deployments = registry.getDeployments("default");
      return Response.json({
        activeVersionId: pointer?.activeVersionId ?? null,
        previousVersionId: pointer?.previousVersionId ?? null,
        deploymentCount: deployments.length,
        recentDeployments: deployments.slice(-5),
      });
    }

    if (url.pathname === "/prompt" && req.method === "POST") {
      const body = (await req.json()) as { text: string };
      const id = env.AGENT.idFromName("default");
      // Route through the runtime's built-in POST /prompt endpoint
      const doReq = new Request("https://internal/prompt", {
        method: "POST",
        body: JSON.stringify({ text: body.text }),
        headers: { "content-type": "application/json" },
      });
      return env.AGENT.get(id).fetch(doReq);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
