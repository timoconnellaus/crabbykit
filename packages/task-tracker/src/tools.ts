import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { defineTool, Type, toolResult } from "@claw-for-cloudflare/agent-runtime";
import type { TaskStore } from "./task-store.js";
import {
  InvalidTransitionError,
  TaskAuthError,
  TaskCycleError,
  TaskNotFoundError,
} from "./task-store.js";
import type { Task, TaskTreeNode } from "./types.js";

type BroadcastFn = (name: string, data: Record<string, unknown>) => void;

interface ToolDeps {
  getStore: () => TaskStore;
  getSessionId: () => string;
  getBroadcast: () => BroadcastFn;
}

function emitTaskEvent(
  broadcast: BroadcastFn,
  changeType: string,
  task: Task,
  extra?: Record<string, unknown>,
): void {
  broadcast("task_event", { changeType, task, ...extra });
}

function handleError(err: unknown): ReturnType<typeof toolResult.error> {
  if (
    err instanceof TaskNotFoundError ||
    err instanceof TaskAuthError ||
    err instanceof TaskCycleError ||
    err instanceof InvalidTransitionError
  ) {
    return toolResult.error(err.message);
  }
  throw err;
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createTaskCreateTool(deps: ToolDeps): AgentTool<any> {
  return defineTool({
    name: "task_create",
    description:
      "Create a new task. Use type 'epic' for top-level work containers. " +
      "Specify parentId to create a subtask. Specify dependsOn for blocking dependencies.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(Type.String({ description: "Detailed description" })),
      acceptance: Type.Optional(Type.String({ description: "Definition of done" })),
      type: Type.Optional(
        Type.Union([Type.Literal("task"), Type.Literal("epic"), Type.Literal("bug")], {
          description: "Task type (default: task)",
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 4,
          description: "Priority 0-4 (0=critical, 4=backlog, default=2)",
        }),
      ),
      parentId: Type.Optional(Type.String({ description: "Parent task ID for subtasks" })),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task IDs this task depends on (blocking)",
        }),
      ),
    }),
    execute: async (args) => {
      try {
        const task = deps.getStore().create(deps.getSessionId(), args);
        emitTaskEvent(deps.getBroadcast(), "created", task);
        return toolResult.text(
          `Created ${task.type} "${task.title}" (${task.id})` +
            (task.parentId ? ` under parent ${task.parentId}` : "") +
            (args.dependsOn?.length ? ` with ${args.dependsOn.length} blocking deps` : ""),
          { task },
        );
      } catch (err) {
        return handleError(err);
      }
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createTaskUpdateTool(deps: ToolDeps): AgentTool<any> {
  return defineTool({
    name: "task_update",
    description: "Update a task's status, priority, description, or acceptance criteria.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(
        Type.Union([Type.Literal("open"), Type.Literal("in_progress"), Type.Literal("blocked")], {
          description: "New status",
        }),
      ),
      priority: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 4, description: "New priority" }),
      ),
      description: Type.Optional(Type.String({ description: "Updated description" })),
      acceptance: Type.Optional(Type.String({ description: "Updated acceptance criteria" })),
    }),
    execute: async (args) => {
      try {
        const { taskId, ...input } = args;
        const task = deps.getStore().update(deps.getSessionId(), taskId, input);
        emitTaskEvent(deps.getBroadcast(), "updated", task);
        return toolResult.text(`Updated task "${task.title}" — status: ${task.status}`, {
          task,
        });
      } catch (err) {
        return handleError(err);
      }
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createTaskCloseTool(deps: ToolDeps): AgentTool<any> {
  return defineTool({
    name: "task_close",
    description: "Close a task with a reason.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to close" }),
      reason: Type.String({ description: "Why the task is being closed" }),
    }),
    execute: async (args) => {
      try {
        const task = deps.getStore().close(deps.getSessionId(), args.taskId, args.reason);
        emitTaskEvent(deps.getBroadcast(), "closed", task);
        return toolResult.text(`Closed task "${task.title}" — ${args.reason}`, { task });
      } catch (err) {
        return handleError(err);
      }
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createTaskReadyTool(deps: ToolDeps): AgentTool<any> {
  return defineTool({
    name: "task_ready",
    description:
      "List tasks that are ready to work on — open tasks whose blocking dependencies are all closed.",
    parameters: Type.Object({
      ownerSession: Type.Optional(
        Type.String({ description: "Filter to a specific session's tasks" }),
      ),
    }),
    execute: async (args) => {
      const ready = deps.getStore().ready(args.ownerSession);
      if (ready.length === 0) {
        return toolResult.text("No tasks are currently ready.", { tasks: [] });
      }
      const lines = ready.map((t) => `- [${t.priority}] ${t.title} (${t.id}) — ${t.type}`);
      return toolResult.text(`${ready.length} ready task(s):\n${lines.join("\n")}`, {
        tasks: ready,
      });
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createTaskTreeTool(deps: ToolDeps): AgentTool<any> {
  return defineTool({
    name: "task_tree",
    description: "Show the task hierarchy from a root task.",
    parameters: Type.Object({
      rootId: Type.String({ description: "Root task ID to show tree from" }),
    }),
    execute: async (args) => {
      const tree = deps.getStore().tree(args.rootId);
      if (!tree) {
        return toolResult.error(`Task not found: ${args.rootId}`);
      }
      const lines = formatTree(tree, "");
      return toolResult.text(lines.join("\n"), { tree });
    },
  });
}

function formatTree(node: TaskTreeNode, indent: string): string[] {
  const status = node.status === "closed" ? "✓" : node.status === "in_progress" ? "▶" : "○";
  const lines = [`${indent}${status} ${node.title} (${node.id}) [${node.status}]`];
  for (const child of node.children) {
    lines.push(...formatTree(child, `${indent}  `));
  }
  return lines;
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createTaskDepAddTool(deps: ToolDeps): AgentTool<any> {
  return defineTool({
    name: "task_dep_add",
    description:
      "Add a dependency between tasks. Use type 'blocks' for blocking deps " +
      "(affects ready-work) or 'related' for informational links.",
    parameters: Type.Object({
      sourceId: Type.String({ description: "Task that depends on another" }),
      targetId: Type.String({ description: "Task that must be completed first" }),
      depType: Type.Union([Type.Literal("blocks"), Type.Literal("related")], {
        description: "Dependency type",
      }),
    }),
    execute: async (args) => {
      try {
        const dep = deps
          .getStore()
          .addDep(deps.getSessionId(), args.sourceId, args.targetId, args.depType);
        const source = deps.getStore().get(args.sourceId);
        if (source) {
          emitTaskEvent(deps.getBroadcast(), "dep_added", source, { dep });
        }
        return toolResult.text(
          `Added ${args.depType} dependency: ${args.sourceId} → ${args.targetId}`,
          { dep },
        );
      } catch (err) {
        return handleError(err);
      }
    },
  });
}
