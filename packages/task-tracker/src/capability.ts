import type { Capability, SqlStore } from "@claw-for-cloudflare/agent-runtime";
import type { AuthChecker } from "./task-store.js";
import { TaskStore } from "./task-store.js";
import {
  createTaskCloseTool,
  createTaskCreateTool,
  createTaskDepAddTool,
  createTaskReadyTool,
  createTaskTreeTool,
  createTaskUpdateTool,
} from "./tools.js";

export interface TaskTrackerOptions {
  /** SQL store (DO SQLite). Shared with SessionStore. */
  sql: SqlStore;
  /**
   * Authorization checker. Called to verify whether a session can write
   * to tasks owned by another session. By default only the owner session
   * can write. Set this to allow subagent sessions to inherit authority.
   */
  authChecker?: AuthChecker;
}

/**
 * Create a DAG-based task tracking capability.
 *
 * Provides tools for creating, updating, and closing tasks with
 * dependency graphs and ready-work computation.
 *
 * Tasks are DO-scoped (persist across sessions). The creating session
 * owns its tasks — other sessions have read-only access unless the
 * authChecker grants subagent authority.
 */
export function taskTracker(options: TaskTrackerOptions): Capability {
  const store = new TaskStore(options.sql, options.authChecker);

  return {
    id: "task-tracker",
    name: "Task Tracker",
    description:
      "DAG-based task management with dependency graph, ready-work computation, and session ownership.",

    tools: (context) => {
      const deps = {
        getStore: () => store,
        getSessionId: () => context.sessionId,
        getBroadcast: () => context.broadcastToAll,
      };

      return [
        createTaskCreateTool(deps),
        createTaskUpdateTool(deps),
        createTaskCloseTool(deps),
        createTaskReadyTool(deps),
        createTaskTreeTool(deps),
        createTaskDepAddTool(deps),
      ];
    },

    promptSections: () => [
      "You have a task tracker for organizing work into a dependency graph. " +
        "Use task_create to break work into tasks (type 'epic' for containers, 'task' for leaf work). " +
        "Use task_dep_add to sequence work (type 'blocks' for ordering). " +
        "Use task_ready to find what's available to work on next. " +
        "Use task_tree to visualize the hierarchy. " +
        "Close tasks with task_close when done.",
    ],
  };
}

/** Get the underlying TaskStore for direct access (e.g., from subagent capability). */
export function createTaskStore(sql: SqlStore, authChecker?: AuthChecker): TaskStore {
  return new TaskStore(sql, authChecker);
}
