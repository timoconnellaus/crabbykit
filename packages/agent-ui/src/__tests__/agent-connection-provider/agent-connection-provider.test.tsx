/**
 * Tests for AgentConnectionProvider + its subscription API.
 *
 * Note on location: These tests live under agent-ui (not agent-runtime)
 * because agent-runtime's vitest config runs only in the Cloudflare Workers
 * pool, which doesn't provide jsdom / react-dom. agent-ui already has a
 * jsdom + @testing-library/react setup (see its vitest.config.ts) and
 * follows the same pattern for the useAgentChat hook tests. If
 * agent-runtime ever grows a jsdom project, these tests can move.
 *
 * Covers tasks:
 *   11.7  Provider lifecycle (mount, reconnect, cleanup)
 *   11.10 useCapabilityEvents receives individual events via subscribe()
 *   11.11 Subscription cleanup on unmount
 */

import {
  AgentConnectionProvider,
  type ServerMessage,
  useAgentConnection,
} from "@claw-for-cloudflare/agent-runtime/client";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockWebSocket, MockWebSocket } from "./mock-websocket";

// Default URL used by provider tests.
const TEST_URL = "ws://test/agent";

let restoreWebSocket: () => void;

beforeEach(() => {
  restoreWebSocket = installMockWebSocket();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  restoreWebSocket();
});

// Small wrapper that renders the provider with reasonable defaults.
function wrap(children: ReactNode, url = TEST_URL) {
  return render(
    <AgentConnectionProvider url={url} maxReconnectDelay={1000}>
      {children}
    </AgentConnectionProvider>,
  );
}

// Helper to build a capability_state server message.
function capabilityStateMsg(opts: {
  capabilityId: string;
  event: string;
  data: unknown;
  sessionId?: string;
  scope?: "session" | "global";
}): ServerMessage {
  return {
    type: "capability_state",
    capabilityId: opts.capabilityId,
    scope: opts.scope ?? "global",
    event: opts.event,
    data: opts.data,
    sessionId: opts.sessionId,
  } as ServerMessage;
}

// ---------------------------------------------------------------------------
// 11.7 — Provider lifecycle
// ---------------------------------------------------------------------------

