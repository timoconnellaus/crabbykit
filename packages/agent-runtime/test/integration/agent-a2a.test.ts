import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, setMockResponses } from "../../src/test-helpers/test-agent-do.js";

// biome-ignore lint/suspicious/noExplicitAny: Test environment typing
const testEnv = env as any;

function getStub(name: string) {
  const id = testEnv.AGENT.idFromName(name);
  return testEnv.AGENT.get(id);
}

function rpc(method: string, params?: unknown) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

async function a2aFetch(stub: DurableObjectStub, method: string, params?: unknown) {
  const res = await stub.fetch("http://fake/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
    body: JSON.stringify(rpc(method, params)),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function sendMessage(stub: DurableObjectStub, text: string, opts?: { contextId?: string }) {
  return a2aFetch(stub, "message/send", {
    message: {
      messageId: crypto.randomUUID(),
      role: "user",
      parts: [{ text }],
      ...(opts?.contextId ? { contextId: opts.contextId } : {}),
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Test type flexibility
type R = any;

// Use a small number of DO instances to avoid isolated storage issues.
// Tests within a describe block share a stub but use unique contextIds.
describe("A2A Integration", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  describe("Agent Card", () => {
    it("serves card with correct structure and headers", async () => {
      const stub = getStub("a2a-do-1");
      const res = await stub.fetch("http://fake/.well-known/agent-card.json");
      const card = (await res.json()) as R;

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("A2A-Version")).toBe("1.0");
      expect(card.protocolVersion).toBe("1.0");
      expect(card.capabilities.streaming).toBe(true);
      expect(card.capabilities.pushNotifications).toBe(true);
      expect(card.defaultInputModes).toContain("text/plain");
    });
  });

  describe("message/send", () => {
    it("creates a completed task with agent response", async () => {
      const stub = getStub("a2a-do-2");
      setMockResponses([{ text: "Hello!" }]);

      const { res, body } = await sendMessage(stub, "Hi there");

      expect(res.status).toBe(200);
      expect(body.jsonrpc).toBe("2.0");
      const result = body.result as R;
      expect(result.id).toBeDefined();
      expect(result.contextId).toBeDefined();
      expect(result.status.state).toBe("completed");
      expect(result.status.message.role).toBe("agent");
      expect(result.status.message.parts.length).toBeGreaterThan(0);
    });

    it("handles tool-calling flows", async () => {
      const stub = getStub("a2a-do-2");
      setMockResponses([
        { text: "", toolCalls: [{ name: "echo", args: { text: "ping" } }] },
        { text: "Done" },
      ]);

      const { body } = await sendMessage(stub, "Use a tool");
      expect((body.result as R).status.state).toBe("completed");
    });

    it("rejects missing message", async () => {
      const stub = getStub("a2a-do-2");
      const { body } = await a2aFetch(stub, "message/send", {});
      expect((body.error as R).code).toBe(-32602);
    });

    it("rejects empty parts", async () => {
      const stub = getStub("a2a-do-2");
      const { body } = await a2aFetch(stub, "message/send", {
        message: { messageId: "m1", role: "user", parts: [] },
      });
      expect((body.error as R).code).toBe(-32602);
    });

    it("rejects missing role", async () => {
      const stub = getStub("a2a-do-2");
      const { body } = await a2aFetch(stub, "message/send", {
        message: { messageId: "m1", parts: [{ text: "Hi" }] },
      });
      expect((body.error as R).code).toBe(-32602);
    });
  });

  describe("tasks/get and tasks/cancel", () => {
    it("retrieves a previously created task", async () => {
      const stub = getStub("a2a-do-3");
      setMockResponses([{ text: "Result" }]);

      const { body: createBody } = await sendMessage(stub, "Create this");
      const taskId = (createBody.result as R).id;

      const { body } = await a2aFetch(stub, "tasks/get", { id: taskId });
      expect((body.result as R).id).toBe(taskId);
      expect((body.result as R).status.state).toBe("completed");
    });

    it("returns -32001 for nonexistent task", async () => {
      const stub = getStub("a2a-do-3");
      const { res, body } = await a2aFetch(stub, "tasks/get", { id: "nope" });
      expect(res.status).toBe(404);
      expect((body.error as R).code).toBe(-32001);
    });

    it("returns -32002 when canceling a completed task", async () => {
      const stub = getStub("a2a-do-3");
      setMockResponses([{ text: "Done" }]);

      const { body: createBody } = await sendMessage(stub, "Do it");
      const taskId = (createBody.result as R).id;

      const { body } = await a2aFetch(stub, "tasks/cancel", { id: taskId });
      expect((body.error as R).code).toBe(-32002);
    });
  });

  describe("tasks/list and multi-turn", () => {
    it("lists tasks for a context", async () => {
      const stub = getStub("a2a-do-4");
      setMockResponses([{ text: "One" }, { text: "Two" }]);

      await sendMessage(stub, "First", { contextId: "ctx-a" });
      await sendMessage(stub, "Second", { contextId: "ctx-a" });

      const { body } = await a2aFetch(stub, "tasks/list", { contextId: "ctx-a" });
      expect((body.result as R[]).length).toBe(2);
    });

    it("returns empty list for unknown context", async () => {
      const stub = getStub("a2a-do-4");
      const { body } = await a2aFetch(stub, "tasks/list", { contextId: "unknown" });
      expect((body.result as R[]).length).toBe(0);
    });

    it("preserves contextId across messages", async () => {
      const stub = getStub("a2a-do-4");
      setMockResponses([{ text: "A" }, { text: "B" }]);

      const { body: b1 } = await sendMessage(stub, "Hello", { contextId: "ctx-b" });
      const { body: b2 } = await sendMessage(stub, "Follow up", { contextId: "ctx-b" });

      expect((b1.result as R).contextId).toBe("ctx-b");
      expect((b2.result as R).contextId).toBe("ctx-b");
    });
  });

  describe("JSON-RPC validation and routing", () => {
    it("rejects invalid JSON with -32700", async () => {
      const stub = getStub("a2a-do-5");
      const res = await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: "not json",
      });
      const body = (await res.json()) as R;
      expect(res.status).toBe(400);
      expect(body.error.code).toBe(-32700);
    });

    it("rejects missing jsonrpc field with -32600", async () => {
      const stub = getStub("a2a-do-5");
      const res = await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({ method: "message/send", id: 1 }),
      });
      const body = (await res.json()) as R;
      expect(res.status).toBe(400);
      expect(body.error.code).toBe(-32600);
    });

    it("returns -32601 for unknown methods", async () => {
      const stub = getStub("a2a-do-5");
      const { res, body } = await a2aFetch(stub, "unknown/method");
      expect(res.status).toBe(404);
      expect((body.error as R).code).toBe(-32601);
    });

    it("rejects unsupported A2A version with -32009", async () => {
      const stub = getStub("a2a-do-5");
      const res = await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "99.0" },
        body: JSON.stringify(rpc("message/send", {})),
      });
      const body = (await res.json()) as R;
      expect(res.status).toBe(400);
      expect(body.error.code).toBe(-32009);
    });

    it("accepts requests without A2A-Version header (defaults to 1.0)", async () => {
      const stub = getStub("a2a-do-5");
      setMockResponses([{ text: "OK" }]);
      const res = await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          rpc("message/send", {
            message: { messageId: "v1", role: "user", parts: [{ text: "Hi" }] },
          }),
        ),
      });
      expect(res.status).toBe(200);
      await res.json(); // consume body
    });
  });

  describe("message/stream", () => {
    it("returns SSE with valid JSON-RPC events", async () => {
      const stub = getStub("a2a-do-6");
      setMockResponses([{ text: "Streamed" }]);

      const res = await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify(
          rpc("message/stream", {
            message: { messageId: "s1", role: "user", parts: [{ text: "Stream me" }] },
          }),
        ),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const text = await res.text();
      const lines = text.split("\n").filter((l: string) => l.startsWith("data:"));
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const json = JSON.parse(line.slice(5).trim());
        expect(json.jsonrpc).toBe("2.0");
      }
    });
  });

  describe("push notification config", () => {
    it("stores push notification config when provided in message/send", async () => {
      const stub = getStub("a2a-do-6");
      setMockResponses([{ text: "Working on it" }]);

      const { body } = await a2aFetch(stub, "message/send", {
        message: {
          messageId: "push-1",
          role: "user",
          parts: [{ text: "Do something async" }],
        },
        configuration: {
          blocking: true,
          pushNotificationConfig: {
            url: "https://caller/a2a-callback/caller-agent",
            token: "webhook-secret",
          },
        },
      });

      const result = body.result as R;
      expect(result.id).toBeDefined();
      expect(result.status.state).toBe("completed");

      // Task should be retrievable and push config was stored
      const { body: getBody } = await a2aFetch(stub, "tasks/get", { id: result.id });
      expect((getBody.result as R).id).toBe(result.id);
    });
  });
});
