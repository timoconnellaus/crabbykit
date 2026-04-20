/**
 * bundle-lifecycle-hooks — SDK tests for the five new lifecycle
 * endpoints (/after-turn, /on-connect, /dispose, /on-turn-end,
 * /on-agent-end) and the build-time metadata aggregation.
 */

import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type {
  BundleAfterTurnContext,
  BundleAgentEndContext,
  BundleCapability,
  BundleDisposeContext,
  BundleEnv,
  BundleOnConnectContext,
  BundleToolResult,
  BundleTurnEndContext,
} from "../types.js";

function makeSpineStub(): Record<string, unknown> {
  return {
    appendEntry: vi.fn().mockResolvedValue(undefined),
    getEntries: vi.fn().mockResolvedValue([]),
    buildContext: vi.fn().mockResolvedValue([]),
    broadcast: vi.fn().mockResolvedValue(undefined),
  };
}

async function post(
  bundle: ReturnType<typeof defineBundleAgent>,
  path: string,
  body: unknown,
  env: Record<string, unknown>,
): Promise<Response> {
  return bundle.fetch(
    new Request(`https://bundle${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env as unknown as BundleEnv,
  );
}

describe("bundle-lifecycle-hooks — /after-turn", () => {
  it("invokes afterTurn on every declaring capability in registration order", async () => {
    const order: string[] = [];
    const capA: BundleCapability = {
      id: "cap-a",
      name: "A",
      description: "",
      afterTurn: async (_ctx: BundleAfterTurnContext) => {
        order.push("a");
      },
    };
    const capB: BundleCapability = {
      id: "cap-b",
      name: "B",
      description: "",
      afterTurn: async (_ctx: BundleAfterTurnContext) => {
        order.push("b");
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [capA, capB],
    });
    const res = await post(
      bundle,
      "/after-turn",
      { agentId: "a1", sessionId: "s1", finalText: "hello" },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
    expect(order).toEqual(["a", "b"]);
  });

  it("isolates per-cap errors — A throws, B still fires", async () => {
    const ran: string[] = [];
    const capA: BundleCapability = {
      id: "cap-a",
      name: "A",
      description: "",
      afterTurn: async () => {
        throw new Error("boom");
      },
    };
    const capB: BundleCapability = {
      id: "cap-b",
      name: "B",
      description: "",
      afterTurn: async () => {
        ran.push("b");
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [capA, capB],
    });
    const res = await post(
      bundle,
      "/after-turn",
      { agentId: "a1", sessionId: "s1", finalText: "" },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
    expect(ran).toEqual(["b"]);
  });

  it("returns 401 without __BUNDLE_TOKEN", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });
    const res = await post(
      bundle,
      "/after-turn",
      { agentId: "a", sessionId: "s", finalText: "" },
      { SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(401);
  });

  it("rejects envelope missing agentId/sessionId", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [
        {
          id: "c",
          name: "",
          description: "",
          afterTurn: async () => {},
        } satisfies BundleCapability,
      ],
    });
    const res = await post(
      bundle,
      "/after-turn",
      { agentId: "a" },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(400);
  });
});

describe("bundle-lifecycle-hooks — /on-connect", () => {
  it("invokes hooks.onConnect on each declaring capability", async () => {
    const calls: string[] = [];
    const cap: BundleCapability = {
      id: "c",
      name: "",
      description: "",
      hooks: {
        onConnect: async (ctx: BundleOnConnectContext) => {
          calls.push(ctx.capabilityId);
        },
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const res = await post(
      bundle,
      "/on-connect",
      { agentId: "a", sessionId: "s" },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
    expect(calls).toEqual(["c"]);
  });
});

describe("bundle-lifecycle-hooks — /dispose", () => {
  it("invokes each capability's dispose() once — no sessionId in envelope", async () => {
    const disposed: string[] = [];
    const capA: BundleCapability = {
      id: "a",
      name: "",
      description: "",
      dispose: async () => {
        disposed.push("a");
      },
    };
    const capB: BundleCapability = {
      id: "b",
      name: "",
      description: "",
      dispose: async () => {
        disposed.push("b");
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [capA, capB],
    });
    const res = await post(
      bundle,
      "/dispose",
      { agentId: "a1" }, // intentionally no sessionId
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
    expect(disposed).toEqual(["a", "b"]);
  });

  it("rejects envelope missing agentId", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [
        {
          id: "a",
          name: "",
          description: "",
          dispose: async () => {},
        } satisfies BundleCapability,
      ],
    });
    const res = await post(bundle, "/dispose", {}, { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() });
    expect(res.status).toBe(400);
  });
});

describe("bundle-lifecycle-hooks — /on-turn-end", () => {
  it("invokes setup.onTurnEnd once with messages and projected toolResults", async () => {
    let seenMessages: unknown;
    let seenToolResults: BundleToolResult[] | undefined;
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [{ id: "c", name: "", description: "" }],
      onTurnEnd: async (messages, toolResults) => {
        seenMessages = messages;
        seenToolResults = toolResults;
      },
    });
    const messages = [{ role: "assistant", content: "done" }];
    const toolResults: BundleToolResult[] = [
      { toolName: "search", args: { q: "x" }, content: "ok", isError: false },
    ];
    const res = await post(
      bundle,
      "/on-turn-end",
      { agentId: "a", sessionId: "s", messages, toolResults },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
    expect(seenMessages).toEqual(messages);
    expect(seenToolResults).toEqual(toolResults);
  });

  it("returns 204 noop when setup.onTurnEnd not declared", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });
    const res = await post(
      bundle,
      "/on-turn-end",
      { agentId: "a", sessionId: "s", messages: [], toolResults: [] },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
  });
});

describe("bundle-lifecycle-hooks — /on-agent-end", () => {
  it("invokes setup.onAgentEnd once — envelope omits sessionId", async () => {
    let seen: unknown;
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      onAgentEnd: async (messages) => {
        seen = messages;
      },
    });
    const msgs = [{ role: "assistant", content: "end" }];
    const res = await post(
      bundle,
      "/on-agent-end",
      { agentId: "a", messages: msgs },
      { __BUNDLE_TOKEN: "t", SPINE: makeSpineStub() },
    );
    expect(res.status).toBe(204);
    expect(seen).toEqual(msgs);
  });
});

describe("bundle-lifecycle-hooks — build-time metadata aggregation", () => {
  it("sets all five flags true when every hook is declared", async () => {
    const cap: BundleCapability = {
      id: "c",
      name: "",
      description: "",
      afterTurn: async () => {},
      dispose: async () => {},
      hooks: { onConnect: async () => {} },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
      onTurnEnd: () => {},
      onAgentEnd: () => {},
    });
    const res = await bundle.fetch(
      new Request("https://bundle/metadata", { method: "POST" }),
      {} as BundleEnv,
    );
    const meta = (await res.json()) as {
      lifecycleHooks?: Record<string, boolean>;
    };
    expect(meta.lifecycleHooks).toMatchObject({
      afterTurn: true,
      onConnect: true,
      dispose: true,
      onTurnEnd: true,
      onAgentEnd: true,
    });
  });

  it("sets all five flags false when no hooks are declared (lifecycleHooks absent)", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });
    const res = await bundle.fetch(
      new Request("https://bundle/metadata", { method: "POST" }),
      {} as BundleEnv,
    );
    const meta = (await res.json()) as {
      lifecycleHooks?: Record<string, boolean>;
    };
    expect(meta.lifecycleHooks).toBeUndefined();
  });

  it("metadata survives JSON round-trip with all flags intact", async () => {
    const cap: BundleCapability = {
      id: "c",
      name: "",
      description: "",
      afterTurn: async () => {},
      hooks: { onConnect: async () => {} },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
      onTurnEnd: () => {},
    });
    const res = await bundle.fetch(
      new Request("https://bundle/metadata", { method: "POST" }),
      {} as BundleEnv,
    );
    const raw = await res.text();
    const parsed = JSON.parse(raw) as {
      lifecycleHooks?: Record<string, boolean>;
    };
    expect(parsed.lifecycleHooks?.afterTurn).toBe(true);
    expect(parsed.lifecycleHooks?.onConnect).toBe(true);
    expect(parsed.lifecycleHooks?.onTurnEnd).toBe(true);
    expect(parsed.lifecycleHooks?.dispose).toBe(false);
    expect(parsed.lifecycleHooks?.onAgentEnd).toBe(false);
  });
});

describe("bundle-lifecycle-hooks — type-level context shape", () => {
  it("BundleDisposeContext omits sessionId/channel/emitCost/agentConfig", () => {
    // Compile-time assertion: these property accesses would fail typecheck
    // if the context shape regressed. No runtime check — the test exists
    // so coverage sees the file; the real guarantee is the build passing.
    const Assert = (ctx: BundleDisposeContext): void => {
      // @ts-expect-error — BundleDisposeContext has no `sessionId`
      ctx.sessionId;
      // @ts-expect-error — BundleDisposeContext has no `channel`
      ctx.channel;
      // @ts-expect-error — BundleDisposeContext has no `emitCost`
      ctx.emitCost;
      // @ts-expect-error — BundleDisposeContext has no `agentConfig`
      ctx.agentConfig;
      void ctx.agentId;
      void ctx.capabilityId;
      void ctx.spine;
    };
    expect(typeof Assert).toBe("function");
  });

  it("BundleAgentEndContext omits sessionId", () => {
    const Assert = (ctx: BundleAgentEndContext): void => {
      // @ts-expect-error — BundleAgentEndContext has no `sessionId`
      ctx.sessionId;
      void ctx.agentId;
      void ctx.spine;
    };
    expect(typeof Assert).toBe("function");
  });

  it("BundleTurnEndContext carries sessionId + spine", () => {
    const Assert = (ctx: BundleTurnEndContext): void => {
      void ctx.agentId;
      void ctx.sessionId;
      void ctx.spine;
    };
    expect(typeof Assert).toBe("function");
  });
});
