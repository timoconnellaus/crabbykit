/**
 * Host hook-bus bridge integration tests (Phase 0 of bundle-shape-2-rollout).
 *
 * Exercises `AgentRuntime.spineRecordToolExecution` and
 * `spineProcessBeforeInference` — the two new bridge entry points that
 * let bundle-originated tool events and pre-inference message streams
 * pass through the host's existing hook chains (`afterToolExecutionHooks`,
 * `beforeInferenceHooks`).
 *
 * Tests here call the methods directly on the DO stub, bypassing
 * SpineService's token verifier — the host-side implementation is what
 * determines functional parity with the static path. A separate suite
 * lower in the file covers the SpineService-mediated path (scope check,
 * sanitize, token-derived caller).
 *
 * Uses unique DO names per describe block since `isolatedStorage` is
 * disabled (same rule as other integration tests here).
 */

import { env as testEnv } from "cloudflare:test";
import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import {
  BUNDLE_SUBKEY_LABEL,
  deriveMintSubkey,
  mintToken,
  SpineService,
} from "@claw-for-cloudflare/bundle-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDO } from "../../src/agent-do.js";
import type {
  BeforeToolExecutionEvent,
  BeforeToolExecutionResult,
  Capability,
  ToolExecutionEvent,
} from "../../src/capabilities/types.js";
import type { SpineCaller } from "../../src/spine-host.js";
import {
  clearExtraCapabilities,
  clearMockResponses,
  setExtraCapabilities,
  setMockResponses,
  TEST_BUNDLE_AUTH_KEY,
} from "../../src/test-helpers/test-agent-do.js";
import { connectAndGetSession, getStub } from "../helpers/ws-client.js";

type SpineStub = DurableObjectStub<AgentDO<Record<string, unknown>>>;
function spine(stub: DurableObjectStub): SpineStub {
  return stub as unknown as SpineStub;
}

function makeCaller(overrides: Partial<SpineCaller> = {}): SpineCaller {
  return {
    aid: "test-agent",
    sid: "test-session",
    nonce: crypto.randomUUID(),
    ...overrides,
  };
}

function makeEvent(toolName = "test_tool", isError = false): ToolExecutionEvent {
  return { toolName, args: { foo: "bar" }, isError };
}

function makeBtcEvent(
  toolName = "test_tool",
  args: unknown = { foo: "bar" },
  toolCallId = "call-1",
): BeforeToolExecutionEvent {
  return { toolName, args, toolCallId };
}

