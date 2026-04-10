import { describe, expect, it } from "vitest";
import type { TelegramAccount } from "../types.js";
import { constantTimeEqual, verifyTelegramSecret } from "../verify.js";

const account: TelegramAccount = {
  id: "primary",
  token: "fake-token",
  webhookSecret: "swordfish-hunter2",
};

function makeRequest(headerValue: string | null): Request {
  const headers: Record<string, string> = {};
  if (headerValue !== null) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = headerValue;
  }
  return new Request("https://agent.test/telegram/webhook/primary", {
    method: "POST",
    headers,
  });
}

describe("verifyTelegramSecret", () => {
  it("accepts the correct secret", () => {
    expect(verifyTelegramSecret(makeRequest("swordfish-hunter2"), account)).toBe(true);
  });

  it("rejects a mismatched secret", () => {
    expect(verifyTelegramSecret(makeRequest("wrong-secret-entirely"), account)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyTelegramSecret(makeRequest(null), account)).toBe(false);
  });

  it("rejects a shorter-than-expected header without leaking the length comparison", () => {
    expect(verifyTelegramSecret(makeRequest("short"), account)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for unequal strings of the same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
