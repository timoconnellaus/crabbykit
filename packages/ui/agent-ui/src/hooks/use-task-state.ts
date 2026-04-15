import { useCallback, useMemo, useReducer } from "react";
import type { TaskNode } from "../components/task-tree-panel";

/** A flat task item used for display in the compact task list. */
export interface TaskItem {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "closed";
  type: "task" | "epic" | "bug";
  priority: number;
  parentId: string | null;
  createdAt: string;
}

/** Raw task event from the transport layer. */
export interface RawTaskEvent {
  changeType: string;
  task: Record<string, unknown>;
  dep?: Record<string, unknown>;
}

export interface UseTaskStateReturn {
  /** All known tasks, keyed by ID. */
  tasks: Map<string, TaskItem>;
  /** Reconstructed tree for TaskTreePanel/TaskBreadcrumb compatibility. */
  taskTree: TaskNode | null;
  /** Flat display list of active tasks, sorted by relevance. */
  displayTasks: TaskItem[];
  /** Count of active tasks beyond the display limit. */
  overflowCount: number;
  /** Total active (non-closed) task count. */
  activeCount: number;
  /** Process a raw task_event from the transport layer. */
  handleTaskEvent: (event: RawTaskEvent) => void;
  /** Reset all task state (e.g. on session switch). */
  reset: () => void;
}

// --- Reducer ---

interface TaskState {
  tasksById: Map<string, TaskItem>;
  rootId: string | null;
  /** sourceId → set of targetIds that block it (only "blocks" and "parent-child" dep types). */
  blockingDeps: Map<string, Set<string>>;
  /** Insertion order for stable sorting. */
  insertionOrder: Map<string, number>;
  counter: number;
}

type TaskAction =
  | { type: "created"; task: TaskItem }
  | { type: "updated"; task: TaskItem }
  | { type: "closed"; task: TaskItem }
  | {
      type: "dep_added";
      sourceId: string;
      targetId: string;
      depType: string;
    }
  | {
      type: "dep_removed";
      sourceId: string;
      targetId: string;
    }
  | { type: "reset" };

function createInitialState(): TaskState {
  return {
    tasksById: new Map(),
    rootId: null,
    blockingDeps: new Map(),
    insertionOrder: new Map(),
    counter: 0,
  };
}

/** Blocking dep types that affect the display. */
const BLOCKING_DEP_TYPES = new Set(["blocks", "parent-child"]);

function taskReducer(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case "created": {
      const next = new Map(state.tasksById);
      next.set(action.task.id, action.task);
      const order = new Map(state.insertionOrder);
      order.set(action.task.id, state.counter);
      return {
        ...state,
        tasksById: next,
        rootId: action.task.parentId === null ? action.task.id : state.rootId,
        insertionOrder: order,
        counter: state.counter + 1,
      };
    }
    case "updated": {
      const existing = state.tasksById.get(action.task.id);
      if (!existing) return state;
      const next = new Map(state.tasksById);
      next.set(action.task.id, { ...existing, ...action.task });
      return { ...state, tasksById: next };
    }
    case "closed": {
      const existing = state.tasksById.get(action.task.id);
      if (!existing) return state;
      const next = new Map(state.tasksById);
      next.set(action.task.id, {
        ...existing,
        ...action.task,
        status: "closed",
      });
      return { ...state, tasksById: next };
    }
    case "dep_added": {
      if (!BLOCKING_DEP_TYPES.has(action.depType)) return state;
      const deps = new Map(state.blockingDeps);
      const sourceSet = new Set(deps.get(action.sourceId));
      sourceSet.add(action.targetId);
      deps.set(action.sourceId, sourceSet);
      return { ...state, blockingDeps: deps };
    }
    case "dep_removed": {
      const deps = new Map(state.blockingDeps);
      const sourceSet = deps.get(action.sourceId);
      if (!sourceSet) return state;
      const next = new Set(sourceSet);
      next.delete(action.targetId);
      if (next.size === 0) {
        deps.delete(action.sourceId);
      } else {
        deps.set(action.sourceId, next);
      }
      return { ...state, blockingDeps: deps };
    }
    case "reset":
      return createInitialState();
  }
}

// --- Helpers ---

/** Parse a raw task record from the transport into a TaskItem. */
function parseTaskItem(raw: Record<string, unknown>): TaskItem {
  return {
    id: raw.id as string,
    title: raw.title as string,
    status: raw.status as TaskItem["status"],
    type: (raw.type as TaskItem["type"]) ?? "task",
    priority: (raw.priority as number) ?? 2,
    parentId: (raw.parentId as string) ?? null,
    createdAt: (raw.createdAt as string) ?? new Date().toISOString(),
  };
}

