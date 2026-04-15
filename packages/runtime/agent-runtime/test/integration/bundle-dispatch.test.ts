/**
 * Bundle dispatch integration tests.
 *
 * Exercises AgentDO.initBundleDispatch end-to-end inside the pool-workers
 * runtime. Uses a hand-rolled TestBundleAgentDO (extends AgentDO, calls
 * initBundleDispatch in its constructor, mocks pi-agent-core via MockPiAgent
 * for the static brain fallback), paired with an InMemoryBundleRegistry
 * seeded with the fixtures in test/fixtures/bundle-sources.ts and the
 * data:text/javascript fake loader in test-helpers/fake-worker-loader.ts.
 *
 * Each describe block uses a unique DO name suffix so `isolatedStorage=false`
 * does not cross-contaminate state across tests.
 *
 * Important: the runtime derives `agentId` from `ctx.id.toString()` (the DO
 * id hash), NOT the name passed to `idFromName()`. Tests MUST use
 * `getBundleStubAndId(name)` and pass `agentId` to every `registry.setActive`
 * call — otherwise the runtime's registry lookup misses the pointer.
 */

import { InMemoryBundleRegistry } from "@claw-for-cloudflare/agent-bundle/host";
import { beforeEach, describe, expect, it } from "vitest";
import { makeFakeWorkerLoader } from "../../src/test-helpers/fake-worker-loader.js";
import {
  clearMockResponses,
  resetTestBundleHolders,
  setMockResponses,
  setTestBundleEnv,
  setTestBundleLoader,
  setTestBundleRegistry,
} from "../../src/test-helpers/test-agent-do.js";
import {
  encodeBundleEnvelope,
  POISON_BUNDLE_SOURCE,
  REFERENCE_BUNDLE_SOURCE,
} from "../fixtures/bundle-sources.js";
import {
  assistantText,
  getBundleStub,
  getBundleStubAndId,
  getCachedBundlePointer,
  getEntries,
  openBundleSocket,
  postBundleDisable,
  postBundleRefresh,
  runTurn,
} from "../helpers/bundle-client.js";

// Unique marker used for the static-brain mock response across all tests.
// Appearing in session entries = static brain ran. Absent = bundle handled.
const STATIC_MARKER = "STATIC_BRAIN_MARKER";

function freshRegistry(): InMemoryBundleRegistry {
  return new InMemoryBundleRegistry();
}

function assistantEntries(entries: Array<{ type: string; data: Record<string, unknown> }>) {
  return entries.filter(
    (e) => e.type === "message" && (e.data as { role?: string }).role === "assistant",
  );
}

describe("bundle dispatch: static brain fallback", () => {
  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    setTestBundleRegistry(freshRegistry());
    setTestBundleLoader(makeFakeWorkerLoader());
  });

  it("runs the static brain when no bundle is registered", async () => {
    setMockResponses([{ text: "static-brain-reply" }]);

    const { stub } = getBundleStubAndId("static-brain-no-bundle");
    const sid = await runTurn(stub, "hi");

    const entries = await getEntries(stub, sid);
    const assistants = assistantEntries(entries);
    expect(assistants.length).toBe(1);
    expect(assistantText(assistants[0])).toBe("static-brain-reply");

    // Pointer cache populated with null after the cold-path registry read.
    const cached = await getCachedBundlePointer(stub);
    expect(cached).toBeNull();
  });

  it("runs the static brain when a bundle is seeded but not active", async () => {
    const registry = freshRegistry();
    registry.seed("v1", REFERENCE_BUNDLE_SOURCE);
    // Seed but NEVER call setActive — getActiveForAgent returns null.
    setTestBundleRegistry(registry);
    setMockResponses([{ text: "static-after-seed" }]);

    const { stub } = getBundleStubAndId("static-brain-seeded-but-inactive");
    const sid = await runTurn(stub, "hi");

    const assistants = assistantEntries(await getEntries(stub, sid));
    expect(assistants.length).toBe(1);
    expect(assistantText(assistants[0])).toBe("static-after-seed");
  });
});

