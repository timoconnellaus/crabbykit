/**
 * Focused-hook isolation tests (task 11.8).
 *
 * These tests exercise the decomposed hooks (useSchedules, useSkills,
 * useCommands, useSessions, useQueue) against a lightweight mock
 * AgentConnectionContext provider — no WebSocket involved. The goal is to
 * verify:
 *   - the hook reads capability state from the shared reducer state
 *   - the hook's action callbacks produce the correct ClientMessage
 *   - useQueue resets its local state on session switch
 */

import {
  useCommands,
  useQueue,
  useSchedules,
  useSessions,
  useSkills,
} from "@claw-for-cloudflare/agent-runtime/client";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockProviderHandle,
  fireSessionSwitch,
  MockAgentConnectionProvider,
  type MockProviderHandle,
} from "./test-provider";

afterEach(() => {
  cleanup();
});

// Tiny wrapper factory: returns a React wrapper that renders a
// MockAgentConnectionProvider with the given options.
function makeWrapper(
  handle: MockProviderHandle,
  opts: {
    currentSessionId?: string | null;
    state?: Partial<
      Parameters<typeof MockAgentConnectionProvider>[0]["stateOverrides"]
    >;
  } = {},
) {
  return ({ children }: { children: ReactNode }) => (
    <MockAgentConnectionProvider
      handle={handle}
      currentSessionId={opts.currentSessionId ?? null}
      stateOverrides={opts.state}
    >
      {children}
    </MockAgentConnectionProvider>
  );
}

// ---------------------------------------------------------------------------
// useSchedules
// ---------------------------------------------------------------------------

describe("useSchedules", () => {
  it("reads schedules from capabilityState", () => {
    const handle = createMockProviderHandle();
    const schedule = {
      id: "sched_1",
      name: "Morning",
      cron: "0 8 * * *",
      enabled: true,
      status: "active",
      nextFireAt: null,
      expiresAt: null,
      lastFiredAt: null,
    };
    const { result } = renderHook(() => useSchedules(), {
      wrapper: makeWrapper(handle, {
        currentSessionId: "sess_1",
        state: {
          capabilityState: { schedules: { schedules: [schedule] } },
        } as never,
      }),
    });
    expect(result.current.schedules).toEqual([schedule]);
  });

  it("returns empty array when capabilityState is absent", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSchedules(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });
    expect(result.current.schedules).toEqual([]);
  });

  it("toggleSchedule sends a capability_action message", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSchedules(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });

    act(() => {
      result.current.toggleSchedule("sched_1", false);
    });

    expect(handle.sent).toEqual([
      {
        type: "capability_action",
        capabilityId: "schedules",
        action: "toggle",
        data: { scheduleId: "sched_1", enabled: false },
        sessionId: "sess_1",
      },
    ]);
  });

  it("toggleSchedule is a no-op without a current session", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSchedules(), {
      wrapper: makeWrapper(handle, { currentSessionId: null }),
    });
    act(() => {
      result.current.toggleSchedule("sched_1", true);
    });
    expect(handle.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// useSkills
// ---------------------------------------------------------------------------

describe("useSkills", () => {
  it("reads skills from capabilityState.skills.skills", () => {
    const handle = createMockProviderHandle();
    const skills = [
      { name: "deploy", description: "Ship it", version: 1, enabled: true },
    ];
    const { result } = renderHook(() => useSkills(), {
      wrapper: makeWrapper(handle, {
        state: {
          capabilityState: { skills: { skills } },
        } as never,
      }),
    });
    expect(result.current.skills).toEqual(skills);
  });

  it("returns empty array when capabilityState is absent", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSkills(), {
      wrapper: makeWrapper(handle),
    });
    expect(result.current.skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// useCommands
// ---------------------------------------------------------------------------

describe("useCommands", () => {
  it("sendCommand dispatches the core command message and optimistic user message", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useCommands(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });

    act(() => {
      result.current.sendCommand("help", "me please");
    });

    expect(handle.sent).toEqual([
      {
        type: "command",
        sessionId: "sess_1",
        name: "help",
        args: "me please",
      },
    ]);

    // Clears error + adds an optimistic user message.
    const actionTypes = handle.dispatched.map((a) => a.type);
    expect(actionTypes).toContain("SET_ERROR");
    expect(actionTypes).toContain("ADD_MESSAGE");
  });

  it("sendCommand with no args still sends a command", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useCommands(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });

    act(() => {
      result.current.sendCommand("status");
    });

    expect(handle.sent[0]).toMatchObject({
      type: "command",
      name: "status",
      sessionId: "sess_1",
    });
  });

  it("sendCommand is a no-op without a current session", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useCommands(), {
      wrapper: makeWrapper(handle, { currentSessionId: null }),
    });
    act(() => {
      result.current.sendCommand("help");
    });
    expect(handle.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// useSessions
// ---------------------------------------------------------------------------

describe("useSessions", () => {
  it("exposes sessions and currentSessionId from state", () => {
    const handle = createMockProviderHandle();
    const sessions = [
      {
        id: "s1",
        name: "First",
        source: "websocket",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];
    const { result } = renderHook(() => useSessions(), {
      wrapper: makeWrapper(handle, {
        currentSessionId: "s1",
        state: { sessions } as never,
      }),
    });
    expect(result.current.sessions).toEqual(sessions);
    expect(result.current.currentSessionId).toBe("s1");
  });

  it("switchSession sends a switch_session message", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSessions(), {
      wrapper: makeWrapper(handle, { currentSessionId: "s1" }),
    });
    act(() => {
      result.current.switchSession("s2");
    });
    expect(handle.sent).toEqual([{ type: "switch_session", sessionId: "s2" }]);
  });

  it("createSession sends a new_session message with optional name", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSessions(), {
      wrapper: makeWrapper(handle),
    });
    act(() => {
      result.current.createSession("Fresh");
    });
    expect(handle.sent).toEqual([{ type: "new_session", name: "Fresh" }]);
  });

  it("deleteSession sends a delete_session message", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useSessions(), {
      wrapper: makeWrapper(handle),
    });
    act(() => {
      result.current.deleteSession("s3");
    });
    expect(handle.sent).toEqual([{ type: "delete_session", sessionId: "s3" }]);
  });
});