/** Status sort rank: in_progress=0, open=1, blocked=2, closed=3. */
const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  open: 1,
  blocked: 2,
  closed: 3,
};

/** Check if a task is blocked by any unclosed blocking dependency. */
function isTaskBlocked(
  taskId: string,
  blockingDeps: Map<string, Set<string>>,
  tasksById: Map<string, TaskItem>,
): boolean {
  const targets = blockingDeps.get(taskId);
  if (!targets) return false;
  for (const targetId of targets) {
    const target = tasksById.get(targetId);
    if (!target || target.status !== "closed") return true;
  }
  return false;
}

/** Build a TaskNode tree from the flat task map. */
function buildTree(tasksById: Map<string, TaskItem>, rootId: string | null): TaskNode | null {
  if (!rootId) return null;
  const root = tasksById.get(rootId);
  if (!root) return null;

  // Group children by parentId
  const childrenMap = new Map<string, TaskItem[]>();
  for (const task of tasksById.values()) {
    if (task.parentId) {
      const siblings = childrenMap.get(task.parentId) ?? [];
      siblings.push(task);
      childrenMap.set(task.parentId, siblings);
    }
  }

  function buildNode(item: TaskItem, depth: number): TaskNode {
    const children = (childrenMap.get(item.id) ?? []).map((child) => buildNode(child, depth + 1));
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      type: item.type,
      priority: item.priority,
      depth,
      children,
    };
  }

  return buildNode(root, 0);
}

// --- Hook ---

const DEFAULT_MAX_VISIBLE = 5;

export function useTaskState(options?: { maxVisible?: number }): UseTaskStateReturn {
  const maxVisible = options?.maxVisible ?? DEFAULT_MAX_VISIBLE;
  const [state, dispatch] = useReducer(taskReducer, undefined, createInitialState);

  const handleTaskEvent = useCallback((event: RawTaskEvent) => {
    const task = parseTaskItem(event.task);
    switch (event.changeType) {
      case "created":
        dispatch({ type: "created", task });
        break;
      case "updated":
        dispatch({ type: "updated", task });
        break;
      case "closed":
        dispatch({ type: "closed", task });
        break;
      case "dep_added":
        if (event.dep) {
          dispatch({
            type: "dep_added",
            sourceId: event.dep.sourceId as string,
            targetId: event.dep.targetId as string,
            depType: event.dep.depType as string,
          });
        }
        break;
      case "dep_removed":
        if (event.dep) {
          dispatch({
            type: "dep_removed",
            sourceId: event.dep.sourceId as string,
            targetId: event.dep.targetId as string,
          });
        }
        break;
      case "cleared":
        dispatch({ type: "reset" });
        break;
    }
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  const { displayTasks, overflowCount, activeCount } = useMemo(() => {
    const all: Array<TaskItem & { effectiveStatus: string }> = [];
    let activeTotal = 0;
    for (const task of state.tasksById.values()) {
      const blocked =
        task.status !== "closed" && isTaskBlocked(task.id, state.blockingDeps, state.tasksById);
      const effectiveStatus = blocked ? "blocked" : task.status;
      if (effectiveStatus !== "closed") activeTotal++;
      all.push({ ...task, effectiveStatus });
    }

    all.sort((a, b) => {
      const rankA = STATUS_RANK[a.effectiveStatus] ?? 1;
      const rankB = STATUS_RANK[b.effectiveStatus] ?? 1;
      if (rankA !== rankB) return rankA - rankB;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const orderA = state.insertionOrder.get(a.id) ?? 0;
      const orderB = state.insertionOrder.get(b.id) ?? 0;
      return orderA - orderB;
    });

    const display = all.slice(0, maxVisible).map(
      ({ effectiveStatus, ...item }): TaskItem => ({
        ...item,
        status: effectiveStatus as TaskItem["status"],
      }),
    );

    return {
      displayTasks: display,
      overflowCount: Math.max(0, all.length - maxVisible),
      activeCount: activeTotal,
    };
  }, [state.tasksById, state.blockingDeps, state.insertionOrder, maxVisible]);

  const taskTree = useMemo(
    () => buildTree(state.tasksById, state.rootId),
    [state.tasksById, state.rootId],
  );

  return {
    tasks: state.tasksById,
    taskTree,
    displayTasks,
    overflowCount,
    activeCount,
    handleTaskEvent,
    reset,
  };
}
