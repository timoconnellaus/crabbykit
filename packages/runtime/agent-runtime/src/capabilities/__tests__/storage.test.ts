import { describe, expect, it } from "vitest";
import { createMockKvStore } from "../../test-helpers/mock-kv-storage.js";
import type { CapabilityStorage } from "../storage.js";
import { createCapabilityStorage, createNoopStorage } from "../storage.js";

describe("createCapabilityStorage", () => {
  it("round-trips a value through put and get", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");

    await storage.put("key1", { foo: "bar" });
    const result = await storage.get<{ foo: string }>("key1");

    expect(result).toEqual({ foo: "bar" });
  });

  it("returns undefined for a missing key", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");

    const result = await storage.get("nonexistent");

    expect(result).toBeUndefined();
  });

  it("deletes a key and returns true", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");
    await storage.put("to-delete", 42);

    const deleted = await storage.delete("to-delete");

    expect(deleted).toBe(true);
    expect(await storage.get("to-delete")).toBeUndefined();
  });

  it("returns false when deleting a missing key", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");

    const deleted = await storage.delete("nonexistent");

    expect(deleted).toBe(false);
  });

  it("lists all keys with prefix stripped", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");
    await storage.put("a", 1);
    await storage.put("b", 2);
    await storage.put("c", 3);

    const result = await storage.list<number>();

    expect(result.size).toBe(3);
    expect(result.get("a")).toBe(1);
    expect(result.get("b")).toBe(2);
    expect(result.get("c")).toBe(3);
  });

  it("lists with a sub-prefix filter", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");
    await storage.put("settings:theme", "dark");
    await storage.put("settings:lang", "en");
    await storage.put("data:items", [1, 2, 3]);

    const result = await storage.list<string>("settings:");

    expect(result.size).toBe(2);
    expect(result.get("settings:theme")).toBe("dark");
    expect(result.get("settings:lang")).toBe("en");
  });

  it("isolates storage between capabilities", async () => {
    const doStorage = createMockKvStore();
    const storageA = createCapabilityStorage(doStorage, "cap-a");
    const storageB = createCapabilityStorage(doStorage, "cap-b");

    await storageA.put("shared-key", "value-a");
    await storageB.put("shared-key", "value-b");

    expect(await storageA.get("shared-key")).toBe("value-a");
    expect(await storageB.get("shared-key")).toBe("value-b");
  });

  it("handles complex values", async () => {
    const storage = createCapabilityStorage(createMockKvStore(), "my-cap");
    const complex = { nested: { array: [1, "two", { three: true }] }, date: "2024-01-01" };

    await storage.put("complex", complex);

    expect(await storage.get("complex")).toEqual(complex);
  });
});

describe("createNoopStorage", () => {
  let storage: CapabilityStorage;

  it("get returns undefined", async () => {
    storage = createNoopStorage();
    expect(await storage.get("anything")).toBeUndefined();
  });

  it("put does not throw", async () => {
    storage = createNoopStorage();
    await expect(storage.put("key", "value")).resolves.toBeUndefined();
  });

  it("delete returns false", async () => {
    storage = createNoopStorage();
    expect(await storage.delete("key")).toBe(false);
  });

  it("list returns empty Map", async () => {
    storage = createNoopStorage();
    const result = await storage.list();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
