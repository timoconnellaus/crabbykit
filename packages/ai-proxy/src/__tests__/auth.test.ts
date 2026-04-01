import { describe, expect, it } from "vitest";
import { clearToken, generateProxyToken, storeToken, validateToken } from "../auth.js";

function createMapStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
    list: async <T>(_prefix?: string) => new Map<string, T>(),
  };
}

describe("generateProxyToken", () => {
  it("generates a 64-char hex string", () => {
    const token = generateProxyToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it("generates unique tokens", () => {
    const a = generateProxyToken();
    const b = generateProxyToken();
    expect(a).not.toBe(b);
  });
});

describe("validateToken", () => {
  it("rejects null auth header", async () => {
    const storage = createMapStorage();
    expect(await validateToken(storage, null)).toBe(false);
  });

  it("rejects missing Bearer prefix", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "abc123");
    expect(await validateToken(storage, "abc123")).toBe(false);
  });

  it("rejects when no token is stored", async () => {
    const storage = createMapStorage();
    expect(await validateToken(storage, "Bearer abc123")).toBe(false);
  });

  it("rejects wrong token", async () => {
    const storage = createMapStorage();
    await storeToken(
      storage,
      "correct-token-abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    );
    expect(await validateToken(storage, "Bearer wrong-token")).toBe(false);
  });

  it("accepts correct token", async () => {
    const storage = createMapStorage();
    const token = generateProxyToken();
    await storeToken(storage, token);
    expect(await validateToken(storage, `Bearer ${token}`)).toBe(true);
  });

  it("is case-insensitive for Bearer prefix", async () => {
    const storage = createMapStorage();
    const token = generateProxyToken();
    await storeToken(storage, token);
    expect(await validateToken(storage, `bearer ${token}`)).toBe(true);
  });
});

describe("clearToken", () => {
  it("clears the stored token", async () => {
    const storage = createMapStorage();
    const token = generateProxyToken();
    await storeToken(storage, token);
    expect(await validateToken(storage, `Bearer ${token}`)).toBe(true);

    await clearToken(storage);
    expect(await validateToken(storage, `Bearer ${token}`)).toBe(false);
  });
});
