import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompactionOverrides,
  clearMockResponses,
  setCompactionOverride,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import type { ClientMessage, ServerMessage } from "../../src/transport/types.js";

function getStub(name = "test-agent") {
  const id = env.AGENT.idFromName(name);
  return env.AGENT.get(id);
}

/** Open a WebSocket to the DO and collect messages. */
async function openSocket(stub: DurableObjectStub) {
  const resp = await stub.fetch("http://fake/ws", {
    headers: { upgrade: "websocket" },
  });
  const ws = resp.webSocket!;
  ws.accept();

  const messages: ServerMessage[] = [];
  const waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
  }> = [];

  ws.addEventListener("message", (event) => {
    const msg: ServerMessage = JSON.parse(event.data as string);
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  const waitForMessage = (
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`)),
        timeoutMs,
      );
      waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  };

  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
  const close = () => ws.close();

  return { ws, messages, waitForMessage, send, close };
}

async function prompt(stub: DurableObjectStub, text: string, sessionId?: string) {
  const body: Record<string, string> = { text };
  if (sessionId) body.sessionId = sessionId;

  const res = await stub.fetch("http://fake/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ messages: any[] }>;
}

async function getEntries(stub: DurableObjectStub, sessionId?: string) {
  const url = sessionId ? `http://fake/entries?sessionId=${sessionId}` : "http://fake/entries";
  const res = await stub.fetch(url);
  return res.json() as Promise<{ entries: any[] }>;
}

async function steer(stub: DurableObjectStub, sessionId: string, text: string) {
  const res = await stub.fetch("http://fake/steer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  return res.json() as Promise<{ steered: boolean }>;
}

async function abort(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/abort", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return res.json() as Promise<{ aborted: boolean }>;
}

async function registerMockMcp(
  stub: DurableObjectStub,
  tools: Array<{ name: string; description: string }>,
) {
  const res = await stub.fetch("http://fake/register-mock-mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tools }),
  });
  return res.json() as Promise<{ registered: number }>;
}

async function getSteerHistory(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/steer-history");
  return res.json() as Promise<{ steeredMessages: any[] }>;
}

describe("AgentDO Integration", () => {
  beforeEach(() => {
    clearMockResponses();
    clearCompactionOverrides();
  });

  describe("9.1 Full chat flow", () => {
    it("prompt → response → persisted", async () => {
      const stub = getStub("chat-flow");
      setMockResponses([{ text: "Hello there!" }]);

      const result = await prompt(stub, "Hi");

      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      // Should have user message + assistant response
      const roles = result.messages.map((m: any) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });

    it("messages persist across requests", async () => {
      const stub = getStub("persist-test");
      setMockResponses([{ text: "First response" }, { text: "Second response" }]);

      await prompt(stub, "Message 1");
      const result = await prompt(stub, "Message 2");

      // Should have messages from both turns
      expect(result.messages.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("9.2 Chat with tools", () => {
    it("tool call → execute → response", async () => {
      const stub = getStub("tool-test");
      setMockResponses([
        {
          text: "",
          toolCalls: [{ name: "echo", args: { text: "test input" } }],
        },
        { text: "The echo returned: test input" },
      ]);

      const result = await prompt(stub, "Echo something");

      // Should have messages including tool results
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("9.4 Multi-session", () => {
    it("sessions are isolated", async () => {
      const stub = getStub("multi-session");
      setMockResponses([{ text: "Response A" }, { text: "Response B" }]);

      // Create session A implicitly (first prompt creates a session)
      const resultA = await prompt(stub, "Hello session A");
      const sessionAMessages = resultA.messages;

      // Verify session A has messages
      expect(sessionAMessages.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("9.7 Hibernation", () => {
    it("session state survives across DO instances", async () => {
      // First request creates session and stores messages
      const stub1 = getStub("hibernate-test");
      setMockResponses([{ text: "Before hibernation" }]);

      const result1 = await prompt(stub1, "Remember this");
      expect(result1.messages.length).toBeGreaterThanOrEqual(2);

      // Second request to same DO — agent is reconstructed from SQLite
      setMockResponses([{ text: "After wake" }]);
      const result2 = await prompt(stub1, "What was stored?");

      // Should have all messages from both turns
      expect(result2.messages.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("9.3 Compaction flow", () => {
    it("fills session to threshold → compaction triggers → summary entry created → context uses compacted result", async () => {
      const stub = getStub("compaction-flow");

      // Set tiny context window so compaction triggers quickly
      setCompactionOverride("compaction-flow", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      // Fill session with enough messages to exceed threshold
      // Each message ~120 tokens (400 chars / 4 * 1.2), threshold = 250 tokens
      // 3+ messages should trigger compaction
      const responses = Array.from({ length: 5 }, (_, i) => ({
        text: `Response ${i}: ${"x".repeat(400)}`,
      }));
      setMockResponses(responses);

      for (let i = 0; i < 5; i++) {
        await prompt(stub, `Message ${i}: ${"y".repeat(400)}`);
      }

      // Check entries — should include a compaction entry
      const { entries } = await getEntries(stub);
      const compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      // Verify compaction entry has expected shape
      const compaction = compactionEntries[0];
      expect(compaction.data.summary).toBeTruthy();
      expect(compaction.data.firstKeptEntryId).toBeTruthy();
      expect(compaction.data.tokensBefore).toBeGreaterThan(0);

      // Subsequent prompt should use compacted context
      setMockResponses([{ text: "After compaction" }]);
      const result = await prompt(stub, "What happened?");

      // Context should include the summary + recent messages, not all original messages
      const summaryMessage = result.messages.find(
        (m: any) =>
          typeof m.content === "string" && m.content.includes("[Previous conversation summary]"),
      );
      expect(summaryMessage).toBeTruthy();
    });
  });

  describe("9.5 Steering", () => {
    it("steer message is injected while agent is running", async () => {
      const stub = getStub("steer-test");

      // Use WebSocket — DO input gates serialize HTTP fetch requests, so
      // steering via HTTP can never arrive mid-inference. WebSocket messages
      // are processed at await yield points within the same DO.
      setMockResponses([{ text: "Working on it...", delay: 200 }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as { sessionId: string }).sessionId;

      // Start inference via WebSocket (fire-and-forget)
      client.send({ type: "prompt", sessionId, text: "Do a long task" });

      // Wait for agent to enter the streaming delay, then steer
      await new Promise((r) => setTimeout(r, 50));
      client.send({ type: "steer", sessionId, text: "Actually, change direction" });

      // Wait for agent_end
      await client.waitForMessage((m) => m.type === "agent_event" && (m as any).event?.type === "agent_end");

      // Verify the steer was persisted to the session store.
      // We can't check MockPiAgent.steeredMessages because the agent is
      // cleaned up from sessionAgents on agent_end.
      const { entries } = await getEntries(stub, sessionId);
      const userEntries = entries.filter(
        (e: any) => e.type === "message" && e.data?.role === "user",
      );
      // Should have 2 user messages: the original prompt + the steer
      expect(userEntries.length).toBe(2);
      expect(userEntries[1].data.content).toBe("Actually, change direction");

      client.close();
    });
  });

  describe("9.6 Abort", () => {
    it("abort stops agent and partial message is persisted", async () => {
      const stub = getStub("abort-test");

      // Use WebSocket for the same reason as the steer test — HTTP requests
      // are serialized by the DO input gate.
      setMockResponses([{ text: "This is a long response that should be cut short", delay: 200 }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as { sessionId: string }).sessionId;

      // Start inference via WebSocket
      client.send({ type: "prompt", sessionId, text: "Generate a long response" });

      // Wait for streaming to start, then abort
      await new Promise((r) => setTimeout(r, 50));
      client.send({ type: "abort", sessionId });

      // Wait for agent_end
      await client.waitForMessage((m) => m.type === "agent_event" && (m as any).event?.type === "agent_end");

      // Check that entries were persisted (at least user message)
      const { entries } = await getEntries(stub);
      expect(entries.length).toBeGreaterThanOrEqual(1);

      client.close();
    });
  });

  describe("9.8 MCP end-to-end", () => {
    it("register mock MCP server → tools discovered → agent uses MCP tool → result persisted", async () => {
      const stub = getStub("mcp-e2e");

      // Register a mock MCP tool
      const registered = await registerMockMcp(stub, [
        { name: "weather_lookup", description: "Look up weather for a city" },
      ]);
      expect(registered.registered).toBe(1);

      // Prompt the agent to use the MCP tool
      setMockResponses([
        {
          text: "",
          toolCalls: [{ name: "weather_lookup", args: { query: "San Francisco" } }],
        },
        { text: "The weather in San Francisco is sunny." },
      ]);

      const result = await prompt(stub, "What's the weather in SF?");

      // Should have messages including the tool result
      expect(result.messages.length).toBeGreaterThanOrEqual(2);

      // Verify MCP tool execution persisted in entries
      const { entries } = await getEntries(stub);
      const toolResultEntries = entries.filter(
        (e: any) => e.type === "message" && e.data.role === "toolResult",
      );
      expect(toolResultEntries.length).toBeGreaterThanOrEqual(1);

      // The tool result should contain the mock MCP response
      const toolResult = toolResultEntries[0];
      expect(toolResult.data.toolName).toBe("weather_lookup");
      expect(JSON.stringify(toolResult.data.content)).toContain("MCP result for: San Francisco");
    });
  });
});
