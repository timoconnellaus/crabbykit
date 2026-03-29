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

describe("A2A Integration", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("serves agent card at well-known URL", async () => {
    const stub = getStub("a2a-1");
    const res = await stub.fetch("http://fake/.well-known/agent-card.json");
    const card = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(res.headers.get("A2A-Version")).toBe("1.0");
    expect(card.protocolVersion).toBe("1.0");
    expect((card.capabilities as Record<string, unknown>).streaming).toBe(true);
  });

  it("handles message/send and returns completed task", async () => {
    const stub = getStub("a2a-2");
    setMockResponses([{ text: "Hello from A2A!" }]);

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(
        rpc("message/send", {
          message: { messageId: "m1", role: "user", parts: [{ text: "Hi" }] },
        }),
      ),
    });
    const body = (await res.json()) as { result: { id: string; status: { state: string } } };

    expect(res.status).toBe(200);
    expect(body.result.id).toBeDefined();
    expect(body.result.status.state).toBe("completed");
  });

  it("returns error for missing message params", async () => {
    const stub = getStub("a2a-3");

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(rpc("message/send", {})),
    });
    const body = (await res.json()) as { error: { code: number } };

    expect(body.error.code).toBe(-32602);
  });

  it("retrieves a task via tasks/get", async () => {
    const stub = getStub("a2a-4");
    setMockResponses([{ text: "Result" }]);

    // Create
    const createRes = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(
        rpc("message/send", {
          message: { messageId: "m2", role: "user", parts: [{ text: "Do something" }] },
        }),
      ),
    });
    const created = (await createRes.json()) as { result: { id: string } };

    // Get
    const getRes = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(rpc("tasks/get", { id: created.result.id })),
    });
    const got = (await getRes.json()) as { result: { id: string; status: { state: string } } };

    expect(got.result.id).toBe(created.result.id);
    expect(got.result.status.state).toBe("completed");
  });

  it("returns task not found for nonexistent ID", async () => {
    const stub = getStub("a2a-5");

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(rpc("tasks/get", { id: "nonexistent" })),
    });
    const body = (await res.json()) as { error: { code: number } };

    expect(body.error.code).toBe(-32001);
  });

  it("returns method not found for unknown methods", async () => {
    const stub = getStub("a2a-6");

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(rpc("unknown/method")),
    });
    const body = (await res.json()) as { error: { code: number } };

    expect(body.error.code).toBe(-32601);
  });

  it("rejects invalid JSON body", async () => {
    const stub = getStub("a2a-7");

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: "not json",
    });
    const body = (await res.json()) as { error: { code: number } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32700);
  });

  it("rejects missing jsonrpc field", async () => {
    const stub = getStub("a2a-8");

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({ method: "message/send", id: 1 }),
    });
    const body = (await res.json()) as { error: { code: number } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32600);
  });

  it("returns SSE for message/stream", async () => {
    const stub = getStub("a2a-9");
    setMockResponses([{ text: "Streamed" }]);

    const res = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(
        rpc("message/stream", {
          message: { messageId: "ms1", role: "user", parts: [{ text: "Stream" }] },
        }),
      ),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
  });

  it("lists tasks for a context", async () => {
    const stub = getStub("a2a-10");
    setMockResponses([{ text: "One" }, { text: "Two" }]);

    // Create two tasks in same context
    await (
      await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify(
          rpc("message/send", {
            message: { messageId: "ml1", role: "user", parts: [{ text: "A" }], contextId: "ctx" },
          }),
        ),
      })
    ).json();

    await (
      await stub.fetch("http://fake/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify(
          rpc("message/send", {
            message: { messageId: "ml2", role: "user", parts: [{ text: "B" }], contextId: "ctx" },
          }),
        ),
      })
    ).json();

    const listRes = await stub.fetch("http://fake/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(rpc("tasks/list", { contextId: "ctx" })),
    });
    const listBody = (await listRes.json()) as { result: unknown[] };

    expect(listBody.result.length).toBe(2);
  });
});
