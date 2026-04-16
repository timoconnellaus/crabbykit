/**
 * SpineService bridge integration tests.
 *
 * Exercises the full bundle → SpineService → agent DO spine method
 * pipeline with real token minting and verification:
 *   1. `AgentDO.initBundleDispatch` mints a capability token per turn and
 *      injects it into the bundle env as `__SPINE_TOKEN`.
 *   2. The bundle (running in the fake loader) calls `env.SPINE.appendEntry(
 *      token, entry)` on a real `SpineService` instance via service binding.
 *   3. `SpineService` derives its HKDF verify-only subkey from the master
 *      `AGENT_AUTH_KEY`, verifies the token, checks the per-turn budget,
 *      and dispatches to the agent DO via a direct DO method-call RPC
 *      (`host.spineAppendEntry(sessionId, entry)`) on a typed
 *      `DurableObjectStub<SpineHost>`.
 *   4. `AgentDO.spineAppendEntry` forwards to `AgentRuntime.spineAppendEntry`,
 *      which persists the entry via `sessionStore.appendEntry`.
 *
 * Covers the token verification error codes (`ERR_BAD_TOKEN`,
 * `ERR_TOKEN_EXPIRED`, `ERR_TOKEN_REPLAY`) and the budget enforcement
 * (`ERR_BUDGET_EXCEEDED`) paths — none of which had real integration
 * coverage prior to this file.
 */

import { env as testEnv } from "cloudflare:test";
import {
  deriveMintSubkey,
  InMemoryBundleRegistry,
  mintToken,
  SpineService,
} from "@claw-for-cloudflare/bundle-host";
import { beforeEach, describe, expect, it } from "vitest";
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
    await registry.setActive(agentId, "v-spine");

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
    await registry.setActive(agentId, "v-spine");

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
    // biome-ignore lint/suspicious/noExplicitAny: direct DO stub method call
    const session = (await (stub as any).spineCreateSession({
      name: "bundle-spine-bridge-test",
    })) as { id: string };
    return session.id;
  }

  it("bad (tampered) token is rejected with ERR_BAD_TOKEN", async () => {
    // Mint a valid token under the spine subkey, then flip a character
    // in the signature to invalidate the HMAC.
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, "claw/spine-v1");
    const validToken = await mintToken({ agentId, sessionId: "fake-session" }, subkey);
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
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, "claw/spine-v1");
    const expired = await mintToken({ agentId, sessionId: "fake-session", ttlMs: -1 }, subkey);

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
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, "claw/spine-v1");
    const token = await mintToken({ agentId, sessionId }, subkey);

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
    // is the real spam brake. Hit it.
    const sessionId = await createRealSession();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, "claw/spine-v1");
    const token = await mintToken({ agentId, sessionId }, subkey);

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
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, "claw/spine-v1");
    const expired = await mintToken({ agentId, sessionId: "fake-session", ttlMs: -1 }, subkey);

    await expect(
      spine.appendEntry(expired, {
        type: "message",
        data: { role: "assistant", content: "nope", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_TOKEN_EXPIRED" });
  });

  it("token signed with the wrong master key is rejected", async () => {
    const wrongSubkey = await deriveMintSubkey("different-master-key", "claw/spine-v1");
    const foreign = await mintToken({ agentId, sessionId: "fake-session" }, wrongSubkey);

    await expect(
      spine.appendEntry(foreign, {
        type: "message",
        data: { role: "assistant", content: "foreign", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_BAD_TOKEN" });
  });

  it("token signed with the llm subkey label is rejected by the spine subkey", async () => {
    // Domain separation: tokens minted under "claw/llm-v1" must NOT
    // verify under "claw/spine-v1", even though the master key is the same.
    const llmSubkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, "claw/llm-v1");
    const llmToken = await mintToken({ agentId, sessionId: "fake-session" }, llmSubkey);

    await expect(
      spine.appendEntry(llmToken, {
        type: "message",
        data: { role: "assistant", content: "wrong-service", timestamp: Date.now() },
      }),
    ).rejects.toMatchObject({ code: "ERR_BAD_TOKEN" });
  });
});
