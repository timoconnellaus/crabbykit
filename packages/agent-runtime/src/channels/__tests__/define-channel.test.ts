import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../agent-runtime.js";
import type { CapabilityStorage } from "../../capabilities/storage.js";
import type { CapabilityHookContext, CapabilityHttpContext } from "../../capabilities/types.js";
import { SessionStore } from "../../session/session-store.js";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import { defineChannel } from "../define-channel.js";
import type { ChannelDefinition } from "../types.js";

/**
 * Simple in-memory capability storage for the helper. The real runtime
 * wraps DO KV, but these tests exercise the helper in isolation.
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

/**
 * Minimal test channel definition. Mocks every hook so tests can assert
 * what was called with what.
 */
interface TestAccount {
  id: string;
  tag: string;
}

interface TestInbound {
  chatId: number;
  messageId: number;
}

function makeChannelDef(
  overrides: Partial<ChannelDefinition<TestAccount, TestInbound>> = {},
): ChannelDefinition<TestAccount, TestInbound> {
  return {
    id: "test-ch",
    accounts: () => [{ id: "acct-a", tag: "primary" }],
    webhookPath: (a) => `/webhook/${a.id}`,
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
  rateLimit?: CapabilityHttpContext["rateLimit"];
  sendPrompt?: CapabilityHttpContext["sendPrompt"];
}): CapabilityHttpContext {
  return {
    storage: opts.storage,
    sessionStore: opts.sessionStore,
    broadcastToAll: () => {},
    broadcastState: () => {},
    rateLimit: opts.rateLimit ?? { consume: async () => ({ allowed: true }) },
    sendPrompt:
      opts.sendPrompt ?? (async (o) => ({ sessionId: o.sessionId ?? "s1", response: "ok" })),
  };
}

