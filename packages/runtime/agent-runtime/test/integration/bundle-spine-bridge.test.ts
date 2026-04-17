/**
 * SpineService bridge integration tests.
 *
 * Exercises the full bundle -> SpineService -> agent DO spine method
 * pipeline with real token minting and verification:
 *   1. `AgentDO.initBundleDispatch` mints a unified capability token per turn
 *      and injects it into the bundle env as `__BUNDLE_TOKEN`.
 *   2. The bundle (running in the fake loader) calls `env.SPINE.appendEntry(
 *      token, entry)` on a real `SpineService` instance via service binding.
 *   3. `SpineService` derives its HKDF verify-only subkey from the master
 *      `AGENT_AUTH_KEY` using `BUNDLE_SUBKEY_LABEL`, verifies the token with
 *      `requiredScope: "spine"`, constructs a `SpineCaller` from the verified
 *      payload, and dispatches to the agent DO via a direct DO method-call RPC
 *      (`host.spineAppendEntry(caller, entry)`) on a typed
 *      `DurableObjectStub<SpineHost>`.
 *   4. `AgentDO.spineAppendEntry` forwards to `AgentRuntime.spineAppendEntry`,
 *      which checks the per-turn budget then persists the entry via
 *      `sessionStore.appendEntry`.
 *
 * Covers the token verification error codes (`ERR_BAD_TOKEN`,
 * `ERR_TOKEN_EXPIRED`, `ERR_SCOPE_DENIED`) and the budget enforcement
 * (`ERR_BUDGET_EXCEEDED`) paths.
 */

import { env as testEnv } from "cloudflare:test";
import {
  BUNDLE_SUBKEY_LABEL,
  deriveMintSubkey,
  InMemoryBundleRegistry,
  mintToken,
  SpineService,
} from "@claw-for-cloudflare/bundle-host";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpineCaller } from "../../src/spine-host.js";
import { makeFakeWorkerLoader } from "../../src/test-helpers/fake-worker-loader.js";
import {
  clearMockResponses,
  resetTestBundleHolders,
  setTestBundleEnv,
  setTestBundleLoader,
  setTestBundleRegistry,
  TEST_BUNDLE_AUTH_KEY,
} from "../../src/test-helpers/test-agent-do.js";
import { SPINE_BRIDGE_BUNDLE_SOURCE } from "../fixtures/bundle-sources.js";
import { getBundleStubAndId, getEntries, runTurn } from "../helpers/bundle-client.js";

interface TestEnv {
  TEST_BUNDLE_AGENT: DurableObjectNamespace;
}

