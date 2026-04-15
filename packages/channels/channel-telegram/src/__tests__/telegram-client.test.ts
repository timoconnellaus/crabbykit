import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactToken, TelegramClient } from "../telegram-client.js";
import type { TelegramAccount } from "../types.js";

const TOKEN = "111111:AAEEverySecretTokenStringHere";
const account: TelegramAccount = {
  id: "primary",
  token: TOKEN,
  webhookSecret: "secret",
};

describe("redactToken", () => {
  it("replaces the token with [REDACTED_TOKEN]", () => {
    const msg = `GET https://api.telegram.org/bot${TOKEN}/getMe failed`;
    expect(redactToken(msg, TOKEN)).toBe(
      "GET https://api.telegram.org/bot[REDACTED_TOKEN]/getMe failed",
    );
  });

  it("is a no-op when the token is not present", () => {
    expect(redactToken("some unrelated error", TOKEN)).toBe("some unrelated error");
  });

  it("leaves other content untouched when the token is an empty string", () => {
    expect(redactToken("message", "")).toBe("message");
  });
});

describe("TelegramClient (token redaction)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Replace global fetch with a function we control.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("strips the bot token from thrown errors on non-ok HTTP responses", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      // The error body deliberately echoes the request URL so we can
      // verify the redaction actually runs.
      const url = typeof input === "string" ? input : input.toString();
      return new Response(`upstream error at ${url}`, { status: 500 });
    }) as typeof globalThis.fetch;
    const client = new TelegramClient(account);
    let thrown: Error | null = null;
    try {
      await client.sendMessage({ chat_id: 1, text: "hi" });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).not.toContain(TOKEN);
    expect(thrown!.message).toContain("[REDACTED_TOKEN]");
  });

  it("strips the bot token from thrown errors on ok: false API responses", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: `invalid token ${TOKEN}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof globalThis.fetch;
    const client = new TelegramClient(account);
    let thrown: Error | null = null;
    try {
      await client.sendMessage({ chat_id: 1, text: "hi" });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).not.toContain(TOKEN);
  });
});
