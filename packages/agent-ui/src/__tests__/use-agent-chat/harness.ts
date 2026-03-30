/**
 * Test harness for useAgentChat — wraps renderHook + MockWebSocket into
 * a fluent API for writing readable e2e-style tests.
 */

import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import {
  type ClientMessage,
  type ServerMessage,
  type UseAgentChatConfig,
  type UseAgentChatReturn,
  useAgentChat,
} from "@claw-for-cloudflare/agent-runtime/client";
import { act, renderHook } from "@testing-library/react";
import { sessionSync } from "./fixtures";
import { MockWebSocket } from "./mock-websocket";

export interface HarnessOptions {
  url?: string;
  sessionId?: string;
  autoReconnect?: boolean;
  maxReconnectDelay?: number;
  onCustomEvent?: (name: string, data: Record<string, unknown>) => void;
}

export interface Harness {
  /** Latest hook return value. */
  readonly current: UseAgentChatReturn;
  /** The most recent MockWebSocket instance. */
  readonly ws: MockWebSocket;
  /** All MockWebSocket instances created (for reconnection tests). */
  readonly allWs: MockWebSocket[];
  /** All ClientMessages sent by the hook. */
  readonly sent: ClientMessage[];

  /** Simulate server opening the connection. */
  open(): Promise<void>;
  /** Send a single ServerMessage from the server. */
  serverSend(msg: ServerMessage): Promise<void>;
  /** Send multiple ServerMessages sequentially. */
  serverSendAll(msgs: ServerMessage[]): Promise<void>;
  /** Call sendMessage on the hook. */
  sendMessage(text: string): Promise<void>;
  /** Call abort on the hook. */
  abort(): Promise<void>;
  /** Call switchSession on the hook. */
  switchSession(sessionId: string): Promise<void>;
  /** Call createSession on the hook. */
  createSession(name?: string): Promise<void>;
  /** Call deleteSession on the hook. */
  deleteSession(sessionId: string): Promise<void>;
  /** Common setup: open connection + send session_sync. */
  establish(sessionId?: string, messages?: AgentMessage[]): Promise<void>;
  /** Unmount hook and restore original WebSocket. */
  cleanup(): void;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const OriginalWebSocket = globalThis.WebSocket;
  MockWebSocket.reset();
  // biome-ignore lint/suspicious/noExplicitAny: replacing global WebSocket with mock
  (globalThis as any).WebSocket = MockWebSocket;

  const config: UseAgentChatConfig = {
    url: options.url ?? "ws://test/agent",
    sessionId: options.sessionId,
    autoReconnect: options.autoReconnect,
    maxReconnectDelay: options.maxReconnectDelay,
    onCustomEvent: options.onCustomEvent,
  };

  const hookResult = renderHook(() => useAgentChat(config));

  const harness: Harness = {
    get current() {
      return hookResult.result.current;
    },

    get ws() {
      return MockWebSocket.latest;
    },

    get allWs() {
      return [...MockWebSocket._instances];
    },

    get sent() {
      return this.ws.sentMessages;
    },

    async open() {
      await act(() => harness.ws.simulateOpen());
    },

    async serverSend(msg: ServerMessage) {
      await act(() => harness.ws.simulateMessage(msg));
    },

    async serverSendAll(msgs: ServerMessage[]) {
      for (const msg of msgs) {
        await act(() => harness.ws.simulateMessage(msg));
      }
    },

    async sendMessage(text: string) {
      await act(() => hookResult.result.current.sendMessage(text));
    },

    async abort() {
      await act(() => hookResult.result.current.abort());
    },

    async switchSession(sessionId: string) {
      await act(() => hookResult.result.current.switchSession(sessionId));
    },

    async createSession(name?: string) {
      await act(() => hookResult.result.current.createSession(name));
    },

    async deleteSession(sessionId: string) {
      await act(() => hookResult.result.current.deleteSession(sessionId));
    },

    async establish(sessionId = "sess_1", messages: AgentMessage[] = []) {
      await harness.open();
      await harness.serverSend(sessionSync({ sessionId, messages }));
    },

    cleanup() {
      hookResult.unmount();
      // biome-ignore lint/suspicious/noExplicitAny: restoring global WebSocket
      (globalThis as any).WebSocket = OriginalWebSocket;
      MockWebSocket.reset();
    },
  };

  return harness;
}
