/**
 * Bundle SDK `/action` endpoint round-trip tests.
 */

import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapability, BundleEnv } from "../types.js";

interface SpineStub {
  emitCost: ReturnType<typeof vi.fn>;
  kvGet: ReturnType<typeof vi.fn>;
  kvPut: ReturnType<typeof vi.fn>;
  kvDelete: ReturnType<typeof vi.fn>;
  kvList: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  broadcastGlobal: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  getEntries: ReturnType<typeof vi.fn>;
  buildContext: ReturnType<typeof vi.fn>;
}

function makeSpineStub(): SpineStub {
  return {
    emitCost: vi.fn().mockResolvedValue(undefined),
    kvGet: vi.fn().mockResolvedValue(null),
    kvPut: vi.fn().mockResolvedValue(undefined),
    kvDelete: vi.fn().mockResolvedValue(undefined),
    kvList: vi.fn().mockResolvedValue([]),
    broadcast: vi.fn().mockResolvedValue(undefined),
    broadcastGlobal: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    getEntries: vi.fn().mockResolvedValue([]),
    buildContext: vi.fn().mockResolvedValue([]),
  };
}

function makeToken(aid: string): string {
  const payload = JSON.stringify({ aid, sid: "s1", scope: ["spine"], exp: Date.now() + 60_000 });
  const b64 = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64}.sig`;
}

async function postAction(opts: {
  bundle: ReturnType<typeof defineBundleAgent>;
  envelope: Record<string, unknown>;
  env?: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = {
    __BUNDLE_TOKEN: makeToken("agent-1"),
    SPINE: makeSpineStub(),
    ...(opts.env ?? {}),
  };
  const res = await opts.bundle.fetch(
    new Request("https://bundle/action", {
      method: "POST",
      body: JSON.stringify(opts.envelope),
    }),
    env as unknown as BundleEnv,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("Bundle SDK /action endpoint", () => {
  it("round-trips a handler that broadcasts back via ctx.channel.broadcast", async () => {
    const spine = makeSpineStub();
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      onAction: async (action, data, ctx) => {
        await ctx.channel.broadcast({
          type: "state_event",
          capabilityId: "files",
          event: action,
          data,
        });
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const { body } = await postAction({
      bundle,
      envelope: {
        capabilityId: "files",
        action: "deleted",
        data: { id: "f1" },
        sessionId: "s1",
      },
      env: { SPINE: spine },
    });
    expect(body).toEqual({ status: "ok" });
    expect(spine.broadcast).toHaveBeenCalledTimes(1);
    const broadcastedEvent = spine.broadcast.mock.calls[0][1] as Record<string, unknown>;
    expect(broadcastedEvent.event).toBe("deleted");
  });

  it("returns { status: 'noop' } when capability has no onAction", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const { body } = await postAction({
      bundle,
      envelope: { capabilityId: "files", action: "x", data: {}, sessionId: "s1" },
    });
    expect(body).toEqual({ status: "noop" });
  });

  it("returns { status: 'noop' } when capability id is unknown", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [{ id: "files", name: "F", description: "", onAction: async () => {} }],
    });
    const { body } = await postAction({
      bundle,
      envelope: { capabilityId: "missing", action: "x", data: {}, sessionId: "s1" },
    });
    expect(body).toEqual({ status: "noop" });
  });

  it("returns { status: 'error', message } when handler throws", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      onAction: async () => {
        throw new Error("boom");
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const { body } = await postAction({
      bundle,
      envelope: { capabilityId: "files", action: "delete", data: {}, sessionId: "s1" },
    });
    expect(body).toEqual({ status: "error", message: "boom" });
  });

  it("exposes ctx.publicUrl from __BUNDLE_PUBLIC_URL env injection", async () => {
    let captured: string | undefined;
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      onAction: async (_a, _d, ctx) => {
        captured = ctx.publicUrl;
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    await postAction({
      bundle,
      envelope: { capabilityId: "files", action: "x", data: {}, sessionId: "s1" },
      env: { __BUNDLE_PUBLIC_URL: "https://agents.example.com" },
    });
    expect(captured).toBe("https://agents.example.com");
  });

  it("exposes ctx.emitCost", async () => {
    const spine = makeSpineStub();
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      onAction: async (_a, _d, ctx) => {
        await ctx.emitCost({
          capabilityId: "files",
          toolName: "click",
          amount: 0.001,
          currency: "USD",
        });
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    await postAction({
      bundle,
      envelope: { capabilityId: "files", action: "x", data: {}, sessionId: "s1" },
      env: { SPINE: spine },
    });
    expect(spine.emitCost).toHaveBeenCalledTimes(1);
  });

  it("rejects when __BUNDLE_TOKEN is missing", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });
    const res = await bundle.fetch(
      new Request("https://bundle/action", {
        method: "POST",
        body: JSON.stringify({
          capabilityId: "files",
          action: "x",
          data: {},
          sessionId: "s1",
        }),
      }),
      { SPINE: makeSpineStub() } as unknown as BundleEnv,
    );
    expect(res.status).toBe(401);
  });
});
