export interface AgentRecord {
  id: string;
  name: string;
  ownerId: string;
  parentAgentId: string | null;
  status: "active" | "deleted";
  createdAt: string;
}

export interface AgentRegistry {
  list(ownerId: string): Promise<AgentRecord[]>;
  get(agentId: string): Promise<AgentRecord | null>;
  create(record: Omit<AgentRecord, "createdAt" | "status">): Promise<AgentRecord>;
  delete(agentId: string): Promise<void>;
  getRelationship(
    agentIdA: string,
    agentIdB: string,
  ): Promise<"parent" | "child" | "sibling" | null>;
}
