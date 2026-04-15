/**
 * KV readback verification helper.
 *
 * After `kv.put(key, bytes)`, eventual consistency means a subsequent
 * `kv.get(key)` can return null until bytes propagate. verifyKvReadback
 * polls with exponential backoff until the bytes are visible or the
 * schedule is exhausted.
 *
 * Exported as a standalone helper so it can be unit-tested against a
 * fake KV whose get visibility is controllable.
 */

import { READBACK_DELAYS } from "./types.js";

export interface ReadbackKv {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
}

export interface VerifyReadbackOptions {
  /** Override the polling schedule (mainly for tests). */
  delays?: readonly number[];
  /** Override the sleep implementation (mainly for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `kv.get(key)` on the given schedule until it returns non-null.
 * Throws with a clear message if the bytes are not visible within the
 * full schedule.
 */
export async function verifyKvReadback(
  kv: ReadbackKv,
  key: string,
  options: VerifyReadbackOptions = {},
): Promise<void> {
  const delays = options.delays ?? READBACK_DELAYS;
  const sleep = options.sleep ?? realSleep;

  for (const delay of delays) {
    await sleep(delay);
    const value = await kv.get(key, "arrayBuffer");
    if (value !== null) {
      return;
    }
  }
  throw new Error(`KV readback verification timed out for key: ${key}`);
}
