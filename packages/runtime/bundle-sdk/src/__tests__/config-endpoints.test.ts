/**
 * Bundle SDK config endpoints round-trip tests.
 * Covers /config-change, /agent-config-change, /config-namespace-get,
 * /config-namespace-set.
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapability, BundleEnv } from "../types.js";

function makeSpineStub() {
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

async function post(
  bundle: ReturnType<typeof defineBundleAgent>,
  path: string,
  envelope: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const env = {
    __BUNDLE_TOKEN: makeToken("agent-1"),
    SPINE: makeSpineStub(),
  };
  const res = await bundle.fetch(
    new Request(`https://bundle${path}`, {
      method: "POST",
      body: JSON.stringify(envelope),
    }),
    env as unknown as BundleEnv,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("Bundle SDK /config-change", () => {
  it("invokes onConfigChange and returns ok", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configSchema: Type.Object({ n: Type.Number() }),
      hooks: { onConfigChange: spy },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/config-change", {
      capabilityId: "my-cap",
      oldCfg: { n: 1 },
      newCfg: { n: 2 },
      sessionId: "s1",
    });
    expect(body).toEqual({ status: "ok" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ n: 1 });
    expect(spy.mock.calls[0][1]).toEqual({ n: 2 });
  });

  it("returns noop when handler absent", async () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configSchema: Type.Object({}),
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/config-change", {
      capabilityId: "my-cap",
      oldCfg: {},
      newCfg: {},
      sessionId: "s1",
    });
    expect(body).toEqual({ status: "noop" });
  });

  it("returns error when handler throws", async () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configSchema: Type.Object({}),
      hooks: {
        onConfigChange: async () => {
          throw new Error("boom");
        },
      },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/config-change", {
      capabilityId: "my-cap",
      oldCfg: {},
      newCfg: {},
      sessionId: "s1",
    });
    expect(body).toMatchObject({ status: "error", message: "boom" });
  });
});

describe("Bundle SDK /agent-config-change", () => {
  it("invokes onAgentConfigChange with slices", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      agentConfigPath: "botConfig",
      hooks: { onAgentConfigChange: spy },
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      config: { botConfig: Type.Object({ rateLimit: Type.Number() }) },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/agent-config-change", {
      capabilityId: "my-cap",
      oldSlice: { rateLimit: 1 },
      newSlice: { rateLimit: 5 },
      sessionId: "s1",
    });
    expect(body).toEqual({ status: "ok" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ rateLimit: 1 });
    expect(spy.mock.calls[0][1]).toEqual({ rateLimit: 5 });
  });

  it("returns noop when handler absent", async () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/agent-config-change", {
      capabilityId: "my-cap",
      oldSlice: undefined,
      newSlice: undefined,
      sessionId: "s1",
    });
    expect(body).toEqual({ status: "noop" });
  });
});

describe("Bundle SDK /config-namespace-get + /config-namespace-set", () => {
  it("round-trips get", async () => {
    const getFn = vi.fn().mockResolvedValue({ x: 1 });
    const setFn = vi.fn().mockResolvedValue(undefined);
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configNamespaces: () => [
        {
          id: "accounts",
          description: "",
          schema: Type.Object({ x: Type.Number() }),
          get: getFn,
          set: setFn,
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/config-namespace-get", {
      namespace: "accounts",
      sessionId: "s1",
    });
    expect(body).toEqual({ status: "ok", value: { x: 1 } });
    expect(getFn).toHaveBeenCalledWith("accounts");
  });

  it("round-trips set with display string", async () => {
    const getFn = vi.fn().mockResolvedValue(null);
    const setFn = vi.fn().mockResolvedValue("account saved");
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configNamespaces: () => [
        {
          id: "accounts",
          description: "",
          schema: Type.Object({ x: Type.Number() }),
          get: getFn,
          set: setFn,
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/config-namespace-set", {
      namespace: "accounts",
      value: { x: 5 },
      sessionId: "s1",
    });
    expect(body).toMatchObject({ status: "ok", display: "account saved" });
    expect(setFn).toHaveBeenCalledWith("accounts", { x: 5 });
  });

  it("returns error when namespace unknown", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [{ id: "noop", name: "Noop", description: "" }],
    });
    const body = await post(bundle, "/config-namespace-get", {
      namespace: "missing",
      sessionId: "s1",
    });
    expect(body).toMatchObject({ status: "error" });
  });

  it("returns error when set handler throws", async () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configNamespaces: () => [
        {
          id: "accounts",
          description: "",
          schema: Type.Object({}),
          get: async () => null,
          set: async () => {
            throw new Error("set failed");
          },
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const body = await post(bundle, "/config-namespace-set", {
      namespace: "accounts",
      value: {},
      sessionId: "s1",
    });
    expect(body).toMatchObject({ status: "error", message: "set failed" });
  });
});
