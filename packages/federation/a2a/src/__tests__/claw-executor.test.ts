import { describe, expect, it, vi } from "vitest";
import { ClawExecutor } from "../server/claw-executor.js";
import { A2AEventBus, StatusUpdateEvent, TaskCompleteEvent } from "../server/event-bus.js";
import type { TaskStore } from "../server/task-store.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

function createMockTaskStore(): TaskStore {
  const tasks = new Map<string, R>();
  return {
    create: vi.fn((opts: R) => {
      const task = {
        id: opts.id,
        contextId: opts.contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
      };
      tasks.set(opts.id, task);
      return task;
    }),
    get: vi.fn((id: string) => tasks.get(id) ?? null),
    list: vi.fn(() => [...tasks.values()]),
    updateStatus: vi.fn((id: string, status: R) => {
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

function createMockSessionStore() {
  return {
    create: vi.fn(() => ({ id: "sess-1", name: "test", source: "a2a" })),
    get: vi.fn(() => ({ id: "sess-1", name: "test" })),
  };
}

describe("ClawExecutor", () => {
  it("creates a session and runs blocking execution", async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ sessionId: "sess-1", response: "Hello!" });
    const sessionStore = createMockSessionStore();

    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
    });

    executor.setContext({ sendPrompt, sessionStore: sessionStore as R });

    const bus = new A2AEventBus();
    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    const events: string[] = [];
    bus.subscribe("t1", (event) => {
      if (event instanceof StatusUpdateEvent) events.push(event.status.state);
      if (event instanceof TaskCompleteEvent) events.push("complete");
    });

    const result = await executor.execute(
      "t1",
      {
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ text: "Hi" }],
        },
      },
      bus,
      taskStore,
    );

    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(result.task).toBeDefined();
    expect(result.task!.status.state).toBe("completed");
    expect(result.task!.status.message?.parts[0]).toEqual({ text: "Hello!" });

    // Should have emitted status updates
    expect(events).toContain("submitted");
    expect(events).toContain("working");
    expect(events).toContain("completed");
    expect(events).toContain("complete");
  });

  it("returns failed task when sendPrompt throws", async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new Error("Agent is busy on this session"));
    const sessionStore = createMockSessionStore();

    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
    });

    executor.setContext({ sendPrompt, sessionStore: sessionStore as R });

    const bus = new A2AEventBus();
    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    const result = await executor.execute(
      "t1",
      {
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ text: "Hi" }],
        },
      },
      bus,
      taskStore,
    );

    expect(result.task).toBeDefined();
    expect(result.task!.status.state).toBe("failed");
    expect(result.task!.status.message?.parts[0]).toEqual({
      text: "Agent is busy on this session",
    });
  });

  it("fails task when message has no text content", async () => {
    const sendPrompt = vi.fn();
    const sessionStore = createMockSessionStore();

    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
    });

    executor.setContext({ sendPrompt, sessionStore: sessionStore as R });

    const bus = new A2AEventBus();
    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    const result = await executor.execute(
      "t1",
      {
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ data: { key: "value" } }], // No text parts
        },
      },
      bus,
      taskStore,
    );

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(result.task!.status.state).toBe("failed");
    expect(result.task!.status.message?.parts[0]).toEqual({
      text: "Message contained no text content",
    });
  });

  it("cancels running agent via getSessionAgentHandle", async () => {
    const abort = vi.fn();
    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
      getSessionAgentHandle: () => ({ abort, isStreaming: true }),
    });

    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    const cancelled = await executor.cancel("t1", taskStore);

    expect(cancelled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("returns false when no agent handle available", async () => {
    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
    });

    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    const cancelled = await executor.cancel("t1", taskStore);
    expect(cancelled).toBe(false);
  });

  it("returns false when agent is not streaming", async () => {
    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
      getSessionAgentHandle: () => ({ abort: vi.fn(), isStreaming: false }),
    });

    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    const cancelled = await executor.cancel("t1", taskStore);
    expect(cancelled).toBe(false);
  });

  it("generates correct agent card", () => {
    const executor = new ClawExecutor({
      agentCardConfig: {
        name: "My Agent",
        description: "Does things",
        url: "https://agent.example.com",
        version: "2.0.0",
        skills: [{ id: "search", name: "Search", description: "Web search" }],
        provider: { organization: "Acme" },
      },
    });

    const card = executor.getAgentCard();
    expect(card.name).toBe("My Agent");
    expect(card.description).toBe("Does things");
    expect(card.url).toBe("https://agent.example.com");
    expect(card.version).toBe("2.0.0");
    expect(card.protocolVersion).toBe("1.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.skills).toHaveLength(1);
    expect(card.skills![0].id).toBe("search");
    expect(card.provider?.organization).toBe("Acme");
  });

  it("throws when context is not set", async () => {
    const executor = new ClawExecutor({
      agentCardConfig: { name: "Test", url: "https://test" },
    });

    const bus = new A2AEventBus();
    const taskStore = createMockTaskStore();
    taskStore.create({ id: "t1", contextId: "c1", sessionId: "sess-1" });

    await expect(
      executor.execute(
        "t1",
        { message: { messageId: "m1", role: "user", parts: [{ text: "Hi" }] } },
        bus,
        taskStore,
      ),
    ).rejects.toThrow("ClawExecutor context not set");
  });
});
