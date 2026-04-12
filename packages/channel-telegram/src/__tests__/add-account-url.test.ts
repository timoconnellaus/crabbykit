import type { CapabilityHookContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { defineTelegramChannel } from "../index.js";
import type { TelegramClient } from "../telegram-client.js";
import type { TelegramAccount } from "../types.js";

/**
 * Captures every setWebhook call made against the fake client so tests
 * can assert the URL shape the channel registered with the Bot API.
 */
interface SetWebhookCall {
  url: string;
  secretToken: string;
}

function createMockStorage(): CapabilityStorage {
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

function createHookContext(storage: CapabilityStorage, publicUrl?: string): CapabilityHookContext {
  return {
    agentId: "test-do-id",
    publicUrl,
    sessionId: "test-session",
    sessionStore: {} as any,
    storage,
    capabilityIds: ["telegram"],
    broadcastState: () => {},
  };
}

function makeFakeClient(calls: SetWebhookCall[]): (_: TelegramAccount) => TelegramClient {
  return (_account: TelegramAccount) =>
    ({
      async setWebhook(url: string, secretToken: string) {
        calls.push({ url, secretToken });
      },
      async deleteWebhook() {},
    }) as any;
}

describe("defineTelegramChannel — addAccount webhook URL", () => {
  let storage: CapabilityStorage;
  let calls: SetWebhookCall[];

  beforeEach(() => {
    storage = createMockStorage();
    calls = [];
  });

  it("reads publicUrl from the capability context (runtime-supplied)", async () => {
    const channel = defineTelegramChannel({
      clientFactory: makeFakeClient(calls),
    });
    const ctx = createHookContext(storage, "https://agent.example.com");

    await channel.onAction?.(
      "add",
      { id: "support", token: "bot-token", webhookSecret: "secret" },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://agent.example.com/telegram/webhook/support");
  });

  it("includes the agent segment when agentId is configured (multi-tenant shape)", async () => {
    const channel = defineTelegramChannel({
      agentId: "agent-bob",
      clientFactory: makeFakeClient(calls),
    });
    const ctx = createHookContext(storage, "https://agent.example.com");

    await channel.onAction?.(
      "add",
      { id: "support", token: "bot-token", webhookSecret: "secret" },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://agent.example.com/telegram/webhook/agent-bob/support");
  });

  it("URL-encodes agent and account ids so path-unsafe characters don't break routing", async () => {
    const channel = defineTelegramChannel({
      agentId: "tenant/with spaces",
      clientFactory: makeFakeClient(calls),
    });
    const ctx = createHookContext(storage, "https://agent.example.com");

    await channel.onAction?.(
      "add",
      { id: "acc/1", token: "bot-token", webhookSecret: "secret" },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://agent.example.com/telegram/webhook/tenant%2Fwith%20spaces/acc%2F1",
    );
  });

  it("strips a trailing slash from publicUrl before joining the webhook path", async () => {
    const channel = defineTelegramChannel({
      agentId: "agent-bob",
      clientFactory: makeFakeClient(calls),
    });
    const ctx = createHookContext(storage, "https://agent.example.com/");

    await channel.onAction?.(
      "add",
      { id: "support", token: "bot-token", webhookSecret: "secret" },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://agent.example.com/telegram/webhook/agent-bob/support");
  });

  it("swallows the add failure and leaves no account when publicUrl is missing", async () => {
    // onAction catches add failures internally — they surface as a logged
    // error + a re-broadcast of the (still empty) account list, not a
    // thrown exception. Assert via the storage state instead.
    const channel = defineTelegramChannel({
      clientFactory: makeFakeClient(calls),
    });
    const ctx = createHookContext(storage, undefined);

    await channel.onAction?.(
      "add",
      { id: "support", token: "bot-token", webhookSecret: "secret" },
      ctx,
    );

    // No Bot API call happened.
    expect(calls).toHaveLength(0);
    // No account persisted — the add handler refused before calling store.put.
    const stored = await storage.list("");
    expect(stored.size).toBe(0);
  });
});
