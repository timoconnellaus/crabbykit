import { describe, expect, it, vi } from "vitest";
import { A2AClientError, A2AHttpClient } from "../client/http-client.js";
import { A2A_PROTOCOL_VERSION } from "../version.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcSuccess(result: unknown): unknown {
  return { jsonrpc: "2.0", id: "test-id", result };
}

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: "test-id", error: { code, message } };
}

describe("A2AHttpClient", () => {
  describe("sendMessage", () => {
    it("sends a JSON-RPC request and returns a task", async () => {
      const task = { id: "t1", contextId: "ctx-1", status: { state: "completed" } };
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcSuccess(task)));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      const result = await client.sendMessage({
        message: { messageId: "m1", role: "user", parts: [{ text: "Hello" }] },
      });

      expect(result.id).toBe("t1");
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://agent.example.com/a2a");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["A2A-Version"]).toBe(A2A_PROTOCOL_VERSION);
    });

    it("unwraps task from { task: Task } wrapper", async () => {
      const task = { id: "t1", contextId: "ctx-1", status: { state: "completed" } };
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcSuccess({ task })));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      const result = await client.sendMessage({
        message: { messageId: "m1", role: "user", parts: [{ text: "Hello" }] },
      });

      expect(result.id).toBe("t1");
    });

    it("handles URL that already ends with /a2a", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(rpcSuccess({ id: "t1", contextId: "c1", status: { state: "completed" } })),
        );

      const client = new A2AHttpClient("https://agent.example.com/a2a", mockFetch as R);
      await client.sendMessage({
        message: { messageId: "m1", role: "user", parts: [{ text: "Hello" }] },
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://agent.example.com/a2a");
    });

    it("throws A2AClientError on JSON-RPC error", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcError(-32001, "Task not found")));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);

      await expect(
        client.sendMessage({
          message: { messageId: "m1", role: "user", parts: [{ text: "Hello" }] },
        }),
      ).rejects.toThrow(A2AClientError);
    });

    it("throws A2AClientError on HTTP error", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 }));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);

      await expect(
        client.sendMessage({
          message: { messageId: "m1", role: "user", parts: [{ text: "Hello" }] },
        }),
      ).rejects.toThrow(A2AClientError);
    });

    it("includes auth headers when provided", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(rpcSuccess({ id: "t1", contextId: "c1", status: { state: "completed" } })),
        );

      const authHeaders = vi.fn().mockResolvedValue({ Authorization: "Bearer my-token" });
      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R, authHeaders);

      await client.sendMessage({
        message: { messageId: "m1", role: "user", parts: [{ text: "Hello" }] },
      });

      expect(authHeaders).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer my-token");
    });
  });

  describe("getTask", () => {
    it("returns a task by id", async () => {
      const task = { id: "t1", contextId: "ctx-1", status: { state: "working" } };
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcSuccess(task)));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      const result = await client.getTask("t1");

      expect(result.id).toBe("t1");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("tasks/get");
      expect(body.params.id).toBe("t1");
    });

    it("includes historyLength when provided", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(rpcSuccess({ id: "t1", contextId: "c1", status: { state: "completed" } })),
        );

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      await client.getTask("t1", 10);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.historyLength).toBe(10);
    });
  });

  describe("cancelTask", () => {
    it("cancels a task", async () => {
      const task = { id: "t1", contextId: "ctx-1", status: { state: "canceled" } };
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcSuccess(task)));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      const result = await client.cancelTask("t1");

      expect(result.status.state).toBe("canceled");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("tasks/cancel");
      expect(body.params.id).toBe("t1");
    });
  });

  describe("listTasks", () => {
    it("lists all tasks", async () => {
      const tasks = [{ id: "t1" }, { id: "t2" }];
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcSuccess(tasks)));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      const result = await client.listTasks();

      expect(result).toHaveLength(2);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("tasks/list");
    });

    it("filters by contextId", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(rpcSuccess([])));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      await client.listTasks("ctx-1");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.contextId).toBe("ctx-1");
    });
  });

  describe("sendMessageStream", () => {
    it("yields stream events from SSE", async () => {
      const event1 = { statusUpdate: { taskId: "t1", status: { state: "working" } } };
      const event2 = { statusUpdate: { taskId: "t1", status: { state: "completed" } } };

      const sseBody =
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: event1 })}\n\n` +
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: event2 })}\n\n`;

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);
      const events: unknown[] = [];

      for await (const event of client.sendMessageStream({
        message: { messageId: "m1", role: "user", parts: [{ text: "Stream" }] },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect((events[0] as R).statusUpdate.status.state).toBe("working");
      expect((events[1] as R).statusUpdate.status.state).toBe("completed");
    });

    it("throws on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 }));

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);

      await expect(async () => {
        for await (const _event of client.sendMessageStream({
          message: { messageId: "m1", role: "user", parts: [{ text: "Stream" }] },
        })) {
          // Should not reach here
        }
      }).rejects.toThrow(A2AClientError);
    });

    it("throws on empty response body", async () => {
      const response = new Response(null, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      // Force body to null
      const mockFetch = vi.fn().mockResolvedValue(response);

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);

      // Response has a body (empty ReadableStream) in the spec, so we need a custom response
      // that truly has no body. This tests the guard path.
      const noBodyResponse = {
        ok: true,
        status: 200,
        body: null,
        text: async () => "",
      } as unknown as Response;
      mockFetch.mockResolvedValue(noBodyResponse);

      await expect(async () => {
        for await (const _event of client.sendMessageStream({
          message: { messageId: "m1", role: "user", parts: [{ text: "Stream" }] },
        })) {
          // noop
        }
      }).rejects.toThrow("No response body");
    });

    it("throws on JSON-RPC error in stream", async () => {
      const sseBody = `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      })}\n\n`;

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

      const client = new A2AHttpClient("https://agent.example.com", mockFetch as R);

      await expect(async () => {
        for await (const _event of client.sendMessageStream({
          message: { messageId: "m1", role: "user", parts: [{ text: "Stream" }] },
        })) {
          // noop
        }
      }).rejects.toThrow(A2AClientError);
    });
  });
});

describe("A2AClientError", () => {
  it("has correct properties", () => {
    const error = new A2AClientError(500, "Server Error", { detail: "something" });
    expect(error.code).toBe(500);
    expect(error.message).toBe("Server Error");
    expect(error.data).toEqual({ detail: "something" });
    expect(error.name).toBe("A2AClientError");
  });

  it("extends Error", () => {
    const error = new A2AClientError(400, "Bad Request");
    expect(error).toBeInstanceOf(Error);
  });
});
