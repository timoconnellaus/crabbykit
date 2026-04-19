import type { CapabilityStorage } from "@crabbykit/agent-runtime";
import type { PeerRecord } from "./types.js";

const INBOUND_PREFIX = "peer:in:";
const OUTBOUND_PREFIX = "peer:out:";

export async function getInboundPeer(
  storage: CapabilityStorage,
  agentId: string,
): Promise<PeerRecord | null> {
  const record = await storage.get<PeerRecord>(`${INBOUND_PREFIX}${agentId}`);
  return record ?? null;
}

export async function getOutboundPeer(
  storage: CapabilityStorage,
  agentId: string,
): Promise<PeerRecord | null> {
  const record = await storage.get<PeerRecord>(`${OUTBOUND_PREFIX}${agentId}`);
  return record ?? null;
}

export async function setInboundPeer(
  storage: CapabilityStorage,
  record: PeerRecord,
): Promise<void> {
  await storage.put(`${INBOUND_PREFIX}${record.agentId}`, record);
}

export async function setOutboundPeer(
  storage: CapabilityStorage,
  record: PeerRecord,
): Promise<void> {
  await storage.put(`${OUTBOUND_PREFIX}${record.agentId}`, record);
}

export async function deleteInboundPeer(
  storage: CapabilityStorage,
  agentId: string,
): Promise<void> {
  await storage.delete(`${INBOUND_PREFIX}${agentId}`);
}

export async function deleteOutboundPeer(
  storage: CapabilityStorage,
  agentId: string,
): Promise<void> {
  await storage.delete(`${OUTBOUND_PREFIX}${agentId}`);
}

export async function listInboundPeers(storage: CapabilityStorage): Promise<PeerRecord[]> {
  const map = await storage.list<PeerRecord>(INBOUND_PREFIX);
  return Array.from(map.values());
}

export async function listOutboundPeers(storage: CapabilityStorage): Promise<PeerRecord[]> {
  const map = await storage.list<PeerRecord>(OUTBOUND_PREFIX);
  return Array.from(map.values());
}
