import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../agent-runtime.js";
import type { CapabilityStorage } from "../../capabilities/storage.js";
import type { CapabilityHttpContext } from "../../capabilities/types.js";
import { SessionStore } from "../../session/session-store.js";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import { defineChannel } from "../define-channel.js";
import type { ChannelDefinition } from "../types.js";

/**
 * Simple in-memory capability storage. The real runtime wraps DO KV,
 * but these tests exercise the helper in isolation.
 */
function makeStorage(): CapabilityStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T = unknown>(prefix?: string) {
      const out = new Map<string, T>();
      for (const [k, v] of data) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v as T);
      }
      return out;
    },
  };
}

interface TestAccount {
  id: string;
  tag: string;
}

interface TestInbound {
  chatId: number;
  messageId: number;
}

/**
 * Build a `ChannelDefinition` backed by an in-memory account registry.
 * The test mutates `accounts` between calls to simulate runtime add /
 * remove flows.
 */
function makeChannelDef(
  accounts: TestAccount[] = [{ id: "acct-a", tag: "primary" }],
  overrides: Partial<ChannelDefinition<TestAccount, TestInbound>> = {},
): ChannelDefinition<TestAccount, TestInbound> {
  return {
    id: "test-ch",
    getAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
    listAccounts: async () => accounts,
    webhookPathPattern: "/webhook/:accountId",
    verifyWebhook: () => true,
    parseWebhook: async (req) => {
      const body = (await req.json()) as {
        senderId?: string;
        text?: string;
        chatId?: number;
        messageId?: number;
      };
      if (!body.senderId || !body.text) return null;
      return {
        senderId: body.senderId,
        text: body.text,
        inbound: { chatId: body.chatId ?? 1, messageId: body.messageId ?? 1 },
      };
    },
    rateLimit: {
      perSender: { perMinute: 10, perHour: 100 },
      perAccount: { perMinute: 60, perHour: 1000 },
    },
    sendReply: async () => {},
    ...overrides,
  };
}

function makeAgentContext(storage: CapabilityStorage): AgentContext {
  return {
    agentId: "test-agent",
    sessionId: "",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("not available")),
    broadcastState: () => {},
    storage,
    // biome-ignore lint/suspicious/noExplicitAny: minimal ScheduleManager stub
    schedules: {} as any,
    rateLimit: { consume: async () => ({ allowed: true }) },
    // biome-ignore lint/suspicious/noExplicitAny: env is not consulted by the test channel
    env: undefined as any,
  } as AgentContext;
}

function makeHttpContext(opts: {
  storage: CapabilityStorage;
  sessionStore: SessionStore;
  params?: Record<string, string>;
  rateLimit?: CapabilityHttpContext["rateLimit"];
  sendPrompt?: CapabilityHttpContext["sendPrompt"];
}): CapabilityHttpContext {
  return {
    storage: opts.storage,
    sessionStore: opts.sessionStore,
    broadcastToAll: () => {},
    broadcastState: () => {},
    params: opts.params ?? { accountId: "acct-a" },
    rateLimit: opts.rateLimit ?? { consume: async () => ({ allowed: true }) },
    sendPrompt:
      opts.sendPrompt ?? (async (o) => ({ sessionId: o.sessionId ?? "s1", response: "ok" })),
  };
}

