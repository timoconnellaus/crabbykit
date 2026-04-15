import { describe, expect, it } from "vitest";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import { ScheduleStore } from "../schedule-store.js";

function createStore(): ScheduleStore {
  return new ScheduleStore(createMockSqlStore());
}

describe("ScheduleStore", () => {
  describe("create", () => {
    it("creates a prompt schedule with defaults", () => {
      const store = createStore();
      const schedule = store.create({
        name: "Hourly check",
        cron: "0 * * * *",
        handlerType: "prompt",
        prompt: "Check for updates.",
      });

      expect(schedule.id).toBeDefined();
      expect(schedule.name).toBe("Hourly check");
      expect(schedule.cron).toBe("0 * * * *");
      expect(schedule.enabled).toBe(true);
      expect(schedule.handlerType).toBe("prompt");
      expect(schedule.prompt).toBe("Check for updates.");
      expect(schedule.sessionPrefix).toBe("Hourly check");
      expect(schedule.ownerId).toBeNull();
      expect(schedule.status).toBe("idle");
      expect(schedule.retention).toBe(10);
      expect(schedule.createdAt).toBeDefined();
    });

    it("creates a callback schedule with custom options", () => {
      const store = createStore();
      const schedule = store.create({
        id: "custom-id",
        name: "Cleanup",
        cron: "0 0 * * *",
        handlerType: "callback",
        ownerId: "my-capability",
        enabled: false,
        retention: 5,
      });

      expect(schedule.id).toBe("custom-id");
      expect(schedule.handlerType).toBe("callback");
      expect(schedule.ownerId).toBe("my-capability");
      expect(schedule.enabled).toBe(false);
      expect(schedule.retention).toBe(5);
    });

    it("stores nextFireAt when provided", () => {
      const store = createStore();
      const fireTime = new Date("2026-04-01T12:00:00Z").toISOString();
      const schedule = store.create({
        name: "Test",
        cron: "0 * * * *",
        handlerType: "prompt",
        prompt: "Go",
        nextFireAt: fireTime,
      });

      expect(schedule.nextFireAt).toBe(fireTime);
    });
  });

  describe("get", () => {
    it("returns a schedule by id", () => {
      const store = createStore();
      const created = store.create({
        id: "sched-1",
        name: "Test",
        cron: "*/30 * * * *",
        handlerType: "prompt",
        prompt: "hello",
      });

      const fetched = store.get("sched-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("Test");
    });

    it("returns null for missing id", () => {
      const store = createStore();
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all schedules", () => {
      const store = createStore();
      store.create({ name: "A", cron: "* * * * *", handlerType: "prompt", prompt: "a" });
      store.create({ name: "B", cron: "* * * * *", handlerType: "callback" });

      const all = store.list();
      expect(all).toHaveLength(2);
    });

    it("returns empty array when no schedules", () => {
      const store = createStore();
      expect(store.list()).toEqual([]);
    });
  });

  describe("update", () => {
    it("updates specified fields", () => {
      const store = createStore();
      store.create({
        id: "u1",
        name: "Original",
        cron: "*/30 * * * *",
        handlerType: "prompt",
        prompt: "original prompt",
      });

      const updated = store.update("u1", {
        name: "Updated",
        cron: "*/15 * * * *",
        prompt: "new prompt",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated");
      expect(updated!.cron).toBe("*/15 * * * *");
      expect(updated!.prompt).toBe("new prompt");
    });

    it("returns null for missing id", () => {
      const store = createStore();
      expect(store.update("nonexistent", { name: "x" })).toBeNull();
    });

    it("updates enabled flag", () => {
      const store = createStore();
      store.create({
        id: "e1",
        name: "Test",
        cron: "* * * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      store.update("e1", { enabled: false });
      expect(store.get("e1")!.enabled).toBe(false);

      store.update("e1", { enabled: true });
      expect(store.get("e1")!.enabled).toBe(true);
    });

    it("updates lastError field", () => {
      const store = createStore();
      store.create({
        id: "err1",
        name: "Error test",
        cron: "* * * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      store.update("err1", { lastError: "Connection timeout" });
      expect(store.get("err1")!.lastError).toBe("Connection timeout");

      // Clear error
      store.update("err1", { lastError: null });
      expect(store.get("err1")!.lastError).toBeNull();
    });

    it("updates retention field", () => {
      const store = createStore();
      store.create({
        id: "ret1",
        name: "Retention test",
        cron: "0 * * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      expect(store.get("ret1")!.retention).toBe(10); // default
      store.update("ret1", { retention: 25 });
      expect(store.get("ret1")!.retention).toBe(25);
    });

    it("updates timezone field", () => {
      const store = createStore();
      store.create({
        id: "tz1",
        name: "TZ test",
        cron: "0 9 * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      store.update("tz1", { timezone: "America/New_York" });
      expect(store.get("tz1")!.timezone).toBe("America/New_York");
    });

    it("updates sessionPrefix field", () => {
      const store = createStore();
      store.create({
        id: "sp1",
        name: "Prefix test",
        cron: "0 * * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      store.update("sp1", { sessionPrefix: "custom-prefix" });
      expect(store.get("sp1")!.sessionPrefix).toBe("custom-prefix");
    });
  });

  describe("delete", () => {
    it("removes a schedule", () => {
      const store = createStore();
      store.create({
        id: "d1",
        name: "ToDelete",
        cron: "* * * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      store.delete("d1");
      expect(store.get("d1")).toBeNull();
    });
  });

  describe("markRunning / markIdle / markFailed", () => {
    it("transitions status correctly", () => {
      const store = createStore();
      store.create({
        id: "s1",
        name: "Status test",
        cron: "* * * * *",
        handlerType: "prompt",
        prompt: "x",
      });

      expect(store.get("s1")!.status).toBe("idle");

      store.markRunning("s1");
      const running = store.get("s1")!;
      expect(running.status).toBe("running");
      expect(running.lastFiredAt).toBeDefined();

      store.markIdle("s1");
      expect(store.get("s1")!.status).toBe("idle");
      expect(store.get("s1")!.lastError).toBeNull();

      store.markFailed("s1", "Something went wrong");
      const failed = store.get("s1")!;
      expect(failed.status).toBe("failed");
      expect(failed.lastError).toBe("Something went wrong");
    });
  });

  describe("timer schedules", () => {
    it("creates a timer schedule with handlerType timer", () => {
      const store = createStore();
      const firesAt = new Date(Date.now() + 60_000).toISOString();
      const schedule = store.create({
        id: "timer-1",
        name: "auto-de-elevate",
        cron: "0 0 1 1 *",
        handlerType: "timer",
        nextFireAt: firesAt,
      });

      expect(schedule.handlerType).toBe("timer");
      expect(schedule.nextFireAt).toBe(firesAt);
    });

    it("timer schedule shows up in getDueSchedules when due", () => {
      const store = createStore();
      const pastTime = new Date(Date.now() - 1000).toISOString();
      store.create({
        id: "timer-due",
        name: "due timer",
        cron: "0 0 1 1 *",
        handlerType: "timer",
        nextFireAt: pastTime,
      });

      const due = store.getDueSchedules(new Date());
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe("timer-due");
      expect(due[0].handlerType).toBe("timer");
    });

    it("timer schedule can be deleted after firing", () => {
      const store = createStore();
      store.create({
        id: "timer-delete",
        name: "one-shot",
        cron: "0 0 1 1 *",
        handlerType: "timer",
        nextFireAt: new Date(Date.now() - 1000).toISOString(),
      });

      expect(store.get("timer-delete")).not.toBeNull();
      store.delete("timer-delete");
      expect(store.get("timer-delete")).toBeNull();
    });
  });
});
