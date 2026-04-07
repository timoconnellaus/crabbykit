import { useCallback } from "react";
import type { TaskItem } from "../hooks/use-task-state";

export interface TaskListProps {
  /** Flat list of tasks to display (already sorted/sliced). */
  tasks: TaskItem[];
  /** Number of additional active tasks beyond the visible list. */
  overflowCount: number;
  /** Currently active/selected task ID. */
  activeTaskId?: string;
  /** Called when a task row is clicked. */
  onTaskClick?: (taskId: string) => void;
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "P0",
  1: "P1",
};

/**
 * Compact task checklist displayed above the chat input.
 * Shows up to N active tasks sorted by relevance, with an overflow indicator.
 */
export function TaskList({ tasks, overflowCount, activeTaskId, onTaskClick }: TaskListProps) {
  if (tasks.length === 0) return null;

  const closedCount = tasks.filter((t) => t.status === "closed").length;
  const totalTracked = tasks.length + overflowCount;

  return (
    <div data-agent-ui="task-list">
      <div data-agent-ui="task-list-header">
        <span data-agent-ui="task-list-label">Tasks</span>
        {totalTracked > 0 && (
          <span data-agent-ui="task-list-count">
            {closedCount}/{totalTracked}
          </span>
        )}
      </div>
      <div data-agent-ui="task-list-items">
        {tasks.map((task) => (
          <TaskListRow
            key={task.id}
            task={task}
            isActive={task.id === activeTaskId}
            onClick={onTaskClick}
          />
        ))}
      </div>
      {overflowCount > 0 && <div data-agent-ui="task-list-overflow">+ {overflowCount} more</div>}
    </div>
  );
}

function TaskListRow({
  task,
  isActive,
  onClick,
}: {
  task: TaskItem;
  isActive: boolean;
  onClick?: (taskId: string) => void;
}) {
  const handleClick = useCallback(() => {
    onClick?.(task.id);
  }, [task.id, onClick]);

  const priorityLabel = PRIORITY_LABELS[task.priority];

  return (
    // biome-ignore lint/a11y/useSemanticElements: div needed for compact list layout
    <div
      data-agent-ui="task-list-row"
      data-status={task.status}
      data-active={isActive || undefined}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      role="button"
      tabIndex={0}
    >
      <span data-agent-ui="task-list-indicator" />
      <span data-agent-ui="task-list-title">{task.title}</span>
      {priorityLabel && (
        <span data-agent-ui="task-list-priority" data-priority={task.priority}>
          {priorityLabel}
        </span>
      )}
    </div>
  );
}
