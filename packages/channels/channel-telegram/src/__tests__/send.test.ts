import { describe, expect, it, vi } from "vitest";
import { chunkMessage, createTelegramSendReply } from "../send.js";
import type { TelegramAccount } from "../types.js";

describe("chunkMessage", () => {
  it("returns [''] for an empty string", () => {
    expect(chunkMessage("")).toEqual([""]);
  });

  it("returns a single chunk for short messages", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("splits a message of exactly the max length into one chunk", () => {
    const text = "a".repeat(4096);
    expect(chunkMessage(text)).toEqual([text]);
  });

  it("splits a message of 8192 characters into two full chunks", () => {
    const text = "a".repeat(8192);
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(4096);
  });

  it("caps the output at 5 chunks for messages above 20480 characters", () => {
    // 25_000 chars — far above 5 * 4096 = 20480 capacity.
    const text = "x".repeat(25_000);
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(5);
    // The first four chunks are the full max length.
    for (let i = 0; i < 4; i++) {
      expect(chunks[i]).toHaveLength(4096);
    }
    // The fifth chunk ends with the truncation marker.
    expect(chunks[4].endsWith("…[truncated]")).toBe(true);
    // And the fifth chunk is not longer than the max.
    expect(chunks[4].length).toBeLessThanOrEqual(4096);
  });

  it("produces exactly 5 chunks and truncation for a message right above capacity", () => {
    const text = "y".repeat(4096 * 5 + 1);
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(5);
    expect(chunks[4].endsWith("…[truncated]")).toBe(true);
  });
});

describe("createTelegramSendReply", () => {
  const account: TelegramAccount = {
    id: "primary",
    token: "fake-token",
    webhookSecret: "secret",
  };

  function makeFakeClient() {
    const calls: Array<{ chat_id: number; text: string; reply_to_message_id?: number }> = [];
    const client = {
      sendMessage: vi.fn(
        async (params: { chat_id: number; text: string; reply_to_message_id?: number }) => {
          calls.push(params);
        },
      ),
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake client for the factory slot
    return { client: client as any, calls };
  }

  it("calls sendMessage once with reply_to_message_id on a short reply", async () => {
    const { client, calls } = makeFakeClient();
    const sendReply = createTelegramSendReply(() => client);
    await sendReply(account, { chatId: 42, messageId: 7, originalSenderId: 1 }, "hi back");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ chat_id: 42, text: "hi back", reply_to_message_id: 7 });
  });

  it("only the first chunk carries reply_to_message_id on long replies", async () => {
    const { client, calls } = makeFakeClient();
    const sendReply = createTelegramSendReply(() => client);
    const text = "z".repeat(25_000);
    await sendReply(account, { chatId: 1, messageId: 99, originalSenderId: 1 }, text);
    expect(calls).toHaveLength(5);
    expect(calls[0].reply_to_message_id).toBe(99);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].reply_to_message_id).toBeUndefined();
    }
    expect(calls[4].text.endsWith("…[truncated]")).toBe(true);
  });
});
