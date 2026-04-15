import {
  getAuthFromRequest,
  setAuthHeaders,
  signToken,
  verifyToken,
} from "@claw-for-cloudflare/agent-auth";
import type { CapabilityHttpContext, HttpHandler } from "@claw-for-cloudflare/agent-runtime";
import { getInboundPeer, getOutboundPeer, setInboundPeer, setOutboundPeer } from "./peers.js";
import type { PeeringOptions, PeerPolicy, PeerRecord } from "./types.js";

const DEFAULT_SAME_OWNER_POLICY: PeerPolicy = "auto-allow";

function resolvePolicy(options: PeeringOptions): PeerPolicy {
  // For now, always use sameOwnerPolicy since we don't have owner info in the token.
  return options.sameOwnerPolicy ?? DEFAULT_SAME_OWNER_POLICY;
}

function statusFromPolicy(policy: PeerPolicy): "accepted" | "pending" | "rejected" {
  switch (policy) {
    case "auto-allow":
      return "accepted";
    case "auto-disallow":
      return "rejected";
    case "user-approval":
      return "pending";
  }
}

/**
 * POST /agent-handshake — Receive a handshake request from another agent.
 */
export function handshakeHandler(options: PeeringOptions): HttpHandler {
  return {
    method: "POST",
    path: "/agent-handshake",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const auth = getAuthFromRequest(request);
      if (!auth) {
        return new Response(JSON.stringify({ error: "Missing auth headers" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const payload = await verifyToken(auth.token, options.agentId, options.secret);
      if (!payload) {
        return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Idempotent: return existing peer status if already known
      const existing = await getInboundPeer(ctx.storage, payload.sender);
      if (existing) {
        return new Response(JSON.stringify({ status: existing.status }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = (await request.json()) as { agentName?: string };

      const policy = resolvePolicy(options);
      const status = statusFromPolicy(policy);

      const record: PeerRecord = {
        agentId: payload.sender,
        agentName: body.agentName ?? payload.sender,
        status,
        grantedAt: Date.now(),
      };

      await setInboundPeer(ctx.storage, record);

      if (status === "pending") {
        ctx.broadcastToAll("agent_ops_handshake_pending", {
          agentId: payload.sender,
          agentName: record.agentName,
        });
      }

      return new Response(JSON.stringify({ status }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/**
 * POST /agent-handshake-approve — Dashboard/UI approves a pending handshake.
 */
export function handshakeApproveHandler(options: PeeringOptions): HttpHandler {
  return {
    method: "POST",
    path: "/agent-handshake-approve",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const body = (await request.json()) as { agentId: string };
      if (!body.agentId) {
        return new Response(JSON.stringify({ error: "Missing agentId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const existing = await getInboundPeer(ctx.storage, body.agentId);
      if (!existing) {
        return new Response(JSON.stringify({ error: "No pending handshake for this agent" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const updated: PeerRecord = { ...existing, status: "accepted", grantedAt: Date.now() };
      await setInboundPeer(ctx.storage, updated);

      // Callback to the peer to notify acceptance
      try {
        const token = await signToken(options.agentId, body.agentId, options.secret);
        const stub = options.getAgentStub(body.agentId);
        const headers = new Headers({ "Content-Type": "application/json" });
        setAuthHeaders(headers, token, options.agentId);

        await stub.fetch("https://agent/agent-handshake-callback", {
          method: "POST",
          headers,
          body: JSON.stringify({ status: "accepted" }),
        });
      } catch {
        // Best-effort callback — peer may be unreachable
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/**
 * POST /agent-handshake-deny — Dashboard/UI denies a pending handshake.
 */
export function handshakeDenyHandler(options: PeeringOptions): HttpHandler {
  return {
    method: "POST",
    path: "/agent-handshake-deny",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const body = (await request.json()) as { agentId: string };
      if (!body.agentId) {
        return new Response(JSON.stringify({ error: "Missing agentId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const existing = await getInboundPeer(ctx.storage, body.agentId);
      if (!existing) {
        return new Response(JSON.stringify({ error: "No pending handshake for this agent" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const updated: PeerRecord = { ...existing, status: "rejected", grantedAt: Date.now() };
      await setInboundPeer(ctx.storage, updated);

      // Callback to the peer to notify rejection
      try {
        const token = await signToken(options.agentId, body.agentId, options.secret);
        const stub = options.getAgentStub(body.agentId);
        const headers = new Headers({ "Content-Type": "application/json" });
        setAuthHeaders(headers, token, options.agentId);

        await stub.fetch("https://agent/agent-handshake-callback", {
          method: "POST",
          headers,
          body: JSON.stringify({ status: "rejected" }),
        });
      } catch {
        // Best-effort callback — peer may be unreachable
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/**
 * POST /agent-handshake-callback — Receive status update from target after approve/deny.
 */
export function handshakeCallbackHandler(options: PeeringOptions): HttpHandler {
  return {
    method: "POST",
    path: "/agent-handshake-callback",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const auth = getAuthFromRequest(request);
      if (!auth) {
        return new Response(JSON.stringify({ error: "Missing auth headers" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const payload = await verifyToken(auth.token, options.agentId, options.secret);
      if (!payload) {
        return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = (await request.json()) as { status: "accepted" | "rejected" };
      if (body.status !== "accepted" && body.status !== "rejected") {
        return new Response(JSON.stringify({ error: "Invalid status" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const existing = await getOutboundPeer(ctx.storage, payload.sender);
      if (existing) {
        const updated: PeerRecord = { ...existing, status: body.status, grantedAt: Date.now() };
        await setOutboundPeer(ctx.storage, updated);
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}
