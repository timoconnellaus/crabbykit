import {
  getAuthFromRequest,
  setAuthHeaders,
  signToken,
  verifyToken,
} from "@claw-for-cloudflare/agent-auth";
import type {
  CapabilityHttpContext,
  CapabilityStorage,
  HttpHandler,
} from "@claw-for-cloudflare/agent-runtime";
import type { MessagingOptions } from "./types.js";

const DEFAULT_MAX_DEPTH = 5;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function authenticateSender(
  request: Request,
  options: MessagingOptions,
): Promise<{ senderId: string } | Response> {
  const auth = getAuthFromRequest(request);
  if (!auth) {
    return jsonResponse({ error: "Missing auth headers" }, 401);
  }

  const payload = await verifyToken(auth.token, options.agentId, options.secret);
  if (!payload) {
    return jsonResponse({ error: "Invalid or expired token" }, 401);
  }

  return { senderId: payload.sender };
}

interface IncomingMessageBody {
  message: string;
  senderName?: string;
  depth?: number;
}

function parseMessageBody(raw: unknown): IncomingMessageBody | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("message" in raw) ||
    typeof (raw as Record<string, unknown>).message !== "string"
  ) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return {
    message: obj.message as string,
    senderName: typeof obj.senderName === "string" ? obj.senderName : undefined,
    depth: typeof obj.depth === "number" ? obj.depth : undefined,
  };
}

async function checkAccess(
  options: MessagingOptions,
  senderId: string,
  depth: number | undefined,
  storage: CapabilityStorage,
): Promise<Response | null> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const currentDepth = depth ?? 0;
  if (currentDepth >= maxDepth) {
    return jsonResponse({ error: "Max hop depth exceeded" }, 429);
  }

  // Store incoming depth so tools can read it when sending outbound messages
  await storage.put("depth", currentDepth);

  if (options.peeringService) {
    const authorized = await options.peeringService.isPeerAuthorized(senderId);
    if (!authorized) {
      return jsonResponse({ error: "Peer not authorized" }, 403);
    }

    const withinLimit = await options.peeringService.checkRateLimit(senderId);
    if (!withinLimit) {
      return jsonResponse({ error: "Rate limit exceeded" }, 429);
    }
  }

  return null;
}

/**
 * POST /agent-message-sync — Synchronous message processing.
 * Verify HMAC, check depth/peering, run inference, return response.
 */
function syncMessageHandler(
  options: MessagingOptions,
  getStorage: () => CapabilityStorage,
): HttpHandler {
  return {
    method: "POST",
    path: "/agent-message-sync",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const authResult = await authenticateSender(request, options);
      if (authResult instanceof Response) return authResult;

      const raw: unknown = await request.json();
      const body = parseMessageBody(raw);
      if (!body) {
        return jsonResponse({ error: "Invalid request body" }, 400);
      }

      const accessError = await checkAccess(options, authResult.senderId, body.depth, getStorage());
      if (accessError) return accessError;

      const senderLabel = body.senderName ?? authResult.senderId;
      const result = await ctx.sendPrompt({
        text: body.message,
        sessionName: `From ${senderLabel}`,
        source: "agent",
      });

      return jsonResponse({
        ok: true,
        response: result.response,
        sessionId: result.sessionId,
      });
    },
  };
}

interface AsyncMessageBody extends IncomingMessageBody {
  replyTo?: string;
}

function parseAsyncBody(raw: unknown): AsyncMessageBody | null {
  const base = parseMessageBody(raw);
  if (!base) return null;
  const obj = raw as Record<string, unknown>;
  return {
    ...base,
    replyTo: typeof obj.replyTo === "string" ? obj.replyTo : undefined,
  };
}

/**
 * POST /agent-message — Async message (fire-and-forget with callback).
 * Returns 202 immediately, processes inline, sends reply to sender's /agent-reply.
 */
function asyncMessageHandler(
  options: MessagingOptions,
  getStorage: () => CapabilityStorage,
): HttpHandler {
  return {
    method: "POST",
    path: "/agent-message",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const authResult = await authenticateSender(request, options);
      if (authResult instanceof Response) return authResult;

      const raw: unknown = await request.json();
      const body = parseAsyncBody(raw);
      if (!body) {
        return jsonResponse({ error: "Invalid request body" }, 400);
      }

      const accessError = await checkAccess(options, authResult.senderId, body.depth, getStorage());
      if (accessError) return accessError;

      const messageId = crypto.randomUUID();

      const senderLabel = body.senderName ?? authResult.senderId;
      const result = await ctx.sendPrompt({
        text: body.message,
        sessionName: `From ${senderLabel}`,
        source: "agent",
      });

      // Send reply back to the sender's /agent-reply endpoint
      const replyTo = body.replyTo ?? authResult.senderId;
      try {
        const token = await signToken(options.agentId, replyTo, options.secret);
        const stub = options.getAgentStub(replyTo);
        const headers = new Headers({ "Content-Type": "application/json" });
        setAuthHeaders(headers, token, options.agentId);

        await stub.fetch("https://agent/agent-reply", {
          method: "POST",
          headers,
          body: JSON.stringify({
            messageId,
            response: result.response,
          }),
        });
      } catch {
        // Fire-and-forget: reply delivery failure is silent
      }

      return jsonResponse({ ok: true, messageId }, 202);
    },
  };
}

interface ReplyBody {
  messageId: string;
  response: string;
}

function parseReplyBody(raw: unknown): ReplyBody | null {
  if (typeof raw !== "object" || raw === null || !("messageId" in raw) || !("response" in raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.messageId !== "string" || typeof obj.response !== "string") {
    return null;
  }
  return { messageId: obj.messageId, response: obj.response };
}

/**
 * POST /agent-reply — Receive async reply from target agent.
 * Stores reply in capability storage and broadcasts to clients.
 */
function replyHandler(options: MessagingOptions, getStorage: () => CapabilityStorage): HttpHandler {
  return {
    method: "POST",
    path: "/agent-reply",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      const authResult = await authenticateSender(request, options);
      if (authResult instanceof Response) return authResult;

      const raw: unknown = await request.json();
      const body = parseReplyBody(raw);
      if (!body) {
        return jsonResponse({ error: "Invalid request body" }, 400);
      }

      const storage = getStorage();
      await storage.put(`reply:${body.messageId}`, body.response);

      ctx.broadcastToAll("agent_reply", {
        messageId: body.messageId,
        response: body.response,
        fromAgentId: authResult.senderId,
      });

      return jsonResponse({ ok: true });
    },
  };
}

/**
 * Create the three HTTP handlers for agent messaging.
 */
export function createMessagingHandlers(
  options: MessagingOptions,
  getStorage: () => CapabilityStorage,
): HttpHandler[] {
  return [
    syncMessageHandler(options, getStorage),
    asyncMessageHandler(options, getStorage),
    replyHandler(options, getStorage),
  ];
}
