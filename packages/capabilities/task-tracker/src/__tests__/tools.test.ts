import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers to avoid resolution failure when importing agent-runtime barrel
class MockDurableObject {}
class MockWorkerEntrypoint {}
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export names
vi.mock("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkerEntrypoint: MockWorkerEntrypoint,
}));

import { TaskStore } from "../task-store.js";

const {
  createTaskCloseTool,
  createTaskCreateTool,
  createTaskDepAddTool,
  createTaskReadyTool,
  createTaskTreeTool,
  createTaskUpdateTool,
} = await import("../tools.js");

import { createMockSqlStore } from "./mock-sql.js";

const SESSION = "test-session";
const OTHER_SESSION = "other-session";

function setup() {
  const store = new TaskStore(createMockSqlStore());
  const broadcast = vi.fn();
  const deps = {
    getStore: () => store,
    getSessionId: () => SESSION,
    getBroadcast: () => broadcast,
  };
  return { store, broadcast, deps };
}

// Helpers to execute tools (they return promises)
async function exec(tool: { execute: Function }, args: Record<string, unknown>) {
  return tool.execute(args, { toolCallId: "test", signal: undefined });
}

function textContent(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

// ============================================================================
// task_create
// ============================================================================

describe("task_create tool", () => {
  it("creates a task and broadcasts event", async () => {
    const { deps, broadcast } = setup();
    const tool = createTaskCreateTool(deps);
    const result = await exec(tool, { title: "Build auth" });

    expect(textContent(result)).toContain("Build auth");
    expect(broadcast).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({ changeType: "created" }),
    );
  });

  it("creates task with parent and deps", async () => {
    const { store, deps, broadcast } = setup();
    const parent = store.create(SESSION, { title: "Epic", type: "epic" });
    const dep = store.create(SESSION, { title: "Dep" });

    const tool = createTaskCreateTool(deps);
    const result = await exec(tool, {
      title: "Child",
      parentId: parent.id,
      dependsOn: [dep.id],
    });

    expect(textContent(result)).toContain("under parent");
    expect(textContent(result)).toContain("1 blocking deps");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("returns error for non-existent parent", async () => {
    const { deps } = setup();
    const tool = createTaskCreateTool(deps);
    const result = await exec(tool, { title: "Child", parentId: "non-existent" });

    expect(textContent(result)).toContain("not found");
  });

  it("returns error when non-owner creates child", async () => {
    const { store, broadcast } = setup();
    const parent = store.create("owner-session", { title: "Parent" });

    const deps = {
      getStore: () => store,
      getSessionId: () => OTHER_SESSION,
      getBroadcast: () => broadcast,
    };
    const tool = createTaskCreateTool(deps);
    const result = await exec(tool, { title: "Child", parentId: parent.id });

    expect(textContent(result)).toContain("does not have write access");
  });
});

// ============================================================================
// task_update
// ============================================================================

describe("task_update tool", () => {
  it("updates status and broadcasts", async () => {
    const { store, deps, broadcast } = setup();
    const task = store.create(SESSION, { title: "Test" });

    const tool = createTaskUpdateTool(deps);
    const result = await exec(tool, { taskId: task.id, status: "in_progress" });

    expect(textContent(result)).toContain("in_progress");
    expect(broadcast).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({ changeType: "updated" }),
    );
  });

  it("returns error for invalid transition", async () => {
    const { store, deps } = setup();
    const task = store.create(SESSION, { title: "Test" });
    store.close(SESSION, task.id, "Done");

    const tool = createTaskUpdateTool(deps);
    const result = await exec(tool, { taskId: task.id, status: "in_progress" });

    expect(textContent(result)).toContain("Invalid status transition");
  });

  it("returns error for non-owner", async () => {
    const { store, broadcast } = setup();
    const task = store.create("owner-session", { title: "Test" });

    const deps = {
      getStore: () => store,
      getSessionId: () => OTHER_SESSION,
      getBroadcast: () => broadcast,
    };
    const tool = createTaskUpdateTool(deps);
    const result = await exec(tool, { taskId: task.id, status: "in_progress" });

    expect(textContent(result)).toContain("does not have write access");
  });
});

// ============================================================================
// task_close
// ============================================================================

describe("task_close tool", () => {
  it("closes task and broadcasts", async () => {
    const { store, deps, broadcast } = setup();
    const task = store.create(SESSION, { title: "Test" });

    const tool = createTaskCloseTool(deps);
    const result = await exec(tool, { taskId: task.id, reason: "Complete" });

    expect(textContent(result)).toContain("Closed");
    expect(textContent(result)).toContain("Complete");
    expect(broadcast).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({ changeType: "closed" }),
    );
  });

  it("returns error for non-existent task", async () => {
    const { deps } = setup();
    const tool = createTaskCloseTool(deps);
    const result = await exec(tool, { taskId: "non-existent", reason: "N/A" });

    expect(textContent(result)).toContain("not found");
  });
});

