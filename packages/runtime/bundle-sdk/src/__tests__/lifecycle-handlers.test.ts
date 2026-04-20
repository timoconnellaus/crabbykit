/**
 * Phase 2 — bundle SDK lifecycle handler tests (tasks 4.14, 4.20).
 *
 * Verifies:
 *  - handler defined → invokes user code, returns ok with result
 *  - handler undefined → noop
 *  - handler throws → error response with structured message
 *  - missing __BUNDLE_TOKEN → 401
 *  - missing env.SPINE → 500
 *  - defineBundleAgent metadata declares lifecycleHooks accurately
 */

import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleEnv } from "../types.js";

function makeSpineStub(): Record<string, unknown> {
  return {
    appendEntry: vi.fn().mockResolvedValue(undefined),
    getEntries: vi.fn().mockResolvedValue([]),
    buildContext: vi.fn().mockResolvedValue([]),
    broadcast: vi.fn().mockResolvedValue(undefined),
  };
}

async function postLifecycle(opts: {
  bundle: ReturnType<typeof defineBundleAgent>;
  path: "/alarm" | "/session-created" | "/client-event";
  body: unknown;
  env: Record<string, unknown>;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await opts.bundle.fetch(
    new Request(`https://bundle${opts.path}`, {
      method: "POST",
      body: JSON.stringify(opts.body),
    }),
    opts.env as unknown as BundleEnv,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("Phase 2 — lifecycle handlers", () => {
  describe("metadata declaration", () => {
    it("populates lifecycleHooks: { onAlarm: true } when only onAlarm is defined", async () => {
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onAlarm: async () => {},
      });
      const res = await bundle.fetch(
        new Request("https://bundle/metadata", { method: "POST" }),
        {} as BundleEnv,
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.lifecycleHooks).toEqual({
        onAlarm: true,
        onSessionCreated: false,
        onClientEvent: false,
        afterTurn: false,
        onConnect: false,
        dispose: false,
        onTurnEnd: false,
        onAgentEnd: false,
      });
    });

    it("populates all three when all three are defined", async () => {
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onAlarm: async () => {},
        onSessionCreated: async () => {},
        onClientEvent: async () => {},
      });
      const res = await bundle.fetch(
        new Request("https://bundle/metadata", { method: "POST" }),
        {} as BundleEnv,
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.lifecycleHooks).toEqual({
        onAlarm: true,
        onSessionCreated: true,
        onClientEvent: true,
        afterTurn: false,
        onConnect: false,
        dispose: false,
        onTurnEnd: false,
        onAgentEnd: false,
      });
    });

    it("omits lifecycleHooks entirely when no hook is defined", async () => {
      const bundle = defineBundleAgent({ model: { provider: "openrouter", modelId: "x" } });
      const res = await bundle.fetch(
        new Request("https://bundle/metadata", { method: "POST" }),
        {} as BundleEnv,
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.lifecycleHooks).toBeUndefined();
    });
  });

  describe("/alarm", () => {
    const schedule = {
      id: "s1",
      name: "n",
      cron: "0 * * * *",
      enabled: true,
      handlerType: "prompt" as const,
      prompt: "do x",
      sessionPrefix: null,
      ownerId: null,
      nextFireAt: null,
      lastFiredAt: null,
      timezone: null,
      expiresAt: null,
      status: "idle" as const,
      lastError: null,
      retention: 5,
      createdAt: "",
      updatedAt: "",
    };

    it("returns noop when no onAlarm is registered", async () => {
      const bundle = defineBundleAgent({ model: { provider: "openrouter", modelId: "x" } });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/alarm",
        body: { schedule },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(status).toBe(200);
      expect(json.status).toBe("noop");
    });

    it("returns ok with result when handler returns { skip: true }", async () => {
      const onAlarm = vi.fn().mockResolvedValue({ skip: true });
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onAlarm,
      });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/alarm",
        body: { schedule },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.result).toEqual({ skip: true });
      expect(onAlarm).toHaveBeenCalledOnce();
    });

    it("returns error when handler throws", async () => {
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onAlarm: async () => {
          throw new Error("boom");
        },
      });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/alarm",
        body: { schedule },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(status).toBe(200);
      expect(json.status).toBe("error");
      expect(json.message).toBe("boom");
    });

    it("returns 401 when __BUNDLE_TOKEN is missing", async () => {
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onAlarm: async () => {},
      });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/alarm",
        body: { schedule },
        env: { SPINE: makeSpineStub() },
      });
      expect(status).toBe(401);
      expect(json.message).toContain("__BUNDLE_TOKEN");
    });

    it("returns 500 when env.SPINE is missing", async () => {
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onAlarm: async () => {},
      });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/alarm",
        body: { schedule },
        env: { __BUNDLE_TOKEN: "tok" },
      });
      expect(status).toBe(500);
      expect(json.message).toContain("SPINE");
    });
  });

  describe("/session-created", () => {
    it("invokes user code with the session shape", async () => {
      const onSessionCreated = vi.fn().mockResolvedValue(undefined);
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onSessionCreated,
      });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/session-created",
        body: { session: { id: "sess-1", name: "primary" } },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(status).toBe(200);
      expect(json.status).toBe("ok");
      expect(onSessionCreated).toHaveBeenCalledOnce();
      const args = onSessionCreated.mock.calls[0];
      expect(args[1]).toEqual({ id: "sess-1", name: "primary" });
    });

    it("returns noop when handler not registered", async () => {
      const bundle = defineBundleAgent({ model: { provider: "openrouter", modelId: "x" } });
      const { json } = await postLifecycle({
        bundle,
        path: "/session-created",
        body: { session: { id: "s", name: "n" } },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(json.status).toBe("noop");
    });
  });

  describe("/client-event", () => {
    it("invokes user code with the event payload", async () => {
      const onClientEvent = vi.fn().mockResolvedValue(undefined);
      const bundle = defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        onClientEvent,
      });
      const { status, json } = await postLifecycle({
        bundle,
        path: "/client-event",
        body: {
          sessionId: "s",
          event: { kind: "steer", payload: { messageIds: ["m1"], type: "user-message-update" } },
        },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(status).toBe(200);
      expect(json.status).toBe("ok");
      const event = onClientEvent.mock.calls[0][1] as { kind: string };
      expect(event.kind).toBe("steer");
    });

    it("returns noop for an abort event when no onClientEvent is registered", async () => {
      const bundle = defineBundleAgent({ model: { provider: "openrouter", modelId: "x" } });
      const { json } = await postLifecycle({
        bundle,
        path: "/client-event",
        body: { sessionId: "s", event: { kind: "abort", payload: {} } },
        env: { __BUNDLE_TOKEN: "tok", SPINE: makeSpineStub() },
      });
      expect(json.status).toBe("noop");
    });
  });
});