describe("bundle dispatch: turn dispatch", () => {
  let registry: InMemoryBundleRegistry;
  let envCaptures: Array<Record<string, unknown>>;
  let getVersionIdCalls: string[];

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    // Seed a poison-pill static response. Any assertion should confirm
    // the bundle handled the turn so this marker never appears.
    setMockResponses([{ text: STATIC_MARKER }, { text: STATIC_MARKER }, { text: STATIC_MARKER }]);
    registry = freshRegistry();
    registry.seed("v-ref", REFERENCE_BUNDLE_SOURCE);
    envCaptures = [];
    getVersionIdCalls = [];
    setTestBundleRegistry(registry);
    setTestBundleLoader(
      makeFakeWorkerLoader({
        onGetCall: (v) => getVersionIdCalls.push(v),
        onFactoryCall: (env) => envCaptures.push(env),
      }),
    );
    setTestBundleEnv({ TIMEZONE: "UTC" });
  });

  it("dispatches the turn into the bundle when a version is active", async () => {
    const { stub, agentId } = getBundleStubAndId("dispatch-active");
    await registry.setActive(agentId, "v-ref");

    const sid = await runTurn(stub, "hello");

    // Bundle handled — static brain did not run.
    const assistants = assistantEntries(await getEntries(stub, sid));
    expect(
      assistants.every((a) => assistantText(a) !== STATIC_MARKER),
      `static brain ran when bundle was expected to dispatch; entries=${JSON.stringify(assistants)}`,
    ).toBe(true);

    // Loader was invoked with the active version.
    expect(getVersionIdCalls).toContain("v-ref");

    // Cached pointer is set.
    expect(await getCachedBundlePointer(stub)).toBe("v-ref");
  });

  it("mints a fresh capability token per turn", async () => {
    const { stub, agentId } = getBundleStubAndId("dispatch-fresh-token");
    await registry.setActive(agentId, "v-ref");

    await runTurn(stub, "first");
    await runTurn(stub, "second");

    expect(envCaptures.length).toBeGreaterThanOrEqual(2);
    const token1 = envCaptures[0].__SPINE_TOKEN as string;
    const token2 = envCaptures[1].__SPINE_TOKEN as string;
    expect(typeof token1).toBe("string");
    expect(typeof token2).toBe("string");
    expect(token1).not.toEqual(token2);
  });

  it("mints separate spine and llm tokens with different subkeys", async () => {
    const { stub, agentId } = getBundleStubAndId("dispatch-token-subkeys");
    await registry.setActive(agentId, "v-ref");
    await runTurn(stub, "hi");

    expect(envCaptures[0]).toHaveProperty("__SPINE_TOKEN");
    expect(envCaptures[0]).toHaveProperty("__LLM_TOKEN");
    // Different subkeys → different signatures even though payload is identical.
    expect(envCaptures[0].__SPINE_TOKEN).not.toEqual(envCaptures[0].__LLM_TOKEN);
  });

  it("invokes loader.get() with the active versionId", async () => {
    const { stub, agentId } = getBundleStubAndId("dispatch-versionid");
    await registry.setActive(agentId, "v-ref");
    await runTurn(stub, "x");
    expect(getVersionIdCalls).toContain("v-ref");
  });

  it("forwards the projected bundleEnv plus injected tokens", async () => {
    const { stub, agentId } = getBundleStubAndId("dispatch-env-projection");
    await registry.setActive(agentId, "v-ref");
    await runTurn(stub, "hi");

    expect(envCaptures.length).toBeGreaterThanOrEqual(1);
    expect(envCaptures[0].TIMEZONE).toBe("UTC");
    expect(envCaptures[0]).toHaveProperty("__SPINE_TOKEN");
    expect(envCaptures[0]).toHaveProperty("__LLM_TOKEN");
  });

  it("bundle dispatch path does NOT invoke the static-brain MockPiAgent", async () => {
    // Extra guard: seed a distinctive marker. If static ran, we'd see it.
    setMockResponses([{ text: STATIC_MARKER }]);

    const { stub, agentId } = getBundleStubAndId("dispatch-no-static");
    await registry.setActive(agentId, "v-ref");
    const sid = await runTurn(stub, "hi");

    const assistants = assistantEntries(await getEntries(stub, sid));
    for (const a of assistants) {
      expect(assistantText(a)).not.toBe(STATIC_MARKER);
    }
  });
});

