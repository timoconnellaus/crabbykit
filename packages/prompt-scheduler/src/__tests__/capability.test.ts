import { describe, expect, it, vi } from "vitest";
import type { AgentContext, Schedule, ScheduleManager } from "@claw-for-cloudflare/agent-runtime";
import { promptScheduler } from "../capability.js";

/** Creates a mock Schedule object with sensible defaults. */
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sched-test-id",
    name: "Test Schedule",
    cron: "0 9 * * *",
    enabled: true,
    handlerType: "prompt",
    prompt: "Run daily task",
    sessionPrefix: null,
    ownerId: null,
    nextFireAt: "2026-04-02T09:00:00.000Z",
    lastFiredAt: null,
    timezone: null,
    expiresAt: null,
    status: "idle",
    lastError: null,
    retention: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Creates a mock ScheduleManager. */
function mockScheduleManager(overrides: Partial<ScheduleManager> = {}): ScheduleManager {
  return {
    create: vi.fn().mockResolvedValue(makeSchedule()),
    update: vi.fn().mockResolvedValue(makeSchedule()),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    setTimer: vi.fn().mockResolvedValue(undefined),
    cancelTimer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Creates a mock AgentContext with a given ScheduleManager. */
function mockContext(schedules?: ScheduleManager): AgentContext {
  return {
    agentId: "test-agent",
    sessionId: "s1",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    schedules: schedules ?? mockScheduleManager(),
  };
}

describe("promptScheduler", () => {
  it("returns a valid Capability with correct shape", () => {
    const cap = promptScheduler();

    expect(cap.id).toBe("prompt-scheduler");
    expect(cap.name).toBe("Prompt Scheduler");
    expect(cap.description).toBeTruthy();
    expect(cap.configNamespaces).toBeInstanceOf(Function);
    expect(cap.promptSections).toBeInstanceOf(Function);
  });

  it("has no tools or hooks", () => {
    const cap = promptScheduler();
    expect(cap.tools).toBeUndefined();
    expect(cap.hooks).toBeUndefined();
  });

  it("returns prompt sections with scheduling instructions", () => {
    const cap = promptScheduler();
    const sections = cap.promptSections!({} as AgentContext);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("config_set");
    expect(sections[0]).toContain("config_get");
    expect(sections[0]).toContain("cron");
    expect(sections[0]).toContain("maxDuration");
  });
});

describe("configNamespaces", () => {
  it("registers two namespaces: schedules and schedule:{id}", () => {
    const cap = promptScheduler();
    const namespaces = cap.configNamespaces!(mockContext());

    expect(namespaces).toHaveLength(2);
    expect(namespaces[0].id).toBe("schedules");
    expect(namespaces[1].id).toBe("schedule:{id}");
  });

  describe("schedules namespace", () => {
    it("get returns list of all schedules", async () => {
      const scheduleList = [makeSchedule(), makeSchedule({ id: "sched-2", name: "Second" })];
      const mgr = mockScheduleManager({ list: vi.fn().mockReturnValue(scheduleList) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      const result = await ns.get("schedules");
      expect(result).toEqual(scheduleList);
      expect(mgr.list).toHaveBeenCalled();
    });

    it("set creates a schedule with valid cron", async () => {
      const created = makeSchedule({ id: "sched-new", name: "Daily" });
      const mgr = mockScheduleManager({ create: vi.fn().mockResolvedValue(created) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      const result = await ns.set("schedules", {
        name: "Daily",
        cron: "0 9 * * *",
        prompt: "Do the thing",
      });

      expect(mgr.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Daily",
          cron: "0 9 * * *",
          prompt: "Do the thing",
        }),
      );
      expect(result).toContain("Daily");
      expect(result).toContain("created");
    });

    it("set creates a schedule with interval shorthand", async () => {
      const created = makeSchedule({ name: "Every 30m" });
      const mgr = mockScheduleManager({ create: vi.fn().mockResolvedValue(created) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      await ns.set("schedules", {
        name: "Every 30m",
        cron: "30m",
        prompt: "Check status",
      });

      expect(mgr.create).toHaveBeenCalledWith(
        expect.objectContaining({ cron: "30m" }),
      );
    });

    it("set passes optional fields (timezone, maxDuration)", async () => {
      const created = makeSchedule({ name: "With Options" });
      const mgr = mockScheduleManager({ create: vi.fn().mockResolvedValue(created) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      await ns.set("schedules", {
        name: "With Options",
        cron: "0 9 * * MON-FRI",
        prompt: "Weekday check",
        timezone: "Australia/Sydney",
        maxDuration: "3d",
      });

      expect(mgr.create).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: "Australia/Sydney",
          maxDuration: "3d",
        }),
      );
    });

    it("set generates a unique schedule id", async () => {
      const mgr = mockScheduleManager({
        create: vi.fn().mockImplementation((config) => Promise.resolve(makeSchedule(config))),
      });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      await ns.set("schedules", {
        name: "Test",
        cron: "0 9 * * *",
        prompt: "Test",
      });

      const call = (mgr.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.id).toMatch(/^sched-/);
    });

    it("set includes nextFireAt in response when available", async () => {
      const created = makeSchedule({ nextFireAt: "2026-04-02T09:00:00.000Z" });
      const mgr = mockScheduleManager({ create: vi.fn().mockResolvedValue(created) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      const result = await ns.set("schedules", {
        name: "Test",
        cron: "0 9 * * *",
        prompt: "Test",
      });

      expect(result).toContain("2026-04-02T09:00:00.000Z");
    });

    it("set shows 'pending' when nextFireAt is null", async () => {
      const created = makeSchedule({ nextFireAt: null });
      const mgr = mockScheduleManager({ create: vi.fn().mockResolvedValue(created) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      const result = await ns.set("schedules", {
        name: "Test",
        cron: "0 9 * * *",
        prompt: "Test",
      });

      expect(result).toContain("pending");
    });

    it("set throws on invalid cron expression", async () => {
      const mgr = mockScheduleManager();
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      await expect(
        ns.set("schedules", {
          name: "Bad Cron",
          cron: "invalid-cron",
          prompt: "Test",
        }),
      ).rejects.toThrow("Invalid cron expression");

      expect(mgr.create).not.toHaveBeenCalled();
    });

    it("set throws on malformed cron with wrong field count", async () => {
      const mgr = mockScheduleManager();
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[0];

      await expect(
        ns.set("schedules", {
          name: "Bad Cron",
          cron: "* * *", // Only 3 fields
          prompt: "Test",
        }),
      ).rejects.toThrow("Invalid cron expression");
    });
  });

  describe("schedule:{id} namespace", () => {
    it("has a pattern that matches schedule:* format", () => {
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext())[1];

      expect(ns.pattern).toBeDefined();
      expect(ns.pattern!.test("schedule:abc123")).toBe(true);
      expect(ns.pattern!.test("schedule:sched-some-uuid")).toBe(true);
      expect(ns.pattern!.test("schedules")).toBe(false);
      expect(ns.pattern!.test("other:abc")).toBe(false);
    });

    it("get returns a specific schedule by id", async () => {
      const schedule = makeSchedule({ id: "my-id" });
      const mgr = mockScheduleManager({ get: vi.fn().mockReturnValue(schedule) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      const result = await ns.get("schedule:my-id");
      expect(mgr.get).toHaveBeenCalledWith("my-id");
      expect(result).toEqual(schedule);
    });

    it("get returns null for non-matching namespace format", async () => {
      const mgr = mockScheduleManager();
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      // Directly call with a non-matching namespace (bypassing pattern check)
      const result = await ns.get("notschedule");
      expect(result).toBeNull();
    });

    it("set with null deletes the schedule", async () => {
      const existing = makeSchedule({ id: "del-id", name: "To Delete" });
      const mgr = mockScheduleManager({ get: vi.fn().mockReturnValue(existing) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      const result = await ns.set("schedule:del-id", null);
      expect(mgr.delete).toHaveBeenCalledWith("del-id");
      expect(result).toContain("To Delete");
      expect(result).toContain("deleted");
    });

    it("set with null throws if schedule not found", async () => {
      const mgr = mockScheduleManager({ get: vi.fn().mockReturnValue(null) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await expect(ns.set("schedule:nonexistent", null)).rejects.toThrow("Schedule not found");
    });

    it("set with object updates the schedule", async () => {
      const updated = makeSchedule({ id: "upd-id", name: "Updated Name" });
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(updated) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      const result = await ns.set("schedule:upd-id", {
        name: "Updated Name",
        cron: "0 10 * * *",
      });

      expect(mgr.update).toHaveBeenCalledWith("upd-id", {
        name: "Updated Name",
        cron: "0 10 * * *",
      });
      expect(result).toContain("Updated Name");
      expect(result).toContain("updated");
    });

    it("set updates with partial fields (only name)", async () => {
      const updated = makeSchedule({ name: "New Name" });
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(updated) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await ns.set("schedule:some-id", { name: "New Name" });

      expect(mgr.update).toHaveBeenCalledWith("some-id", { name: "New Name" });
    });

    it("set updates with partial fields (only enabled)", async () => {
      const updated = makeSchedule({ enabled: false });
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(updated) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await ns.set("schedule:some-id", { enabled: false });

      expect(mgr.update).toHaveBeenCalledWith("some-id", { enabled: false });
    });

    it("set update throws on invalid cron", async () => {
      const mgr = mockScheduleManager();
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await expect(
        ns.set("schedule:some-id", { cron: "not-valid" }),
      ).rejects.toThrow("Invalid cron expression");

      expect(mgr.update).not.toHaveBeenCalled();
    });

    it("set update throws if schedule not found", async () => {
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(null) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await expect(
        ns.set("schedule:missing", { name: "New Name" }),
      ).rejects.toThrow("Schedule not found");
    });

    it("set throws on non-matching namespace format", async () => {
      const mgr = mockScheduleManager();
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await expect(ns.set("notschedule", { name: "X" })).rejects.toThrow(
        "Invalid schedule namespace format",
      );
    });

    it("set update includes nextFireAt in response", async () => {
      const updated = makeSchedule({ nextFireAt: "2026-05-01T10:00:00.000Z" });
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(updated) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      const result = await ns.set("schedule:some-id", { cron: "0 10 * * *" });
      expect(result).toContain("2026-05-01T10:00:00.000Z");
    });

    it("set update shows 'pending' when nextFireAt is null", async () => {
      const updated = makeSchedule({ nextFireAt: null });
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(updated) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      const result = await ns.set("schedule:some-id", { name: "X" });
      expect(result).toContain("pending");
    });

    it("set update ignores non-string/boolean fields in updates", async () => {
      const updated = makeSchedule();
      const mgr = mockScheduleManager({ update: vi.fn().mockResolvedValue(updated) });
      const cap = promptScheduler();
      const ns = cap.configNamespaces!(mockContext(mgr))[1];

      await ns.set("schedule:some-id", {
        name: 42, // Not a string — should be ignored
        enabled: "yes", // Not a boolean — should be ignored
        prompt: "Valid prompt",
      });

      expect(mgr.update).toHaveBeenCalledWith("some-id", {
        prompt: "Valid prompt",
      });
    });
  });
});
