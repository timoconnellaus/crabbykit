import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, setMockResponses } from "../src/test-agent";

function getStub(name = "e2e-smoke") {
  const id = env.AGENT.idFromName(name);
  return env.AGENT.get(id);
}

async function prompt(stub: DurableObjectStub, text: string, sessionId?: string) {
  const body: Record<string, string> = { text };
  if (sessionId) body.sessionId = sessionId;

  const res = await stub.fetch("http://fake/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: Test helper
  return res.json() as Promise<{ sessionId: string; entries: any[] }>;
}

async function executeTool(
  stub: DurableObjectStub,
  toolName: string,
  args: Record<string, unknown> = {},
  sessionId?: string,
) {
  const body: Record<string, unknown> = { toolName, args };
  if (sessionId) body.sessionId = sessionId;

  const res = await stub.fetch("http://fake/execute-tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function getSessions(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/sessions");
  // biome-ignore lint/suspicious/noExplicitAny: Test helper
  return res.json() as Promise<{ sessions: any[] }>;
}

async function getEntries(stub: DurableObjectStub, sessionId?: string) {
  const url = sessionId ? `http://fake/entries?sessionId=${sessionId}` : "http://fake/entries";
  const res = await stub.fetch(url);
  // biome-ignore lint/suspicious/noExplicitAny: Test helper
  return res.json() as Promise<{ entries: any[] }>;
}

describe("E2E Smoke", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("prompt creates a session and persists messages", async () => {
    const stub = getStub("smoke-1");
    setMockResponses([{ text: "Hello from the mock!" }]);

    const result = await prompt(stub, "Hi there");

    expect(result.sessionId).toBeDefined();
    expect(result.entries.length).toBeGreaterThanOrEqual(2); // user + assistant

    const userEntry = result.entries.find((e) => e.type === "message" && e.data?.role === "user");
    const assistantEntry = result.entries.find(
      (e) => e.type === "message" && e.data?.role === "assistant",
    );
    expect(userEntry).toBeDefined();
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry.data.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello from the mock!" }),
    );
  });

  it("executes the echo tool directly", async () => {
    const stub = getStub("smoke-2");
    const result = await executeTool(stub, "echo", { text: "ping" });

    expect(result.toolName).toBe("echo");
    expect(result.result).toEqual({
      content: [{ type: "text", text: "Echo: ping" }],
      details: { echoed: "ping" },
    });
  });

  it("file_write + file_read round-trip via R2", async () => {
    const stub = getStub("smoke-3");

    // Write a file
    const writeResult = await executeTool(stub, "file_write", {
      path: "test/hello.txt",
      content: "Hello from e2e!",
    });
    expect(writeResult.result).toBeDefined();

    // Read it back
    const readResult = await executeTool(stub, "file_read", {
      path: "test/hello.txt",
    });
    const content = readResult.result as { content: Array<{ type: string; text: string }> };
    expect(content.content[0].text).toContain("Hello from e2e!");
  });

  it("returns 404 for unknown tools", async () => {
    const stub = getStub("smoke-4");
    const res = await stub.fetch("http://fake/execute-tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName: "nonexistent", args: {} }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; available: string[] };
    expect(body.error).toContain("nonexistent");
    expect(body.available).toContain("echo");
    expect(body.available).toContain("file_read");
    expect(body.available).toContain("file_write");
  });

  it("mock tool calls are executed for real", async () => {
    const stub = getStub("smoke-5");

    // Queue: LLM "decides" to call echo, then gives follow-up text
    setMockResponses([
      { text: "Let me echo that.", toolCalls: [{ name: "echo", args: { text: "e2e" } }] },
      { text: "Done! The echo said e2e." },
    ]);

    const result = await prompt(stub, "Echo something for me");

    // Should have: user msg, assistant msg with tool call, tool result, follow-up assistant
    const toolResults = result.entries.filter(
      (e) => e.type === "message" && e.data?.role === "toolResult",
    );
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].data.content[0].text).toBe("Echo: e2e");
  });
});
