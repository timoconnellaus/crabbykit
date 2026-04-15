import { describe, expect, it, vi } from "vitest";
import { createCfScheduler } from "../cloudflare-scheduler.js";

function mockStorage() {
  let currentAlarm: number | null = null;
  return {
    setAlarm: vi.fn(async (time: number) => {
      currentAlarm = time;
    }),
    deleteAlarm: vi.fn(async () => {
      currentAlarm = null;
    }),
    getAlarm: vi.fn(async () => currentAlarm),
  } as unknown as DurableObjectStorage;
}

describe("createCfScheduler", () => {
  it("setWakeTime calls storage.setAlarm with epoch ms", async () => {
    const storage = mockStorage();
    const scheduler = createCfScheduler(storage);
    const time = new Date("2025-06-01T12:00:00Z");

    await scheduler.setWakeTime(time);

    expect(storage.setAlarm).toHaveBeenCalledWith(time.getTime());
  });

  it("cancelWakeTime calls storage.deleteAlarm", async () => {
    const storage = mockStorage();
    const scheduler = createCfScheduler(storage);

    await scheduler.cancelWakeTime();

    expect(storage.deleteAlarm).toHaveBeenCalled();
  });

  it("getWakeTime returns Date when alarm is set", async () => {
    const storage = mockStorage();
    const scheduler = createCfScheduler(storage);
    const time = new Date("2025-06-01T12:00:00Z");

    await scheduler.setWakeTime(time);
    const result = await scheduler.getWakeTime();

    expect(result).toBeInstanceOf(Date);
    expect(result).toEqual(time);
  });

  it("getWakeTime returns null when no alarm is set", async () => {
    const storage = mockStorage();
    const scheduler = createCfScheduler(storage);

    const result = await scheduler.getWakeTime();

    expect(result).toBeNull();
  });

  it("setWakeTime replaces existing wake time", async () => {
    const storage = mockStorage();
    const scheduler = createCfScheduler(storage);
    const t1 = new Date("2025-06-01T12:00:00Z");
    const t2 = new Date("2025-06-02T08:00:00Z");

    await scheduler.setWakeTime(t1);
    await scheduler.setWakeTime(t2);

    const result = await scheduler.getWakeTime();
    expect(result).toEqual(t2);
  });

  it("cancelWakeTime then getWakeTime returns null", async () => {
    const storage = mockStorage();
    const scheduler = createCfScheduler(storage);

    await scheduler.setWakeTime(new Date("2025-06-01T12:00:00Z"));
    await scheduler.cancelWakeTime();

    const result = await scheduler.getWakeTime();
    expect(result).toBeNull();
  });
});
