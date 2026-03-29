import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, ExecuteResult } from "../server/executor.js";
import { A2AHandler } from "../server/handler.js";
import type { TaskStore } from "../server/task-store.js";
import type { AgentCard, JsonRpcRequest, JsonRpcSuccessResponse, Task } from "../types.js";

// --- Mock Executor ---

function createMockExecutor(
  result: ExecuteResult,
  opts?: { cancelResult?: boolean },
): AgentExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(opts?.cancelResult ?? true),
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
  const pushConfigs = new Map<string, unknown>();

  return {
    create: vi.fn((opts: { id: string; contextId: string }) => {
      const task: Task = {
        id: opts.id,
        contextId: opts.contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
      };
      tasks.set(opts.id, task);
      return task;
    }),
    get: vi.fn((id: string) => tasks.get(id) ?? null),
    list: vi.fn((opts?: { contextId?: string }) => {
      const all = [...tasks.values()];
      if (opts?.contextId) return all.filter((t) => t.contextId === opts.contextId);
      return all;
    }),
    updateStatus: vi.fn((id: string, status: { state: string }) => {
      const task = tasks.get(id);
      if (task) task.status = status as Task["status"];
    }),
    getSessionId: vi.fn(() => "session-1"),
    getSessionIdForContext: vi.fn(() => null),
    delete: vi.fn(),
    addArtifact: vi.fn(),
    appendArtifactParts: vi.fn(),
    getArtifacts: vi.fn(() => []),
    setPushConfig: vi.fn((taskId: string, config: unknown) => {
      pushConfigs.set(taskId, config);
    }),
    getPushConfig: vi.fn((taskId: string) => pushConfigs.get(taskId) ?? null),
    deletePushConfig: vi.fn(),
  } as unknown as TaskStore;
}

// --- Helpers ---

