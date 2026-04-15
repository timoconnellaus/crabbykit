import type { HttpHandler } from "@claw-for-cloudflare/agent-runtime";
import {
  httpStatusForError,
  invalidRequestError,
  parseError,
  versionNotSupportedError,
} from "../errors.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../types.js";
import { isJsonRpcError } from "../types.js";
import { A2A_PROTOCOL_VERSION, DEFAULT_VERSION, SUPPORTED_VERSIONS } from "../version.js";
import type { AgentExecutor } from "./executor.js";
import type { A2AHandler } from "./handler.js";

// ============================================================================
// Transport Options
// ============================================================================

export interface A2ATransportOptions {
  handler: A2AHandler;
  executor: AgentExecutor;
  /** Optional auth middleware. Return null to allow, or a Response to reject. */
  authenticate?: (request: Request) => Promise<Response | null>;
}

// ============================================================================
// Workers HTTP Handlers
// ============================================================================

/**
 * Create CLAW HttpHandler[] for the A2A server endpoints.
 * Registers two routes:
 *   GET  /.well-known/agent-card.json  — public agent card
 *   POST /a2a                          — JSON-RPC endpoint
 */
export function createA2AServerHandlers(options: A2ATransportOptions): HttpHandler[] {
  return [
    {
      method: "GET",
      path: "/.well-known/agent-card.json",
      handler: async () => {
        const card = options.executor.getAgentCard();
        return new Response(JSON.stringify(card), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            "A2A-Version": A2A_PROTOCOL_VERSION,
          },
        });
      },
    },
    {
      method: "POST",
      path: "/a2a",
      handler: async (request) => {
        // Version negotiation
        const version = request.headers.get("A2A-Version") ?? DEFAULT_VERSION;
        if (!SUPPORTED_VERSIONS.has(version)) {
          return jsonResponse(versionNotSupportedError(null, version), 400);
        }

        // Optional auth middleware
        if (options.authenticate) {
          const authResponse = await options.authenticate(request);
          if (authResponse) return authResponse;
        }

        // Parse JSON-RPC body
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse(parseError(null), 400);
        }

        // Validate JSON-RPC envelope
        const rpcRequest = body as JsonRpcRequest;
        if (
          !rpcRequest ||
          rpcRequest.jsonrpc !== "2.0" ||
          !rpcRequest.method ||
          rpcRequest.id === undefined
        ) {
          return jsonResponse(
            invalidRequestError(rpcRequest?.id ?? null, "Invalid JSON-RPC 2.0 request"),
            400,
          );
        }

        // Route to handler
        const result = await options.handler.handleRequest(rpcRequest);

        // Streaming response (SSE)
        if (result instanceof ReadableStream) {
          return new Response(result, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
              "A2A-Version": A2A_PROTOCOL_VERSION,
            },
          });
        }

        // Standard JSON-RPC response
        const status = isJsonRpcError(result) ? httpStatusForError(result.error.code) : 200;
        return jsonResponse(result, status);
      },
    },
  ];
}

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(body: JsonRpcResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": A2A_PROTOCOL_VERSION,
    },
  });
}
