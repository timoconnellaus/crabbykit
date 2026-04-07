/** Shared status display constants for task components. */

export const STATUS_ICONS: Record<string, string> = {
  open: "○",
  in_progress: "▶",
  blocked: "◼",
  closed: "✓",
};

export const STATUS_COLORS: Record<string, string> = {
  open: "var(--task-open, #888)",
  in_progress: "var(--task-in-progress, #3b82f6)",
  blocked: "var(--task-blocked, #ef4444)",
  closed: "var(--task-closed, #22c55e)",
};
