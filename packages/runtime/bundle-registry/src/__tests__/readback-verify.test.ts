/**
 * verifyKvReadback unit tests (task 5.12).
 *
 * Exercises the KV readback loop against a fake KV whose `get` visibility
 * is controllable. Uses an injectable sleep so tests run in ms, not seconds.
 */

import { describe, expect, it, vi } from "vitest";
import { type ReadbackKv, verifyKvReadback } from "../readback.js";

/**
 * Fake KV where bytes become visible to `get` only after N `get` calls.
 * `null` means bytes never become visible.
 */
function makeLaggyKv(visibleAfterGetCount: number | null): ReadbackKv & {
  getCalls: number;
} {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const state = { getCalls: 0 };
  return {
    get getCalls() {
      return state.getCalls;
    },
    get: vi.fn(async () => {
      state.getCalls += 1;
      if (visibleAfterGetCount === null) return null;
      return state.getCalls >= visibleAfterGetCount ? bytes : null;
    }),
  } as unknown as ReadbackKv & { getCalls: number };
}

function noSleep() {
  return Promise.resolve();
}

describe("verifyKvReadback", () => {
  it("resolves immediately when bytes are visible on the first poll", async () => {
    const kv = makeLaggyKv(1);
    const slept: number[] = [];
    await expect(
      verifyKvReadback(kv, "bundle:abc", {
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    ).resolves.toBeUndefined();
    expect(kv.getCalls).toBe(1);
    expect(slept.length).toBe(1);
  });

  it("retries across the polling schedule until bytes become visible (simulated lag)", async () => {
    const kv = makeLaggyKv(4);
    await expect(verifyKvReadback(kv, "bundle:abc", { sleep: noSleep })).resolves.toBeUndefined();
    expect(kv.getCalls).toBe(4);
  });

  it("throws a descriptive timeout error when bytes never become visible", async () => {
    const kv = makeLaggyKv(null);
    await expect(verifyKvReadback(kv, "bundle:never", { sleep: noSleep })).rejects.toThrow(
      /KV readback verification timed out for key: bundle:never/,
    );
    // All 7 polls should have been exercised
    expect(kv.getCalls).toBe(7);
  });

  it("respects a custom delays schedule (shorter for tests)", async () => {
    const slept: number[] = [];
    const kv = makeLaggyKv(3);
    await verifyKvReadback(kv, "k", {
      delays: [1, 2, 3],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([1, 2, 3]);
  });

  it("stops the loop as soon as bytes are visible (does not poll further)", async () => {
    const kv = makeLaggyKv(2);
    await verifyKvReadback(kv, "k", { sleep: noSleep });
    expect(kv.getCalls).toBe(2);
  });

  it("surfaces upstream kv.get errors rather than swallowing them", async () => {
    const kv: ReadbackKv = {
      get: vi.fn(async () => {
        throw new Error("kv network partition");
      }),
    };
    await expect(verifyKvReadback(kv, "k", { delays: [0], sleep: noSleep })).rejects.toThrow(
      "kv network partition",
    );
  });
});