/** Build a webhook POST request with a JSON body. The URL is cosmetic — the path is already matched via `ctx.params`. */
function webhookRequest(body: Record<string, unknown>): Request {
  return new Request("https://agent.test/webhook/acct-a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("defineChannel", () => {
  let sessionStore: SessionStore;
  let storage: CapabilityStorage;

  beforeEach(() => {
    sessionStore = new SessionStore(createMockSqlStore());
    storage = makeStorage();
  });

  describe("HTTP handler registration", () => {
    it("registers a single handler at the webhookPathPattern", () => {
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      expect(handlers).toHaveLength(1);
      expect(handlers[0].method).toBe("POST");
      expect(handlers[0].path).toBe("/webhook/:accountId");
    });
  });

  describe("dynamic rateLimit (agent-config backed)", () => {
    it("calls rateLimit() with the http context on each inbound", async () => {
      const rateLimitFn = vi.fn().mockReturnValue({
        perSender: { perMinute: 2 },
        perAccount: { perMinute: 5 },
      });
      const consumeCalls: Array<{ key: string; perMinute: number }> = [];
      const rateLimit = {
        consume: async (opts: { key: string; perMinute: number }) => {
          consumeCalls.push({ key: opts.key, perMinute: opts.perMinute });
          return { allowed: true };
        },
      };
      const cap = defineChannel(
        makeChannelDef([{ id: "acct-a", tag: "primary" }], { rateLimit: rateLimitFn }),
      );
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({
          storage,
          sessionStore,
          sendPrompt: async () => ({ sessionId: "s1", response: "ok" }),
          rateLimit,
        }),
      );
      expect(resp.status).toBe(200);
      // Called once, with the http context (agentConfig visible if the
      // runtime populated it).
      expect(rateLimitFn).toHaveBeenCalledTimes(1);
      // Both buckets consulted with the mapped perMinute values.
      expect(consumeCalls.find((c) => c.key.includes(":sender:"))?.perMinute).toBe(2);
      expect(consumeCalls.find((c) => c.key.endsWith(":_global"))?.perMinute).toBe(5);
    });

    it("still accepts a static rateLimit object for back-compat", async () => {
      const consumeCalls: number[] = [];
      const rateLimit = {
        consume: async (opts: { key: string; perMinute: number }) => {
          consumeCalls.push(opts.perMinute);
          return { allowed: true };
        },
      };
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({
          storage,
          sessionStore,
          sendPrompt: async () => ({ sessionId: "s1", response: "ok" }),
          rateLimit,
        }),
      );
      // Default perSender.perMinute = 10, perAccount.perMinute = 60 from makeChannelDef.
      expect(consumeCalls).toContain(10);
      expect(consumeCalls).toContain(60);
    });
  });

  describe("inbound pipeline", () => {
    it("returns 403 when the path-param account id is unknown", async () => {
      const sendPrompt = vi.fn();
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({
          storage,
          sessionStore,
          sendPrompt,
          params: { accountId: "not-a-thing" },
        }),
      );
      expect(resp.status).toBe(403);
      expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("returns 403 when no accountId is present in params (definition bug)", async () => {
      const sendPrompt = vi.fn();
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, params: {} }),
      );
      expect(resp.status).toBe(403);
      expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("returns 403 when verifyWebhook returns false", async () => {
      const sendPrompt = vi.fn();
      const cap = defineChannel(makeChannelDef([{ id: "acct-a", tag: "primary" }], { verifyWebhook: () => false }));
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt }),
      );
      expect(resp.status).toBe(403);
      expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("returns 200 without processing when parseWebhook returns null", async () => {
      const sendPrompt = vi.fn();
      const cap = defineChannel(
        makeChannelDef([{ id: "acct-a", tag: "primary" }], { parseWebhook: async () => null }),
      );
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt }),
      );
      expect(resp.status).toBe(200);
      expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("returns 200 without processing on per-sender rate-limit denial", async () => {
      const sendPrompt = vi.fn();
      const rateLimit = {
        consume: vi.fn(async ({ key }: { key: string }) => {
          if (key.includes(":sender:"))
            return { allowed: false, reason: "perMinute limit exceeded" };
          return { allowed: true };
        }),
      };
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, rateLimit }),
      );
      expect(resp.status).toBe(200);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(rateLimit.consume).toHaveBeenCalledTimes(1);
    });

    it("returns 200 without processing on per-account rate-limit denial", async () => {
      const sendPrompt = vi.fn();
      const rateLimit = {
        consume: vi.fn(async ({ key }: { key: string }) => {
          if (key.includes(":_global"))
            return { allowed: false, reason: "perMinute limit exceeded" };
          return { allowed: true };
        }),
      };
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, rateLimit }),
      );
      expect(resp.status).toBe(200);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(rateLimit.consume).toHaveBeenCalledTimes(2);
    });

    it("creates a session via findBySourceAndSender on first inbound, reuses it on the second", async () => {
      const sendPrompt = vi.fn(async (o: { sessionId?: string }) => ({
        sessionId: o.sessionId ?? "",
        response: "",
      }));
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const ctx = makeHttpContext({ storage, sessionStore, sendPrompt });

      await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "one", chatId: 123, messageId: 1 }),
        ctx,
      );
      await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "two", chatId: 123, messageId: 2 }),
        ctx,
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(sendPrompt).toHaveBeenCalledTimes(2);
      const first = sendPrompt.mock.calls[0][0] as { sessionId: string };
      const second = sendPrompt.mock.calls[1][0] as { sessionId: string };
      expect(first.sessionId).toBeTruthy();
      expect(first.sessionId).toBe(second.sessionId);

      const found = sessionStore.findBySourceAndSender("test-ch", "@alice");
      expect(found).not.toBeNull();
      expect(found?.sender).toBe("@alice");
    });

    it("stashes the inbound payload under channel-inbound:<sessionId>", async () => {
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const ctx = makeHttpContext({
        storage,
        sessionStore,
        sendPrompt: async (o) => ({ sessionId: o.sessionId ?? "", response: "" }),
      });

      await handlers[0].handler(
        webhookRequest({ senderId: "@bob", text: "hi", chatId: 555, messageId: 77 }),
        ctx,
      );

      const session = sessionStore.findBySourceAndSender("test-ch", "@bob")!;
      const stash = (await storage.get(`channel-inbound:${session.id}`)) as {
        accountId: string;
        inbound: TestInbound;
      };
      expect(stash.accountId).toBe("acct-a");
      expect(stash.inbound).toEqual({ chatId: 555, messageId: 77 });
    });

    it("overwrites the stash on subsequent inbounds for the same session", async () => {
      const cap = defineChannel(makeChannelDef());
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const ctx = makeHttpContext({ storage, sessionStore });

      await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "one", chatId: 1, messageId: 10 }),
        ctx,
      );
      await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "two", chatId: 1, messageId: 20 }),
        ctx,
      );

      const session = sessionStore.findBySourceAndSender("test-ch", "@alice")!;
      const stash = (await storage.get(`channel-inbound:${session.id}`)) as {
        inbound: TestInbound;
      };
      expect(stash.inbound.messageId).toBe(20);
    });

    it("looks up the account dynamically (reflects runtime mutations)", async () => {
      // Start with NO accounts — webhook should 403. Then add one —
      // next webhook should succeed, without rebuilding the handler.
      const sendPrompt = vi.fn(async (o: { sessionId?: string }) => ({
        sessionId: o.sessionId ?? "s1",
        response: "",
      }));
      const accounts: TestAccount[] = [];
      const cap = defineChannel(makeChannelDef(accounts));
      const handlers = cap.httpHandlers!(makeAgentContext(storage));

      const resp1 = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, params: { accountId: "acct-a" } }),
      );
      expect(resp1.status).toBe(403);
      expect(sendPrompt).not.toHaveBeenCalled();

      // Mutate the backing store — real channels do this via their own
      // add-account flow (see packages/channel-telegram).
      accounts.push({ id: "acct-a", tag: "primary" });

      const resp2 = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, params: { accountId: "acct-a" } }),
      );
      expect(resp2.status).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(sendPrompt).toHaveBeenCalledTimes(1);
    });
  });

  describe("outbound (afterTurn)", () => {
    it("reads the stash and calls sendReply with the stashed inbound", async () => {
      const sendReply = vi.fn(async () => {});
      const cap = defineChannel(makeChannelDef([{ id: "acct-a", tag: "primary" }], { sendReply }));

      // Seed the stash directly (as if a webhook had arrived).
      await storage.put("channel-inbound:sess-1", {
        accountId: "acct-a",
        inbound: { chatId: 99, messageId: 7 },
      });

      const ctx = makeAgentContext(storage);
      await cap.afterTurn!(ctx, "sess-1", "final text");

      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith(
        { id: "acct-a", tag: "primary" },
        { chatId: 99, messageId: 7 },
        "final text",
      );
    });

    it("is a no-op for sessions with no stash", async () => {
      const sendReply = vi.fn(async () => {});
      const cap = defineChannel(makeChannelDef([{ id: "acct-a", tag: "primary" }], { sendReply }));
      const ctx = makeAgentContext(storage);
      await cap.afterTurn!(ctx, "ws-session", "anything");
      expect(sendReply).not.toHaveBeenCalled();
    });

    it("drops the dispatch if the stashed accountId is no longer configured", async () => {
      const sendReply = vi.fn(async () => {});
      const cap = defineChannel(makeChannelDef([{ id: "acct-a", tag: "primary" }], { sendReply }));
      await storage.put("channel-inbound:sess-1", {
        accountId: "acct-gone",
        inbound: { chatId: 1, messageId: 1 },
      });
      await cap.afterTurn!(makeAgentContext(storage), "sess-1", "text");
      expect(sendReply).not.toHaveBeenCalled();
    });

    it("swallows sendReply errors and does NOT rethrow", async () => {
      const sendReply = vi.fn(async () => {
        throw new Error("telegram down");
      });
      const cap = defineChannel(makeChannelDef([{ id: "acct-a", tag: "primary" }], { sendReply }));
      await storage.put("channel-inbound:sess-1", {
        accountId: "acct-a",
        inbound: { chatId: 1, messageId: 1 },
      });
      await expect(
        cap.afterTurn!(makeAgentContext(storage), "sess-1", "text"),
      ).resolves.toBeUndefined();
    });

    it("does NOT delete the stash after dispatch", async () => {
      const cap = defineChannel(makeChannelDef());
      await storage.put("channel-inbound:sess-1", {
        accountId: "acct-a",
        inbound: { chatId: 1, messageId: 1 },
      });
      await cap.afterTurn!(makeAgentContext(storage), "sess-1", "text");
      const stillThere = await storage.get("channel-inbound:sess-1");
      expect(stillThere).toBeDefined();
    });
  });
});