describe("AgentConnectionProvider: lifecycle", () => {
  it("creates a WebSocket connection on mount", () => {
    wrap(<div>child</div>);
    expect(MockWebSocket._instances).toHaveLength(1);
    expect(MockWebSocket.latest.url).toBe(TEST_URL);
  });

  it("transitions to connected once the socket opens", () => {
    const statuses: string[] = [];
    function Probe() {
      const { connectionStatus } = useAgentConnection();
      statuses.push(connectionStatus);
      return null;
    }
    wrap(<Probe />);
    expect(statuses[statuses.length - 1]).toBe("connecting");

    act(() => {
      MockWebSocket.latest.simulateOpen();
    });
    expect(statuses[statuses.length - 1]).toBe("connected");
  });

  it("reconnects with exponential backoff after an unexpected close", () => {
    wrap(<div>child</div>);
    expect(MockWebSocket._instances).toHaveLength(1);

    act(() => {
      MockWebSocket.latest.simulateOpen();
    });
    // Unexpected close triggers a reconnect timer.
    act(() => {
      MockWebSocket.latest.simulateClose();
    });
    expect(MockWebSocket._instances).toHaveLength(1);

    // First reconnect delay is ~1000ms (2 ** 0 * 1000), capped at
    // maxReconnectDelay=1000. Advance timers to fire the scheduled reconnect.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(MockWebSocket._instances).toHaveLength(2);

    // A second unexpected close should schedule another reconnect, also
    // capped to maxReconnectDelay (1000ms).
    act(() => {
      MockWebSocket._instances[1].simulateOpen();
    });
    act(() => {
      MockWebSocket._instances[1].simulateClose();
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(MockWebSocket._instances).toHaveLength(3);
  });

  it("does not reconnect when the provider is unmounted", () => {
    const view = wrap(<div>child</div>);
    expect(MockWebSocket._instances).toHaveLength(1);

    act(() => {
      MockWebSocket.latest.simulateOpen();
    });

    // Unmount BEFORE the socket closes — cleanup must flip disposedRef.
    view.unmount();

    // Even if more time passes and the (now-closed) socket fires more events,
    // a new WebSocket must not be created.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(MockWebSocket._instances).toHaveLength(1);
  });

  it("closes the WebSocket on unmount", () => {
    const view = wrap(<div>child</div>);
    act(() => {
      MockWebSocket.latest.simulateOpen();
    });

    const ws = MockWebSocket.latest;
    const closeSpy = vi.spyOn(ws, "close");

    view.unmount();
    expect(closeSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11.10 — subscribe() delivers individual capability_state events
// ---------------------------------------------------------------------------

describe("AgentConnectionProvider: subscribe()", () => {
  it("delivers each capability_state event to the subscribed handler", () => {
    const received: Array<{ event: string; data: unknown }> = [];

    function Subscriber() {
      const { subscribe } = useAgentConnection();
      // Subscribe once on mount.
      // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe is stable
      useEffect(() => {
        return subscribe("test-cap", (event, data) => {
          received.push({ event, data });
        });
      }, []);
      return null;
    }

    wrap(<Subscriber />);
    act(() => {
      MockWebSocket.latest.simulateOpen();
    });

    // Fire sync, update, remove — all three should reach the handler.
    act(() => {
      MockWebSocket.latest.simulateMessage(
        capabilityStateMsg({
          capabilityId: "test-cap",
          event: "sync",
          data: { items: [] },
        }),
      );
    });
    act(() => {
      MockWebSocket.latest.simulateMessage(
        capabilityStateMsg({
          capabilityId: "test-cap",
          event: "update",
          data: { id: "a", value: 1 },
        }),
      );
    });
    act(() => {
      MockWebSocket.latest.simulateMessage(
        capabilityStateMsg({
          capabilityId: "test-cap",
          event: "remove",
          data: { id: "a" },
        }),
      );
    });

    expect(received).toEqual([
      { event: "sync", data: { items: [] } },
      { event: "update", data: { id: "a", value: 1 } },
      { event: "remove", data: { id: "a" } },
    ]);
  });

  it("does not deliver events for unrelated capability ids", () => {
    const received: Array<{ event: string; data: unknown }> = [];

    function Subscriber() {
      const { subscribe } = useAgentConnection();
      // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe is stable
      useEffect(() => {
        return subscribe("test-cap", (event, data) => {
          received.push({ event, data });
        });
      }, []);
      return null;
    }

    wrap(<Subscriber />);
    act(() => {
      MockWebSocket.latest.simulateOpen();
    });
    act(() => {
      MockWebSocket.latest.simulateMessage(
        capabilityStateMsg({
          capabilityId: "other-cap",
          event: "sync",
          data: {},
        }),
      );
    });

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11.11 — Subscription cleanup on unmount
// ---------------------------------------------------------------------------

describe("AgentConnectionProvider: subscription cleanup", () => {
  it("stops invoking the handler after the subscriber unmounts", () => {
    const received: Array<{ event: string; data: unknown }> = [];

    function Subscriber() {
      const { subscribe } = useAgentConnection();
      // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe is stable
      useEffect(() => {
        return subscribe("test-cap", (event, data) => {
          received.push({ event, data });
        });
      }, []);
      return null;
    }

    // Wrap in a parent that can conditionally render the subscriber.
    function Parent({ show }: { show: boolean }) {
      return show ? <Subscriber /> : null;
    }

    const view = render(
      <AgentConnectionProvider url={TEST_URL} maxReconnectDelay={1000}>
        <Parent show={true} />
      </AgentConnectionProvider>,
    );

    act(() => {
      MockWebSocket.latest.simulateOpen();
    });

    act(() => {
      MockWebSocket.latest.simulateMessage(
        capabilityStateMsg({
          capabilityId: "test-cap",
          event: "sync",
          data: { before: true },
        }),
      );
    });
    expect(received).toHaveLength(1);

    // Unmount only the Subscriber — the provider remains.
    view.rerender(
      <AgentConnectionProvider url={TEST_URL} maxReconnectDelay={1000}>
        <Parent show={false} />
      </AgentConnectionProvider>,
    );

    act(() => {
      MockWebSocket.latest.simulateMessage(
        capabilityStateMsg({
          capabilityId: "test-cap",
          event: "update",
          data: { after: true },
        }),
      );
    });
    // No new events after unmount.
    expect(received).toHaveLength(1);
  });
});
