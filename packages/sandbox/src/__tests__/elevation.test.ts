import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { checkElevation } from "../elevation.js";
import { isSessionElevated, setSessionElevated } from "../session-state.js";
import type { SandboxProvider } from "../types.js";

function createMapStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async list<T>(prefix?: string): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}

function mockProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

describe("checkElevation", () => {
  it("returns NOT_ELEVATED_RESULT when session is not elevated", async () => {
    const storage = createMapStorage();
    const result = await checkElevation(storage, "s1");

    expect(result).not.toBeNull();
    expect(result!.details).toEqual({ error: "not_elevated" });
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain("Not elevated");
  });

  it("returns null when elevated and no provider given (trust state)", async () => {
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");

    const result = await checkElevation(storage, "s1");
    expect(result).toBeNull();
  });

  it("returns null when elevated and provider health is ready", async () => {
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");
    const provider = mockProvider();

    const result = await checkElevation(storage, "s1", provider);
    expect(result).toBeNull();
    expect(provider.health).toHaveBeenCalled();
  });

  it("restarts container when elevated but health fails, then succeeds", async () => {
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");

    let healthCallCount = 0;
    const provider = mockProvider({
      health: vi.fn().mockImplementation(async () => {
        healthCallCount++;
        if (healthCallCount === 1) throw new Error("dead");
        return { ready: true };
      }),
      start: vi.fn().mockResolvedValue(undefined),
    });

    const result = await checkElevation(storage, "s1", provider);
    expect(result).toBeNull();

    // Container was restarted
    expect(provider.start).toHaveBeenCalled();

    // Session should be re-elevated
    const stillElevated = await isSessionElevated(storage, "s1");
    expect(stillElevated).toBe(true);
  });

  it("returns CONTAINER_RESTART_FAILED when start throws", async () => {
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");

    const provider = mockProvider({
      health: vi.fn().mockRejectedValue(new Error("dead")),
      start: vi.fn().mockRejectedValue(new Error("cannot start")),
    });

    const result = await checkElevation(storage, "s1", provider);
    expect(result).not.toBeNull();
    expect(result!.details).toEqual({ error: "container_restart_failed" });
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain("died");
  });

  it("returns CONTAINER_RESTART_FAILED when health after restart says not ready", async () => {
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");

    let healthCallCount = 0;
    const provider = mockProvider({
      health: vi.fn().mockImplementation(async () => {
        healthCallCount++;
        if (healthCallCount === 1) throw new Error("dead");
        // After restart, not ready
        return { ready: false };
      }),
      start: vi.fn().mockResolvedValue(undefined),
    });

    const result = await checkElevation(storage, "s1", provider);
    expect(result).not.toBeNull();
    expect(result!.details).toEqual({ error: "container_restart_failed" });
  });

  it("clears all elevation and process owner state on dead container", async () => {
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");
    await setSessionElevated(storage, "s2", "other");
    await storage.put("proc:bg-1", "s1");

    let healthCallCount = 0;
    const provider = mockProvider({
      health: vi.fn().mockImplementation(async () => {
        healthCallCount++;
        if (healthCallCount === 1) throw new Error("dead");
        return { ready: true };
      }),
    });

    await checkElevation(storage, "s1", provider);

    // Other session's elevation should have been cleared
    const s2Elevated = await isSessionElevated(storage, "s2");
    expect(s2Elevated).toBe(false);

    // Process ownership should have been cleared
    const procOwner = await storage.get("proc:bg-1");
    expect(procOwner).toBeUndefined();
  });

  it("throws when storage is undefined", async () => {
    await expect(
      checkElevation(undefined, "s1"),
    ).rejects.toThrow("Sandbox capability requires storage");
  });
});