function textMessage(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

describe("hook bridge — spineRecordToolExecution", () => {
  afterEach(() => {
    clearExtraCapabilities();
    clearMockResponses();
  });

  it("invokes afterToolExecution hooks in registration order", async () => {
    const order: string[] = [];
    const cap = (id: string): Capability => ({
      id,
      name: id,
      description: id,
      hooks: {
        afterToolExecution: async () => {
          order.push(id);
        },
      },
    });
    setExtraCapabilities([cap("cap-A"), cap("cap-B"), cap("cap-C")]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-order-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineRecordToolExecution(caller, makeEvent());

    expect(order).toEqual(["cap-A", "cap-B", "cap-C"]);
    client.close();
  });

  it("continues the chain when one hook throws", async () => {
    const order: string[] = [];
    setExtraCapabilities([
      {
        id: "ok-1",
        name: "ok-1",
        description: "ok-1",
        hooks: {
          afterToolExecution: async () => {
            order.push("ok-1");
          },
        },
      },
      {
        id: "bad",
        name: "bad",
        description: "bad",
        hooks: {
          afterToolExecution: async () => {
            order.push("bad");
            throw new Error("hook-boom");
          },
        },
      },
      {
        id: "ok-2",
        name: "ok-2",
        description: "ok-2",
        hooks: {
          afterToolExecution: async () => {
            order.push("ok-2");
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-error-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    // Per-hook error swallowing — bridge call resolves cleanly even
    // though the middle hook threw.
    await expect(
      spine(stub).spineRecordToolExecution(caller, makeEvent()),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["ok-1", "bad", "ok-2"]);

    client.close();
  });

  it("enforces the hook_after_tool per-turn budget", async () => {
    setExtraCapabilities([
      {
        id: "noop",
        name: "noop",
        description: "noop",
        hooks: {
          afterToolExecution: async () => {},
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-budget-after-tool-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    // Default maxHookAfterTool = 200 — burn through without throwing.
    for (let i = 0; i < 200; i++) {
      await spine(stub).spineRecordToolExecution(caller, makeEvent());
    }
    await expect(spine(stub).spineRecordToolExecution(caller, makeEvent())).rejects.toThrow(
      /budget exceeded/i,
    );

    client.close();
  });

  it("passes a CapabilityHookContext carrying the verified caller's sessionId", async () => {
    const seen: Array<{ toolName: string; sessionId: string }> = [];
    setExtraCapabilities([
      {
        id: "observer",
        name: "observer",
        description: "observer",
        hooks: {
          afterToolExecution: async (event, ctx) => {
            seen.push({ toolName: event.toolName, sessionId: ctx.sessionId });
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-context-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineRecordToolExecution(caller, makeEvent("my_tool"));

    expect(seen).toHaveLength(1);
    expect(seen[0].toolName).toBe("my_tool");
    expect(seen[0].sessionId).toBe(sessionId);
    client.close();
  });
});

describe("hook bridge — spineProcessBeforeInference", () => {
  afterEach(() => {
    clearExtraCapabilities();
    clearMockResponses();
  });

  it("threads messages through registered hooks (H1 → H2 chain)", async () => {
    setExtraCapabilities([
      {
        id: "h1",
        name: "h1",
        description: "h1",
        hooks: {
          beforeInference: async (messages) => {
            return [...messages, textMessage("from-h1")];
          },
        },
      },
      {
        id: "h2",
        name: "h2",
        description: "h2",
        hooks: {
          beforeInference: async (messages) => {
            // H2 observes H1's output.
            return [...messages, textMessage("from-h2")];
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-mutator-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    const result = (await spine(stub).spineProcessBeforeInference(caller, [
      textMessage("seed"),
    ])) as AgentMessage[];

    // Seed + H1 + H2 → three messages in registration order.
    expect(result.map((m) => (m as { content: string }).content)).toEqual([
      "seed",
      "from-h1",
      "from-h2",
    ]);
    client.close();
  });

  it("per-hook errors don't abort the chain; final array is the last success", async () => {
    setExtraCapabilities([
      {
        id: "good",
        name: "good",
        description: "good",
        hooks: {
          beforeInference: async (messages) => [...messages, textMessage("good")],
        },
      },
      {
        id: "bad",
        name: "bad",
        description: "bad",
        hooks: {
          beforeInference: async () => {
            throw new Error("boom");
          },
        },
      },
      {
        id: "tail",
        name: "tail",
        description: "tail",
        hooks: {
          beforeInference: async (messages) => [...messages, textMessage("tail")],
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-mutator-err-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    const result = (await spine(stub).spineProcessBeforeInference(caller, [
      textMessage("seed"),
    ])) as AgentMessage[];

    // Middle hook threw; its contribution lost but chain continued.
    expect(result.map((m) => (m as { content: string }).content)).toEqual(["seed", "good", "tail"]);
    client.close();
  });

  it("enforces the hook_before_inference per-turn budget", async () => {
    setExtraCapabilities([
      {
        id: "identity",
        name: "identity",
        description: "identity",
        hooks: {
          beforeInference: async (messages) => messages,
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-budget-before-inf-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    // Default maxHookBeforeInference = 100.
    for (let i = 0; i < 100; i++) {
      await spine(stub).spineProcessBeforeInference(caller, [textMessage("hi")]);
    }
    await expect(
      spine(stub).spineProcessBeforeInference(caller, [textMessage("hi")]),
    ).rejects.toThrow(/budget exceeded/i);

    client.close();
  });
});

describe("hook bridge — parity with the static tool-execution path", () => {
  afterEach(() => {
    clearExtraCapabilities();
    clearMockResponses();
  });

  it("bridge-routed event invokes the same hook with the same context shape as the static path", async () => {
    // Register a capability whose hook snapshots the context shape and
    // the event it sees. We call the bridge once and assert the observed
    // fields match the CapabilityHookContext surface the static path
    // documents (same agentId, sessionId, populated capabilityIds array,
    // no extra/missing fields that would surprise a hook author).
    const observed: Array<{
      event: ToolExecutionEvent;
      agentId: string;
      sessionId: string;
      capIds: string[];
    }> = [];
    setExtraCapabilities([
      {
        id: "parity",
        name: "parity",
        description: "parity",
        hooks: {
          afterToolExecution: async (event, ctx) => {
            observed.push({
              event,
              agentId: ctx.agentId,
              sessionId: ctx.sessionId,
              capIds: [...ctx.capabilityIds],
            });
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-parity-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    const e: ToolExecutionEvent = { toolName: "echo", args: { x: 1 }, isError: false };
    await spine(stub).spineRecordToolExecution(caller, e);

    expect(observed).toHaveLength(1);
    const [first] = observed;
    expect(first.event.toolName).toBe("echo");
    expect(first.event.isError).toBe(false);
    expect(first.sessionId).toBe(sessionId);
    expect(typeof first.agentId).toBe("string");
    expect(first.agentId.length).toBeGreaterThan(0);
    expect(first.capIds).toContain("parity");

    client.close();
  });
});

describe("hook bridge — spineProcessBeforeToolExecution", () => {
  afterEach(() => {
    clearExtraCapabilities();
    clearMockResponses();
  });

  it("invokes beforeToolExecution hooks in registration order", async () => {
    const order: string[] = [];
    const cap = (id: string): Capability => ({
      id,
      name: id,
      description: id,
      hooks: {
        beforeToolExecution: async () => {
          order.push(id);
        },
      },
    });
    setExtraCapabilities([cap("btc-A"), cap("btc-B"), cap("btc-C")]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-order-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent());

    expect(order).toEqual(["btc-A", "btc-B", "btc-C"]);
    client.close();
  });

  it("continues the chain when one hook throws (subsequent hooks still run)", async () => {
    const order: string[] = [];
    setExtraCapabilities([
      {
        id: "ok-1",
        name: "ok-1",
        description: "ok-1",
        hooks: {
          beforeToolExecution: async () => {
            order.push("ok-1");
          },
        },
      },
      {
        id: "bad",
        name: "bad",
        description: "bad",
        hooks: {
          beforeToolExecution: async () => {
            order.push("bad");
            throw new Error("btc-boom");
          },
        },
      },
      {
        id: "ok-2",
        name: "ok-2",
        description: "ok-2",
        hooks: {
          beforeToolExecution: async () => {
            order.push("ok-2");
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-error-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    // Per-hook error swallowing — bridge call resolves cleanly (no block)
    // even though the middle hook threw.
    await expect(
      spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent()),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["ok-1", "bad", "ok-2"]);

    client.close();
  });

  it("first blocking hook short-circuits the chain and returns its reason", async () => {
    const order: string[] = [];
    setExtraCapabilities([
      {
        id: "first",
        name: "first",
        description: "first",
        hooks: {
          beforeToolExecution: async () => {
            order.push("first");
          },
        },
      },
      {
        id: "blocker",
        name: "blocker",
        description: "blocker",
        hooks: {
          beforeToolExecution: async () => {
            order.push("blocker");
            return { block: true, reason: "nope" };
          },
        },
      },
      {
        id: "tail",
        name: "tail",
        description: "tail",
        hooks: {
          beforeToolExecution: async () => {
            order.push("tail");
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-block-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    const result = (await spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent())) as
      | BeforeToolExecutionResult
      | undefined;

    expect(result).toEqual({ block: true, reason: "nope" });
    // Tail hook must NOT have run — first blocker wins.
    expect(order).toEqual(["first", "blocker"]);
    client.close();
  });

  it("returns undefined when no hook blocks", async () => {
    setExtraCapabilities([
      {
        id: "noop",
        name: "noop",
        description: "noop",
        hooks: {
          beforeToolExecution: async () => {},
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-noop-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    await expect(
      spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent()),
    ).resolves.toBeUndefined();
    client.close();
  });

  it("enforces the hook_before_tool per-turn budget", async () => {
    setExtraCapabilities([
      {
        id: "noop-btc",
        name: "noop-btc",
        description: "noop-btc",
        hooks: {
          beforeToolExecution: async () => {},
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-budget-before-tool-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    // Default maxHookBeforeTool = 200.
    for (let i = 0; i < 200; i++) {
      await spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent());
    }
    await expect(
      spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent()),
    ).rejects.toThrow(/budget exceeded/i);

    client.close();
  });

  it("passes a CapabilityHookContext carrying the verified caller's sessionId", async () => {
    const seen: Array<{ toolName: string; sessionId: string }> = [];
    setExtraCapabilities([
      {
        id: "btc-observer",
        name: "btc-observer",
        description: "btc-observer",
        hooks: {
          beforeToolExecution: async (event, ctx) => {
            seen.push({ toolName: event.toolName, sessionId: ctx.sessionId });
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-context-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineProcessBeforeToolExecution(caller, makeBtcEvent("gated_tool"));

    expect(seen).toHaveLength(1);
    expect(seen[0].toolName).toBe("gated_tool");
    expect(seen[0].sessionId).toBe(sessionId);
    client.close();
  });
});

// --- SpineService-mediated bridge tests ---
//
// These cover task 1.12: scope-check rejection, token-derived caller,
// error sanitization for the two new RPC methods. We mint tokens under
// the test master key and call SpineService directly.

interface TestEnv {
  AGENT: DurableObjectNamespace;
}

function makeSpineCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function makeRealSpineService(): SpineService {
  const spineEnv = {
    AGENT: (testEnv as unknown as TestEnv).AGENT,
    AGENT_AUTH_KEY: TEST_BUNDLE_AUTH_KEY,
  };
  return new SpineService(makeSpineCtx(), spineEnv);
}

describe("hook bridge — SpineService.recordToolExecution / processBeforeInference", () => {
  let service: SpineService;

  beforeEach(() => {
    clearExtraCapabilities();
    clearMockResponses();
    service = makeRealSpineService();
  });

  afterEach(() => {
    clearExtraCapabilities();
  });

  it("token without 'spine' scope is rejected with ERR_SCOPE_DENIED (recordToolExecution)", async () => {
    // Scope gate lives in SpineService.verify — no DO call made.
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const llmOnly = await mintToken(
      { agentId: "fake-agent", sessionId: "fake-session", scope: ["llm"] },
      subkey,
    );
    await expect(service.recordToolExecution(llmOnly, makeEvent())).rejects.toMatchObject({
      code: "ERR_SCOPE_DENIED",
    });
  });

  it("token without 'spine' scope is rejected with ERR_SCOPE_DENIED (processBeforeInference)", async () => {
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const llmOnly = await mintToken(
      { agentId: "fake-agent", sessionId: "fake-session", scope: ["llm"] },
      subkey,
    );
    await expect(
      service.processBeforeInference(llmOnly, [textMessage("hi") as unknown as AgentMessage]),
    ).rejects.toMatchObject({ code: "ERR_SCOPE_DENIED" });
  });

  it("verified call delegates to the host with the token-derived caller", async () => {
    const seenSids: string[] = [];
    setExtraCapabilities([
      {
        id: "delegate-observer",
        name: "delegate-observer",
        description: "delegate-observer",
        hooks: {
          afterToolExecution: async (_event, ctx) => {
            seenSids.push(ctx.sessionId);
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    // Create a real session on a stub then mint a token for that agent
    // + session. The bridge method should fire the hook with ctx.sessionId
    // matching the token's sid claim.
    const stub = getStub("hook-bridge-service-delegate-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const agentId = (testEnv as unknown as TestEnv).AGENT.idFromName(
      "hook-bridge-service-delegate-1",
    ).toString();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    await service.recordToolExecution(token, makeEvent("delegate_tool"));

    expect(seenSids).toEqual([sessionId]);
    client.close();
  });

  it("processBeforeInference returns the (possibly mutated) array via the service", async () => {
    setExtraCapabilities([
      {
        id: "prepend",
        name: "prepend",
        description: "prepend",
        hooks: {
          beforeInference: async (messages) => [textMessage("prepended"), ...messages],
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-service-mutator-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const agentId = (testEnv as unknown as TestEnv).AGENT.idFromName(
      "hook-bridge-service-mutator-1",
    ).toString();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    const out = (await service.processBeforeInference(token, [
      textMessage("seed") as unknown as AgentMessage,
    ])) as AgentMessage[];
    expect(out.map((m) => (m as { content: string }).content)).toEqual(["prepended", "seed"]);
    client.close();
  });
});

describe("hook bridge — SpineService.processBeforeToolExecution", () => {
  let service: SpineService;

  beforeEach(() => {
    clearExtraCapabilities();
    clearMockResponses();
    service = makeRealSpineService();
  });

  afterEach(() => {
    clearExtraCapabilities();
  });

  it("token without 'spine' scope is rejected with ERR_SCOPE_DENIED", async () => {
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const llmOnly = await mintToken(
      { agentId: "fake-agent", sessionId: "fake-session", scope: ["llm"] },
      subkey,
    );
    await expect(service.processBeforeToolExecution(llmOnly, makeBtcEvent())).rejects.toMatchObject(
      {
        code: "ERR_SCOPE_DENIED",
      },
    );
  });

  it("verified call delegates to the host with the token-derived caller", async () => {
    const seenSids: string[] = [];
    setExtraCapabilities([
      {
        id: "btc-delegate-observer",
        name: "btc-delegate-observer",
        description: "btc-delegate-observer",
        hooks: {
          beforeToolExecution: async (_event, ctx) => {
            seenSids.push(ctx.sessionId);
          },
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-service-delegate-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const agentId = (testEnv as unknown as TestEnv).AGENT.idFromName(
      "hook-bridge-btc-service-delegate-1",
    ).toString();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    const result = await service.processBeforeToolExecution(token, makeBtcEvent("gated_tool"));

    expect(result).toBeUndefined();
    expect(seenSids).toEqual([sessionId]);
    client.close();
  });

  it("round-trips a { block: true, reason } result through the service (NOT an error)", async () => {
    setExtraCapabilities([
      {
        id: "svc-blocker",
        name: "svc-blocker",
        description: "svc-blocker",
        hooks: {
          beforeToolExecution: async () => ({ block: true, reason: "policy" }),
        },
      },
    ]);
    setMockResponses([{ text: "irrelevant" }]);

    const stub = getStub("hook-bridge-btc-service-block-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const agentId = (testEnv as unknown as TestEnv).AGENT.idFromName(
      "hook-bridge-btc-service-block-1",
    ).toString();
    const subkey = await deriveMintSubkey(TEST_BUNDLE_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    const token = await mintToken({ agentId, sessionId, scope: ["spine", "llm"] }, subkey);

    // Crucial: this must be a normal resolution, NOT a rejection — the
    // sanitize path would otherwise swallow the blocker reason into a
    // generic ERR_INTERNAL.
    const result = await service.processBeforeToolExecution(token, makeBtcEvent());
    expect(result).toEqual({ block: true, reason: "policy" });
    client.close();
  });
});