// ============================================================================
// task_ready
// ============================================================================

describe("task_ready tool", () => {
  it("lists ready tasks", async () => {
    const { store, deps } = setup();
    store.create(SESSION, { title: "Ready 1" });
    store.create(SESSION, { title: "Ready 2" });

    const tool = createTaskReadyTool(deps);
    const result = await exec(tool, {});

    expect(textContent(result)).toContain("2 ready task(s)");
    expect(textContent(result)).toContain("Ready 1");
    expect(textContent(result)).toContain("Ready 2");
  });

  it("returns message when no tasks ready", async () => {
    const { deps } = setup();
    const tool = createTaskReadyTool(deps);
    const result = await exec(tool, {});

    expect(textContent(result)).toContain("No tasks are currently ready");
  });

  it("excludes blocked tasks", async () => {
    const { store, deps } = setup();
    const a = store.create(SESSION, { title: "Blocker" });
    store.create(SESSION, { title: "Blocked", dependsOn: [a.id] });

    const tool = createTaskReadyTool(deps);
    const result = await exec(tool, {});

    expect(textContent(result)).toContain("1 ready task(s)");
    expect(textContent(result)).toContain("Blocker");
    expect(textContent(result)).not.toContain("Blocked");
  });
});

// ============================================================================
// task_tree
// ============================================================================

describe("task_tree tool", () => {
  it("shows tree hierarchy", async () => {
    const { store, deps } = setup();
    const epic = store.create(SESSION, { title: "Epic", type: "epic" });
    store.create(SESSION, { title: "Child 1", parentId: epic.id });
    store.create(SESSION, { title: "Child 2", parentId: epic.id });

    const tool = createTaskTreeTool(deps);
    const result = await exec(tool, { rootId: epic.id });

    expect(textContent(result)).toContain("Epic");
    expect(textContent(result)).toContain("Child 1");
    expect(textContent(result)).toContain("Child 2");
  });

  it("returns error for non-existent root", async () => {
    const { deps } = setup();
    const tool = createTaskTreeTool(deps);
    const result = await exec(tool, { rootId: "non-existent" });

    expect(textContent(result)).toContain("not found");
  });
});

// ============================================================================
// task_dep_add
// ============================================================================

describe("task_dep_add tool", () => {
  it("adds blocking dep and broadcasts", async () => {
    const { store, deps, broadcast } = setup();
    const a = store.create(SESSION, { title: "A" });
    const b = store.create(SESSION, { title: "B" });

    const tool = createTaskDepAddTool(deps);
    const result = await exec(tool, {
      sourceId: b.id,
      targetId: a.id,
      depType: "blocks",
    });

    expect(textContent(result)).toContain("blocks");
    expect(broadcast).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({ changeType: "dep_added" }),
    );
  });

  it("returns error for cycle", async () => {
    const { store, deps } = setup();
    const a = store.create(SESSION, { title: "A" });
    const b = store.create(SESSION, { title: "B" });
    store.addDep(SESSION, b.id, a.id, "blocks");

    const tool = createTaskDepAddTool(deps);
    const result = await exec(tool, {
      sourceId: a.id,
      targetId: b.id,
      depType: "blocks",
    });

    expect(textContent(result)).toContain("cycle");
  });

  it("returns error for non-owner", async () => {
    const { store, broadcast } = setup();
    const a = store.create("owner-session", { title: "A" });
    const b = store.create("owner-session", { title: "B" });

    const deps = {
      getStore: () => store,
      getSessionId: () => OTHER_SESSION,
      getBroadcast: () => broadcast,
    };
    const tool = createTaskDepAddTool(deps);
    const result = await exec(tool, {
      sourceId: b.id,
      targetId: a.id,
      depType: "blocks",
    });

    expect(textContent(result)).toContain("does not have write access");
  });
});
