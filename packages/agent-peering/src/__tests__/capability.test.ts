import { describe, expect, it, vi, beforeEach } from "vitest";
import { signToken } from "@claw-for-cloudflare/agent-auth";
import { setAuthHeaders } from "@claw-for-cloudflare/agent-auth";
import type { CapabilityStorage, CapabilityHttpContext } from "@claw-for-cloudflare/agent-runtime";
import { createMockStorage } from "@claw-for-cloudflare/agent-runtime/test-utils";
import type { PeeringOptions, PeerRecord } from "../types.js";
import { checkRateLimit } from "../rate-limit.js";
import {
  getInboundPeer,
  getOutboundPeer,
  setInboundPeer,
  setOutboundPeer,
  deleteInboundPeer,
  deleteOutboundPeer,
  listInboundPeers,
  listOutboundPeers,
} from "../peers.js";
import {
  handshakeHandler,
  handshakeApproveHandler,
  handshakeDenyHandler,
  handshakeCallbackHandler,
} from "../handlers.js";
import { agentPeering } from "../capability.js";
import { createPeeringService } from "../service.js";

const SECRET = "test-secret-key-for-hmac";
const AGENT_A = "agent-a-hex-id";
const AGENT_B = "agent-b-hex-id";

function makePeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    agentId: AGENT_B,
    agentName: "Agent B",
    status: "accepted",
    grantedAt: 1000,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<PeeringOptions> = {}): PeeringOptions {
  return {
    secret: SECRET,
    agentId: AGENT_A,
    agentName: "Agent A",
    getAgentStub: () => ({ fetch: vi.fn() }),
    ...overrides,
  };
}

function makeHttpContext(storage: CapabilityStorage): CapabilityHttpContext {
  return {
    storage,
    sessionStore: {} as CapabilityHttpContext["sessionStore"],
    broadcastToAll: vi.fn(),
    sendPrompt: vi.fn(),
  };
}

