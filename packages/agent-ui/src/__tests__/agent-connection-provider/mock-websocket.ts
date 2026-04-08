/**
 * MockWebSocket — minimal controllable WebSocket replacement for testing
 * AgentConnectionProvider.
 *
 * Near-duplicate of the version under ./use-agent-chat/ but kept local so the
 * two suites stay decoupled. If you find yourself extending both copies,
 * promote it to a shared module.
 */

import type {
  ClientMessage,
  ServerMessage,
} from "@claw-for-cloudflare/agent-runtime/client";

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  readonly sentMessages: ClientMessage[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket._instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(msg: ServerMessage): void {
    const event = new MessageEvent("message", { data: JSON.stringify(msg) });
    // The provider's message handler checks `event.target === wsRef.current`
    // to discard stale-connection events, so we must point target at this instance.
    Object.defineProperty(event, "target", { value: this });
    this.onmessage?.(event);
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  static _instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket._instances = [];
  }

  static get latest(): MockWebSocket {
    return MockWebSocket._instances[MockWebSocket._instances.length - 1];
  }
}

/**
 * Install MockWebSocket as the global WebSocket and return a cleanup function
 * that restores the original binding.
 */
export function installMockWebSocket(): () => void {
  const original = globalThis.WebSocket;
  MockWebSocket.reset();
  // biome-ignore lint/suspicious/noExplicitAny: replacing global WebSocket
  (globalThis as any).WebSocket = MockWebSocket;
  return () => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring global WebSocket
    (globalThis as any).WebSocket = original;
    MockWebSocket.reset();
  };
}
