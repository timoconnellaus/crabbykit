import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  TaskAuthError,
  TaskCycleError,
  TaskNotFoundError,
  TaskStore,
} from "../task-store.js";
import { createMockSqlStore } from "./mock-sql.js";

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const SUBAGENT_SESSION = "subagent-of-a";

function createStore(authChecker?: (caller: string, owner: string) => boolean): TaskStore {
  return new TaskStore(createMockSqlStore(), authChecker);
}

// ============================================================================
// CRUD Operations
// ============================================================================

describe("TaskStore CRUD", () => {
  it("creates a root task with defaults", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Build auth" });

    expect(task.id).toBeTruthy();
    expect(task.title).toBe("Build auth");
    expect(task.status).toBe("open");
    expect(task.priority).toBe(2);
    expect(task.type).toBe("task");
    expect(task.ownerSession).toBe(SESSION_A);
    expect(task.parentId).toBeNull();
    expect(task.closedAt).toBeNull();
  });

  it("creates a task with all fields", () => {
    const store = createStore();
    const task = store.create(SESSION_A, {
      title: "Epic",
      description: "Build everything",
      acceptance: "All tests pass",
      type: "epic",
      priority: 0,
    });

    expect(task.type).toBe("epic");
    expect(task.priority).toBe(0);
    expect(task.description).toBe("Build everything");
    expect(task.acceptance).toBe("All tests pass");
  });

  it("creates a child task under a parent", () => {
    const store = createStore();
    const parent = store.create(SESSION_A, { title: "Epic", type: "epic" });
    const child = store.create(SESSION_A, { title: "Task 1", parentId: parent.id });

    expect(child.parentId).toBe(parent.id);

    // Auto-creates parent-child dep
    const deps = store.getDeps(child.id);
    expect(deps).toHaveLength(1);
    expect(deps[0].depType).toBe("parent-child");
    expect(deps[0].targetId).toBe(parent.id);
  });

  it("gets a task by ID", () => {
    const store = createStore();
    const created = store.create(SESSION_A, { title: "Test" });
    const fetched = store.get(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("returns null for non-existent task", () => {
    const store = createStore();
    expect(store.get("non-existent")).toBeNull();
  });

  it("lists all tasks", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "Task A" });
    store.create(SESSION_B, { title: "Task B" });

    const all = store.list();
    expect(all).toHaveLength(2);
  });

  it("lists tasks filtered by owner", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "A1" });
    store.create(SESSION_A, { title: "A2" });
    store.create(SESSION_B, { title: "B1" });

    expect(store.list(SESSION_A)).toHaveLength(2);
    expect(store.list(SESSION_B)).toHaveLength(1);
  });

  it("updates task status", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    const updated = store.update(SESSION_A, task.id, { status: "in_progress" });

    expect(updated.status).toBe("in_progress");
  });

  it("updates task priority and description", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    const updated = store.update(SESSION_A, task.id, {
      priority: 0,
      description: "Updated desc",
    });

    expect(updated.priority).toBe(0);
    expect(updated.description).toBe("Updated desc");
  });

  it("closes a task with reason", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    const closed = store.close(SESSION_A, task.id, "Done");

    expect(closed.status).toBe("closed");
    expect(closed.closeReason).toBe("Done");
    expect(closed.closedAt).not.toBeNull();
  });
});

// ============================================================================
// Status Transitions
// ============================================================================