function rpc(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

// --- Tests ---

describe("A2AHandler", () => {
  // -------------------------------------------------------
  // message/send
  // -------------------------------------------------------

  describe("message/send", () => {
    it("returns a completed task with response content", async () => {
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

      const result = (await handler.handleRequest(
        rpc("message/send", {
          message: { messageId: "msg-1", role: "user", parts: [{ text: "Hello" }] },
        }),
      )) as JsonRpcSuccessResponse;

      expect(result.jsonrpc).toBe("2.0");
      expect(executor.execute).toHaveBeenCalledOnce();

      // Verify response content flows through
      const task = result.result as R;
      expect(task.status.state).toBe("completed");
      expect(task.status.message.parts[0].text).toBe("Hello back!");
    });

    it("returns a direct message response when executor returns message", async () => {
      const executor = createMockExecutor({
        message: {
          messageId: "m1",
          role: "agent",
          parts: [{ text: "Quick reply" }],
        },
      });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = (await handler.handleRequest(
        rpc("message/send", {
          message: { messageId: "msg-1", role: "user", parts: [{ text: "Hi" }] },
        }),
      )) as JsonRpcSuccessResponse;

      const msg = result.result as R;
      expect(msg.role).toBe("agent");
      expect(msg.parts[0].text).toBe("Quick reply");
    });

    it("stores push notification config when provided", async () => {
      const executor = createMockExecutor({
        task: {
          id: "task-1",
          contextId: "ctx",
          status: { state: "completed", timestamp: "now" },
        },
      });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      await handler.handleRequest(
        rpc("message/send", {
          message: { messageId: "m1", role: "user", parts: [{ text: "Hi" }] },
          configuration: {
            pushNotificationConfig: {
              url: "https://callback/a2a-callback/agent-1",
              token: "secret",
            },
          },
        }),
      );

      expect(taskStore.setPushConfig).toHaveBeenCalledOnce();
      const [, config] = (taskStore.setPushConfig as R).mock.calls[0];
      expect(config.url).toBe("https://callback/a2a-callback/agent-1");
      expect(config.token).toBe("secret");
    });

    it("returns internal error when executor throws", async () => {
      const executor = createMockExecutor({ task: undefined });
      (executor.execute as R).mockRejectedValue(new Error("LLM API down"));
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(
        rpc("message/send", {
          message: { messageId: "m1", role: "user", parts: [{ text: "Hi" }] },
        }),
      );

      expect((result as R).error.code).toBe(-32603);
      expect((result as R).error.message).toContain("LLM API down");
    });

    it("rejects referencing a terminal task", async () => {
      const executor = createMockExecutor({ task: undefined });
      const taskStore = createMockTaskStore();
      // Create a completed task
      (taskStore.create as R)({ id: "done-task", contextId: "ctx" });
      (taskStore.updateStatus as R)("done-task", { state: "completed", timestamp: "now" });

      const handler = new A2AHandler({ executor, taskStore });

      const result = await handler.handleRequest(
        rpc("message/send", {
          message: {
            messageId: "m1",
            role: "user",
            parts: [{ text: "Follow up" }],
            taskId: "done-task",
          },
        }),
      );

      expect((result as R).error.code).toBe(-32004); // unsupported operation
    });

    it("rejects missing message", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(rpc("message/send", {}));
      expect((result as R).error.code).toBe(-32602);
    });

    it("rejects empty parts", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(
        rpc("message/send", { message: { messageId: "m1", role: "user", parts: [] } }),
      );
      expect((result as R).error.code).toBe(-32602);
    });

    it("rejects missing role", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(
        rpc("message/send", { message: { messageId: "m1", parts: [{ text: "Hi" }] } }),
      );
      expect((result as R).error.code).toBe(-32602);
    });

    it("rejects missing messageId", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(
        rpc("message/send", { message: { role: "user", parts: [{ text: "Hi" }] } }),
      );
      expect((result as R).error.code).toBe(-32602);
    });
  });

  // -------------------------------------------------------
  // message/stream
  // -------------------------------------------------------

  describe("message/stream", () => {
    it("returns a ReadableStream", async () => {
      const task: Task = {
        id: "t1",
        contextId: "c1",
        status: { state: "completed", timestamp: "now" },
      };
      const executor = createMockExecutor({ task });
      const taskStore = createMockTaskStore();
      const handler = new A2AHandler({ executor, taskStore });

      const result = handler.handleRequest(
        rpc("message/stream", {
          message: { messageId: "m1", role: "user", parts: [{ text: "Stream" }] },
        }),
      );

      // The result should be a ReadableStream (or a promise resolving to one)
      const resolved = await result;
      expect(resolved instanceof ReadableStream).toBe(true);
    });
  });

  // -------------------------------------------------------
  // tasks/get
  // -------------------------------------------------------

  describe("tasks/get", () => {
    it("returns task with artifacts attached", async () => {
      const executor = createMockExecutor({});
      const taskStore = createMockTaskStore();
      (taskStore.create as R)({ id: "t1", contextId: "c1" });
      (taskStore.getArtifacts as R).mockReturnValue([
        { artifactId: "a1", parts: [{ text: "artifact content" }] },
      ]);

      const handler = new A2AHandler({ executor, taskStore });
      const result = (await handler.handleRequest(
        rpc("tasks/get", { id: "t1" }),
      )) as JsonRpcSuccessResponse;

      const task = result.result as R;
      expect(task.id).toBe("t1");
      expect(task.artifacts).toHaveLength(1);
      expect(task.artifacts[0].artifactId).toBe("a1");
    });

    it("returns -32001 for nonexistent task", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(rpc("tasks/get", { id: "nope" }));
      expect((result as R).error.code).toBe(-32001);
    });

    it("returns -32602 for missing id", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(rpc("tasks/get", {}));
      expect((result as R).error.code).toBe(-32602);
    });
  });

  // -------------------------------------------------------
  // tasks/cancel
  // -------------------------------------------------------

  describe("tasks/cancel", () => {
    it("cancels a working task", async () => {
      const executor = createMockExecutor({}, { cancelResult: true });
      const taskStore = createMockTaskStore();
      (taskStore.create as R)({ id: "working-task", contextId: "c1" });
      (taskStore.updateStatus as R)("working-task", { state: "working", timestamp: "now" });

      const handler = new A2AHandler({ executor, taskStore });
      const result = (await handler.handleRequest(
        rpc("tasks/cancel", { id: "working-task" }),
      )) as JsonRpcSuccessResponse;

      expect(executor.cancel).toHaveBeenCalledWith("working-task", taskStore);
      const task = result.result as R;
      expect(task.status.state).toBe("canceled");
    });

    it("returns -32002 for terminal task", async () => {
      const executor = createMockExecutor({});
      const taskStore = createMockTaskStore();
      (taskStore.create as R)({ id: "done", contextId: "c1" });
      (taskStore.updateStatus as R)("done", { state: "completed", timestamp: "now" });

      const handler = new A2AHandler({ executor, taskStore });
      const result = await handler.handleRequest(rpc("tasks/cancel", { id: "done" }));
      expect((result as R).error.code).toBe(-32002);
    });

    it("returns -32002 when executor refuses to cancel", async () => {
      const executor = createMockExecutor({}, { cancelResult: false });
      const taskStore = createMockTaskStore();
      (taskStore.create as R)({ id: "stubborn", contextId: "c1" });
      (taskStore.updateStatus as R)("stubborn", { state: "working", timestamp: "now" });

      const handler = new A2AHandler({ executor, taskStore });
      const result = await handler.handleRequest(rpc("tasks/cancel", { id: "stubborn" }));
      expect((result as R).error.code).toBe(-32002);
    });

    it("returns -32001 for nonexistent task", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(rpc("tasks/cancel", { id: "nope" }));
      expect((result as R).error.code).toBe(-32001);
    });
  });

  // -------------------------------------------------------
  // tasks/list
  // -------------------------------------------------------

  describe("tasks/list", () => {
    it("returns all tasks", async () => {
      const executor = createMockExecutor({});
      const taskStore = createMockTaskStore();
      (taskStore.create as R)({ id: "t1", contextId: "c1" });
      (taskStore.create as R)({ id: "t2", contextId: "c1" });

      const handler = new A2AHandler({ executor, taskStore });
      const result = (await handler.handleRequest(rpc("tasks/list", {}))) as JsonRpcSuccessResponse;

      expect((result.result as R[]).length).toBe(2);
    });

    it("filters by contextId", async () => {
      const executor = createMockExecutor({});
      const taskStore = createMockTaskStore();
      (taskStore.create as R)({ id: "t1", contextId: "c1" });
      (taskStore.create as R)({ id: "t2", contextId: "c2" });

      const handler = new A2AHandler({ executor, taskStore });
      const result = (await handler.handleRequest(
        rpc("tasks/list", { contextId: "c1" }),
      )) as JsonRpcSuccessResponse;

      expect((result.result as R[]).length).toBe(1);
      expect((result.result as R[])[0].contextId).toBe("c1");
    });
  });

  // -------------------------------------------------------
  // Method routing
  // -------------------------------------------------------

  describe("method routing", () => {
    it("returns -32601 for unknown methods", async () => {
      const handler = new A2AHandler({
        executor: createMockExecutor({}),
        taskStore: createMockTaskStore(),
      });
      const result = await handler.handleRequest(rpc("unknown/method"));
      expect((result as R).error.code).toBe(-32601);
    });
  });
});
