import type { TaskNode } from "./task-tree-panel";

export interface TaskBreadcrumbProps {
  /** The full task tree (used to compute the path). */
  tree: TaskNode | null;
  /** The active task ID to show the path for. */
  activeTaskId?: string;
}

/**
 * Displays the path from root epic to the active task as a breadcrumb.
 * Hidden when there's no active task.
 */
export function TaskBreadcrumb({ tree, activeTaskId }: TaskBreadcrumbProps) {
  if (!tree || !activeTaskId) return null;

  const path = findPath(tree, activeTaskId);
  if (path.length === 0) return null;

  return (
    <div data-agent-ui="task-breadcrumb">
      {path.map((node, i) => (
        <span key={node.id} data-agent-ui="task-breadcrumb-segment">
          {i > 0 && <span data-agent-ui="task-breadcrumb-separator"> › </span>}
          <span
            data-agent-ui="task-breadcrumb-label"
            data-active={node.id === activeTaskId || undefined}
          >
            {node.title}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Find the path from root to a target node in the tree. */
function findPath(node: TaskNode, targetId: string): TaskNode[] {
  if (node.id === targetId) return [node];

  for (const child of node.children) {
    const childPath = findPath(child, targetId);
    if (childPath.length > 0) {
      return [node, ...childPath];
    }
  }

  return [];
}