// ---------------------------------------------------------------------------
// useQueue
// ---------------------------------------------------------------------------

describe("useQueue", () => {
  it("reads queued messages from capabilityState", () => {
    const handle = createMockProviderHandle();
    const items = [
      { id: "q1", text: "hello", createdAt: "2025-01-01T00:00:00Z" },
    ];
    const { result } = renderHook(() => useQueue(), {
      wrapper: makeWrapper(handle, {
        currentSessionId: "sess_1",
        state: {
          capabilityState: { queue: { items } },
        } as never,
      }),
    });
    expect(result.current.queuedMessages).toEqual(items);
  });

  it("deleteQueuedMessage sends a capability_action message", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useQueue(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });
    act(() => {
      result.current.deleteQueuedMessage("q1");
    });
    expect(handle.sent).toEqual([
      {
        type: "capability_action",
        capabilityId: "queue",
        action: "delete",
        data: { queueId: "q1" },
        sessionId: "sess_1",
      },
    ]);
  });

  it("steerQueuedMessage sends a capability_action message", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useQueue(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });
    act(() => {
      result.current.steerQueuedMessage("q1");
    });
    expect(handle.sent[0]).toMatchObject({
      type: "capability_action",
      capabilityId: "queue",
      action: "steer",
      data: { queueId: "q1" },
      sessionId: "sess_1",
    });
  });

  it("dispatches SET_CAPABILITY_STATE with an empty list on session switch", () => {
    const handle = createMockProviderHandle();
    renderHook(() => useQueue(), {
      wrapper: makeWrapper(handle, { currentSessionId: "sess_1" }),
    });

    // The hook subscribed to onSessionSwitch during mount — fire it.
    act(() => {
      fireSessionSwitch(handle, "sess_2");
    });

    const resetActions = handle.dispatched.filter(
      (a) =>
        a.type === "SET_CAPABILITY_STATE" &&
        (a as { capabilityId?: string }).capabilityId === "queue",
    );
    expect(resetActions).toHaveLength(1);
    expect(resetActions[0]).toEqual({
      type: "SET_CAPABILITY_STATE",
      capabilityId: "queue",
      data: { items: [] },
    });
  });
});