describe("TaskStore status transitions", () => {
  it("allows open → in_progress", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    const updated = store.update(SESSION_A, task.id, { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
  });

  it("allows open → closed", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    const closed = store.close(SESSION_A, task.id, "Skip");
    expect(closed.status).toBe("closed");
  });

  it("allows in_progress → blocked", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    store.update(SESSION_A, task.id, { status: "in_progress" });
    const blocked = store.update(SESSION_A, task.id, { status: "blocked" });
    expect(blocked.status).toBe("blocked");
  });

  it("allows blocked → in_progress", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    store.update(SESSION_A, task.id, { status: "in_progress" });
    store.update(SESSION_A, task.id, { status: "blocked" });
    const unblocked = store.update(SESSION_A, task.id, { status: "in_progress" });
    expect(unblocked.status).toBe("in_progress");
  });

  it("allows blocked → closed", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    store.update(SESSION_A, task.id, { status: "in_progress" });
    store.update(SESSION_A, task.id, { status: "blocked" });
    const closed = store.close(SESSION_A, task.id, "Abandoned");
    expect(closed.status).toBe("closed");
  });

  it("rejects closed → in_progress", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    store.close(SESSION_A, task.id, "Done");

    expect(() => store.update(SESSION_A, task.id, { status: "in_progress" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects closed → open", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });
    store.close(SESSION_A, task.id, "Done");

    expect(() => store.update(SESSION_A, task.id, { status: "open" })).toThrow(
      InvalidTransitionError,
    );
  });
});

// ============================================================================
// Dependency Graph
// ============================================================================

describe("TaskStore dependencies", () => {
  it("adds a blocking dependency", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });

    const dep = store.addDep(SESSION_A, b.id, a.id, "blocks");
    expect(dep.sourceId).toBe(b.id);
    expect(dep.targetId).toBe(a.id);
    expect(dep.depType).toBe("blocks");
  });

  it("adds a non-blocking related dependency", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });

    const dep = store.addDep(SESSION_A, a.id, b.id, "related");
    expect(dep.depType).toBe("related");
  });

  it("removes a dependency", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });

    store.addDep(SESSION_A, b.id, a.id, "blocks");
    expect(store.getDeps(b.id)).toHaveLength(1);

    store.removeDep(SESSION_A, b.id, a.id);
    expect(store.getDeps(b.id)).toHaveLength(0);
  });

  it("rejects self-dependency", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });

    expect(() => store.addDep(SESSION_A, a.id, a.id, "blocks")).toThrow(TaskCycleError);
  });

  it("rejects direct cycle", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });

    store.addDep(SESSION_A, b.id, a.id, "blocks"); // B depends on A
    expect(() => store.addDep(SESSION_A, a.id, b.id, "blocks")).toThrow(TaskCycleError);
  });

  it("rejects transitive cycle", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });
    const c = store.create(SESSION_A, { title: "C" });

    store.addDep(SESSION_A, b.id, a.id, "blocks"); // B depends on A
    store.addDep(SESSION_A, c.id, b.id, "blocks"); // C depends on B

    // A depends on C would create A→C→B→A cycle
    expect(() => store.addDep(SESSION_A, a.id, c.id, "blocks")).toThrow(TaskCycleError);
  });

  it("allows cycles in non-blocking deps", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });

    store.addDep(SESSION_A, a.id, b.id, "related");
    // This should not throw because "related" is non-blocking
    const dep = store.addDep(SESSION_A, b.id, a.id, "related");
    expect(dep.depType).toBe("related");
  });

  it("creates task with dependsOn atomically", () => {
    const store = createStore();
    const dep1 = store.create(SESSION_A, { title: "Dep 1" });
    const dep2 = store.create(SESSION_A, { title: "Dep 2" });
    const task = store.create(SESSION_A, {
      title: "Blocked task",
      dependsOn: [dep1.id, dep2.id],
    });

    const deps = store.getDeps(task.id);
    const blockingDeps = deps.filter((d) => d.depType === "blocks");
    expect(blockingDeps).toHaveLength(2);
  });

  it("throws on dep to non-existent task", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });

    expect(() => store.addDep(SESSION_A, a.id, "non-existent", "blocks")).toThrow(
      TaskNotFoundError,
    );
  });
});

// ============================================================================
// Ready Work Computation
// ============================================================================

