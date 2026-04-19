import type { CapabilityStorage } from "@crabbykit/agent-runtime";

export async function getAttachedAgentId(
  storage: CapabilityStorage,
  sessionId: string,
): Promise<string | null> {
  return (await storage.get<string>(`attached:${sessionId}`)) ?? null;
}

export async function setAttachedAgentId(
  storage: CapabilityStorage,
  sessionId: string,
  agentId: string,
): Promise<void> {
  await storage.put(`attached:${sessionId}`, agentId);
}

export async function clearAttachedAgentId(
  storage: CapabilityStorage,
  sessionId: string,
): Promise<void> {
  await storage.delete(`attached:${sessionId}`);
}
