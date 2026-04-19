/**
 * Bundle dispatcher integration tests (tasks 2.20, 3.26).
 *
 * Covers the full host-side bundle dispatch flow in a single process:
 *  - A real bundle built from {@link defineBundleAgent}
 *  - A real {@link InMemoryBundleRegistry} with seeded bytes
 *  - A fake {@link WorkerLoader} that synthesizes a runnable entrypoint from
 *    the factory's `modules` payload and environment (including __BUNDLE_TOKEN)
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

import type { WorkerLoader } from "@cloudflare/workers-types";
import type { BundleEnv } from "@crabbykit/bundle-sdk";
import { defineBundleAgent } from "@crabbykit/bundle-sdk";
import { deriveVerifyOnlySubkey, verifyToken } from "@crabbykit/bundle-token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleConfig } from "../bundle-config.js";
import type { BundleDisabledEvent } from "../dispatcher.js";
import { BundleDispatcher } from "../dispatcher.js";
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
// bundle produced by `bun build` against @crabbykit/bundle-sdk.
const REFERENCE_BUNDLE_SOURCE = `
const metadata = { name: "ReferenceBundle", description: "integration fixture" };

async function handleTurn(request, env) {
  const token = env.__BUNDLE_TOKEN;
  if (!token) {
    return new Response("Missing __BUNDLE_TOKEN", { status: 401 });
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
  return Response.json({ status: "ok", hasToken: typeof env.__BUNDLE_TOKEN === "string" });
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

  it("mints a unified capability token and surfaces it to the bundle env as __BUNDLE_TOKEN", async () => {
    const result = await dispatcher.dispatchTurn("session-1", "hello");
    expect(result.dispatched).toBe(true);

    expect(lastEnvSeen).not.toBeNull();
    expect(typeof (lastEnvSeen as BundleEnv).__BUNDLE_TOKEN).toBe("string");

    // Verify the token under the unified BUNDLE_SUBKEY_LABEL
    const subkey = await deriveVerifyOnlySubkey(TEST_AUTH_KEY, "claw/bundle-v1");
    const outcome = await verifyToken((lastEnvSeen as BundleEnv).__BUNDLE_TOKEN as string, subkey);
    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.payload.aid).toBe("agent-1");
      expect(outcome.payload.sid).toBe("session-1");
      expect(outcome.payload.scope).toContain("spine");
      expect(outcome.payload.scope).toContain("llm");
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

  it("forwards bundleEnv projection plus the injected __BUNDLE_TOKEN", async () => {
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
    expect(lastEnvSeen).toHaveProperty("__BUNDLE_TOKEN");
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

describe("BundleDispatcher catalog mismatch → bundle_disabled broadcast (Gap 8)", () => {
  /**
   * When the dispatcher's dispatch-time catalog guard finds a capability
   * declared in the bundle's metadata that is not in the host's registered
   * set, it must:
   *   1. Return { dispatched: false } — fall back to static brain
   *   2. Emit a `bundle_disabled` event with reason.code = "ERR_CAPABILITY_MISMATCH"
   *   3. Clear the active pointer (registry shows null after dispatch)
   *   4. NOT mint a __BUNDLE_TOKEN (no loader call occurs)
   *
   * All covered by wiring a `broadcastEvent` capture into the dispatcher
   * options and observing the result.
   */

  const MISMATCH_BUNDLE_SOURCE = `
export default {
  async fetch(request, env) {
    return Response.json({ tokenPresent: typeof env.__BUNDLE_TOKEN === "string" });
  },
};
`;

  function makeConfigWithMismatch(
    registry: InMemoryBundleRegistry,
    loaderCallLog: string[],
  ): BundleConfig<TestEnv> {
    const loader = makeFakeLoader({
      onGetCall: (versionId) => loaderCallLog.push(versionId),
    });
    return {
      registry: () => registry,
      loader: () => loader,
      authKey: () => TEST_AUTH_KEY,
      bundleEnv: () => ({}),
    };
  }

  it("returns dispatched=false when declared capability is missing from host", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-mismatch", MISMATCH_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    registry.setActiveSync("agent-mm", "v-mismatch");

    const loaderCalls: string[] = [];
    const dispatcher = new BundleDispatcher(
      makeConfigWithMismatch(registry, loaderCalls),
      {} as TestEnv,
      "agent-mm",
      {
        // Host registers no capabilities — so "tavily-web-search" is missing
        getHostCapabilityIds: () => [],
      },
    );
    await dispatcher.hasActiveBundle();

    const result = await dispatcher.dispatchTurn("session-1", "hi");
    expect(result.dispatched).toBe(false);
    if (!result.dispatched) {
      expect(result.reason).toMatch(/catalog mismatch/);
    }
  });

  it("clears the active pointer on catalog mismatch", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-mismatch-clear", MISMATCH_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "file-tools" }],
    });
    registry.setActiveSync("agent-mm-clear", "v-mismatch-clear");

    const dispatcher = new BundleDispatcher(
      {
        registry: () => registry,
        loader: () => makeFakeLoader(),
        authKey: () => TEST_AUTH_KEY,
        bundleEnv: () => ({}),
      },
      {} as TestEnv,
      "agent-mm-clear",
      { getHostCapabilityIds: () => [] },
    );
    await dispatcher.hasActiveBundle();
    await dispatcher.dispatchTurn("session-1", "hi");

    // Pointer cleared — registry now returns null for the agent
    expect(await registry.getActiveForAgent("agent-mm-clear")).toBeNull();
  });

  it("broadcasts bundle_disabled event with reason.code = ERR_CAPABILITY_MISMATCH", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-mismatch-event", MISMATCH_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "vector-memory" }, { id: "file-tools" }],
    });
    registry.setActiveSync("agent-mm-event", "v-mismatch-event");

    const broadcastedEvents: BundleDisabledEvent[] = [];
    const dispatcher = new BundleDispatcher(
      {
        registry: () => registry,
        loader: () => makeFakeLoader(),
        authKey: () => TEST_AUTH_KEY,
        bundleEnv: () => ({}),
      },
      {} as TestEnv,
      "agent-mm-event",
      {
        getHostCapabilityIds: () => [],
        broadcastEvent: (event) => broadcastedEvents.push(event),
      },
    );
    await dispatcher.hasActiveBundle();
    await dispatcher.dispatchTurn("session-1", "hi");

    expect(broadcastedEvents).toHaveLength(1);
    const event = broadcastedEvents[0];
    expect(event.type).toBe("bundle_disabled");
    expect(event.data.reason).toBeDefined();
    expect(event.data.reason?.code).toBe("ERR_CAPABILITY_MISMATCH");
    if (event.data.reason?.code === "ERR_CAPABILITY_MISMATCH") {
      expect(event.data.reason.missingIds).toEqual(
        expect.arrayContaining(["vector-memory", "file-tools"]),
      );
      expect(event.data.reason.versionId).toBe("v-mismatch-event");
    }
  });

  it("does NOT call the loader (no __BUNDLE_TOKEN minted) on catalog mismatch", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-mismatch-noload", MISMATCH_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    registry.setActiveSync("agent-mm-noload", "v-mismatch-noload");

    const loaderCalls: string[] = [];
    const dispatcher = new BundleDispatcher(
      makeConfigWithMismatch(registry, loaderCalls),
      {} as TestEnv,
      "agent-mm-noload",
      { getHostCapabilityIds: () => [] },
    );
    await dispatcher.hasActiveBundle();
    await dispatcher.dispatchTurn("session-1", "hi");

    // The loader.get() must NOT have been called — no token was minted
    expect(loaderCalls).toHaveLength(0);
  });

  it("catalog mismatch does NOT count toward maxLoadFailures", async () => {
    // After a mismatch, the pointer is cleared and consecutive failures are
    // reset. A subsequent turn (after re-deploying a valid version) should
    // start fresh with a zero failure count.
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-mismatch-fail", MISMATCH_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    registry.setActiveSync("agent-mm-fail", "v-mismatch-fail");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const dispatcher = new BundleDispatcher(
      {
        registry: () => registry,
        loader: () => makeFakeLoader(),
        authKey: () => TEST_AUTH_KEY,
        bundleEnv: () => ({}),
        maxLoadFailures: 1, // Would auto-revert after 1 load failure
      },
      {} as TestEnv,
      "agent-mm-fail",
      { getHostCapabilityIds: () => [] },
    );
    await dispatcher.hasActiveBundle();

    // Three dispatches — all catalog mismatches, none count as load failures
    await dispatcher.dispatchTurn("session-1", "hi"); // clears pointer on first mismatch
    // After the first mismatch the pointer is null, so subsequent turns
    // return dispatched=false with "no active bundle" reason (not mismatch)
    const r2 = await dispatcher.dispatchTurn("session-1", "hi");
    expect(r2.dispatched).toBe(false);
    if (!r2.dispatched) {
      // Must be "no active bundle", not a mismatch, and no auto-revert
      expect(r2.reason).not.toMatch(/auto-revert/);
    }

    // Auto-revert message should NOT have fired
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Auto-reverting"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("bundle with all required capabilities present does NOT get disabled", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-ok-caps", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    registry.setActiveSync("agent-ok-caps", "v-ok-caps");

    const broadcastedEvents: BundleDisabledEvent[] = [];
    const dispatcher = new BundleDispatcher(
      {
        registry: () => registry,
        loader: () => makeFakeLoader(),
        authKey: () => TEST_AUTH_KEY,
        bundleEnv: () => ({}),
      },
      {} as TestEnv,
      "agent-ok-caps",
      {
        // Host registers the capability the bundle declared
        getHostCapabilityIds: () => ["tavily-web-search", "file-tools"],
        broadcastEvent: (event) => broadcastedEvents.push(event),
      },
    );
    await dispatcher.hasActiveBundle();

    const result = await dispatcher.dispatchTurn("session-1", "hello");
    expect(result.dispatched).toBe(true);
    expect(broadcastedEvents).toHaveLength(0);
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
      __BUNDLE_TOKEN: "tok",
    } as BundleEnv);
    expect(smoke.status).toBe(200);
    const smokeBody = (await smoke.json()) as Record<string, unknown>;
    expect(smokeBody.status).toBe("ok");

    // With the streaming runtime, /turn requires __BUNDLE_TOKEN + a SPINE
    // binding. Without SPINE the bundle cannot reach host state and
    // returns 500 — that's the intended failure mode, not agent events
    // in the HTTP body. The live-streaming contract is exercised by
    // openrouter-integration.test.ts with a full spine mock.
    const turn = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", agentId: "a", sessionId: "s" }),
      }),
      { __BUNDLE_TOKEN: "tok" } as BundleEnv,
    );
    expect(turn.status).toBe(500);
    const errorBody = (await turn.json()) as { error: string };
    expect(errorBody.error).toContain("SPINE");
  });
});

