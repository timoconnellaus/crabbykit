import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers to avoid resolution failure when importing tools
class MockDurableObject {}
class MockWorkerEntrypoint {}
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export names
vi.mock("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
  WorkerEntrypoint: MockWorkerEntrypoint,
}));

const { createCallAgentTool } = await import("../client/tools.js");
type A2AToolOptions = import("../client/tools.js").A2AToolOptions;

// Minimal mock of CapabilityStorage matching the interface
function mockStorage() {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
    list: async () => store,
  };
}

describe("A2A client tools", () => {
  describe("resolveDoId", () => {
    it("call_agent resolves ID via resolveDoId before calling getAgentStub", async () => {
      const getAgentStub = vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                id: "task-1",
                contextId: "ctx-1",
                status: {
                  state: "completed",
                  message: { role: "agent", parts: [{ text: "Hello from target" }] },
                },
              },
            }),
          ),
        ),
      });

      const resolveDoId = vi.fn().mockImplementation((id: string) => `resolved-${id}`);

      const options: A2AToolOptions = {
        agentId: "caller-agent",
        getAgentStub,
        resolveDoId,
        callbackBaseUrl: "https://agent",
        maxDepth: 5,
      };

      const storage = mockStorage();
      const tool = createCallAgentTool(
        options,
        () => storage as any,
        () => "session-1",
      );

      const result = await tool.execute(
        { targetAgent: "some-uuid-or-name", message: "Hello" },
        { toolCallId: "tc-1" },
      );

      // resolveDoId should have been called with the raw target
      expect(resolveDoId).toHaveBeenCalledWith("some-uuid-or-name");
      // getAgentStub should receive the resolved ID
      expect(getAgentStub).toHaveBeenCalledWith("resolved-some-uuid-or-name");

      // Tool should return the target's response
      const firstContent = result.content[0];
      expect(firstContent.type).toBe("text");
      expect("text" in firstContent && firstContent.text).toContain("Hello from target");
    });

    it("call_agent uses raw ID when resolveDoId is not provided", async () => {
      const getAgentStub = vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                id: "task-1",
                contextId: "ctx-1",
                status: {
                  state: "completed",
                  message: { role: "agent", parts: [{ text: "Response" }] },
                },
              },
            }),
          ),
        ),
      });

      const options: A2AToolOptions = {
        agentId: "caller-agent",
        getAgentStub,
        // No resolveDoId
        callbackBaseUrl: "https://agent",
        maxDepth: 5,
      };

      const storage = mockStorage();
      const tool = createCallAgentTool(
        options,
        () => storage as any,
        () => "session-1",
      );

      await tool.execute({ targetAgent: "raw-agent-id", message: "Hello" }, { toolCallId: "tc-1" });

      // getAgentStub should receive the raw ID directly
      expect(getAgentStub).toHaveBeenCalledWith("raw-agent-id");
    });

    it("call_agent does not call resolveDoId for URL targets", async () => {
      const getAgentStub = vi.fn();
      const resolveDoId = vi.fn();

      // Mock global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              id: "task-1",
              contextId: "ctx-1",
              status: {
                state: "completed",
                message: { role: "agent", parts: [{ text: "External" }] },
              },
            },
          }),
        ),
      ) as typeof fetch;

      try {
        const options: A2AToolOptions = {
          agentId: "caller-agent",
          getAgentStub,
          resolveDoId,
          callbackBaseUrl: "https://agent",
          maxDepth: 5,
        };

        const storage = mockStorage();
        const tool = createCallAgentTool(
          options,
          () => storage as any,
          () => "session-1",
        );

        await tool.execute(
          { targetAgent: "https://external-agent.com/a2a", message: "Hello" },
          { toolCallId: "tc-1" },
        );

        // Neither resolveDoId nor getAgentStub should be called for URL targets
        expect(resolveDoId).not.toHaveBeenCalled();
        expect(getAgentStub).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
