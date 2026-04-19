import { setAuthHeaders, signToken } from "@crabbykit/agent-auth";
import type { CapabilityStorage } from "@crabbykit/agent-runtime";
import {
  deleteInboundPeer,
  deleteOutboundPeer,
  getInboundPeer,
  listInboundPeers,
  listOutboundPeers,
  setOutboundPeer,
} from "./peers.js";
import { checkRateLimit as checkRateLimitFn } from "./rate-limit.js";
import type { PeeringOptions, PeerRecord } from "./types.js";

export interface PeeringService {
  isPeerAuthorized(agentId: string): Promise<boolean>;
  listPeers(direction: "inbound" | "outbound"): Promise<PeerRecord[]>;
  requestPeer(targetAgentId: string): Promise<PeerRecord>;
  revokePeer(agentId: string): Promise<void>;
  checkRateLimit(senderAgentId: string): Promise<boolean>;
}

export function createPeeringService(
  storage: CapabilityStorage,
  options: PeeringOptions,
): PeeringService {
  return {
    async isPeerAuthorized(agentId: string): Promise<boolean> {
      const peer = await getInboundPeer(storage, agentId);
      return peer?.status === "accepted";
    },

    async listPeers(direction: "inbound" | "outbound"): Promise<PeerRecord[]> {
      return direction === "inbound" ? listInboundPeers(storage) : listOutboundPeers(storage);
    },

    async requestPeer(targetAgentId: string): Promise<PeerRecord> {
      const resolveDoId = options.resolveDoId ?? ((x: string) => x);
      const token = await signToken(options.agentId, resolveDoId(targetAgentId), options.secret);
      const stub = options.getAgentStub(targetAgentId);

      const headers = new Headers({ "Content-Type": "application/json" });
      setAuthHeaders(headers, token, options.agentId);

      const response = await stub.fetch("https://agent/agent-handshake", {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentName: options.agentName ?? options.agentId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Handshake failed: ${response.status} ${await response.text()}`);
      }

      const result = (await response.json()) as { status: "accepted" | "pending" | "rejected" };

      const record: PeerRecord = {
        agentId: targetAgentId,
        agentName: targetAgentId,
        status: result.status,
        grantedAt: Date.now(),
      };
      await setOutboundPeer(storage, record);
      return record;
    },

    async revokePeer(agentId: string): Promise<void> {
      await deleteInboundPeer(storage, agentId);
      await deleteOutboundPeer(storage, agentId);
    },

    async checkRateLimit(senderAgentId: string): Promise<boolean> {
      return checkRateLimitFn(storage, senderAgentId, options.rateLimit);
    },
  };
}
