/** Task status values. */
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";

/** Task type classification. */
export type TaskType = "task" | "epic" | "bug";

/** Dependency edge types. */
export type DepType = "blocks" | "parent-child" | "related";

/** Blocking dep types that affect ready-work computation. */
export const BLOCKING_DEP_TYPES: ReadonlySet<DepType> = new Set(["blocks", "parent-child"]);

/** Valid status transitions. */
export const VALID_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ["open", new Set(["in_progress", "closed"]) as ReadonlySet<TaskStatus>],
  ["in_progress", new Set(["closed", "blocked"]) as ReadonlySet<TaskStatus>],
  ["blocked", new Set(["in_progress", "closed"]) as ReadonlySet<TaskStatus>],
  ["closed", new Set<TaskStatus>()],
]);

/** A task in the tracker. */
export interface Task {
  id: string;
  parentId: string | null;
  ownerSession: string;
  title: string;
  description: string;
  acceptance: string;
  status: TaskStatus;
  priority: number;
  type: TaskType;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

/** A dependency edge between two tasks. */
export interface TaskDep {
  sourceId: string;
  targetId: string;
  depType: DepType;
  createdAt: string;
}

/** A task with depth information for tree queries. */
export interface TaskTreeNode extends Task {
  depth: number;
  children: TaskTreeNode[];
}

/** Input for creating a task. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  acceptance?: string;
  type?: TaskType;
  priority?: number;
  parentId?: string;
  /** Blocking dependency target IDs to add atomically with creation. */
  dependsOn?: string[];
}

/** Input for updating a task. */
export interface UpdateTaskInput {
  status?: TaskStatus;
  priority?: number;
  description?: string;
  acceptance?: string;
}

/** Task event change types. */
export type TaskChangeType = "created" | "updated" | "closed" | "dep_added" | "dep_removed";

/** Event emitted on task mutations. */
export interface TaskEvent {
  changeType: TaskChangeType;
  task: Task;
  dep?: TaskDep;
}
