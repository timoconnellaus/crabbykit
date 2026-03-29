export interface PeerRecord {
  agentId: string;
  agentName: string;
  status: "accepted" | "pending" | "rejected";
  grantedAt: number;
}

export type PeerPolicy = "auto-allow" | "auto-disallow" | "user-approval";

export interface PeeringOptions {
  /** Secret for HMAC token signing/verification. */
  secret: string;
  /** Get a DO stub for another agent by ID. */
  getAgentStub: (agentId: string) => {
    fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  };
  /**
   * Resolve an external agent ID (e.g. registry UUID) to the DO's actual hex ID.
   * Used to ensure HMAC token targets match the receiving DO's identity.
   * If omitted, agent IDs are assumed to already be DO hex IDs.
   */
  resolveDoId?: (agentId: string) => string;
  /** This agent's ID. */
  agentId: string;
  /** This agent's name (for handshake metadata). */
  agentName?: string;
  /** Policy for same-owner agents. Default: "auto-allow". */
  sameOwnerPolicy?: PeerPolicy;
  /** Policy for cross-owner agents. Default: "user-approval". */
  crossOwnerPolicy?: PeerPolicy;
  /** Max messages per sender per 60s. Default: 10. */
  rateLimit?: number;
  /** Max hop depth. Default: 5. */
  maxDepth?: number;
}
