/**
 * Bundle dispatcher integration tests (tasks 2.20, 3.26).
 *
 * Covers the full host-side bundle dispatch flow in a single process:
 *  - A real bundle built from {@link defineBundleAgent}
 *  - A real {@link InMemoryBundleRegistry} with seeded bytes
 *  - A fake {@link WorkerLoader} that synthesizes a runnable entrypoint from
 *    the factory's `modules` payload and environment (including __SPINE_TOKEN)
 *  - A fake mock spine the bundle would reach through; since our reference
 *    bundle never calls spine, the mock just records that it would have been
 *    reachable through the env
 *
 * This is the highest-fidelity integration test achievable without actually
 * running Worker Loader in a real workerd isolate — it verifies that the
 * dispatcher mints a token, invokes the loader factory, surfaces the loader's
 * env to the bundle, and consumes the NDJSON response stream.
 *
 * Tasks 2.20 and 3.26 are covered by this file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../../bundle/define.js";
import type { BundleEnv } from "../../bundle/types.js";
import { deriveSubkey, verifyToken } from "../../security/capability-token.js";
import type { BundleConfig } from "../bundle-config.js";
import { BundleDispatcher } from "../bundle-dispatcher.js";
import { InMemoryBundleRegistry } from "../in-memory-registry.js";

interface TestEnv {
  [key: string]: unknown;
}

// --- Fake WorkerLoader that runs the bundle's default export in-process ---

interface FakeLoaderOptions {
  onGetCall?: (versionId: string) => void;
  onFactoryCall?: (env: Record<string, unknown>) => void;
}

function makeFakeLoader(options: FakeLoaderOptions = {}): WorkerLoader & { callCount: number } {
  let callCount = 0;
  const loader = {
    get getCallCount() {
      return callCount;
    },
    get(versionId: string, factory: () => Promise<unknown>) {
      callCount += 1;
      options.onGetCall?.(versionId);

      // Kick off the factory eagerly so getEntrypoint() can stay sync
      // (mirroring the real WorkerLoader contract).
      const factoryPromise = (async () => {
        const init = (await factory()) as {
          modules: Record<string, string>;
          env: Record<string, unknown>;
          mainModule: string;
        };
        options.onFactoryCall?.(init.env);
        const source = init.modules[init.mainModule];
        const encoded = encodeURIComponent(source);
        const mod = (await import(`data:text/javascript;charset=utf-8,${encoded}`)) as {
          default: { fetch: (req: Request, env: unknown) => Promise<Response> };
        };
        return { mod, env: init.env };
      })();

      return {
        getEntrypoint() {
          return {
            async fetch(req: Request) {
              const { mod, env } = await factoryPromise;
              return mod.default.fetch(req, env);
            },
          };
        },
      };
    },
  };
  return loader as unknown as WorkerLoader & { callCount: number };
}

// Reference bundle source — hand-written and compiled inline so we avoid
// needing a pre-built artifact on disk. This mirrors a minimum viable
// bundle produced by `bun build` against @claw-for-cloudflare/agent-bundle/bundle.
const REFERENCE_BUNDLE_SOURCE = `
const metadata = { name: "ReferenceBundle", description: "integration fixture" };

async function handleTurn(request, env) {
  const token = env.__SPINE_TOKEN;
  if (!token) {
    return new Response("Missing __SPINE_TOKEN", { status: 401 });
  }
  const { prompt } = await request.json();
  const lines = [
    JSON.stringify({
      type: "agent_event",
      event: "text",
      data: { content: "bundle-reply: " + prompt },
    }),
    JSON.stringify({
      type: "agent_event",
      event: "agent_end",
      data: { reason: "stop" },
    }),
  ];
  return new Response(lines.join("\\n"), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function handleSmoke(env) {
  return Response.json({ status: "ok", hasToken: typeof env.__SPINE_TOKEN === "string" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/turn": return handleTurn(request, env);
      case "/metadata": return Response.json(metadata);
      case "/smoke": return handleSmoke(env);
      case "/client-event": return Response.json({ status: "acknowledged" });
      default: return new Response("Unknown: " + url.pathname, { status: 404 });
    }
  },
};
`;

// --- Test helpers ---

const TEST_AUTH_KEY = "test-auth-master-key-0123456789";

function makeConfig(
  registry: InMemoryBundleRegistry,
  loader: WorkerLoader,
  bundleEnvFactory: () => Record<string, unknown> = () => ({}),
): BundleConfig<TestEnv> {
  return {
    registry: () => registry,
    loader: () => loader,
    authKey: () => TEST_AUTH_KEY,
    bundleEnv: bundleEnvFactory,
  };
}

function stringToBuffer(s: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

// --- Tests ---

describe("BundleDispatcher.hasActiveBundle", () => {
  it("returns false when no bundle is registered", async () => {
    const registry = new InMemoryBundleRegistry();
    const loader = makeFakeLoader();
    const dispatcher = new BundleDispatcher(makeConfig(registry, loader), {} as TestEnv, "agent-1");
    expect(await dispatcher.hasActiveBundle()).toBe(false);
  });

  it("returns true after a bundle has been registered", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v1", REFERENCE_BUNDLE_SOURCE);
    registry.setActiveSync("agent-1", "v1");

    const dispatcher = new BundleDispatcher(
      makeConfig(registry, makeFakeLoader()),
      {} as TestEnv,
      "agent-1",
    );
    expect(await dispatcher.hasActiveBundle()).toBe(true);
  });
});

describe("BundleDispatcher.dispatchTurn — full integration", () => {
  let registry: InMemoryBundleRegistry;
  let loader: ReturnType<typeof makeFakeLoader>;
  let dispatcher: BundleDispatcher<TestEnv>;
  let lastEnvSeen: Record<string, unknown> | null;

  beforeEach(async () => {
    registry = new InMemoryBundleRegistry();
    registry.seed("v-ref", REFERENCE_BUNDLE_SOURCE);
    registry.setActiveSync("agent-1", "v-ref");
    lastEnvSeen = null;
    loader = makeFakeLoader({
      onFactoryCall: (env) => {
        lastEnvSeen = env;
      },
    });
    dispatcher = new BundleDispatcher(makeConfig(registry, loader), {} as TestEnv, "agent-1");
    await dispatcher.hasActiveBundle();
  });

  it("mints a capability token and surfaces it to the bundle env as __SPINE_TOKEN", async () => {
    const result = await dispatcher.dispatchTurn("session-1", "hello");
    expect(result.dispatched).toBe(true);

    expect(lastEnvSeen).not.toBeNull();
    expect(typeof (lastEnvSeen as BundleEnv).__SPINE_TOKEN).toBe("string");

    // Verify the token under the same subkey the dispatcher used
    const subkey = await deriveSubkey(TEST_AUTH_KEY, "claw/spine-v1");
    const outcome = await verifyToken((lastEnvSeen as BundleEnv).__SPINE_TOKEN as string, subkey);
    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.payload.aid).toBe("agent-1");
      expect(outcome.payload.sid).toBe("session-1");
    }
  });

  it("returns the bundle's NDJSON events (text + agent_end)", async () => {
    const result = await dispatcher.dispatchTurn("session-1", "ping");
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error("unreachable");

    expect(result.events.length).toBe(2);
    expect(result.events[0].type).toBe("agent_event");
    expect(result.events[0].event).toBe("text");
    expect(result.events[0].data).toMatchObject({
      content: "bundle-reply: ping",
    });
    expect(result.events[1].event).toBe("agent_end");
  });

  it("forwards bundleEnv projection plus the injected __SPINE_TOKEN", async () => {
    const cfg = makeConfig(registry, loader, () => ({
      TIMEZONE: "UTC",
      FEATURE_FLAG: true,
    }));
    dispatcher = new BundleDispatcher(cfg, {} as TestEnv, "agent-1");
    await dispatcher.hasActiveBundle();
    await dispatcher.dispatchTurn("session-1", "hi");

    expect(lastEnvSeen).toMatchObject({
      TIMEZONE: "UTC",
      FEATURE_FLAG: true,
    });
    expect(lastEnvSeen).toHaveProperty("__SPINE_TOKEN");
  });

  it("invokes the loader's get() with the active version ID", async () => {
    const seen: string[] = [];
    const spyLoader = makeFakeLoader({ onGetCall: (v) => seen.push(v) });
    dispatcher = new BundleDispatcher(makeConfig(registry, spyLoader), {} as TestEnv, "agent-1");
    await dispatcher.hasActiveBundle();
    await dispatcher.dispatchTurn("session-1", "x");
    expect(seen).toEqual(["v-ref"]);
  });

  it("returns dispatched=false with a clear reason when no bundle is active", async () => {
    const empty = new BundleDispatcher(
      makeConfig(new InMemoryBundleRegistry(), loader),
      {} as TestEnv,
      "agent-no-bundle",
    );
    await empty.hasActiveBundle();
    const result = await empty.dispatchTurn("session-1", "x");
    expect(result.dispatched).toBe(false);
    if (!result.dispatched) {
      expect(result.reason).toMatch(/no active bundle/);
    }
  });
});

describe("BundleDispatcher auto-revert on repeated load failures", () => {
  it("reverts to static brain after N consecutive load failures", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-missing", stringToBuffer("not a valid ES module"));
    registry.setActiveSync("agent-2", "v-missing");

    // A loader whose getEntrypoint returns a binding whose fetch always
    // rejects — simulates "bundle bytes corrupt / isolate boot failure".
    const failingLoader = {
      get(_versionId: string, _factory: () => Promise<unknown>) {
        return {
          getEntrypoint() {
            return {
              fetch(_req: Request): Promise<Response> {
                return Promise.reject(new Error("synthetic isolate boot failure"));
              },
            };
          },
        };
      },
    } as unknown as WorkerLoader;

    const dispatcher = new BundleDispatcher(
      {
        registry: () => registry,
        loader: () => failingLoader,
        authKey: () => TEST_AUTH_KEY,
        bundleEnv: () => ({}),
        maxLoadFailures: 2,
      },
      {} as TestEnv,
      "agent-2",
    );

    // Silence dispatcher's console.error for this test
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await dispatcher.hasActiveBundle();

    // First failure — still has an active bundle, dispatch returns failure
    const r1 = await dispatcher.dispatchTurn("s", "p");
    expect(r1.dispatched).toBe(false);
    expect(await registry.getActiveForAgent("agent-2")).toBe("v-missing");

    // Second failure — should trigger auto-revert
    const r2 = await dispatcher.dispatchTurn("s", "p");
    expect(r2.dispatched).toBe(false);
    expect(await registry.getActiveForAgent("agent-2")).toBeNull();

    errSpy.mockRestore();
  });
});

describe("BundleDispatcher.disable", () => {
  it("clears the active pointer in the registry", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v", REFERENCE_BUNDLE_SOURCE);
    registry.setActiveSync("agent-3", "v");

    const dispatcher = new BundleDispatcher(
      makeConfig(registry, makeFakeLoader()),
      {} as TestEnv,
      "agent-3",
    );
    await dispatcher.hasActiveBundle();
    await dispatcher.disable(undefined, "manual-test", "sess-1");

    expect(await registry.getActiveForAgent("agent-3")).toBeNull();
    const deployments = registry.getDeployments("agent-3");
    expect(deployments[deployments.length - 1].rationale).toBe("manual-test");
  });
});

describe("defineBundleAgent reference check", () => {
  it("the real defineBundleAgent produces a functional /turn endpoint (smoke)", async () => {
    // Cross-check: the same code paths the reference bundle exercises above
    // also work when building a bundle through defineBundleAgent.
    const bundle = defineBundleAgent({
      model: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
      },
      prompt: { agentName: "SmokeBundle" },
      metadata: { name: "Smoke" },
    });

    const smoke = await bundle.fetch(new Request("https://bundle/smoke", { method: "POST" }), {
      __SPINE_TOKEN: "tok",
    } as BundleEnv);
    expect(smoke.status).toBe(200);
    const smokeBody = (await smoke.json()) as Record<string, unknown>;
    expect(smokeBody.status).toBe("ok");

    const turn = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi" }),
      }),
      { __SPINE_TOKEN: "tok" } as BundleEnv,
    );
    expect(turn.status).toBe(200);
    const text = await turn.text();
    expect(text).toContain("agent_event");
  });
});
