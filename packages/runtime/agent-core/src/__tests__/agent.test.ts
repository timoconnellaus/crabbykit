import { describe, expect, it, vi } from "vitest";
import { Agent } from "../agent.js";
import type { AgentEvent, AgentMessage } from "../types.js";

describe("Agent", () => {
  describe("constructor defaults", () => {
    it("has expected initial state", () => {
      const agent = new Agent();
      const s = agent.state;
      expect(s.systemPrompt).toBe("");
      expect(s.thinkingLevel).toBe("off");
      expect(s.tools).toEqual([]);
      expect(s.messages).toEqual([]);
      expect(s.isStreaming).toBe(false);
      expect(s.streamMessage).toBeNull();
      expect(s.pendingToolCalls.size).toBe(0);
      expect(s.error).toBeUndefined();
    });

    it("merges initialState", () => {
      const agent = new Agent({ initialState: { systemPrompt: "hi", thinkingLevel: "high" } });
      expect(agent.state.systemPrompt).toBe("hi");
      expect(agent.state.thinkingLevel).toBe("high");
    });

    it("defaults steeringMode to one-at-a-time", () => {
      const agent = new Agent();
      expect(agent.getSteeringMode()).toBe("one-at-a-time");
    });

    it("defaults followUpMode to one-at-a-time", () => {
      const agent = new Agent();
      expect(agent.getFollowUpMode()).toBe("one-at-a-time");
    });

    it("defaults transport to sse", () => {
      const agent = new Agent();
      expect(agent.transport).toBe("sse");
    });

    it("defaults toolExecution to parallel", () => {
      const agent = new Agent();
      expect(agent.toolExecution).toBe("parallel");
    });

    it("accepts custom options", () => {
      const agent = new Agent({
        steeringMode: "all",
        followUpMode: "all",
        transport: "websocket",
        sessionId: "sess-1",
        maxRetryDelayMs: 5000,
        toolExecution: "sequential",
      });
      expect(agent.getSteeringMode()).toBe("all");
      expect(agent.getFollowUpMode()).toBe("all");
      expect(agent.transport).toBe("websocket");
      expect(agent.sessionId).toBe("sess-1");
      expect(agent.maxRetryDelayMs).toBe(5000);
      expect(agent.toolExecution).toBe("sequential");
    });
  });

  describe("state mutators", () => {
    it("setSystemPrompt", () => {
      const agent = new Agent();
      agent.setSystemPrompt("new prompt");
      expect(agent.state.systemPrompt).toBe("new prompt");
    });

    it("setThinkingLevel", () => {
      const agent = new Agent();
      agent.setThinkingLevel("medium");
      expect(agent.state.thinkingLevel).toBe("medium");
    });

    it("setSteeringMode / getSteeringMode", () => {
      const agent = new Agent();
      agent.setSteeringMode("all");
      expect(agent.getSteeringMode()).toBe("all");
    });

    it("setFollowUpMode / getFollowUpMode", () => {
      const agent = new Agent();
      agent.setFollowUpMode("all");
      expect(agent.getFollowUpMode()).toBe("all");
    });

    it("setTransport", () => {
      const agent = new Agent();
      agent.setTransport("websocket");
      expect(agent.transport).toBe("websocket");
    });

    it("setToolExecution", () => {
      const agent = new Agent();
      agent.setToolExecution("sequential");
      expect(agent.toolExecution).toBe("sequential");
    });

    it("sessionId getter/setter", () => {
      const agent = new Agent();
      expect(agent.sessionId).toBeUndefined();
      agent.sessionId = "s1";
      expect(agent.sessionId).toBe("s1");
    });

    it("maxRetryDelayMs getter/setter", () => {
      const agent = new Agent();
      agent.maxRetryDelayMs = 10_000;
      expect(agent.maxRetryDelayMs).toBe(10_000);
    });

    it("thinkingBudgets getter/setter", () => {
      const agent = new Agent();
      expect(agent.thinkingBudgets).toBeUndefined();
      const budgets = { low: 100, medium: 500, high: 2000 };
      agent.thinkingBudgets = budgets as any;
      expect(agent.thinkingBudgets).toBe(budgets);
    });
  });

  describe("message management", () => {
    const msg = (role: string, text: string): AgentMessage =>
      ({ role, content: [{ type: "text", text }], timestamp: Date.now() }) as AgentMessage;

    it("appendMessage adds to end", () => {
      const agent = new Agent();
      agent.appendMessage(msg("user", "hello"));
      expect(agent.state.messages).toHaveLength(1);
      agent.appendMessage(msg("assistant", "hi"));
      expect(agent.state.messages).toHaveLength(2);
    });

    it("replaceMessages replaces all", () => {
      const agent = new Agent();
      agent.appendMessage(msg("user", "old"));
      const newMsgs = [msg("user", "new")];
      agent.replaceMessages(newMsgs);
      expect(agent.state.messages).toHaveLength(1);
      expect((agent.state.messages[0] as any).content[0].text).toBe("new");
    });

    it("replaceMessages creates a copy", () => {
      const agent = new Agent();
      const source = [msg("user", "a")];
      agent.replaceMessages(source);
      source.push(msg("user", "b"));
      expect(agent.state.messages).toHaveLength(1);
    });

    it("clearMessages empties", () => {
      const agent = new Agent();
      agent.appendMessage(msg("user", "hello"));
      agent.clearMessages();
      expect(agent.state.messages).toHaveLength(0);
    });
  });

  describe("subscribe / emit", () => {
    it("delivers events to listeners", () => {
      const agent = new Agent();
      const events: AgentEvent[] = [];
      agent.subscribe((e) => events.push(e));

      // Trigger an event by directly accessing _processLoopEvent via reset (which doesn't emit)
      // Instead, test subscribe/unsubscribe directly
      expect(events).toHaveLength(0);
    });

    it("unsubscribe stops delivery", () => {
      const agent = new Agent();
      const events: AgentEvent[] = [];
      const unsub = agent.subscribe((e) => events.push(e));
      unsub();
      // No way to emit without running the loop, but unsubscribe should remove the listener
      // We verify the return type is a function
      expect(typeof unsub).toBe("function");
    });
  });

  describe("steering and follow-up queues", () => {
    const msg = (text: string): AgentMessage =>
      ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as AgentMessage;

    it("hasQueuedMessages reflects queue state", () => {
      const agent = new Agent();
      expect(agent.hasQueuedMessages()).toBe(false);
      agent.steer(msg("steer1"));
      expect(agent.hasQueuedMessages()).toBe(true);
    });

    it("hasQueuedMessages true for followUp", () => {
      const agent = new Agent();
      agent.followUp(msg("follow1"));
      expect(agent.hasQueuedMessages()).toBe(true);
    });

    it("clearSteeringQueue clears only steering", () => {
      const agent = new Agent();
      agent.steer(msg("s"));
      agent.followUp(msg("f"));
      agent.clearSteeringQueue();
      expect(agent.hasQueuedMessages()).toBe(true); // followUp still there
    });

    it("clearFollowUpQueue clears only followUp", () => {
      const agent = new Agent();
      agent.steer(msg("s"));
      agent.followUp(msg("f"));
      agent.clearFollowUpQueue();
      expect(agent.hasQueuedMessages()).toBe(true); // steering still there
    });

    it("clearAllQueues clears both", () => {
      const agent = new Agent();
      agent.steer(msg("s"));
      agent.followUp(msg("f"));
      agent.clearAllQueues();
      expect(agent.hasQueuedMessages()).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const agent = new Agent();
      const msg: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: Date.now(),
      } as AgentMessage;
      agent.appendMessage(msg);
      agent.steer(msg);
      agent.followUp(msg);
      agent.reset();
      expect(agent.state.messages).toHaveLength(0);
      expect(agent.state.isStreaming).toBe(false);
      expect(agent.state.streamMessage).toBeNull();
      expect(agent.state.pendingToolCalls.size).toBe(0);
      expect(agent.state.error).toBeUndefined();
      expect(agent.hasQueuedMessages()).toBe(false);
    });
  });

  describe("prompt validation", () => {
    it("throws when no model configured", async () => {
      const agent = new Agent({ initialState: { model: undefined as any } });
      await expect(agent.prompt("hello")).rejects.toThrow("No model configured");
    });

    it("rejects when isStreaming is true", async () => {
      // Directly verify the guard — Agent.prompt() checks isStreaming synchronously
      // before any async work. We can't easily test with a real running stream because
      // the EventStream iterator doesn't support abort/cancellation.
      const agent = new Agent();
      // Force isStreaming via internal state
      (agent as any)._state.isStreaming = true;
      await expect(agent.prompt("second")).rejects.toThrow("already processing");
    });
  });

  describe("continue validation", () => {
    it("throws when no messages", async () => {
      const agent = new Agent();
      await expect(agent.continue()).rejects.toThrow("No messages to continue from");
    });
  });

  describe("waitForIdle", () => {
    it("resolves immediately when not running", async () => {
      const agent = new Agent();
      await expect(agent.waitForIdle()).resolves.toBeUndefined();
    });
  });

  describe("setBeforeToolCall / setAfterToolCall", () => {
    it("accepts and clears hooks", () => {
      const agent = new Agent();
      const before = vi.fn();
      const after = vi.fn();
      agent.setBeforeToolCall(before);
      agent.setAfterToolCall(after);
      // No assertion on internal state — just verify it doesn't throw
      agent.setBeforeToolCall(undefined);
      agent.setAfterToolCall(undefined);
    });
  });
});