async function makeAuthRequest(
  url: string,
  sender: string,
  target: string,
  secret: string,
  body: Record<string, unknown> = {},
): Promise<Request> {
  const token = await signToken(sender, target, secret);
  const headers = new Headers({ "Content-Type": "application/json" });
  setAuthHeaders(headers, token, sender);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// peers.ts — KV CRUD operations
// ---------------------------------------------------------------------------

describe("peers", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("get returns null when no peer exists", async () => {
    expect(await getInboundPeer(storage, "unknown")).toBeNull();
    expect(await getOutboundPeer(storage, "unknown")).toBeNull();
  });

  it("set and get inbound peer", async () => {
    const peer = makePeer();
    await setInboundPeer(storage, peer);
    const result = await getInboundPeer(storage, peer.agentId);
    expect(result).toEqual(peer);
  });

  it("set and get outbound peer", async () => {
    const peer = makePeer();
    await setOutboundPeer(storage, peer);
    const result = await getOutboundPeer(storage, peer.agentId);
    expect(result).toEqual(peer);
  });

  it("inbound and outbound are stored separately", async () => {
    const inPeer = makePeer({ agentId: "in-agent" });
    const outPeer = makePeer({ agentId: "out-agent" });
    await setInboundPeer(storage, inPeer);
    await setOutboundPeer(storage, outPeer);

    expect(await getInboundPeer(storage, "in-agent")).toEqual(inPeer);
    expect(await getOutboundPeer(storage, "in-agent")).toBeNull();
    expect(await getOutboundPeer(storage, "out-agent")).toEqual(outPeer);
    expect(await getInboundPeer(storage, "out-agent")).toBeNull();
  });

  it("delete inbound peer", async () => {
    await setInboundPeer(storage, makePeer());
    await deleteInboundPeer(storage, AGENT_B);
    expect(await getInboundPeer(storage, AGENT_B)).toBeNull();
  });

  it("delete outbound peer", async () => {
    await setOutboundPeer(storage, makePeer());
    await deleteOutboundPeer(storage, AGENT_B);
    expect(await getOutboundPeer(storage, AGENT_B)).toBeNull();
  });

  it("list inbound peers returns all inbound records", async () => {
    await setInboundPeer(storage, makePeer({ agentId: "a1", agentName: "A1" }));
    await setInboundPeer(storage, makePeer({ agentId: "a2", agentName: "A2" }));
    await setOutboundPeer(storage, makePeer({ agentId: "a3" }));

    const inbound = await listInboundPeers(storage);
    expect(inbound).toHaveLength(2);
    expect(inbound.map((p) => p.agentId).sort()).toEqual(["a1", "a2"]);
  });

  it("list outbound peers returns all outbound records", async () => {
    await setOutboundPeer(storage, makePeer({ agentId: "o1" }));
    await setInboundPeer(storage, makePeer({ agentId: "i1" }));

    const outbound = await listOutboundPeers(storage);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].agentId).toBe("o1");
  });

  it("list returns empty array when no peers", async () => {
    expect(await listInboundPeers(storage)).toEqual([]);
    expect(await listOutboundPeers(storage)).toEqual([]);
  });

  it("overwriting a peer replaces the record", async () => {
    await setInboundPeer(storage, makePeer({ status: "pending" }));
    await setInboundPeer(storage, makePeer({ status: "accepted" }));
    const result = await getInboundPeer(storage, AGENT_B);
    expect(result?.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// rate-limit.ts — sliding window rate limiter
// ---------------------------------------------------------------------------

describe("rate-limit", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("allows first request", async () => {
    expect(await checkRateLimit(storage, "sender-1")).toBe(true);
  });

  it("allows requests up to the limit", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await checkRateLimit(storage, "sender-1")).toBe(true);
    }
  });

  it("blocks after exceeding default limit of 10", async () => {
    for (let i = 0; i < 10; i++) {
      await checkRateLimit(storage, "sender-1");
    }
    expect(await checkRateLimit(storage, "sender-1")).toBe(false);
  });

  it("respects custom maxPerWindow", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(storage, "sender-1", 3)).toBe(true);
    }
    expect(await checkRateLimit(storage, "sender-1", 3)).toBe(false);
  });

  it("isolates limits between different senders", async () => {
    for (let i = 0; i < 10; i++) {
      await checkRateLimit(storage, "sender-1");
    }
    expect(await checkRateLimit(storage, "sender-1")).toBe(false);
    expect(await checkRateLimit(storage, "sender-2")).toBe(true);
  });

  it("resets after window expires", async () => {
    const originalNow = Date.now;
    let time = 1000000;
    Date.now = () => time;

    try {
      for (let i = 0; i < 10; i++) {
        await checkRateLimit(storage, "sender-1");
      }
      expect(await checkRateLimit(storage, "sender-1")).toBe(false);

      // Advance past the 60s window
      time += 61_000;
      expect(await checkRateLimit(storage, "sender-1")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("respects custom windowMs", async () => {
    const originalNow = Date.now;
    let time = 1000000;
    Date.now = () => time;

    try {
      for (let i = 0; i < 2; i++) {
        await checkRateLimit(storage, "sender-1", 2, 5000);
      }
      expect(await checkRateLimit(storage, "sender-1", 2, 5000)).toBe(false);

      // Advance past the 5s custom window
      time += 5001;
      expect(await checkRateLimit(storage, "sender-1", 2, 5000)).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});

// ---------------------------------------------------------------------------
// handlers.ts — HTTP handshake protocol
// ---------------------------------------------------------------------------

describe("handlers", () => {
  let storage: CapabilityStorage;
  let ctx: CapabilityHttpContext;

  beforeEach(() => {
    storage = createMockStorage();
    ctx = makeHttpContext(storage);
  });

  describe("handshakeHandler", () => {
    it("returns correct method and path", () => {
      const handler = handshakeHandler(makeOptions());
      expect(handler.method).toBe("POST");
      expect(handler.path).toBe("/agent-handshake");
    });

    it("rejects request without auth headers", async () => {
      const handler = handshakeHandler(makeOptions());
      const request = new Request("https://agent/agent-handshake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Missing auth headers");
    });

    it("rejects request with invalid token", async () => {
      const handler = handshakeHandler(makeOptions());
      const headers = new Headers({ "Content-Type": "application/json" });
      setAuthHeaders(headers, "invalid-token", AGENT_B);
      const request = new Request("https://agent/agent-handshake", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid or expired token");
    });

    it("rejects token signed with wrong secret", async () => {
      const handler = handshakeHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        "wrong-secret",
        { agentName: "Agent B" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(401);
    });

    it("accepts handshake with auto-allow policy (default)", async () => {
      const handler = handshakeHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        SECRET,
        { agentName: "Agent B" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "accepted" });

      // Verify peer was stored
      const peer = await getInboundPeer(storage, AGENT_B);
      expect(peer).not.toBeNull();
      expect(peer!.status).toBe("accepted");
      expect(peer!.agentName).toBe("Agent B");
    });

    it("returns pending status with user-approval policy", async () => {
      const handler = handshakeHandler(makeOptions({ sameOwnerPolicy: "user-approval" }));
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        SECRET,
        { agentName: "Agent B" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "pending" });

      // Verify broadcast was called for pending
      expect(ctx.broadcastToAll).toHaveBeenCalledWith("agent_ops_handshake_pending", {
        agentId: AGENT_B,
        agentName: "Agent B",
      });
    });

    it("returns rejected status with auto-disallow policy", async () => {
      const handler = handshakeHandler(makeOptions({ sameOwnerPolicy: "auto-disallow" }));
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        SECRET,
        { agentName: "Agent B" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "rejected" });
    });

    it("does not broadcast for non-pending statuses", async () => {
      const handler = handshakeHandler(makeOptions({ sameOwnerPolicy: "auto-allow" }));
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        SECRET,
        { agentName: "Agent B" },
      );
      await handler.handler(request, ctx);
      expect(ctx.broadcastToAll).not.toHaveBeenCalled();
    });

    it("returns existing status for idempotent requests", async () => {
      // Pre-store a peer record
      await setInboundPeer(storage, makePeer({ agentId: AGENT_B, status: "rejected" }));

      const handler = handshakeHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        SECRET,
        { agentName: "New Name" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "rejected" });
    });

    it("uses sender ID as agentName when not provided in body", async () => {
      const handler = handshakeHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake",
        AGENT_B,
        AGENT_A,
        SECRET,
        {},
      );
      await handler.handler(request, ctx);
      const peer = await getInboundPeer(storage, AGENT_B);
      expect(peer!.agentName).toBe(AGENT_B);
    });
  });

  describe("handshakeApproveHandler", () => {
    it("returns correct method and path", () => {
      const handler = handshakeApproveHandler(makeOptions());
      expect(handler.method).toBe("POST");
      expect(handler.path).toBe("/agent-handshake-approve");
    });

    it("rejects missing agentId", async () => {
      const handler = handshakeApproveHandler(makeOptions());
      const request = new Request("https://agent/agent-handshake-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 404 when no pending handshake exists", async () => {
      const handler = handshakeApproveHandler(makeOptions());
      const request = new Request("https://agent/agent-handshake-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "unknown-agent" }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(404);
    });

    it("approves a pending handshake and sends callback", async () => {
      // Pre-store a pending peer
      await setInboundPeer(storage, makePeer({ status: "pending" }));

      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
      });

      const handler = handshakeApproveHandler(options);
      const request = new Request("https://agent/agent-handshake-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_B }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);

      // Verify peer was updated to accepted
      const peer = await getInboundPeer(storage, AGENT_B);
      expect(peer!.status).toBe("accepted");

      // Verify callback was sent
      expect(mockFetch).toHaveBeenCalledOnce();
      const [callUrl, callInit] = mockFetch.mock.calls[0];
      expect(callUrl).toBe("https://agent/agent-handshake-callback");
      expect(callInit.method).toBe("POST");
      const callBody = JSON.parse(callInit.body);
      expect(callBody).toEqual({ status: "accepted" });
    });

    it("succeeds even if callback fails", async () => {
      await setInboundPeer(storage, makePeer({ status: "pending" }));

      const mockFetch = vi.fn().mockRejectedValue(new Error("unreachable"));
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
      });

      const handler = handshakeApproveHandler(options);
      const request = new Request("https://agent/agent-handshake-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_B }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);

      // Peer should still be updated
      const peer = await getInboundPeer(storage, AGENT_B);
      expect(peer!.status).toBe("accepted");
    });
  });

  describe("handshakeDenyHandler", () => {
    it("returns correct method and path", () => {
      const handler = handshakeDenyHandler(makeOptions());
      expect(handler.method).toBe("POST");
      expect(handler.path).toBe("/agent-handshake-deny");
    });

    it("rejects missing agentId", async () => {
      const handler = handshakeDenyHandler(makeOptions());
      const request = new Request("https://agent/agent-handshake-deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 404 when no pending handshake exists", async () => {
      const handler = handshakeDenyHandler(makeOptions());
      const request = new Request("https://agent/agent-handshake-deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "unknown" }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(404);
    });

    it("denies a pending handshake and sends callback", async () => {
      await setInboundPeer(storage, makePeer({ status: "pending" }));

      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
      });

      const handler = handshakeDenyHandler(options);
      const request = new Request("https://agent/agent-handshake-deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_B }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);

      const peer = await getInboundPeer(storage, AGENT_B);
      expect(peer!.status).toBe("rejected");

      // Verify callback body
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody).toEqual({ status: "rejected" });
    });

    it("succeeds even if callback fails", async () => {
      await setInboundPeer(storage, makePeer({ status: "pending" }));

      const mockFetch = vi.fn().mockRejectedValue(new Error("unreachable"));
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
      });

      const handler = handshakeDenyHandler(options);
      const request = new Request("https://agent/agent-handshake-deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_B }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);
    });
  });

  describe("handshakeCallbackHandler", () => {
    it("returns correct method and path", () => {
      const handler = handshakeCallbackHandler(makeOptions());
      expect(handler.method).toBe("POST");
      expect(handler.path).toBe("/agent-handshake-callback");
    });

    it("rejects missing auth headers", async () => {
      const handler = handshakeCallbackHandler(makeOptions());
      const request = new Request("https://agent/agent-handshake-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(401);
    });

    it("rejects invalid token", async () => {
      const handler = handshakeCallbackHandler(makeOptions());
      const headers = new Headers({ "Content-Type": "application/json" });
      setAuthHeaders(headers, "bad-token", AGENT_B);
      const request = new Request("https://agent/agent-handshake-callback", {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "accepted" }),
      });
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(401);
    });

    it("rejects invalid status value", async () => {
      const handler = handshakeCallbackHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake-callback",
        AGENT_B,
        AGENT_A,
        SECRET,
        { status: "invalid" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Invalid status");
    });

    it("updates outbound peer status on accepted callback", async () => {
      // Pre-store an outbound pending record
      await setOutboundPeer(storage, makePeer({ agentId: AGENT_B, status: "pending" }));

      const handler = handshakeCallbackHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake-callback",
        AGENT_B,
        AGENT_A,
        SECRET,
        { status: "accepted" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);

      const peer = await getOutboundPeer(storage, AGENT_B);
      expect(peer!.status).toBe("accepted");
    });

    it("updates outbound peer status on rejected callback", async () => {
      await setOutboundPeer(storage, makePeer({ agentId: AGENT_B, status: "pending" }));

      const handler = handshakeCallbackHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake-callback",
        AGENT_B,
        AGENT_A,
        SECRET,
        { status: "rejected" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);

      const peer = await getOutboundPeer(storage, AGENT_B);
      expect(peer!.status).toBe("rejected");
    });

    it("succeeds even if no outbound record exists (no-op update)", async () => {
      const handler = handshakeCallbackHandler(makeOptions());
      const request = await makeAuthRequest(
        "https://agent/agent-handshake-callback",
        AGENT_B,
        AGENT_A,
        SECRET,
        { status: "accepted" },
      );
      const response = await handler.handler(request, ctx);
      expect(response.status).toBe(200);

      // No record should be created
      expect(await getOutboundPeer(storage, AGENT_B)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// capability.ts — agentPeering() factory
// ---------------------------------------------------------------------------

describe("agentPeering", () => {
  it("returns capability with correct metadata", () => {
    const { capability } = agentPeering(makeOptions());
    expect(capability.id).toBe("agent-peering");
    expect(capability.name).toBe("Agent Peering");
    expect(typeof capability.description).toBe("string");
  });

  it("returns 4 HTTP handlers", () => {
    const storage = createMockStorage();
    const { capability } = agentPeering(makeOptions());
    const handlers = capability.httpHandlers!({
      storage,
      agentId: AGENT_A,
      sessionId: "",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      schedules: {} as any,
    });
    expect(handlers).toHaveLength(4);
    const paths = handlers.map((h) => h.path);
    expect(paths).toContain("/agent-handshake");
    expect(paths).toContain("/agent-handshake-approve");
    expect(paths).toContain("/agent-handshake-deny");
    expect(paths).toContain("/agent-handshake-callback");
  });

  it("returns prompt sections", () => {
    const storage = createMockStorage();
    const { capability } = agentPeering(makeOptions());
    const sections = capability.promptSections!({
      storage,
      agentId: AGENT_A,
      sessionId: "",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      schedules: {} as any,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("peering");
  });

  describe("service (lazy storage)", () => {
    it("throws when service is used before capability is registered", async () => {
      const { service } = agentPeering(makeOptions());
      await expect(service.isPeerAuthorized("x")).rejects.toThrow("Peering not initialized");
    });

    it("service works after httpHandlers initializes storage", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions());

      // Initialize storage via httpHandlers
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      // Now service should work
      expect(await service.isPeerAuthorized("unknown")).toBe(false);
    });

    it("service works after promptSections initializes storage", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions());

      capability.promptSections!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      expect(await service.isPeerAuthorized("unknown")).toBe(false);
    });

    it("isPeerAuthorized returns true for accepted inbound peer", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions());
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      await setInboundPeer(storage, makePeer({ status: "accepted" }));
      expect(await service.isPeerAuthorized(AGENT_B)).toBe(true);
    });

    it("isPeerAuthorized returns false for pending/rejected peers", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions());
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      await setInboundPeer(storage, makePeer({ status: "pending" }));
      expect(await service.isPeerAuthorized(AGENT_B)).toBe(false);

      await setInboundPeer(storage, makePeer({ status: "rejected" }));
      expect(await service.isPeerAuthorized(AGENT_B)).toBe(false);
    });

    it("listPeers delegates to correct direction", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions());
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      await setInboundPeer(storage, makePeer({ agentId: "in-1" }));
      await setOutboundPeer(storage, makePeer({ agentId: "out-1" }));

      const inbound = await service.listPeers("inbound");
      expect(inbound).toHaveLength(1);
      expect(inbound[0].agentId).toBe("in-1");

      const outbound = await service.listPeers("outbound");
      expect(outbound).toHaveLength(1);
      expect(outbound[0].agentId).toBe("out-1");
    });

    it("requestPeer sends handshake and stores outbound record", async () => {
      const storage = createMockStorage();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
      });
      const { capability, service } = agentPeering(options);
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      const result = await service.requestPeer(AGENT_B);
      expect(result.status).toBe("accepted");
      expect(result.agentId).toBe(AGENT_B);

      // Verify outbound record was stored
      const peer = await getOutboundPeer(storage, AGENT_B);
      expect(peer).not.toBeNull();
      expect(peer!.status).toBe("accepted");

      // Verify fetch was called with auth headers
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://agent/agent-handshake");
      expect(init.headers.get("x-agent-token")).toBeTruthy();
      expect(init.headers.get("x-agent-id")).toBe(AGENT_A);
    });

    it("requestPeer throws on non-ok response", async () => {
      const storage = createMockStorage();
      const mockFetch = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
      });
      const { capability, service } = agentPeering(options);
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      await expect(service.requestPeer(AGENT_B)).rejects.toThrow("Handshake failed: 403");
    });

    it("requestPeer uses resolveDoId for token target", async () => {
      const storage = createMockStorage();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const options = makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
        resolveDoId: (id) => `resolved-${id}`,
      });
      const { capability, service } = agentPeering(options);
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      const result = await service.requestPeer(AGENT_B);
      expect(result.status).toBe("accepted");
    });

    it("requestPeer uses agentId as agentName when agentName not set", async () => {
      const storage = createMockStorage();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const options = makeOptions({
        agentName: undefined,
        getAgentStub: () => ({ fetch: mockFetch }),
      });
      const { capability, service } = agentPeering(options);
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      await service.requestPeer(AGENT_B);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.agentName).toBe(AGENT_A);
    });

    it("revokePeer removes both inbound and outbound records", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions());
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      await setInboundPeer(storage, makePeer());
      await setOutboundPeer(storage, makePeer());

      await service.revokePeer(AGENT_B);
      expect(await getInboundPeer(storage, AGENT_B)).toBeNull();
      expect(await getOutboundPeer(storage, AGENT_B)).toBeNull();
    });

    it("checkRateLimit delegates to rate limiter", async () => {
      const storage = createMockStorage();
      const { capability, service } = agentPeering(makeOptions({ rateLimit: 2 }));
      capability.httpHandlers!({
        storage,
        agentId: AGENT_A,
        sessionId: "",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        schedules: {} as any,
      });

      expect(await service.checkRateLimit("sender")).toBe(true);
      expect(await service.checkRateLimit("sender")).toBe(true);
      expect(await service.checkRateLimit("sender")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// service.ts — standalone createPeeringService factory
// ---------------------------------------------------------------------------

describe("createPeeringService", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("isPeerAuthorized returns false when no peer exists", async () => {
    const svc = createPeeringService(storage, makeOptions());
    expect(await svc.isPeerAuthorized("unknown")).toBe(false);
  });

  it("isPeerAuthorized returns true for accepted peer", async () => {
    await setInboundPeer(storage, makePeer({ status: "accepted" }));
    const svc = createPeeringService(storage, makeOptions());
    expect(await svc.isPeerAuthorized(AGENT_B)).toBe(true);
  });

  it("isPeerAuthorized returns false for pending peer", async () => {
    await setInboundPeer(storage, makePeer({ status: "pending" }));
    const svc = createPeeringService(storage, makeOptions());
    expect(await svc.isPeerAuthorized(AGENT_B)).toBe(false);
  });

  it("listPeers inbound", async () => {
    await setInboundPeer(storage, makePeer({ agentId: "a1" }));
    const svc = createPeeringService(storage, makeOptions());
    const peers = await svc.listPeers("inbound");
    expect(peers).toHaveLength(1);
    expect(peers[0].agentId).toBe("a1");
  });

  it("listPeers outbound", async () => {
    await setOutboundPeer(storage, makePeer({ agentId: "o1" }));
    const svc = createPeeringService(storage, makeOptions());
    const peers = await svc.listPeers("outbound");
    expect(peers).toHaveLength(1);
    expect(peers[0].agentId).toBe("o1");
  });

  it("requestPeer sends handshake and stores outbound", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const svc = createPeeringService(
      storage,
      makeOptions({ getAgentStub: () => ({ fetch: mockFetch }) }),
    );
    const result = await svc.requestPeer(AGENT_B);
    expect(result.status).toBe("accepted");
    expect(await getOutboundPeer(storage, AGENT_B)).not.toBeNull();
  });

  it("requestPeer throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const svc = createPeeringService(
      storage,
      makeOptions({ getAgentStub: () => ({ fetch: mockFetch }) }),
    );
    await expect(svc.requestPeer(AGENT_B)).rejects.toThrow("Handshake failed: 500");
  });

  it("requestPeer uses resolveDoId", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "pending" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const svc = createPeeringService(
      storage,
      makeOptions({
        getAgentStub: () => ({ fetch: mockFetch }),
        resolveDoId: (id) => `resolved-${id}`,
      }),
    );
    const result = await svc.requestPeer(AGENT_B);
    expect(result.status).toBe("pending");
  });

  it("revokePeer removes both directions", async () => {
    await setInboundPeer(storage, makePeer());
    await setOutboundPeer(storage, makePeer());
    const svc = createPeeringService(storage, makeOptions());
    await svc.revokePeer(AGENT_B);
    expect(await getInboundPeer(storage, AGENT_B)).toBeNull();
    expect(await getOutboundPeer(storage, AGENT_B)).toBeNull();
  });

  it("checkRateLimit delegates correctly", async () => {
    const svc = createPeeringService(storage, makeOptions({ rateLimit: 1 }));
    expect(await svc.checkRateLimit("s1")).toBe(true);
    expect(await svc.checkRateLimit("s1")).toBe(false);
  });
});