describe("bundle dispatch: auto-revert", () => {
  let registry: InMemoryBundleRegistry;

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    registry = freshRegistry();
    registry.seed("v-poison", POISON_BUNDLE_SOURCE);
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
  });

  it("reverts to the static brain after 3 consecutive load failures", async () => {
    // One static response per failing turn (bundle returns false after
    // failure, static brain runs) + one after revert.
    setMockResponses([
      { text: "fail-1" },
      { text: "fail-2" },
      { text: "fail-3" },
      { text: "after-revert" },
    ]);

    const { stub, agentId } = getBundleStubAndId("auto-revert-3");
    await registry.setActive(agentId, "v-poison");

    for (let i = 0; i < 3; i++) {
      await runTurn(stub, `turn-${i}`);
    }

    // Registry pointer auto-reverted to null.
    expect(await registry.getActiveForAgent(agentId)).toBeNull();
    // Cached pointer also cleared.
    expect(await getCachedBundlePointer(stub)).toBeNull();
  });

  it("failure counter resets after a successful bundle turn", async () => {
    setMockResponses([
      { text: "fail-1" },
      { text: "fail-2" },
      { text: "fail-3" },
      { text: "fail-4" },
      { text: "after-revert-ignored" },
    ]);

    registry.seed("v-ref", REFERENCE_BUNDLE_SOURCE);
    const { stub, agentId } = getBundleStubAndId("auto-revert-reset");
    await registry.setActive(agentId, "v-poison");

    // Two failures.
    await runTurn(stub, "fail-1");
    await runTurn(stub, "fail-2");

    // Still poisoned; cache not cleared yet.
    expect(await registry.getActiveForAgent(agentId)).toBe("v-poison");

    // Swap to a working bundle and refresh the cached pointer.
    await registry.setActive(agentId, "v-ref");
    await postBundleRefresh(stub);

    // Successful bundle turn resets consecutiveFailures to 0.
    await runTurn(stub, "success");

    // Swap back to poison; drive 2 failures. Counter is 2 (post-reset), no revert.
    await registry.setActive(agentId, "v-poison");
    await postBundleRefresh(stub);
    await runTurn(stub, "fail-3");
    await runTurn(stub, "fail-4");

    expect(await registry.getActiveForAgent(agentId)).toBe("v-poison");
  });
});

describe("bundle dispatch: POST /bundle/disable", () => {
  let registry: InMemoryBundleRegistry;

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    registry = freshRegistry();
    registry.seed("v-ref", REFERENCE_BUNDLE_SOURCE);
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
  });

  it("authorized POST clears the pointer and forces static brain next turn", async () => {
    setMockResponses([{ text: "static-after-disable" }]);

    const { stub, agentId } = getBundleStubAndId("disable-authz");
    await registry.setActive(agentId, "v-ref");

    const res = await postBundleDisable(stub, { authorized: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("disabled");

    expect(await registry.getActiveForAgent(agentId)).toBeNull();
    expect(await getCachedBundlePointer(stub)).toBeNull();

    const sid = await runTurn(stub, "post-disable");
    const assistants = assistantEntries(await getEntries(stub, sid));
    expect(assistantText(assistants[0])).toBe("static-after-disable");
  });

  it("unauthorized POST returns 401 and leaves the pointer intact", async () => {
    const { stub, agentId } = getBundleStubAndId("disable-unauthz");
    await registry.setActive(agentId, "v-ref");

    const res = await postBundleDisable(stub, { authorized: false });
    expect(res.status).toBe(401);

    // Pointer unchanged.
    expect(await registry.getActiveForAgent(agentId)).toBe("v-ref");
  });
});

describe("bundle dispatch: POST /bundle/refresh", () => {
  let registry: InMemoryBundleRegistry;

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    registry = freshRegistry();
    registry.seed("v1", REFERENCE_BUNDLE_SOURCE);
    registry.seed("v2", REFERENCE_BUNDLE_SOURCE);
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
  });

  it("re-reads the registry pointer after out-of-band setActive", async () => {
    // Poison-pill for static fallback; we should never see it.
    setMockResponses([{ text: STATIC_MARKER }, { text: STATIC_MARKER }, { text: STATIC_MARKER }]);

    const { stub, agentId } = getBundleStubAndId("refresh-oob");
    await registry.setActive(agentId, "v1");

    // Prime cache by running one turn.
    await runTurn(stub, "prime");
    expect(await getCachedBundlePointer(stub)).toBe("v1");

    // Out-of-band pointer mutation (bypasses notifyBundlePointerChanged).
    await registry.setActive(agentId, "v2");

    // Cache is stale — still points at v1.
    expect(await getCachedBundlePointer(stub)).toBe("v1");

    // /bundle/refresh picks up v2.
    const body = await postBundleRefresh(stub);
    expect(body.status).toBe("refreshed");
    expect(body.activeVersionId).toBe("v2");
    expect(await getCachedBundlePointer(stub)).toBe("v2");
  });
});