// Helper to build a webhook Request with a JSON body.
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

  describe("inbound pipeline", () => {
    it("returns 403 when verifyWebhook returns false", async () => {
      const sendPrompt = vi.fn();
      const def = makeChannelDef({ verifyWebhook: () => false });
      const cap = defineChannel(def);
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      expect(handlers).toHaveLength(1);
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt }),
      );
      expect(resp.status).toBe(403);
      expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("returns 200 without processing when parseWebhook returns null", async () => {
      const sendPrompt = vi.fn();
      const def = makeChannelDef({ parseWebhook: async () => null });
      const cap = defineChannel(def);
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
      const def = makeChannelDef();
      const cap = defineChannel(def);
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, rateLimit }),
      );
      expect(resp.status).toBe(200);
      expect(sendPrompt).not.toHaveBeenCalled();
      // Only the per-sender bucket should have been consumed.
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
      const def = makeChannelDef();
      const cap = defineChannel(def);
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const resp = await handlers[0].handler(
        webhookRequest({ senderId: "@alice", text: "hi" }),
        makeHttpContext({ storage, sessionStore, sendPrompt, rateLimit }),
      );
      expect(resp.status).toBe(200);
      expect(sendPrompt).not.toHaveBeenCalled();
      // Per-sender passes, per-account denies.
      expect(rateLimit.consume).toHaveBeenCalledTimes(2);
    });

    it("creates a session via findBySourceAndSender on first inbound, reuses it on the second", async () => {
      const sendPrompt = vi.fn(async (o: { sessionId?: string }) => ({
        sessionId: o.sessionId ?? "",
        response: "",
      }));
      const def = makeChannelDef();
      const cap = defineChannel(def);
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

      // Wait a tick for the fire-and-forget sendPrompt inside the handler.
      await new Promise((r) => setTimeout(r, 10));

      expect(sendPrompt).toHaveBeenCalledTimes(2);
      const first = sendPrompt.mock.calls[0][0] as { sessionId: string };
      const second = sendPrompt.mock.calls[1][0] as { sessionId: string };
      expect(first.sessionId).toBeTruthy();
      expect(first.sessionId).toBe(second.sessionId);

      // Exactly one session row exists for this (source, sender) pair.
      const found = sessionStore.findBySourceAndSender("test-ch", "@alice");
      expect(found).not.toBeNull();
      expect(found?.sender).toBe("@alice");
    });

    it("stashes the inbound payload under channel-inbound:<sessionId>", async () => {
      const def = makeChannelDef();
      const cap = defineChannel(def);
      const handlers = cap.httpHandlers!(makeAgentContext(storage));
      const sendPrompt = vi.fn(async (o: { sessionId?: string }) => ({
        sessionId: o.sessionId ?? "",
        response: "",
      }));
      const ctx = makeHttpContext({ storage, sessionStore, sendPrompt });

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
      const def = makeChannelDef();
      const cap = defineChannel(def);
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
  });

  describe("outbound (afterTurn)", () => {
    it("reads the stash and calls sendReply with the stashed inbound", async () => {
      const sendReply = vi.fn(async () => {});
      const def = makeChannelDef({ sendReply });
      const cap = defineChannel(def);

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
      const def = makeChannelDef({ sendReply });
      const cap = defineChannel(def);
      const ctx = makeAgentContext(storage);
      await cap.afterTurn!(ctx, "ws-session", "anything");
      expect(sendReply).not.toHaveBeenCalled();
    });

    it("drops the dispatch if the stashed accountId is no longer configured", async () => {
      const sendReply = vi.fn(async () => {});
      const def = makeChannelDef({
        accounts: () => [{ id: "acct-a", tag: "primary" }],
        sendReply,
      });
      const cap = defineChannel(def);
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
      const def = makeChannelDef({ sendReply });
      const cap = defineChannel(def);
      await storage.put("channel-inbound:sess-1", {
        accountId: "acct-a",
        inbound: { chatId: 1, messageId: 1 },
      });
      await expect(
        cap.afterTurn!(makeAgentContext(storage), "sess-1", "text"),
      ).resolves.toBeUndefined();
    });

    it("does NOT delete the stash after dispatch", async () => {
      const def = makeChannelDef();
      const cap = defineChannel(def);
      await storage.put("channel-inbound:sess-1", {
        accountId: "acct-a",
        inbound: { chatId: 1, messageId: 1 },
      });
      await cap.afterTurn!(makeAgentContext(storage), "sess-1", "text");
      const stillThere = await storage.get("channel-inbound:sess-1");
      expect(stillThere).toBeDefined();
    });
  });

  describe("lifecycle hooks", () => {
    it("calls onAccountAdded for every configured account on onConnect", async () => {
      const accountsSeen: TestAccount[] = [];
      const onAccountAdded = vi.fn(async (account: TestAccount) => {
        accountsSeen.push(account);
      });
      const def = makeChannelDef({
        accounts: () => [
          { id: "a1", tag: "one" },
          { id: "a2", tag: "two" },
        ],
        onAccountAdded,
      });
      const cap = defineChannel(def);
      // First, httpHandlers populates the cache so onConnect sees accounts.
      cap.httpHandlers!(makeAgentContext(storage));
      await cap.hooks!.onConnect!({
        agentId: "",
        sessionId: "",
        // biome-ignore lint/suspicious/noExplicitAny: stub
        sessionStore: {} as any,
        storage,
        capabilityIds: [def.id],
      } as CapabilityHookContext);
      expect(onAccountAdded).toHaveBeenCalledTimes(2);
      expect(accountsSeen[0]).toEqual({ id: "a1", tag: "one" });
      expect(accountsSeen[1]).toEqual({ id: "a2", tag: "two" });
    });

    it("calls onAccountRemoved for every configured account at dispose", async () => {
      const onAccountRemoved = vi.fn(async () => {});
      const def = makeChannelDef({
        accounts: () => [
          { id: "a1", tag: "one" },
          { id: "a2", tag: "two" },
        ],
        onAccountRemoved,
      });
      const cap = defineChannel(def);
      cap.httpHandlers!(makeAgentContext(storage));
      await cap.dispose!();
      expect(onAccountRemoved).toHaveBeenCalledTimes(2);
    });

    it("survives onAccountAdded throwing without aborting the rest", async () => {
      const calls: string[] = [];
      const def = makeChannelDef({
        accounts: () => [
          { id: "a1", tag: "one" },
          { id: "a2", tag: "two" },
        ],
        onAccountAdded: async (account) => {
          calls.push(account.id);
          if (account.id === "a1") throw new Error("webhook 409");
        },
      });
      const cap = defineChannel(def);
      cap.httpHandlers!(makeAgentContext(storage));
      await cap.hooks!.onConnect!({
        agentId: "",
        sessionId: "",
        // biome-ignore lint/suspicious/noExplicitAny: stub
        sessionStore: {} as any,
        storage,
        capabilityIds: [def.id],
      } as CapabilityHookContext);
      expect(calls).toEqual(["a1", "a2"]);
    });
  });
});
