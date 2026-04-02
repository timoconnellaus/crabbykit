import { describe, expect, it } from "vitest";
import type { PromptSection } from "../../prompt/types.js";
import { chatReducer, createInitialState } from "../chat-reducer.js";

describe("chatReducer", () => {
  describe("SET_SYSTEM_PROMPT", () => {
    it("sets systemPrompt from null", () => {
      const state = createInitialState(undefined);
      expect(state.systemPrompt).toBeNull();

      const sections: PromptSection[] = [
        { name: "Identity", key: "identity", content: "You are a test agent.", lines: 1 },
        { name: "Safety", key: "safety", content: "## Safety\n- Be safe.", lines: 2 },
      ];
      const raw = "You are a test agent.\n\n## Safety\n- Be safe.";

      const next = chatReducer(state, { type: "SET_SYSTEM_PROMPT", sections, raw });

      expect(next.systemPrompt).toEqual({ sections, raw });
    });

    it("replaces existing systemPrompt", () => {
      const initial = createInitialState(undefined);
      const first = chatReducer(initial, {
        type: "SET_SYSTEM_PROMPT",
        sections: [{ name: "Old", key: "old", content: "old", lines: 1 }],
        raw: "old",
      });

      const newSections: PromptSection[] = [
        { name: "New", key: "new", content: "new content", lines: 1 },
      ];
      const second = chatReducer(first, {
        type: "SET_SYSTEM_PROMPT",
        sections: newSections,
        raw: "new content",
      });

      expect(second.systemPrompt?.sections).toHaveLength(1);
      expect(second.systemPrompt?.sections[0].name).toBe("New");
      expect(second.systemPrompt?.raw).toBe("new content");
    });

    it("does not affect other state fields", () => {
      const state = createInitialState("session-1");
      const next = chatReducer(state, {
        type: "SET_SYSTEM_PROMPT",
        sections: [],
        raw: "",
      });

      expect(next.currentSessionId).toBe("session-1");
      expect(next.messages).toEqual([]);
      expect(next.connectionStatus).toBe("connecting");
      expect(next.agentStatus).toBe("idle");
    });
  });

  describe("createInitialState", () => {
    it("initializes systemPrompt as null", () => {
      const state = createInitialState(undefined);
      expect(state.systemPrompt).toBeNull();
    });

    it("initializes systemPrompt as null with sessionId", () => {
      const state = createInitialState("s1");
      expect(state.systemPrompt).toBeNull();
      expect(state.currentSessionId).toBe("s1");
    });
  });

  describe("RESET", () => {
    it("clears systemPrompt back to null", () => {
      const state = createInitialState(undefined);
      const withPrompt = chatReducer(state, {
        type: "SET_SYSTEM_PROMPT",
        sections: [{ name: "Test", key: "test", content: "test", lines: 1 }],
        raw: "test",
      });
      expect(withPrompt.systemPrompt).not.toBeNull();

      const reset = chatReducer(withPrompt, { type: "RESET" });
      expect(reset.systemPrompt).toBeNull();
    });
  });
});
