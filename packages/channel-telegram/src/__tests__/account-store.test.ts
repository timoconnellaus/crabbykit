import { beforeEach, describe, expect, it } from "vitest";
import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { TelegramAccountStore } from "../account-store.js";
import type { TelegramAccount } from "../types.js";

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

function makeAccount(id: string, overrides: Partial<TelegramAccount> = {}): TelegramAccount {
  return {
    id,
    token: `token-${id}`,
    webhookSecret: `secret-${id}`,
    ...overrides,
  };
}

describe("TelegramAccountStore", () => {
  let storage: CapabilityStorage;
  let store: TelegramAccountStore;

  beforeEach(() => {
    storage = createMockStorage();
    store = new TelegramAccountStore(storage);
  });

  describe("get", () => {
    it("returns null for an unknown id", async () => {
      expect(await store.get("nope")).toBeNull();
    });

    it("round-trips a stored account", async () => {
      const account = makeAccount("alpha");
      await store.put(account);
      expect(await store.get("alpha")).toEqual(account);
    });
  });

  describe("list", () => {
    it("returns an empty array when nothing is stored", async () => {
      expect(await store.list()).toEqual([]);
    });

    it("returns accounts in insertion order", async () => {
      await store.put(makeAccount("first"));
      await store.put(makeAccount("second"));
      await store.put(makeAccount("third"));
      const accounts = await store.list();
      expect(accounts.map((a) => a.id)).toEqual(["first", "second", "third"]);
    });

    it("skips torn index entries (index has an id whose row was deleted out-of-band)", async () => {
      await store.put(makeAccount("a"));
      await store.put(makeAccount("b"));
      // Delete the row directly, bypassing `delete()` — simulates a
      // torn state.
      await storage.delete("account:a");
      const accounts = await store.list();
      expect(accounts.map((a) => a.id)).toEqual(["b"]);
    });
  });

  describe("put", () => {
    it("overwrites an existing account without duplicating the index entry", async () => {
      await store.put(makeAccount("x", { token: "old" }));
      await store.put(makeAccount("x", { token: "new" }));
      const accounts = await store.list();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].token).toBe("new");
    });
  });

  describe("delete", () => {
    it("returns true and removes the account when it exists", async () => {
      await store.put(makeAccount("gone"));
      expect(await store.delete("gone")).toBe(true);
      expect(await store.get("gone")).toBeNull();
      expect(await store.list()).toEqual([]);
    });

    it("returns false when the id is not present", async () => {
      expect(await store.delete("never-existed")).toBe(false);
    });

    it("leaves the other accounts alone", async () => {
      await store.put(makeAccount("keep"));
      await store.put(makeAccount("trash"));
      await store.delete("trash");
      const accounts = await store.list();
      expect(accounts.map((a) => a.id)).toEqual(["keep"]);
    });
  });
});
