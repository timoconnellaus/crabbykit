/**
 * E2E tests for the Telegram channel (§7 of add-channels-v2/tasks.md).
 *
 * Runs against the pool-workers harness with a real AgentDO, real
 * SessionStore SQLite, real capability KV (DO KV), and a fake Bot API
 * client injected via `setTelegramClientFactory` that records every
 * `sendMessage` / `setWebhook` call instead of hitting the real Telegram
 * API.
 *
 * Each `describe` block uses a unique DO name to avoid state bleed across
 * tests — the pool-workers storage frame checker is disabled in
 * `vitest.config.ts`, so isolation relies on DO-name uniqueness.
 */

import { env } from "cloudflare:test";
import type { TelegramAccount } from "@crabbykit/channel-telegram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMockResponses,
  clearTelegramTestState,
  setMockResponses,
  setTelegramAccounts,
  setTelegramClientFactory,
} from "../src/test-agent";

interface SendMessageCall {
  account: TelegramAccount;
  chat_id: number;
  text: string;
  reply_to_message_id?: number;
}

interface FakeTelegramClient {
  account: TelegramAccount;
  sendMessage: (p: {
    chat_id: number;
    text: string;
    reply_to_message_id?: number;
  }) => Promise<void>;
  setWebhook: (url: string, secretToken: string) => Promise<void>;
  deleteWebhook: () => Promise<void>;
  getMe: () => Promise<{ id: number; username?: string }>;
}

/** Captures calls across all accounts for a single test. */
interface TelegramHarness {
  sendMessageCalls: SendMessageCall[];
  setWebhookCalls: Array<{ account: TelegramAccount; url: string; secretToken: string }>;
  throwOnSendMessage?: boolean;
  throwOnNextSendMessage?: boolean;
}

function buildFakeClientFactory(harness: TelegramHarness) {
  return (account: TelegramAccount): FakeTelegramClient => ({
    account,
    sendMessage: async (params) => {
      if (harness.throwOnNextSendMessage) {
        harness.throwOnNextSendMessage = false;
        throw new Error("telegram transient failure");
      }
      if (harness.throwOnSendMessage) {
        throw new Error("telegram down");
      }
      harness.sendMessageCalls.push({ account, ...params });
    },
    setWebhook: async (url: string, secretToken: string) => {
      harness.setWebhookCalls.push({ account, url, secretToken });
    },
    deleteWebhook: async () => {},
    getMe: async () => ({ id: 1, username: "testbot" }),
  });
}