describe("TaskStore ready work", () => {
  it("returns open tasks with no deps", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "Ready" });
    store.create(SESSION_A, { title: "Also ready" });

    const ready = store.ready();
    expect(ready).toHaveLength(2);
  });

  it("excludes tasks with unclosed blocking deps", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "Blocker" });
    const b = store.create(SESSION_A, { title: "Blocked" });
    store.addDep(SESSION_A, b.id, a.id, "blocks");

    const ready = store.ready();
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(a.id);
  });

  it("includes task when all blocking deps are closed", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "Blocker" });
    const b = store.create(SESSION_A, { title: "Blocked" });
    store.addDep(SESSION_A, b.id, a.id, "blocks");

    store.close(SESSION_A, a.id, "Done");
    const ready = store.ready();
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(b.id);
  });

  it("waits for all blockers before becoming ready", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "Blocker A" });
    const b = store.create(SESSION_A, { title: "Blocker B" });
    const c = store.create(SESSION_A, { title: "Blocked" });
    store.addDep(SESSION_A, c.id, a.id, "blocks");
    store.addDep(SESSION_A, c.id, b.id, "blocks");

    store.close(SESSION_A, a.id, "Done");
    expect(store.ready().map((t) => t.id)).not.toContain(c.id);

    store.close(SESSION_A, b.id, "Done");
    expect(store.ready().map((t) => t.id)).toContain(c.id);
  });

  it("ignores non-blocking deps for ready computation", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "Related" });
    const b = store.create(SESSION_A, { title: "Task" });
    store.addDep(SESSION_A, b.id, a.id, "related");

    // B should be ready even though A is open (related is non-blocking)
    const ready = store.ready();
    expect(ready).toHaveLength(2);
  });

  it("excludes non-open tasks", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "Open" });
    const ip = store.create(SESSION_A, { title: "In progress" });
    store.update(SESSION_A, ip.id, { status: "in_progress" });

    const ready = store.ready();
    expect(ready).toHaveLength(1);
    expect(ready[0].title).toBe("Open");
  });

  it("filters ready by owner session", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "A's task" });
    store.create(SESSION_B, { title: "B's task" });

    const readyA = store.ready(SESSION_A);
    expect(readyA).toHaveLength(1);
    expect(readyA[0].title).toBe("A's task");
  });

  it("orders by priority then created_at", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "Low prio", priority: 4 });
    store.create(SESSION_A, { title: "High prio", priority: 0 });

    const ready = store.ready();
    expect(ready[0].title).toBe("High prio");
    expect(ready[1].title).toBe("Low prio");
  });
});

// ============================================================================
// Tree Queries
// ============================================================================

describe("TaskStore tree", () => {
  it("returns null for non-existent root", () => {
    const store = createStore();
    expect(store.tree("non-existent")).toBeNull();
  });

  it("returns a leaf task as a tree node with no children", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Leaf" });
    const tree = store.tree(task.id);

    expect(tree).not.toBeNull();
    expect(tree!.id).toBe(task.id);
    expect(tree!.depth).toBe(0);
    expect(tree!.children).toHaveLength(0);
  });

  it("builds a two-level tree", () => {
    const store = createStore();
    const epic = store.create(SESSION_A, { title: "Epic", type: "epic" });
    store.create(SESSION_A, { title: "Child 1", parentId: epic.id });
    store.create(SESSION_A, { title: "Child 2", parentId: epic.id });

    const tree = store.tree(epic.id);
    expect(tree!.children).toHaveLength(2);
    expect(tree!.children[0].depth).toBe(1);
  });

  it("builds a three-level tree", () => {
    const store = createStore();
    const epic = store.create(SESSION_A, { title: "Epic", type: "epic" });
    const child = store.create(SESSION_A, { title: "Child", parentId: epic.id });
    store.create(SESSION_A, { title: "Grandchild", parentId: child.id });

    const tree = store.tree(epic.id);
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].children).toHaveLength(1);
    expect(tree!.children[0].children[0].depth).toBe(2);
    expect(tree!.children[0].children[0].title).toBe("Grandchild");
  });
});

