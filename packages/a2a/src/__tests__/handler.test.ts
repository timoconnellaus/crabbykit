import { describe, expect, it, vi } from "vitest";
import type { A2AEventBus } from "../server/event-bus.js";
import type { AgentExecutor, ExecuteResult } from "../server/executor.js";
import { A2AHandler } from "../server/handler.js";
import type { TaskStore } from "../server/task-store.js";
import type { AgentCard, JsonRpcRequest, JsonRpcSuccessResponse, Task } from "../types.js";

// --- Mock Executor ---

function createMockExecutor(result: ExecuteResult): AgentExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(true),
    getAgentCard: () =>
      ({
        name: "Test Agent",
        description: "A test agent",
        url: "https://test.example.com",
        version: "1.0.0",
        protocolVersion: "1.0",
        capabilities: { streaming: true },
        skills: [],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      }) as AgentCard,
  };
}

// --- Mock TaskStore ---

function createMockTaskStore(): TaskStore {
  const tasks = new Map<string, Task>();
  return {
    create: vi.fn((opts: any) => {
      const task: Task = {
        id: opts.id,
        contextId: opts.contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
      };
      tasks.set(opts.id, task);
      return task;
    }),
    get: vi.fn((id: string) => tasks.get(id) ?? null),
    list: vi.fn(() => [...tasks.values()]),
    updateStatus: vi.fn((id: string, status: any) => {
      const task = tasks.get(id);
      if (task) task.status = status;
    }),
    getSessionId: vi.fn(() => "session-1"),
    getSessionIdForContext: vi.fn(() => null),
    delete: vi.fn(),
    addArtifact: vi.fn(),
    appendArtifactParts: vi.fn(),
    getArtifacts: vi.fn(() => []),
    setPushConfig: vi.fn(),
    getPushConfig: vi.fn(() => null),
    deletePushConfig: vi.fn(),
  } as unknown as TaskStore;
}

// --- Helpers ---

function rpc(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params };
}

function asSuccess(result: unknown): JsonRpcSuccessResponse {
  return result as JsonRpcSuccessResponse;
}

// --- Tests ---

describe("A2AHandler", () => {
  describe("message/send", () => {
    it("returns a task on successful execution", async () => {
      const completedTask: Task = {
        id: "task-abc",
        contextId: "ctx-1",
        status: {
          state: "completed",
          timestamp: "2025-01-01T00:00:00Z",
          message: {
            messageId: "resp-1",
            role: "agent",
            parts: [{ text: "Hello back!" }],
          },
        },
      };

      const executor = createMockExecutor({ task: completedTask });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(
        rpc("message/send", {
          message: {
            messageId: "msg-1",
            role: "user",
            parts: [{ text: "Hello" }],
          },
        }),
      );

      const resp = asSuccess(result);
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe(1);
      expect(executor.execute).toHaveBeenCalledOnce();
    });

    it("returns error for missing message", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(rpc("message/send", {}));

      expect((result as any).error.code).toBe(-32602);
      expect((result as any).error.message).toContain("message");
    });

    it("returns error for empty parts", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(
        rpc("message/send", {
          message: { messageId: "m1", role: "user", parts: [] },
        }),
      );

      expect((result as any).error.code).toBe(-32602);
    });
  });

  describe("tasks/get", () => {
    it("returns task not found error", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(rpc("tasks/get", { id: "nonexistent" }));

      expect((result as any).error.code).toBe(-32001);
    });

    it("returns error for missing id param", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(rpc("tasks/get", {}));

      expect((result as any).error.code).toBe(-32602);
    });
  });

  describe("tasks/cancel", () => {
    it("returns error for terminal task", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();

      // Pre-create a completed task
      (taskStore.create as any)({ id: "task-done", contextId: "ctx", sessionId: "s" });
      (taskStore.updateStatus as any)("task-done", {
        state: "completed",
        timestamp: new Date().toISOString(),
      });

      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(rpc("tasks/cancel", { id: "task-done" }));

      expect((result as any).error.code).toBe(-32002);
    });
  });

  describe("method routing", () => {
    it("returns method not found for unknown methods", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(rpc("unknown/method"));

      expect((result as any).error.code).toBe(-32601);
      expect((result as any).error.message).toContain("unknown/method");
    });
  });
});
