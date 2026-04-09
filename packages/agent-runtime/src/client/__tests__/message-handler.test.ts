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
    capabilitySubscribersRef: { current: new Map() },
    ...overrides,
  };
}

function makeEvent(ws: object, data: unknown): MessageEvent {
  return { target: ws, data: JSON.stringify(data) } as MessageEvent;
}

describe("createMessageHandler", () => {
  describe("system_prompt message", () => {
    it("dispatches SET_SYSTEM_PROMPT with sections and raw", () => {
      const dispatch = vi.fn<(action: ChatAction) => void>();
      const refs = makeRefs();
      const handler = createMessageHandler(dispatch, refs);

      const sections: PromptSection[] = [
        {
          name: "Identity",
          key: "identity",
          content: "You are helpful.",
          lines: 1,
          source: { type: "default", id: "identity" },
          included: true,
        },
        {
          name: "Safety",
          key: "safety",
          content: "## Safety\n- Be safe.",
          lines: 2,
          source: { type: "default", id: "safety" },
          included: true,
        },
      ];
      const raw = "You are helpful.\n\n## Safety\n- Be safe.";

      handler(makeEvent(refs.wsRef.current!, { type: "system_prompt", sections, raw }));

      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SYSTEM_PROMPT",
        sections,
        raw,
      });
    });

    it("normalizes sections missing source/included fields (forward-compat)", () => {
      const dispatch = vi.fn<(action: ChatAction) => void>();
      const refs = makeRefs();
      const handler = createMessageHandler(dispatch, refs);

      // Simulate an older server that omits source/included.
      const legacySections = [{ name: "Identity", key: "identity", content: "hello", lines: 1 }];
      handler(
        makeEvent(refs.wsRef.current!, {
          type: "system_prompt",
          sections: legacySections,
          raw: "hello",
        }),
      );

      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SYSTEM_PROMPT",
        sections: [
          {
            name: "Identity",
            key: "identity",
            content: "hello",
            lines: 1,
            source: { type: "custom" },
            included: true,
            excludedReason: undefined,
          },
        ],
        raw: "hello",
      });
    });

    it("dispatches SET_SYSTEM_PROMPT with empty sections", () => {
      const dispatch = vi.fn<(action: ChatAction) => void>();
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
      const dispatch = vi.fn<(action: ChatAction) => void>();
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
