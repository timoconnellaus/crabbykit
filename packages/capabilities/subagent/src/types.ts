import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { Mode } from "@claw-for-cloudflare/agent-runtime/modes";

export type { Mode };

/** State of a running subagent. */
export type SubagentState = "running" | "completed" | "failed" | "canceled";

/** Record of an in-flight subagent (stored in CapabilityStorage). */
export interface PendingSubagent {
  subagentId: string;
  modeId: string;
  childSessionId: string;
  parentSessionId: string;
  prompt: string;
  state: SubagentState;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Resolved spawn configuration for creating a subagent Agent instance. */
export interface ResolvedSubagentSpawn {
  mode: Mode;
  systemPrompt: string;
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  tools: AgentTool<any>[];
  modelId: string | undefined;
}
