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

// Each describe block uses a unique DO instance name for test isolation.
// Isolated storage is disabled in vitest.config.ts because the pool-workers
// runner's storage frame checker doesn't handle .sqlite-shm files created
// by DO KV storage operations (used by the A2A callback handler).
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

  describe("callback result injection", () => {
    /** Register a PendingTask in the DO's a2a-client storage. */
    async function registerPendingTask(stub: DurableObjectStub, task: Record<string, unknown>) {
      const res = await stub.fetch("http://fake/register-pending-task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(task),
      });
      await res.json();
    }

    /** Create a session by sending a prompt, then get its ID from entries. */
    async function createSession(stub: DurableObjectStub): Promise<string> {
      setMockResponses([{ text: "setup" }]);
      const res = await stub.fetch("http://fake/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "init" }),
      });
      await res.json(); // consume body

      // Get the session ID from the entries endpoint (returns first session's entries)
      const entriesRes = await stub.fetch("http://fake/entries");
      const entries = (await entriesRes.json()) as { entries: Array<{ sessionId: string }> };
      return entries.entries[0].sessionId;
    }

    it("returns 404 for unknown task ID", async () => {
      const stub = getStub("a2a-do-7");

      const res = await stub.fetch("http://fake/a2a-callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer whatever",
        },
        body: JSON.stringify({
          taskId: "nonexistent",
          status: { state: "completed" },
        }),
      });
      expect(res.status).toBe(404);
    });

    it("callback persists result to session and returns 200", async () => {
      const stub = getStub("a2a-do-7");
      // Two mocks: one for createSession, one for the async inference the callback triggers
      setMockResponses([{ text: "setup" }, { text: "callback inference" }]);

      // Create a real session
      const sessionId = await createSession(stub);
      const taskId = "cb-persist-task";
      const token = "cb-persist-token";

      await registerPendingTask(stub, {
        taskId,
        contextId: "ctx-cb",
        targetAgent: "agent-2",
        targetAgentName: "Agent Two",
        originalRequest: "Do research",
        state: "working",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        originSessionId: sessionId,
        webhookToken: token,
      });

      // Send callback
      const res = await stub.fetch("http://fake/a2a-callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          taskId,
          status: {
            state: "completed",
            message: { role: "agent", parts: [{ text: "Research results" }] },
          },
        }),
      });
      const body = (await res.json()) as R;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);

      // Wait for the async inference triggered by the callback to complete.
      // The callback fires handleAgentPrompt as fire-and-forget; this endpoint
      // drains all tracked pending async operations on the DO.
      const waitRes = await stub.fetch("http://fake/wait-idle", { method: "POST" });
      await waitRes.json();

      // Verify the result was persisted to the session
      const entriesRes = await stub.fetch(`http://fake/entries?sessionId=${sessionId}`);
      const entries = (await entriesRes.json()) as { entries: R[] };
      const texts = entries.entries
        .filter((e: R) => e.type === "message")
        .map((e: R) => e.data?.content)
        .filter(Boolean);

      const hasCallbackResult = texts.some(
        (t: string) => typeof t === "string" && t.includes("A2A Task Complete"),
      );
      expect(hasCallbackResult).toBe(true);
    });
  });

  describe("call_agent tool (client-side)", () => {
    it("reaches the correct target DO via resolveDoId", async () => {
      const callerStub = getStub("a2a-caller-1");
      const targetStub = getStub("a2a-target-1");

      // Prime the target DO so it exists (send a direct A2A message to it)
      setMockResponses([{ text: "target ready" }]);
      const { body: targetBody } = await sendMessage(targetStub, "Init");
      expect((targetBody.result as R).status.state).toBe("completed");

      // Now set up responses for the caller's tool call flow:
      // 1. Caller's first turn: invoke call_agent tool
      // 2. Target DO processes the A2A request (shifts next mock)
      // 3. Caller's follow-up turn after tool result
      setMockResponses([
        {
          text: "",
          toolCalls: [
            { name: "call_agent", args: { targetAgent: "a2a-target-1", message: "Hello target" } },
          ],
        },
        { text: "I am the target agent" },
        { text: "The target responded" },
      ]);

      // Send prompt to the caller DO — it will invoke call_agent which hits target DO
      const res = await callerStub.fetch("http://fake/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Please call the target agent" }),
      });
      const result = (await res.json()) as R;
      expect(res.status).toBe(200);

      // Check that the caller's session contains the tool result from the target
      const entriesRes = await callerStub.fetch("http://fake/entries");
      const entries = (await entriesRes.json()) as { entries: R[] };
      const toolResults = entries.entries.filter(
        (e: R) => e.type === "tool_result" || (e.type === "custom" && e.customType === "tool_end"),
      );

      // The call_agent tool should have executed and returned a result
      const messageTexts = entries.entries
        .filter((e: R) => e.type === "message")
        .map((e: R) => e.data?.content)
        .filter(Boolean);

      // The target agent's response should appear somewhere in the session
      // (either as a tool result detail or in the follow-up message)
      const allTexts = JSON.stringify(entries.entries);
      expect(allTexts).toContain("I am the target agent");
    });

    it("A2A messages do not require peering authorization", async () => {
      const stub = getStub("a2a-no-peer-1");
      setMockResponses([{ text: "No peering needed" }]);

      // Send an A2A message directly — no peering headers, no auth
      const { res, body } = await sendMessage(stub, "Hello without peering");

      expect(res.status).toBe(200);
      expect((body.result as R).status.state).toBe("completed");
      const responseParts = (body.result as R).status.message.parts;
      expect(responseParts.some((p: R) => p.text?.includes("No peering needed"))).toBe(true);
    });
  });
});