describe("bundle dispatch: client event routing", () => {
  let registry: InMemoryBundleRegistry;
  let clientEventSink: unknown[];

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    registry = freshRegistry();
    registry.seed("v-ref", REFERENCE_BUNDLE_SOURCE);
    clientEventSink = [];
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
    // The REFERENCE_BUNDLE_SOURCE fixture pushes any body sent to
    // /client-event into env.__TEST_CLIENT_EVENT_SINK. The fake loader
    // passes env references through without cloning, so the test can
    // observe the bundle's receive list directly.
    setTestBundleEnv({ __TEST_CLIENT_EVENT_SINK: clientEventSink });
  });

  it("steer message over WebSocket forwards to the bundle's /client-event", async () => {
    const { stub, agentId } = getBundleStubAndId("client-event-steer");
    await registry.setActive(agentId, "v-ref");

    const socket = await openBundleSocket(stub);
    socket.send({
      type: "steer",
      sessionId: socket.sessionId,
      text: "mid-turn-correction",
    });

    // Give the fire-and-forget forward a chance to resolve.
    // The handler awaits loader.get → fetch /client-event → push to sink.
    // Retry a few times under a hard timeout.
    const deadline = Date.now() + 2000;
    while (clientEventSink.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(
      clientEventSink.length,
      `bundle did not receive client event within 2s. Sink: ${JSON.stringify(clientEventSink)}`,
    ).toBeGreaterThan(0);
    const received = clientEventSink[0] as { type: string; text?: string };
    expect(received.type).toBe("steer");
    expect(received.text).toBe("mid-turn-correction");

    socket.close();
  });

  it("abort message over WebSocket forwards to the bundle's /client-event", async () => {
    const { stub, agentId } = getBundleStubAndId("client-event-abort");
    await registry.setActive(agentId, "v-ref");

    const socket = await openBundleSocket(stub);
    socket.send({ type: "abort", sessionId: socket.sessionId });

    const deadline = Date.now() + 2000;
    while (clientEventSink.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(clientEventSink.length).toBeGreaterThan(0);
    expect((clientEventSink[0] as { type: string }).type).toBe("abort");

    socket.close();
  });

  it("client events are NOT forwarded when no bundle is active", async () => {
    // Do NOT call setActive.
    const { stub } = getBundleStubAndId("client-event-no-bundle");

    const socket = await openBundleSocket(stub);
    socket.send({
      type: "steer",
      sessionId: socket.sessionId,
      text: "whatever",
    });

    // Wait a moment; sink should stay empty.
    await new Promise((r) => setTimeout(r, 100));
    expect(clientEventSink.length).toBe(0);

    socket.close();
  });
});

describe("bundle dispatch: v1 envelope decoding", () => {
  let registry: InMemoryBundleRegistry;

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    registry = freshRegistry();
    // Seed the SAME reference source but wrapped in a v1 envelope — this
    // mirrors what @cloudflare/worker-bundler#createWorker writes (via
    // workshop_build / workshop_deploy). Regression guard for the bug
    // where AgentDO.initBundleDispatch passed raw envelope JSON to the
    // loader, producing "Unexpected token ':' at bundle.js:1:4".
    registry.seed("v-envelope", encodeBundleEnvelope(REFERENCE_BUNDLE_SOURCE));
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
    setMockResponses([
      { text: STATIC_MARKER },
      { text: STATIC_MARKER },
    ]);
  });

  it("dispatches an envelope-wrapped bundle without choking on JSON", async () => {
    const { stub, agentId } = getBundleStubAndId("envelope-dispatch");
    await registry.setActive(agentId, "v-envelope");

    const sid = await runTurn(stub, "hi");

    // Static brain MUST NOT run — if it does, decoding failed and the
    // dispatcher fell through.
    const assistants = assistantEntries(await getEntries(stub, sid));
    for (const a of assistants) {
      expect(assistantText(a)).not.toBe(STATIC_MARKER);
    }
    // Cached pointer set → bundle handled the turn.
    expect(await getCachedBundlePointer(stub)).toBe("v-envelope");
  });
});

describe("bundle dispatch: /bundle/* path reservation", () => {
  beforeEach(() => {
    resetTestBundleHolders();
    setTestBundleRegistry(freshRegistry());
    setTestBundleLoader(makeFakeWorkerLoader());
  });

  it("unknown /bundle/* paths return 404 from the DO, not the bundle", async () => {
    const stub = getBundleStub("bundle-path-reserve");
    const res = await stub.fetch("http://fake/bundle/something-weird", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(404);
  });
});
