import type { CapabilityStorage } from "@crabbykit/agent-runtime";
import type { PendingSubagent, SubagentState } from "./types.js";

const KEY_PREFIX = "subagent:";

/**
 * Stores pending (in-flight) subagents in CapabilityStorage.
 * Survives DO hibernation. Mirrors A2A's PendingTaskStore.
 */
export class PendingSubagentStore {
  constructor(private storage: CapabilityStorage) {}

  async save(subagent: PendingSubagent): Promise<void> {
    await this.storage.put(`${KEY_PREFIX}${subagent.subagentId}`, subagent);
  }

  async get(subagentId: string): Promise<PendingSubagent | undefined> {
    return this.storage.get<PendingSubagent>(`${KEY_PREFIX}${subagentId}`);
  }

  async delete(subagentId: string): Promise<void> {
    await this.storage.delete(`${KEY_PREFIX}${subagentId}`);
  }

  async updateState(subagentId: string, state: SubagentState): Promise<void> {
    const sub = await this.get(subagentId);
    if (!sub) return;
    sub.state = state;
    sub.updatedAt = new Date().toISOString();
    await this.save(sub);
  }

  async list(): Promise<PendingSubagent[]> {
    const map = await this.storage.list<PendingSubagent>(KEY_PREFIX);
    return [...map.values()];
  }

  async listActive(): Promise<PendingSubagent[]> {
    const all = await this.list();
    return all.filter((s) => s.state === "running");
  }
}
