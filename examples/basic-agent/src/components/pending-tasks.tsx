import { pendingTasksStyles } from "../styles/pending-tasks";

export interface PendingA2ATask {
  taskId: string;
  targetAgent: string;
  targetAgentName: string;
  state: string;
  originalRequest: string;
}

export function PendingTasksBanner({ tasks }: { tasks: PendingA2ATask[] }) {
  if (tasks.length === 0) return null;

  const names = tasks.map((t) => t.targetAgentName || t.targetAgent);
  const label = tasks.length === 1 ? "1 task pending" : `${tasks.length} tasks pending`;

  return (
    <>
      <style>{pendingTasksStyles}</style>
      <div data-agent-ui="pending-tasks-banner">
        <span data-agent-ui="pending-tasks-dot" />
        <span data-agent-ui="pending-tasks-label">{label}</span>
        <span data-agent-ui="pending-tasks-names">{names.join(", ")}</span>
      </div>
    </>
  );
}