function makeTelegramWebhookRequest(
  accountId: string,
  secret: string,
  body: unknown,
): { url: string; init: RequestInit } {
  return {
    url: `http://fake/telegram/webhook/${accountId}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": secret,
      },
      body: JSON.stringify(body),
    },
  };
}

function privateChatUpdate(
  updateId: number,
  username: string | undefined,
  userId: number,
  chatId: number,
  messageId: number,
  text: string,
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      text,
      from: { id: userId, ...(username ? { username } : {}) },
      chat: { id: chatId, type: "private" as const },
    },
  };
}

function groupChatUpdate(
  updateId: number,
  userId: number,
  chatId: number,
  messageId: number,
  text: string,
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      text,
      from: { id: userId },
      chat: { id: chatId, type: "group" as const },
    },
  };
}

async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 1500, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
  }
}

describe("Telegram channel e2e", () => {
  let harness: TelegramHarness;
  const primaryAccount: TelegramAccount = {
    id: "support",
    token: "fake-token-support",
    webhookSecret: "secret-support",
  };
  const _secondaryAccount: TelegramAccount = {
    id: "ops",
    token: "fake-token-ops",
    webhookSecret: "secret-ops",
  };

  beforeEach(() => {
    harness = { sendMessageCalls: [], setWebhookCalls: [] };
    clearMockResponses();
    setTelegramAccounts([primaryAccount]);
    setTelegramClientFactory(buildFakeClientFactory(harness));
  });

  afterEach(() => {
    clearTelegramTestState();
    clearMockResponses();
  });

  it("7.2 / 7.3 webhook creates a session and sendReply fires with correct chat_id", async () => {
    const id = env.AGENT.idFromName("tg-1");
    const stub = env.AGENT.get(id);

    setMockResponses([{ text: "Hi Alice!" }]);
    const { url, init } = makeTelegramWebhookRequest(
      primaryAccount.id,
      primaryAccount.webhookSecret,
      privateChatUpdate(1, "alice", 111, 9999, 1, "hello bot"),
    );
    const res = await stub.fetch(url, init);
    expect(res.status).toBe(200);

    await waitForCondition(() => harness.sendMessageCalls.length >= 1);
    expect(harness.sendMessageCalls).toHaveLength(1);
    const call = harness.sendMessageCalls[0];
    expect(call.chat_id).toBe(9999);
    expect(call.reply_to_message_id).toBe(1);
    expect(call.text).toBe("Hi Alice!");
  });

  it("7.3 second webhook for the same sender reuses the session", async () => {
    const id = env.AGENT.idFromName("tg-2");
    const stub = env.AGENT.get(id);

    setMockResponses([{ text: "first reply" }, { text: "second reply" }]);

    const req1 = makeTelegramWebhookRequest(
      primaryAccount.id,
      primaryAccount.webhookSecret,
      privateChatUpdate(1, "alice", 111, 9999, 1, "one"),
    );
    await stub.fetch(req1.url, req1.init);

    const req2 = makeTelegramWebhookRequest(
      primaryAccount.id,
      primaryAccount.webhookSecret,
      privateChatUpdate(2, "alice", 111, 9999, 2, "two"),
    );
    await stub.fetch(req2.url, req2.init);

    await waitForCondition(() => harness.sendMessageCalls.length >= 2);

    // Sessions list should show exactly one session.
    const sessionsRes = await stub.fetch("http://fake/sessions");
    const { sessions } = (await sessionsRes.json()) as { sessions: Array<{ sender: string }> };
    const telegramSessions = sessions.filter((s) => s.sender === "@alice");
    expect(telegramSessions).toHaveLength(1);
  });

  it("7.4 per-sender rate limit caps 20 rapid webhooks at 10 replies", async () => {
    const id = env.AGENT.idFromName("tg-3");
    const stub = env.AGENT.get(id);

    // Queue 25 mock responses so we can confirm that only up to the rate
    // limit actually drive inference.
    setMockResponses(Array.from({ length: 25 }, (_, i) => ({ text: `r${i}` })));

    // Fire 20 webhooks from the same sender sequentially (DO execution is
    // single-threaded so parallelism wouldn't change the result).
    for (let i = 0; i < 20; i++) {
      const req = makeTelegramWebhookRequest(
        primaryAccount.id,
        primaryAccount.webhookSecret,
        privateChatUpdate(100 + i, "alice", 111, 9999, i + 1, `msg ${i}`),
      );
      const res = await stub.fetch(req.url, req.init);
      expect(res.status).toBe(200);
    }

    // Let the waitUntil dispatches drain.
    await waitForCondition(() => harness.sendMessageCalls.length >= 10, { timeoutMs: 3000 });
    // Give a bit more time to confirm no extra calls leak through.
    await new Promise((r) => setTimeout(r, 200));
    expect(harness.sendMessageCalls.length).toBeLessThanOrEqual(10);
  });

  it("7.5 per-account rate limit caps 100 distinct senders at 60 replies", async () => {
    const id = env.AGENT.idFromName("tg-4");
    const stub = env.AGENT.get(id);
    setMockResponses(Array.from({ length: 120 }, (_, i) => ({ text: `r${i}` })));

    for (let i = 0; i < 100; i++) {
      const req = makeTelegramWebhookRequest(
        primaryAccount.id,
        primaryAccount.webhookSecret,
        privateChatUpdate(500 + i, undefined, 200 + i, 1000 + i, 1, `msg ${i}`),
      );
      const res = await stub.fetch(req.url, req.init);
      expect(res.status).toBe(200);
    }

    await waitForCondition(() => harness.sendMessageCalls.length >= 60, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(harness.sendMessageCalls.length).toBeLessThanOrEqual(60);
  });

  it("7.6 secret header mismatch → 403 and no downstream work", async () => {
    const id = env.AGENT.idFromName("tg-5");
    const stub = env.AGENT.get(id);
    setMockResponses([{ text: "should not run" }]);

    const { url, init } = makeTelegramWebhookRequest(
      primaryAccount.id,
      "wrong-secret",
      privateChatUpdate(1, "alice", 111, 9999, 1, "attack"),
    );
    const res = await stub.fetch(url, init);
    expect(res.status).toBe(403);

    // Give any stray async work a chance to run, then confirm nothing did.
    await new Promise((r) => setTimeout(r, 150));
    expect(harness.sendMessageCalls).toHaveLength(0);

    const { sessions } = (await (await stub.fetch("http://fake/sessions")).json()) as {
      sessions: Array<{ sender: string | null }>;
    };
    expect(sessions.filter((s) => s.sender === "@alice")).toHaveLength(0);
  });

  it("7.7 sendReply error is logged and the turn still completes", async () => {
    harness.throwOnSendMessage = true;
    const id = env.AGENT.idFromName("tg-6");
    const stub = env.AGENT.get(id);
    setMockResponses([{ text: "reply that fails to deliver" }]);

    const { url, init } = makeTelegramWebhookRequest(
      primaryAccount.id,
      primaryAccount.webhookSecret,
      privateChatUpdate(1, "alice", 111, 9999, 1, "trigger failure"),
    );
    const res = await stub.fetch(url, init);
    expect(res.status).toBe(200);

    // Turn completes, entry is persisted, but sendMessage did not succeed.
    await new Promise((r) => setTimeout(r, 300));
    expect(harness.sendMessageCalls).toHaveLength(0);

    const entries = (await (await stub.fetch("http://fake/entries")).json()) as {
      entries: Array<{ type: string; data: { role?: string } }>;
    };
    const assistants = entries.entries.filter(
      (e) => e.type === "message" && e.data?.role === "assistant",
    );
    expect(assistants.length).toBeGreaterThanOrEqual(1);
  });

  it("7.10 group chat routes multiple members to a single session", async () => {
    const id = env.AGENT.idFromName("tg-7");
    const stub = env.AGENT.get(id);
    setMockResponses([{ text: "first reply" }, { text: "second reply" }]);

    const req1 = makeTelegramWebhookRequest(
      primaryAccount.id,
      primaryAccount.webhookSecret,
      groupChatUpdate(1, 111, -1001, 10, "from alice"),
    );
    await stub.fetch(req1.url, req1.init);

    const req2 = makeTelegramWebhookRequest(
      primaryAccount.id,
      primaryAccount.webhookSecret,
      groupChatUpdate(2, 222, -1001, 11, "from bob"),
    );
    await stub.fetch(req2.url, req2.init);

    await waitForCondition(() => harness.sendMessageCalls.length >= 2);

    const { sessions } = (await (await stub.fetch("http://fake/sessions")).json()) as {
      sessions: Array<{ sender: string }>;
    };
    const groupSessions = sessions.filter((s) => s.sender === "group:-1001");
    expect(groupSessions).toHaveLength(1);

    // Both replies go to the same chat but each uses its own messageId as
    // the reply anchor — verify the second call used bob's messageId.
    expect(harness.sendMessageCalls.every((c) => c.chat_id === -1001)).toBe(true);
    expect(harness.sendMessageCalls[1].reply_to_message_id).toBe(11);
  });

  it("7.12 regression: HTTP prompt path continues to work when Telegram is registered", async () => {
    // With the Telegram capability registered on this DO, sending a
    // direct HTTP prompt via /prompt (which mirrors the WebSocket path)
    // must still drive inference and persist entries, with no Telegram
    // dispatch (no inbound stash for this session).
    const id = env.AGENT.idFromName("tg-8");
    const stub = env.AGENT.get(id);
    setMockResponses([{ text: "ws-style reply" }]);

    const res = await stub.fetch("http://fake/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi from ws" }),
    });
    const { entries } = (await res.json()) as {
      entries: Array<{ type: string; data: { role?: string } }>;
    };
    const assistant = entries.find((e) => e.type === "message" && e.data?.role === "assistant");
    expect(assistant).toBeDefined();

    // Let any stray afterTurn work drain — Telegram sendReply MUST NOT
    // have fired for a non-telegram session.
    await new Promise((r) => setTimeout(r, 200));
    expect(harness.sendMessageCalls).toHaveLength(0);
  });
});