// ============================================================================
// Session Ownership
// ============================================================================

describe("TaskStore ownership", () => {
  it("allows owner to update their task", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });

    expect(() => store.update(SESSION_A, task.id, { status: "in_progress" })).not.toThrow();
  });

  it("rejects non-owner update", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });

    expect(() => store.update(SESSION_B, task.id, { status: "in_progress" })).toThrow(
      TaskAuthError,
    );
  });

  it("rejects non-owner close", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });

    expect(() => store.close(SESSION_B, task.id, "Nope")).toThrow(TaskAuthError);
  });

  it("rejects non-owner dep add", () => {
    const store = createStore();
    const a = store.create(SESSION_A, { title: "A" });
    const b = store.create(SESSION_A, { title: "B" });

    expect(() => store.addDep(SESSION_B, b.id, a.id, "blocks")).toThrow(TaskAuthError);
  });

  it("rejects child task creation under non-owned parent", () => {
    const store = createStore();
    const parent = store.create(SESSION_A, { title: "Parent" });

    expect(() => store.create(SESSION_B, { title: "Child", parentId: parent.id })).toThrow(
      TaskAuthError,
    );
  });

  it("allows all sessions to read all tasks", () => {
    const store = createStore();
    store.create(SESSION_A, { title: "A's task" });
    store.create(SESSION_B, { title: "B's task" });

    // Both sessions can see both tasks
    const all = store.list();
    expect(all).toHaveLength(2);
  });

  it("allows subagent to write parent session tasks", () => {
    const authChecker = (caller: string, owner: string) => {
      if (caller === owner) return true;
      if (caller === SUBAGENT_SESSION && owner === SESSION_A) return true;
      return false;
    };
    const store = createStore(authChecker);

    const task = store.create(SESSION_A, { title: "Test" });

    // Subagent can update parent's task
    expect(() => store.update(SUBAGENT_SESSION, task.id, { status: "in_progress" })).not.toThrow();

    // Subagent can close parent's task
    expect(() => store.close(SUBAGENT_SESSION, task.id, "Done by subagent")).not.toThrow();
  });

  it("rejects subagent writing other session's tasks", () => {
    const authChecker = (caller: string, owner: string) => {
      if (caller === owner) return true;
      if (caller === SUBAGENT_SESSION && owner === SESSION_A) return true;
      return false;
    };
    const store = createStore(authChecker);

    const task = store.create(SESSION_B, { title: "B's task" });

    expect(() => store.update(SUBAGENT_SESSION, task.id, { status: "in_progress" })).toThrow(
      TaskAuthError,
    );
  });

  it("setAuthChecker updates the checker at runtime", () => {
    const store = createStore();
    const task = store.create(SESSION_A, { title: "Test" });

    // Initially, SESSION_B can't write
    expect(() => store.update(SESSION_B, task.id, { status: "in_progress" })).toThrow(
      TaskAuthError,
    );

    // After updating checker, SESSION_B can write
    store.setAuthChecker(() => true);
    expect(() => store.update(SESSION_B, task.id, { status: "in_progress" })).not.toThrow();
  });
});

// ============================================================================
// Error Cases
// ============================================================================

describe("TaskStore errors", () => {
  it("throws TaskNotFoundError on update of non-existent task", () => {
    const store = createStore();
    expect(() => store.update(SESSION_A, "non-existent", { status: "in_progress" })).toThrow(
      TaskNotFoundError,
    );
  });

  it("throws TaskNotFoundError on close of non-existent task", () => {
    const store = createStore();
    expect(() => store.close(SESSION_A, "non-existent", "reason")).toThrow(TaskNotFoundError);
  });

  it("throws TaskNotFoundError on child creation with non-existent parent", () => {
    const store = createStore();
    expect(() => store.create(SESSION_A, { title: "Child", parentId: "non-existent" })).toThrow(
      TaskNotFoundError,
    );
  });
});
