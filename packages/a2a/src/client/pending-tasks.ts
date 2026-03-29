import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { TaskState } from "../types.js";

const TASK_KEY_PREFIX = "task:";

export interface PendingTask {
  taskId: string;
  contextId: string;
  targetAgent: string;
  targetAgentName: string;
  originalRequest: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  originSessionId: string;
  webhookToken: string;
}

/**
 * Stores pending (in-flight) tasks in CapabilityStorage.
 * Survives DO hibernation. Used by the A2A client capability
 * to track tasks that were started but not yet completed.
 */
export class PendingTaskStore {
  constructor(private storage: CapabilityStorage) {}

  async save(task: PendingTask): Promise<void> {
    await this.storage.put(`${TASK_KEY_PREFIX}${task.taskId}`, task);
  }

  async get(taskId: string): Promise<PendingTask | undefined> {
    return this.storage.get<PendingTask>(`${TASK_KEY_PREFIX}${taskId}`);
  }

  async delete(taskId: string): Promise<void> {
    await this.storage.delete(`${TASK_KEY_PREFIX}${taskId}`);
  }

  async updateState(taskId: string, state: TaskState): Promise<void> {
    const task = await this.get(taskId);
    if (!task) return;
    task.state = state;
    task.updatedAt = new Date().toISOString();
    await this.save(task);
  }

  async list(): Promise<PendingTask[]> {
    const map = await this.storage.list<PendingTask>(TASK_KEY_PREFIX);
    return [...map.values()];
  }

  async listActive(): Promise<PendingTask[]> {
    const all = await this.list();
    return all.filter(
      (t) => t.state === "submitted" || t.state === "working" || t.state === "input-required",
    );
  }
}