function makeSpineCtx(): ExecutionContext {
  // SpineService extends WorkerEntrypoint which stores ctx but doesn't use
  // its fields directly. A minimal stub is fine.
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function makeRealSpineService(): SpineService {
  const spineEnv = {
    AGENT: (testEnv as unknown as TestEnv).TEST_BUNDLE_AGENT,
    AGENT_AUTH_KEY: TEST_BUNDLE_AUTH_KEY,
  };
  return new SpineService(makeSpineCtx(), spineEnv);
}

/** Build a synthetic SpineCaller for direct DO calls in tests. */
function makeCaller(overrides: Partial<SpineCaller> = {}): SpineCaller {
  return {
    aid: "test-agent",
    sid: "test-session",
    nonce: crypto.randomUUID(),
    ...overrides,
  };
}

describe("bundle spine bridge: appendEntry", () => {
  let registry: InMemoryBundleRegistry;
  let spine: SpineService;
  let resultsSink: Array<Record<string, unknown>>;

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    registry = new InMemoryBundleRegistry();
    registry.seed("v-spine", SPINE_BRIDGE_BUNDLE_SOURCE);
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
    spine = makeRealSpineService();
    resultsSink = [];
    setTestBundleEnv({ SPINE: spine, __TEST_RESULTS_SINK: resultsSink });
  });

  it("bundle's env.SPINE.appendEntry persists via the DO /spine route", async () => {
    const { stub, agentId } = getBundleStubAndId("spine-append");
    await registry.setActive(agentId, "v-spine", { skipCatalogCheck: true });

    const sid = await runTurn(stub, JSON.stringify({ action: "appendEntry" }));

    // Debug: if the bundle errored, the sink will carry results.error.
    const bundleResults = resultsSink[0];
    expect(
      bundleResults && !bundleResults.error,
      `bundle threw while calling spine: ${JSON.stringify(bundleResults)}`,
    ).toBe(true);

    const entries = await getEntries(stub, sid);
    const appended = entries.find(
      (e) =>
        e.type === "message" &&
        (e.data as { role: string }).role === "assistant" &&
        (e.data as { content: string }).content === "bundle-appended-via-spine",
    );
    expect(
      appended,
      `appendEntry did not persist; entries=${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it("bundle's env.SPINE.emitCost persists a cost entry", async () => {
    const { stub, agentId } = getBundleStubAndId("spine-emit-cost");
    await registry.setActive(agentId, "v-spine", { skipCatalogCheck: true });

    const sid = await runTurn(stub, JSON.stringify({ action: "emitCost" }));

    const entries = await getEntries(stub, sid);
    // Cost entries are persisted as type="custom" with data.customType="cost".
    const cost = entries.find(
      (e) => e.type === "custom" && (e.data as { customType?: string }).customType === "cost",
    );
    expect(cost, `cost entry did not persist; entries=${JSON.stringify(entries)}`).toBeDefined();
    const payload = (cost?.data as { payload: Record<string, unknown> }).payload;
    expect(payload.capabilityId).toBe("test-bundle");
    expect(payload.toolName).toBe("spine.emitCost");
    expect(payload.amount).toBe(0.0025);
    expect(payload.currency).toBe("USD");
  });
});

describe("bundle spine bridge: token verification", () => {
  let spine: SpineService;
  let agentId: string;
  let stub: DurableObjectStub;

  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-spine", SPINE_BRIDGE_BUNDLE_SOURCE);
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());
    spine = makeRealSpineService();
    const handle = getBundleStubAndId("spine-verify");
    agentId = handle.agentId;
    stub = handle.stub;
  });

  /**
   * Create a real session on the DO via the spine method surface and
   * return its id. Callers mint tokens bound to this id so subsequent
   * `spine.appendEntry` calls reach a session the DO actually knows
   * about — matching production, where the bundle prompt handler mints
   * tokens tied to the session it was called for.
   */
  async function createRealSession(): Promise<string> {
    const caller = makeCaller({ sid: "" });
    // biome-ignore lint/suspicious/noExplicitAny: direct DO stub method call
    const session = (await (stub as any).spineCreateSession(caller, {
      name: "bundle-spine-bridge-test",
    })) as { id: string };
    return session.id;
  }

  it("bad (tampered) token is rejected with ERR_BAD_TOKEN", async () => {
    // Mint a valid token under the bundle subkey, then flip a character
    // in the signature to invalidate the HMAC.
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const validToken = await mintToken(
      { agentId, sessionId: "fake-session", scope: ["spine", "llm"] },
      subkey,
    );
    const [payloadB64, sigB64] = validToken.split(".");
    // Flip a character in the signature. Base64url alphabet: A-Za-z0-9_-
    const tamperedSig = sigB64[0] === "A" ? `B${sigB64.slice(1)}` : `A${sigB64.slice(1)}`;
    const tampered = `${payloadB64}.${tamperedSig}`;

    await expect(
      spine.appendEntry(tampered, {
        type: "message",
        data: { role: "assistant", content: "should-not-persist", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_BAD_TOKEN" });
  });

  it("expired token is rejected with ERR_TOKEN_EXPIRED", async () => {
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const expired = await mintToken(
      { agentId, sessionId: "fake-session", scope: ["spine"], ttlMs: -1 },
      subkey,
    );

    await expect(
      spine.appendEntry(expired, {
        type: "message",
        data: { role: "assistant", content: "nope", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_TOKEN_EXPIRED" });
  });

  it("same token may be reused across the turn (no per-call replay protection)", async () => {
    // Regression guard: we deliberately dropped single-use nonce
    // enforcement from SpineService.verify because it conflated with
    // per-turn budget. A bundle MUST be able to make many spine calls
    // with the same token. Replay protection still exists via token
    // `exp` (default 60s) and `globalOutbound: null` on the isolate.
    //
    // Direct-method dispatch propagates DO exceptions faithfully — so
    // we need a REAL sessionId backed by a session the DO knows about,
    // not a synthetic `"fake-session"` that would trip `sessionStore
    // .appendEntry`'s "Session not found" guard. Create one via the
    // spine surface itself.
    const sessionId = await createRealSession();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    // Three successive calls with the same token succeed.
    for (let i = 0; i < 3; i++) {
      await spine.appendEntry(token, {
        type: "message",
        data: { role: "assistant", content: `reuse-${i}`, timestamp: Date.now() },
      });
    }
  });

  it("budget cap fires on the 101st SQL op within the same turn (same token)", async () => {
    // With nonce reusable, the per-turn budget (100 SQL ops by default)
    // is the real spam brake. Hit it. Budget enforcement now lives in
    // the DO's AgentRuntime, not in the SpineService instance.
    const sessionId = await createRealSession();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    for (let i = 0; i < 100; i++) {
      await spine.appendEntry(token, {
        type: "message",
        data: { role: "assistant", content: `budget-${i}`, timestamp: Date.now() },
      });
    }

    await expect(
      spine.appendEntry(token, {
        type: "message",
        data: { role: "assistant", content: "over-budget", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_BUDGET_EXCEEDED" });
  });

  it("expired token is rejected even with replay protection removed", async () => {
    // exp is enforced independently of nonce tracking. Re-assert here
    // to lock in the invariant after the replay-check removal.
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const expired = await mintToken(
      { agentId, sessionId: "fake-session", scope: ["spine"], ttlMs: -1 },
      subkey,
    );

    await expect(
      spine.appendEntry(expired, {
        type: "message",
        data: { role: "assistant", content: "nope", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_TOKEN_EXPIRED" });
  });

  it("token signed with the wrong master key is rejected", async () => {
    const wrongSubkey = await deriveMintSubkey("different-master-key", BUNDLE_SUBKEY_LABEL);
    const foreign = await mintToken(
      { agentId, sessionId: "fake-session", scope: ["spine"] },
      wrongSubkey,
    );

    await expect(
      spine.appendEntry(foreign, {
        type: "message",
        data: { role: "assistant", content: "foreign", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_BAD_TOKEN" });
  });

  it("token without 'spine' scope is rejected with ERR_SCOPE_DENIED", async () => {
    // Scope enforcement: a valid unified token whose scope array omits
    // "spine" must be rejected at SpineService.verify with ERR_SCOPE_DENIED.
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const noSpineToken = await mintToken(
      { agentId, sessionId: "fake-session", scope: ["llm"] },
      subkey,
    );

    await expect(
      spine.appendEntry(noSpineToken, {
        type: "message",
        data: { role: "assistant", content: "wrong-scope", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_SCOPE_DENIED" });
  });
});

describe("bundle spine bridge: instance-recycle budget enforcement", () => {
  /**
   * Load-bearing test: proves that per-turn budget enforcement survives
   * SpineService instance recycling because the tracker now lives in the
   * DO, not in the SpineService.
   *
   * Under the OLD architecture (BudgetTracker on SpineService), each
   * instance had its own tracker — constructing a fresh instance resets
   * the counters, so two instances serving 50 calls each could pass a
   * cap of 100 (each sees <= 50 calls). Under the NEW architecture
   * (BudgetTracker on AgentRuntime in the DO), state accumulates
   * correctly across any number of SpineService instances.
   */
  it("budget persists across SpineService instance recycles", async () => {
    resetTestBundleHolders();
    clearMockResponses();
    const registry = new InMemoryBundleRegistry();
    registry.seed("v-spine", SPINE_BRIDGE_BUNDLE_SOURCE);
    setTestBundleRegistry(registry);
    setTestBundleLoader(makeFakeWorkerLoader());

    const { stub, agentId } = getBundleStubAndId("spine-recycle");

    // Create a real session so appendEntry doesn't throw "not found"
    const caller = makeCaller({ sid: "" });
    // biome-ignore lint/suspicious/noExplicitAny: direct DO stub method call
    const session = (await (stub as any).spineCreateSession(caller, {
      name: "recycle-test",
    })) as { id: string };
    const sessionId = session.id;

    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    // First SpineService instance — issue 50 calls
    const service1 = makeRealSpineService();
    for (let i = 0; i < 50; i++) {
      await service1.appendEntry(token, {
        type: "message",
        data: { role: "assistant", content: `s1-${i}`, timestamp: Date.now() },
      });
    }

    // Simulate instance recycle — fresh SpineService, same env and DO
    const service2 = makeRealSpineService();
    for (let i = 0; i < 50; i++) {
      await service2.appendEntry(token, {
        type: "message",
        data: { role: "assistant", content: `s2-${i}`, timestamp: Date.now() },
      });
    }

    // 101st call in total should fail — budget state lives in the DO,
    // not in the SpineService instance
    await expect(
      service2.appendEntry(token, {
        type: "message",
        data: { role: "assistant", content: "should-fail", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_BUDGET_EXCEEDED" });
  });
});
