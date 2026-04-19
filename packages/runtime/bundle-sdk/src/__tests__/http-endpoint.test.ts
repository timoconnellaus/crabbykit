/**
 * Bundle SDK `/http` endpoint round-trip tests.
 */

import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapability, BundleCostEvent, BundleEnv, BundleHttpRequest } from "../types.js";

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

// Token format: base64url(payload).base64url(sig). Bundle SDK only
// reads the payload's `aid` claim; signature is unverified there.
function makeToken(aid: string): string {
  const payload = JSON.stringify({ aid, sid: "s1", scope: ["spine"], exp: Date.now() + 60_000 });
  const b64 = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64}.sig`;
}

async function postHttp(opts: {
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
    new Request("https://bundle/http", {
      method: "POST",
      body: JSON.stringify(opts.envelope),
    }),
    env as unknown as BundleEnv,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("Bundle SDK /http endpoint", () => {
  it("round-trips a minimal echo handler", async () => {
    const cap: BundleCapability = {
      id: "demo",
      name: "Demo",
      description: "",
      httpHandlers: () => [
        {
          method: "POST",
          path: "/demo/echo",
          handler: async (req: BundleHttpRequest) => {
            return {
              status: 200,
              headers: { "x-echo-method": req.method },
              body: req.body ?? new Uint8Array(0),
            };
          },
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const { status, body } = await postHttp({
      bundle,
      envelope: {
        capabilityId: "demo",
        method: "POST",
        path: "/demo/echo",
        bodyBase64: btoa("hello"),
        headers: { "content-type": "text/plain" },
        query: {},
        sessionId: "s1",
      },
    });
    expect(status).toBe(200);
    expect(body.status).toBe(200);
    expect((body.headers as Record<string, string>)["x-echo-method"]).toBe("POST");
    expect(atob(body.bodyBase64 as string)).toBe("hello");
  });

  it("extracts path params from :name segments", async () => {
    let captured: Record<string, string> = {};
    const cap: BundleCapability = {
      id: "telegram",
      name: "Telegram",
      description: "",
      httpHandlers: () => [
        {
          method: "POST",
          path: "/telegram/webhook/:accountId",
          handler: async (_req, ctx) => {
            captured = ctx.params;
            return { status: 204 };
          },
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    await postHttp({
      bundle,
      envelope: {
        capabilityId: "telegram",
        method: "POST",
        path: "/telegram/webhook/support",
        sessionId: null,
      },
    });
    expect(captured).toEqual({ accountId: "support" });
  });

  it("returns 404-envelope when capabilityId is unknown", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [
        {
          id: "demo",
          name: "Demo",
          description: "",
          httpHandlers: () => [
            { method: "GET", path: "/demo/x", handler: async () => ({ status: 200 }) },
          ],
        },
      ],
    });
    const { body } = await postHttp({
      bundle,
      envelope: { capabilityId: "missing", method: "GET", path: "/demo/x" },
    });
    expect(body.status).toBe(404);
    expect(atob(body.bodyBase64 as string)).toContain("capability not found in bundle");
  });

  it("returns 404-envelope when route does not match on a known capability", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [
        {
          id: "demo",
          name: "Demo",
          description: "",
          httpHandlers: () => [
            { method: "GET", path: "/demo/x", handler: async () => ({ status: 200 }) },
          ],
        },
      ],
    });
    const { body } = await postHttp({
      bundle,
      envelope: { capabilityId: "demo", method: "POST", path: "/demo/y" },
    });
    expect(body.status).toBe(404);
    expect(atob(body.bodyBase64 as string)).toContain("route not found");
  });

  it("exposes ctx.publicUrl from __BUNDLE_PUBLIC_URL env injection", async () => {
    let captured: string | undefined;
    const cap: BundleCapability = {
      id: "demo",
      name: "Demo",
      description: "",
      httpHandlers: () => [
        {
          method: "GET",
          path: "/demo/url",
          handler: async (_req, ctx) => {
            captured = ctx.publicUrl;
            return { status: 200 };
          },
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    await postHttp({
      bundle,
      envelope: { capabilityId: "demo", method: "GET", path: "/demo/url" },
      env: { __BUNDLE_PUBLIC_URL: "https://agents.example.com" },
    });
    expect(captured).toBe("https://agents.example.com");
  });

  it("exposes ctx.emitCost and round-trips through the spine", async () => {
    const spine = makeSpineStub();
    const captured: BundleCostEvent[] = [];
    spine.emitCost.mockImplementation(async (_token: string, cost: BundleCostEvent) => {
      captured.push(cost);
    });
    const cap: BundleCapability = {
      id: "demo",
      name: "Demo",
      description: "",
      httpHandlers: () => [
        {
          method: "POST",
          path: "/demo/charge",
          handler: async (_req, ctx) => {
            await ctx.emitCost({
              capabilityId: "demo",
              toolName: "ping",
              amount: 0.01,
              currency: "USD",
            });
            return { status: 200 };
          },
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    await postHttp({
      bundle,
      envelope: { capabilityId: "demo", method: "POST", path: "/demo/charge" },
      env: { SPINE: spine },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.amount).toBe(0.01);
  });

  it("rejects when __BUNDLE_TOKEN is missing", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });
    const res = await bundle.fetch(
      new Request("https://bundle/http", {
        method: "POST",
        body: JSON.stringify({ capabilityId: "demo", method: "GET", path: "/demo" }),
      }),
      { SPINE: makeSpineStub() } as unknown as BundleEnv,
    );
    expect(res.status).toBe(401);
  });
});