// Gap 8: catalog mismatch at dispatch time → no mint, no env projection, static fallback
describe("BundleDispatcher catalog-mismatch dispatch guard (Gap 8)", () => {
  it("returns dispatched=false when bundle requires a capability absent from host", async () => {
    // Bundle declares it needs "secret-capability" but the host only has "file-tools".
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-needs-secret", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "secret-capability" }],
    });
    registry.setActiveSync("agent-cat-fail", "v-needs-secret");

    let envProjected: Record<string, unknown> | null = null;
    const spyLoader = makeFakeLoader({
      onFactoryCall: (env) => {
        envProjected = env;
      },
    });

    // Host only offers "file-tools" — "secret-capability" is absent.
    const dispatcher = new BundleDispatcher(
      makeConfig(registry, spyLoader),
      {} as TestEnv,
      "agent-cat-fail",
      { getHostCapabilityIds: () => ["file-tools"] },
    );
    await dispatcher.hasActiveBundle();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dispatcher.dispatchTurn("s1", "hello");
    warnSpy.mockRestore();

    // Dispatcher must signal fallback, not bundle success
    expect(result.dispatched).toBe(false);
    if (!result.dispatched) {
      expect(result.reason).toMatch(/catalog mismatch/);
      expect(result.reason).toContain("secret-capability");
    }
    // And the bundle env must never have been projected to the loader.
    expect(envProjected).toBeNull();
  });

  it("does NOT project bundleEnv or mint a token on catalog mismatch", async () => {
    // The factory callback (onFactoryCall) would only fire if the loader's
    // get() is called — which only happens after catalog validation passes
    // and mintToken runs. A catalog failure must short-circuit before either.
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-needs-missing", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "nonexistent-cap" }],
    });
    registry.setActiveSync("agent-no-mint", "v-needs-missing");

    let loaderWasCalled = false;
    let envProjected: Record<string, unknown> | null = null;
    const spyLoader = makeFakeLoader({
      onGetCall: () => {
        loaderWasCalled = true;
      },
      onFactoryCall: (env) => {
        envProjected = env;
      },
    });

    const dispatcher = new BundleDispatcher(
      makeConfig(registry, spyLoader),
      {} as TestEnv,
      "agent-no-mint",
      // Empty host capability set — "nonexistent-cap" is absent
      { getHostCapabilityIds: () => [] },
    );
    await dispatcher.hasActiveBundle();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dispatcher.dispatchTurn("s1", "hello");
    warnSpy.mockRestore();

    expect(result.dispatched).toBe(false);

    // Loader must NOT have been called — no mint, no env projection
    expect(loaderWasCalled).toBe(false);
    expect(envProjected).toBeNull();
  });

  it("clears the registry pointer after catalog mismatch (static fallback is permanent)", async () => {
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-clears", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "gone-capability" }],
    });
    registry.setActiveSync("agent-clears", "v-clears");

    const dispatcher = new BundleDispatcher(
      makeConfig(registry, makeFakeLoader()),
      {} as TestEnv,
      "agent-clears",
      { getHostCapabilityIds: () => [] },
    );
    await dispatcher.hasActiveBundle();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dispatcher.dispatchTurn("s1", "hello");
    warnSpy.mockRestore();

    // Registry pointer must be cleared — bundle is permanently disabled
    expect(await registry.getActiveForAgent("agent-clears")).toBeNull();
  });

  it("dispatches normally when bundle requires a capability that the host provides", async () => {
    // Positive control: catalog match → dispatch proceeds normally.
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-matches", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "file-tools" }],
    });
    registry.setActiveSync("agent-matches", "v-matches");

    const dispatcher = new BundleDispatcher(
      makeConfig(registry, makeFakeLoader()),
      {} as TestEnv,
      "agent-matches",
      { getHostCapabilityIds: () => ["file-tools"] },
    );
    await dispatcher.hasActiveBundle();

    const result = await dispatcher.dispatchTurn("s1", "hi");
    expect(result.dispatched).toBe(true);
  });
});
