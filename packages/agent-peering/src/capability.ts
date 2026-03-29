import { setAuthHeaders, signToken } from "@claw-for-cloudflare/agent-auth";
import type { Capability, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import {
  handshakeApproveHandler,
  handshakeCallbackHandler,
  handshakeDenyHandler,
  handshakeHandler,
} from "./handlers.js";
import {
  deleteInboundPeer,
  deleteOutboundPeer,
  getInboundPeer,
  listInboundPeers,
  listOutboundPeers,
  setOutboundPeer,
} from "./peers.js";
import { checkRateLimit as checkRateLimitFn } from "./rate-limit.js";
import type { PeeringService } from "./service.js";
import type { PeeringOptions, PeerRecord } from "./types.js";

/**
 * Create the agent-peering capability and its service handle.
 *
 * The capability registers HTTP handlers for inter-agent handshakes.
 * The service provides programmatic access to peering state.
 *
 * Storage is lazily resolved — it becomes available when the capability's
 * `httpHandlers()` or `promptSections()` is first called by the framework.
 */
export function agentPeering(options: PeeringOptions): {
  capability: Capability;
  service: PeeringService;
} {
  let _storage: CapabilityStorage | undefined;

  const getStorage = (): CapabilityStorage => {
    if (!_storage) {
      throw new Error("Peering not initialized — capability must be registered");
    }
    return _storage;
  };

  const service: PeeringService = {
    async isPeerAuthorized(agentId: string): Promise<boolean> {
      const peer = await getInboundPeer(getStorage(), agentId);
      return peer?.status === "accepted";
    },

    async listPeers(direction: "inbound" | "outbound"): Promise<PeerRecord[]> {
      return direction === "inbound"
        ? listInboundPeers(getStorage())
        : listOutboundPeers(getStorage());
    },

    async requestPeer(targetAgentId: string): Promise<PeerRecord> {
      const storage = getStorage();
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

      const result = (await response.json()) as {
        status: "accepted" | "pending" | "rejected";
      };

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
      const storage = getStorage();
      await deleteInboundPeer(storage, agentId);
      await deleteOutboundPeer(storage, agentId);
    },

    async checkRateLimit(senderAgentId: string): Promise<boolean> {
      return checkRateLimitFn(getStorage(), senderAgentId, options.rateLimit);
    },
  };

  const capability: Capability = {
    id: "agent-peering",
    name: "Agent Peering",
    description: "Manages trust relationships between agents.",

    httpHandlers: (context) => {
      _storage = context.storage;
      return [
        handshakeHandler(options),
        handshakeApproveHandler(options),
        handshakeDenyHandler(options),
        handshakeCallbackHandler(options),
      ];
    },

    promptSections: (context) => {
      _storage = context.storage;
      return [
        "This agent supports peering with other agents. Peer relationships are managed via the agent-peering capability.",
      ];
    },
  };

  return { capability, service };
}
