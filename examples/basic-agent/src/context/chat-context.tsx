import type {
  BrowserState,
  ConsoleLogEntry,
  SandboxBadgeProps,
  SubagentInfo,
  TaskItem,
  TaskNode,
} from "@claw-for-cloudflare/agent-ui";
import { createContext, useContext } from "react";
import type { PendingA2ATask } from "../components/pending-tasks";

export interface AppSummary {
  id: string;
  name: string;
  slug: string;
  currentVersion: number;
  hasBackend: boolean;
  lastDeployedAt: string;
  commitHash: string;
  commitMessage: string | null;
}

export interface ChatContextValue {
  agentId: string;
  sessionId: string;
  sandboxState: SandboxBadgeProps;
  pendingTasks: PendingA2ATask[];
  deployedApps: AppSummary[];
  previewState: { open: boolean; port?: number; previewBasePath?: string };
  consoleLogs: ConsoleLogEntry[];
  onClearLogs: () => void;
  onClosePreview: () => void;
  logFilter: "all" | "error" | "warn" | "info" | "log";
  onLogFilterChange: (filter: "all" | "error" | "warn" | "info" | "log") => void;
  taskTree: TaskNode | null;
  displayTasks: TaskItem[];
  overflowCount: number;
  activeTaskId: string | undefined;
  onTaskClick: (taskId: string) => void;
  subagents: SubagentInfo[];
  browserState: BrowserState;
  onCloseBrowser: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatContextProvider = ChatContext.Provider;

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatContextProvider");
  }
  return ctx;
}
