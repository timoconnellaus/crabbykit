import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers
class MockDurableObject {}
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export name
vi.mock("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { taskTracker, createTaskStore } = await import("../capability.js");

import { createMockSqlStore } from "./mock-sql.js";

describe("taskTracker capability", () => {
  it("has correct id and metadata", () => {
    const cap = taskTracker({ sql: createMockSqlStore() });

    expect(cap.id).toBe("task-tracker");
    expect(cap.name).toBe("Task Tracker");
    expect(cap.description).toBeTruthy();
  });

  it("provides 6 tools", () => {
    const cap = taskTracker({ sql: createMockSqlStore() });
    const context = {
      agentId: "agent-1",
      sessionId: "session-1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: vi.fn(),
      broadcastToAll: vi.fn(),
      broadcastState: vi.fn(),
      requestFromClient: vi.fn(),
      storage: createNoopStorage(),
      schedules: {} as any,
    };

    const tools = cap.tools!(context);
    expect(tools).toHaveLength(6);

    const names = tools.map((t) => t.name);
    expect(names).toContain("task_create");
    expect(names).toContain("task_update");
    expect(names).toContain("task_close");
    expect(names).toContain("task_ready");
    expect(names).toContain("task_tree");
    expect(names).toContain("task_dep_add");
  });

  it("provides prompt sections", () => {
    const cap = taskTracker({ sql: createMockSqlStore() });
    const context = {
      agentId: "agent-1",
      sessionId: "session-1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: vi.fn(),
      broadcastToAll: vi.fn(),
      broadcastState: vi.fn(),
      requestFromClient: vi.fn(),
      storage: createNoopStorage(),
      schedules: {} as any,
    };

    const sections = cap.promptSections!(context);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("task tracker");
  });

  it("accepts authChecker option", () => {
    const authChecker = vi.fn().mockReturnValue(true);
    const cap = taskTracker({
      sql: createMockSqlStore(),
      authChecker,
    });

    expect(cap.id).toBe("task-tracker");
  });
});

describe("createTaskStore", () => {
  it("creates a TaskStore instance", () => {
    const store = createTaskStore(createMockSqlStore());
    expect(store).toBeDefined();

    const task = store.create("session-1", { title: "Test" });
    expect(task.title).toBe("Test");
  });
});
