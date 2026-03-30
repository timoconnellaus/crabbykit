/**
 * MockWebSocket — controllable WebSocket replacement for testing useAgentChat.
 *
 * Implements the subset of the WebSocket API that the hook uses:
 * - readyState, onopen/onclose/onmessage/onerror
 * - send(), close()
 *
 * Test control surface:
 * - simulateOpen/Close/Message/Error to drive the hook
 * - sentMessages captures all ClientMessages sent by the hook
 * - Static instance tracking for reconnection tests
 */

import type { ClientMessage, ServerMessage } from "@claw-for-cloudflare/agent-runtime/client";

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

  /** All messages sent by the hook, parsed back to ClientMessage. */
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

  // --- Test control ---

  /** Simulate server opening the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /**
   * Simulate a server-sent message.
   *
   * Critical: the hook checks `event.target !== wsRef.current` (line 312)
   * to discard messages from stale connections. We must set `target` on the
   * MessageEvent to reference this instance.
   */
  simulateMessage(msg: ServerMessage): void {
    const event = new MessageEvent("message", {
      data: JSON.stringify(msg),
    });
    Object.defineProperty(event, "target", { value: this });
    this.onmessage?.(event);
  }

  /** Simulate server closing the connection. */
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  /** Simulate a connection error (browser fires close after error). */
  simulateError(): void {
    this.onerror?.(new Event("error"));
    this.simulateClose();
  }

  // --- Static instance tracking ---

  static _instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket._instances = [];
  }

  static get latest(): MockWebSocket {
    return MockWebSocket._instances[MockWebSocket._instances.length - 1];
  }
}
