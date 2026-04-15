import { describe, expect, it } from "vitest";
import { parseTelegramUpdate, type TelegramUpdate } from "../parse.js";

function makeUpdate(overrides: Partial<TelegramUpdate["message"]> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      text: "hello",
      from: { id: 555, username: "alice" },
      chat: { id: 123, type: "private" },
      ...overrides,
    },
  };
}

describe("parseTelegramUpdate", () => {
  it("parses a private-chat message with a username", () => {
    const parsed = parseTelegramUpdate(makeUpdate());
    expect(parsed).not.toBeNull();
    expect(parsed!.senderId).toBe("@alice");
    expect(parsed!.text).toBe("hello");
    expect(parsed!.inbound).toEqual({ chatId: 123, messageId: 100, originalSenderId: 555 });
  });

  it("falls back to the numeric user id when username is absent", () => {
    const update = makeUpdate({ from: { id: 777 } });
    const parsed = parseTelegramUpdate(update);
    expect(parsed?.senderId).toBe("777");
  });

  it("collapses group chats onto a group:<chatId> sender", () => {
    const update = makeUpdate({
      chat: { id: -1001, type: "group" },
      from: { id: 555, username: "alice" },
    });
    const parsed = parseTelegramUpdate(update);
    expect(parsed?.senderId).toBe("group:-1001");
    expect(parsed?.inbound.originalSenderId).toBe(555);
  });

  it("collapses supergroups the same way", () => {
    const update = makeUpdate({
      chat: { id: -999, type: "supergroup" },
    });
    const parsed = parseTelegramUpdate(update);
    expect(parsed?.senderId).toBe("group:-999");
  });

  it("returns null for updates without message.text", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 1, type: "private" },
      },
    };
    expect(parseTelegramUpdate(update)).toBeNull();
  });

  it("returns null for updates without a message at all", () => {
    expect(parseTelegramUpdate({ update_id: 1 })).toBeNull();
  });

  it("returns null for updates missing `from`", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        text: "hi",
        chat: { id: 1, type: "private" },
      },
    };
    expect(parseTelegramUpdate(update)).toBeNull();
  });
});
