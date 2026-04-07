import { useCallback, useState } from "react";
import { STATUS_COLORS, STATUS_ICONS } from "./task-status";

export interface TaskNode {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "closed";
  type: "task" | "epic" | "bug";
  priority: number;
  depth: number;
  children: TaskNode[];
}

export interface TaskTreePanelProps {
  /** Root task tree to display. */
  tree: TaskNode | null;
  /** Currently active task ID (highlighted + breadcrumb source). */
  activeTaskId?: string;
  /** Called when a task node is clicked. */
  onTaskClick?: (taskId: string) => void;
}

export function TaskTreePanel({ tree, activeTaskId, onTaskClick }: TaskTreePanelProps) {
  if (!tree) return null;

  return (
    <div data-agent-ui="task-tree-panel">
      <TaskTreeNode node={tree} activeTaskId={activeTaskId} onTaskClick={onTaskClick} />
    </div>
  );
}

function TaskTreeNode({
  node,
  activeTaskId,
  onTaskClick,
}: {
  node: TaskNode;
  activeTaskId?: string;
  onTaskClick?: (taskId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  const isActive = node.id === activeTaskId;

  const handleClick = useCallback(() => {
    onTaskClick?.(node.id);
  }, [node.id, onTaskClick]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsed((c) => !c);
  }, []);

  return (
    <div data-agent-ui="task-tree-node">
      {/* biome-ignore lint/a11y/useSemanticElements: div needed for layout with tree indentation */}
      <div
        data-agent-ui="task-tree-row"
        data-active={isActive || undefined}
        data-status={node.status}
        onClick={handleClick}
        onKeyDown={(e) => e.key === "Enter" && handleClick()}
        role="button"
        tabIndex={0}
        style={{ paddingLeft: `${node.depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            data-agent-ui="task-tree-toggle"
            onClick={handleToggle}
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span data-agent-ui="task-tree-spacer" />
        )}
        <span data-agent-ui="task-tree-status" style={{ color: STATUS_COLORS[node.status] }}>
          {STATUS_ICONS[node.status] ?? "○"}
        </span>
        <span data-agent-ui="task-tree-title">{node.title}</span>
        <span data-agent-ui="task-tree-type">{node.type}</span>
      </div>
      {hasChildren && !collapsed && (
        <div data-agent-ui="task-tree-children">
          {node.children.map((child) => (
            <TaskTreeNode
              key={child.id}
              node={child}
              activeTaskId={activeTaskId}
              onTaskClick={onTaskClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
