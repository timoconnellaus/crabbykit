import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CDPClient } from "../cdp-client.js";

/** Minimal mock WebSocket that simulates the standard WebSocket API. */
class MockWebSocket {
  static instance: MockWebSocket | null = null;
  private handlers = new Map<string, Array<(event: unknown) => void>>();

  constructor(public url: string) {
    MockWebSocket.instance = this;
    // Simulate async open
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(handler);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.emit("close", {});
  });

  /** Simulate receiving a message from the server. */
  receiveMessage(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }

  /** Simulate a connection error. */
  emitError() {
    this.emit("error", {});
  }

  /** Simulate close from server side. */
  emitClose() {
    this.emit("close", {});
  }

  private emit(type: string, event: unknown) {
    const list = this.handlers.get(type) ?? [];
    for (const handler of list) {
      handler(event);
    }
  }
}

describe("CDPClient", () => {
  let client: CDPClient;

  beforeEach(() => {
    MockWebSocket.instance = null;
    vi.stubGlobal("WebSocket", MockWebSocket);
    client = new CDPClient();
  });

  afterEach(() => {
    client.close();
    vi.unstubAllGlobals();
  });

  describe("connect", () => {
    it("connects to the given URL", async () => {
      await client.connect("wss://connect.browserbase.com/test");
      expect(MockWebSocket.instance).not.toBeNull();
      expect(MockWebSocket.instance!.url).toBe("wss://connect.browserbase.com/test");
      expect(client.isConnected).toBe(true);
    });

    it("rejects on connection error before open", async () => {
      // Create a mock that emits error instead of open
      vi.stubGlobal("WebSocket", class {
        private handlers = new Map<string, Array<(event: unknown) => void>>();
        url: string;
        constructor(url: string) {
          this.url = url;
          // Emit error, not open
          queueMicrotask(() => {
            const list = this.handlers.get("error") ?? [];
            for (const h of list) h({});
          });
        }
        addEventListener(type: string, handler: (event: unknown) => void) {
          let list = this.handlers.get(type);
          if (!list) { list = []; this.handlers.set(type, list); }
          list.push(handler);
        }
        send = vi.fn();
        close = vi.fn();
      });

      const errorClient = new CDPClient();
      await expect(errorClient.connect("wss://bad-url")).rejects.toThrow("connection failed");
    });
  });

  describe("send", () => {
    it("sends JSON-RPC message and resolves with result", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      const promise = client.send("Page.navigate", { url: "https://example.com" });

      // Verify the sent message
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.method).toBe("Page.navigate");
      expect(sent.params).toEqual({ url: "https://example.com" });
      expect(sent.id).toBe(1);

      // Simulate response
      ws.receiveMessage({ id: 1, result: { frameId: "frame-1" } });

      const result = await promise;
      expect(result).toEqual({ frameId: "frame-1" });
    });

    it("rejects on CDP error response", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      const promise = client.send("Bad.method");
      ws.receiveMessage({ id: 1, error: { code: -32601, message: "Method not found" } });

      await expect(promise).rejects.toThrow("CDP error: Method not found (-32601)");
    });

    it("rejects when not connected", async () => {
      await expect(client.send("Page.navigate")).rejects.toThrow("not connected");
    });

    it("uses incrementing IDs", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      client.send("Method.one");
      client.send("Method.two");

      const msg1 = JSON.parse(ws.send.mock.calls[0][0]);
      const msg2 = JSON.parse(ws.send.mock.calls[1][0]);
      expect(msg2.id).toBe(msg1.id + 1);

      // Clean up pending promises
      ws.receiveMessage({ id: msg1.id, result: null });
      ws.receiveMessage({ id: msg2.id, result: null });
    });

    it("rejects with timeout", async () => {
      await client.connect("wss://test");

      const promise = client.send("Slow.method", undefined, 50);

      await expect(promise).rejects.toThrow("timed out after 50ms");
    });
  });

  describe("event listeners", () => {
    it("dispatches CDP events to registered listeners", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      const handler = vi.fn();
      client.on("Page.loadEventFired", handler);

      ws.receiveMessage({ method: "Page.loadEventFired", params: { timestamp: 123 } });

      expect(handler).toHaveBeenCalledWith({ timestamp: 123 });
    });

    it("does not dispatch to removed listeners", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      const handler = vi.fn();
      client.on("Page.loadEventFired", handler);
      client.off("Page.loadEventFired", handler);

      ws.receiveMessage({ method: "Page.loadEventFired", params: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it("handles events with no params", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      const handler = vi.fn();
      client.on("Page.frameStoppedLoading", handler);

      ws.receiveMessage({ method: "Page.frameStoppedLoading" });

      expect(handler).toHaveBeenCalledWith({});
    });
  });

  describe("connection close", () => {
    it("rejects all pending commands on close", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      const p1 = client.send("Method.one");
      const p2 = client.send("Method.two");

      ws.emitClose();

      await expect(p1).rejects.toThrow("connection closed");
      await expect(p2).rejects.toThrow("connection closed");
      expect(client.isConnected).toBe(false);
    });

    it("close() disconnects gracefully", async () => {
      await client.connect("wss://test");
      const ws = MockWebSocket.instance!;

      client.close();

      expect(ws.close).toHaveBeenCalled();
      expect(client.isConnected).toBe(false);
    });
  });
});
