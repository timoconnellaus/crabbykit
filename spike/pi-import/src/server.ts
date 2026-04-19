import { DurableObject } from "cloudflare:workers";

// Compiled bundle loaded as text via wrangler rules (**.bundle.js → Text)
// @ts-expect-error — text module import, no TS declaration needed for spike
import bundleSource from "../dist/pi-import.bundle.js";

export interface Env {
  AGENT: DurableObjectNamespace;
  LOADER: WorkerLoader;
}

/**
 * Spike 0.A — verify pi-agent-core + pi-ai can import inside a Worker Loader
 * isolate when compiled via `bun build --target=browser --format=esm`.
 *
 * The bundle is compiled from bundle-src/index.ts which imports:
 * - Agent from @crabbykit/agent-core
 * - getModel from @crabbykit/ai
 * - AgentRuntime from @crabbykit/agent-runtime
 *
 * The DO loads it via LOADER.get() and invokes its fetch handler to check
 * whether these imports resolved successfully inside the loader isolate.
 */
export class SpikeAgent extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/test") {
      return this.runBundleTest();
    }

    return new Response("Spike 0.A — GET /test to run\n");
  }

  private async runBundleTest(): Promise<Response> {
    const startTime = Date.now();
    const cacheKey = "spike:v1";

    try {
      const loadStart = Date.now();
      const worker = this.env.LOADER.get(cacheKey, async () => {
        return {
          compatibilityDate: "2025-12-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "bundle.js",
          modules: { "bundle.js": bundleSource },
          env: {},
        };
      });
      const loadEnd = Date.now();

      const execStart = Date.now();
      const res = await worker
        .getEntrypoint()
        .fetch(new Request("https://bundle/test", { method: "POST" }));
      const execEnd = Date.now();

      const body = (await res.json()) as Record<string, unknown>;

      return Response.json({
        success: true,
        loadMs: loadEnd - loadStart,
        execMs: execEnd - execStart,
        totalMs: Date.now() - startTime,
        bundleResult: body,
      });
    } catch (err) {
      return Response.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          totalMs: Date.now() - startTime,
        },
        { status: 500 },
      );
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/test") {
      const id = env.AGENT.idFromName("spike");
      return env.AGENT.get(id).fetch(req);
    }

    // Cold-start test: use a fresh cache key each time
    if (url.pathname === "/test-cold") {
      const id = env.AGENT.idFromName("spike");
      return env.AGENT.get(id).fetch(
        new Request(`${url.origin}/test?cold=${Date.now()}`, {
          method: req.method,
        }),
      );
    }

    return new Response(
      "Spike 0.A: pi-agent-core in Worker Loader\nGET /test — run the spike\nGET /test-cold — force cold load\n",
    );
  },
} satisfies ExportedHandler<Env>;
