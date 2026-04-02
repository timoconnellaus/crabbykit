import { describe, expect, it, vi } from "vitest";
import type { PromptSection } from "../../prompt/types.js";
import type { ChatAction } from "../chat-reducer.js";
import { createMessageHandler, type MessageHandlerRefs } from "../message-handler.js";

function makeRefs(overrides?: Partial<MessageHandlerRefs>): MessageHandlerRefs {
  const ws = {} as WebSocket;
  return {
    wsRef: { current: ws },
    currentSessionIdRef: { current: "s1" },
    streamMessageRef: { current: null },
    onCustomEventRef: { current: undefined },
    onCustomRequestRef: { current: undefined },
    lastPongAtRef: { current: 0 },
    pongTimeoutRef: { current: null },
    ...overrides,
  };
}

function makeEvent(ws: object, data: unknown): MessageEvent {
  return { target: ws, data: JSON.stringify(data) } as MessageEvent;
}

describe("createMessageHandler", () => {
  describe("system_prompt message", () => {
    it("dispatches SET_SYSTEM_PROMPT with sections and raw", () => {
      const dispatch = vi.fn<[ChatAction]>();
      const refs = makeRefs();
      const handler = createMessageHandler(dispatch, refs);

      const sections: PromptSection[] = [
        { name: "Identity", key: "identity", content: "You are helpful.", lines: 1 },
        { name: "Safety", key: "safety", content: "## Safety\n- Be safe.", lines: 2 },
      ];
      const raw = "You are helpful.\n\n## Safety\n- Be safe.";

      handler(makeEvent(refs.wsRef.current!, { type: "system_prompt", sections, raw }));

      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SYSTEM_PROMPT",
        sections,
        raw,
      });
    });

    it("dispatches SET_SYSTEM_PROMPT with empty sections", () => {
      const dispatch = vi.fn<[ChatAction]>();
      const refs = makeRefs();
      const handler = createMessageHandler(dispatch, refs);

      handler(makeEvent(refs.wsRef.current!, { type: "system_prompt", sections: [], raw: "" }));

      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SYSTEM_PROMPT",
        sections: [],
        raw: "",
      });
    });

    it("ignores system_prompt from stale WebSocket", () => {
      const dispatch = vi.fn<[ChatAction]>();
      const refs = makeRefs();
      const handler = createMessageHandler(dispatch, refs);

      const staleWs = {} as WebSocket;
      handler(
        makeEvent(staleWs, {
          type: "system_prompt",
          sections: [{ name: "X", key: "x", content: "x", lines: 1 }],
          raw: "x",
        }),
      );

      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
