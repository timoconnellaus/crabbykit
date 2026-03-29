import type { PeeringService } from "@claw-for-cloudflare/agent-peering";

export interface MessagingOptions {
  /** Secret for HMAC token signing/verification. */
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
  /** This agent's name (included in messages to other agents). */
  agentName?: string;
  /**
   * Peering service for access checks. If omitted, all messages accepted (open mode).
   * NOTE: PeeringService is imported as a TYPE only. agent-messaging does NOT depend
   * on agent-peering as a package dependency — the consumer passes the service instance.
   */
  peeringService?: PeeringService;
  /** Max hop depth for agent chains. Default: 5. */
  maxDepth?: number;
}
