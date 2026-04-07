import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor } from "../server/executor.js";
import type { A2AHandler } from "../server/handler.js";
import { createA2AServerHandlers } from "../server/transport.js";
import type { AgentCard, JsonRpcErrorResponse, JsonRpcSuccessResponse } from "../types.js";
import { A2A_PROTOCOL_VERSION } from "../version.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

function createMockExecutor(): AgentExecutor {
  return {
    execute: vi.fn(),
    cancel: vi.fn(),
    getAgentCard: () =>
      ({
        name: "Test Agent",
        description: "A test agent",
        url: "https://test.example.com",
        version: "1.0.0",
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: { streaming: true },
        skills: [],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      }) as AgentCard,
  };
}

function createMockHandler(response: unknown = { jsonrpc: "2.0", id: 1, result: {} }): A2AHandler {
  return {
    handleRequest: vi.fn().mockResolvedValue(response),
  } as unknown as A2AHandler;
}

describe("createA2AServerHandlers", () => {
  it("returns two handlers", () => {
    const handlers = createA2AServerHandlers({
      handler: createMockHandler(),
      executor: createMockExecutor(),
    });

    expect(handlers).toHaveLength(2);
  });

  describe("GET /.well-known/agent-card.json", () => {
    it("has correct method and path", () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const agentCardHandler = handlers[0];
      expect(agentCardHandler.method).toBe("GET");
      expect(agentCardHandler.path).toBe("/.well-known/agent-card.json");
    });

    it("returns agent card as JSON", async () => {
      const executor = createMockExecutor();
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor,
      });

      const response = await handlers[0].handler(new Request("https://test"), {} as R);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect((body as R).name).toBe("Test Agent");
      expect((body as R).protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    });

    it("sets correct headers", async () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const response = await handlers[0].handler(new Request("https://test"), {} as R);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
      expect(response.headers.get("A2A-Version")).toBe(A2A_PROTOCOL_VERSION);
    });
  });

  describe("POST /a2a", () => {
    it("has correct method and path", () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const a2aHandler = handlers[1];
      expect(a2aHandler.method).toBe("POST");
      expect(a2aHandler.path).toBe("/a2a");
    });

    it("rejects unsupported A2A version", async () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        headers: { "A2A-Version": "99.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(400);

      const body = (await response.json()) as JsonRpcErrorResponse;
      expect(body.error.code).toBe(-32009);
    });

    it("accepts default version when header is missing", async () => {
      const handler = createMockHandler({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      const handlers = createA2AServerHandlers({
        handler,
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(200);
    });

    it("runs auth middleware when provided", async () => {
      const authenticate = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
        authenticate,
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(401);
      expect(authenticate).toHaveBeenCalledOnce();
    });

    it("passes through when auth middleware returns null", async () => {
      const authenticate = vi.fn().mockResolvedValue(null);
      const handler = createMockHandler({ jsonrpc: "2.0", id: 1, result: { ok: true } });

      const handlers = createA2AServerHandlers({
        handler,
        executor: createMockExecutor(),
        authenticate,
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(200);
    });

    it("returns parse error for invalid JSON", async () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: "not json",
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(400);

      const body = (await response.json()) as JsonRpcErrorResponse;
      expect(body.error.code).toBe(-32700);
    });

    it("rejects invalid JSON-RPC envelope (missing jsonrpc)", async () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ id: 1, method: "message/send" }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(400);

      const body = (await response.json()) as JsonRpcErrorResponse;
      expect(body.error.code).toBe(-32600);
    });

    it("rejects invalid JSON-RPC envelope (missing method)", async () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(400);
    });

    it("rejects invalid JSON-RPC envelope (missing id)", async () => {
      const handlers = createA2AServerHandlers({
        handler: createMockHandler(),
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "message/send" }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(400);
    });

    it("returns JSON-RPC success response from handler", async () => {
      const handler = createMockHandler({
        jsonrpc: "2.0",
        id: 1,
        result: { id: "task-1", status: { state: "completed" } },
      });

      const handlers = createA2AServerHandlers({
        handler,
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(200);
      expect(response.headers.get("A2A-Version")).toBe(A2A_PROTOCOL_VERSION);

      const body = (await response.json()) as JsonRpcSuccessResponse;
      expect(body.jsonrpc).toBe("2.0");
    });

    it("returns error status for JSON-RPC error response", async () => {
      const handler = createMockHandler({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Task not found" },
      });

      const handlers = createA2AServerHandlers({
        handler,
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.status).toBe(404); // httpStatusForError maps -32001 to 404
    });

    it("returns SSE response for ReadableStream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const handler = createMockHandler(stream);

      const handlers = createA2AServerHandlers({
        handler,
        executor: createMockExecutor(),
      });

      const request = new Request("https://test/a2a", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/stream", params: {} }),
      });

      const response = await handlers[1].handler(request, {} as R);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("X-Accel-Buffering")).toBe("no");
      expect(response.headers.get("A2A-Version")).toBe(A2A_PROTOCOL_VERSION);
    });
  });
});
