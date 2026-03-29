import type { PeeringService } from "@claw-for-cloudflare/agent-peering";
import type { AgentRegistry } from "@claw-for-cloudflare/agent-registry";

export interface FleetOptions {
  /** Agent registry for CRUD operations. */
  registry: AgentRegistry;
  /** Secret for inter-agent HMAC tokens. */
  secret: string;
  /** Get a DO stub for another agent. */
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
  /** This agent's owner ID. */
  ownerId: string;
  /** This agent's name. */
  agentName?: string;
  /** Peering service for auto-handshake on create. Optional. */
  peeringService?: PeeringService;
  /** Hook called after creating a child agent. */
  onChildCreated?: (
    childStub: {
      fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
    },
    childId: string,
  ) => Promise<void>;
}
