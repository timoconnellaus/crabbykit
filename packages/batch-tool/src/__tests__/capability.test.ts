import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { batchTool } from "../capability.js";

function makeTool(
  name: string,
  result = "ok",
  opts: { throws?: boolean; delay?: number } = {},
): AgentTool {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: {},
    execute: async () => {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      if (opts.throws) throw new Error(`${name} failed`);
      return { content: [{ type: "text" as const, text: result }], details: {} };
    },
  } as unknown as AgentTool;
}

function getCapTools(getTools: () => AgentTool[]) {
  const cap = batchTool({ getTools });
  const ctx = {
    agentId: "test",
    sessionId: "s1",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    storage: createNoopStorage(),
    schedules: {} as never,
  };
  return cap.tools!(ctx);
}

async function executeBatch(
  getTools: () => AgentTool[],
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
) {
  const tools = getCapTools(getTools);
  const batch = tools[0];
  return batch.execute({ calls }, { toolCallId: "test-batch" });
}

describe("batchTool", () => {
  describe("capability shape", () => {
    it("returns a valid Capability with correct id", () => {
      const cap = batchTool({ getTools: () => [] });
      expect(cap.id).toBe("batch-tool");
      expect(cap.tools).toBeInstanceOf(Function);
      expect(cap.promptSections).toBeInstanceOf(Function);
    });

    it("provides a single 'batch' tool", () => {
      const tools = getCapTools(() => []);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("batch");
    });
  });

  describe("happy path — parallel execution", () => {
    it("executes 3 tools in parallel and returns results in order", async () => {
      const toolA = makeTool("tool_a", "result_a");
      const toolB = makeTool("tool_b", "result_b");
      const toolC = makeTool("tool_c", "result_c");

      const result = await executeBatch(
        () => [toolA, toolB, toolC],
        [
          { tool: "tool_a", args: {} },
          { tool: "tool_b", args: {} },
          { tool: "tool_c", args: {} },
        ],
      );

      const text = textOf(result);
      expect(text).toContain("3 succeeded, 0 failed");
      expect(text).toContain("[0] tool_a: OK");
      expect(text).toContain("[1] tool_b: OK");
      expect(text).toContain("[2] tool_c: OK");
      expect(text).toContain("result_a");
      expect(text).toContain("result_b");
      expect(text).toContain("result_c");
    });

    it("passes args to sub-calls", async () => {
      const spy = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        details: {},
      });
      const tool: AgentTool = {
        name: "search",
        label: "search",
        description: "search",
        parameters: {},
        execute: spy,
      } as unknown as AgentTool;

      await executeBatch(() => [tool], [{ tool: "search", args: { query: "hello" } }]);

      expect(spy).toHaveBeenCalledWith(
        { query: "hello" },
        expect.objectContaining({ toolCallId: "batch-search" }),
      );
    });
  });

  describe("negative — error handling", () => {
    it("blocks self-referential batch calls", async () => {
      const result = await executeBatch(() => [], [{ tool: "batch", args: {} }]);

      const text = textOf(result);
      expect(text).toContain("Recursive batch calls are not allowed");
      expect(text).toContain("0 succeeded, 1 failed");
    });

    it("returns error for unregistered tool name", async () => {
      const result = await executeBatch(
        () => [makeTool("existing")],
        [{ tool: "nonexistent", args: {} }],
      );

      const text = textOf(result);
      expect(text).toContain("Tool 'nonexistent' not found");
      expect(text).toContain("0 succeeded, 1 failed");
    });

    it("returns error for sub-call that throws", async () => {
      const failTool = makeTool("fail_tool", "unused", { throws: true });

      const result = await executeBatch(() => [failTool], [{ tool: "fail_tool", args: {} }]);

      const text = textOf(result);
      expect(text).toContain("fail_tool failed");
      expect(text).toContain("0 succeeded, 1 failed");
    });
  });

  describe("boundary conditions", () => {
    it("handles empty batch (0 items)", async () => {
      const result = await executeBatch(() => [], []);

      const text = textOf(result);
      expect(text).toContain("0 calls (empty batch)");
    });

    it("handles single item batch", async () => {
      const result = await executeBatch(() => [makeTool("a", "done")], [{ tool: "a", args: {} }]);

      const text = textOf(result);
      expect(text).toContain("1 succeeded, 0 failed");
    });

    it("rejects batch exceeding 25 items", async () => {
      const calls = Array.from({ length: 26 }, (_, i) => ({
        tool: `tool_${i}`,
        args: {},
      }));

      const result = await executeBatch(() => [], calls);

      const text = textOf(result);
      expect(text).toContain("Batch limited to 25 tool calls, received 26");
      // biome-ignore lint/suspicious/noExplicitAny: testing error result shape
      expect((result as any).isError).toBe(true);
    });

    it("handles all sub-calls failing", async () => {
      const failTool = makeTool("fail", "unused", { throws: true });

      const result = await executeBatch(
        () => [failTool],
        [
          { tool: "fail", args: {} },
          { tool: "fail", args: {} },
          { tool: "fail", args: {} },
        ],
      );

      const text = textOf(result);
      expect(text).toContain("0 succeeded, 3 failed");
    });
  });

  describe("state — partial success", () => {
    it("failed sub-calls don't abort other sub-calls", async () => {
      const goodTool = makeTool("good", "success");
      const badTool = makeTool("bad", "unused", { throws: true });

      const result = await executeBatch(
        () => [goodTool, badTool],
        [
          { tool: "good", args: {} },
          { tool: "bad", args: {} },
          { tool: "good", args: {} },
        ],
      );

      const text = textOf(result);
      expect(text).toContain("2 succeeded, 1 failed");
      expect(text).toContain("[0] good: OK");
      expect(text).toContain("[1] bad: ERROR");
      expect(text).toContain("[2] good: OK");
    });
  });

  describe("invariants", () => {
    it("result array length equals input array length", async () => {
      const tool = makeTool("t", "ok");

      const result = await executeBatch(
        () => [tool],
        [
          { tool: "t", args: {} },
          { tool: "t", args: {} },
          { tool: "nonexistent", args: {} },
        ],
      );

      const text = textOf(result);
      // 3 entries: [0], [1], [2]
      expect(text).toContain("[0]");
      expect(text).toContain("[1]");
      expect(text).toContain("[2]");
    });

    it("preserves input order in results", async () => {
      const toolA = makeTool("a", "alpha", { delay: 50 });
      const toolB = makeTool("b", "beta");

      // toolA is slower but should still appear first in results
      const result = await executeBatch(
        () => [toolA, toolB],
        [
          { tool: "a", args: {} },
          { tool: "b", args: {} },
        ],
      );

      const text = textOf(result);
      const indexA = text.indexOf("[0] a: OK");
      const indexB = text.indexOf("[1] b: OK");
      expect(indexA).toBeLessThan(indexB);
    });

    it("getTools is called at execute time, not registration time", async () => {
      const getTools = vi.fn().mockReturnValue([makeTool("dynamic", "ok")]);

      const cap = batchTool({ getTools });
      const ctx = {
        agentId: "test",
        sessionId: "s1",
        stepNumber: 0,
        emitCost: () => {},
        broadcast: () => {},
        broadcastToAll: () => {},
        broadcastState: () => {},
        requestFromClient: () => Promise.reject(new Error("Not available")),
        storage: createNoopStorage(),
    schedules: {} as never,
      };
      const tools = cap.tools!(ctx);

      // Not called yet at registration
      expect(getTools).not.toHaveBeenCalled();

      // Called when batch executes
      await tools[0].execute({ calls: [{ tool: "dynamic", args: {} }] }, { toolCallId: "test" });

      expect(getTools).toHaveBeenCalledTimes(1);
    });
  });
});
