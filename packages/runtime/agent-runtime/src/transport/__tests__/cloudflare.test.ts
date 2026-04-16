import { beforeEach, describe, expect, it, vi } from "vitest";
import { CfWebSocketTransport } from "../cloudflare.js";
import type { ServerMessage } from "../types.js";

/** WebSocket with hibernation attachment methods (added by ctx.acceptWebSocket in Workers). */
interface HibernatableWebSocket extends WebSocket {
  serializeAttachment(data: unknown): void;
  deserializeAttachment(): unknown;
}

/**
 * Creates a mock WebSocket pair with serializeAttachment/deserializeAttachment
 * support (normally added by ctx.acceptWebSocket in real Workers).
 */
function createMockWebSocketPair() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Track attachment data (simulates hibernation API)
  let attachment: unknown = null;
  const hws = server as HibernatableWebSocket;
  hws.serializeAttachment = (data: unknown) => {
    attachment = structuredClone(data);
  };
  hws.deserializeAttachment = () => {
    return structuredClone(attachment);
  };

  return { client, server: hws, getAttachment: () => attachment };
}

/** Minimal mock of DurableObjectState — only acceptWebSocket is used. */
function createMockCtx(): DurableObjectState {
  return {
    acceptWebSocket: vi.fn((ws: WebSocket) => {
      // In real Workers, acceptWebSocket enables send/close on the server socket.
      // We call accept() to do the same in tests.
      ws.accept();
    }),
  } as unknown as DurableObjectState;
}

/** Collect messages from a client WebSocket. */
function _collectMessages(ws: WebSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(e.data as string));
  });
  return messages;
}

const SAMPLE_MSG: ServerMessage = {
  type: "error",
  code: "INTERNAL_ERROR",
  message: "test message",
};

describe("CfWebSocketTransport", () => {
  let ctx: DurableObjectState;
  let transport: CfWebSocketTransport;

  beforeEach(() => {
    ctx = createMockCtx();
    transport = new CfWebSocketTransport(ctx);
  });

  describe("handleUpgrade", () => {
    it("returns a 101 response with webSocket", () => {
      const resp = transport.handleUpgrade(new Request("http://fake/ws"));
      expect(resp.status).toBe(101);
      expect(resp.webSocket).toBeTruthy();
    });

    it("calls ctx.acceptWebSocket", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      expect(ctx.acceptWebSocket).toHaveBeenCalledOnce();
    });

    it("fires onOpen handler with the new connection", () => {
      const handler = vi.fn();
      transport.onOpen(handler);
      transport.handleUpgrade(new Request("http://fake/ws"));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].id).toBeTruthy();
    });

    it("registers the connection for getConnections()", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const connections = [...transport.getConnections()];
      expect(connections).toHaveLength(1);
    });
  });

  describe("handleMessage", () => {
    it("fires onMessage handler with string data", () => {
      const handler = vi.fn();
      transport.onMessage(handler);

      const _resp = transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];

      transport.handleMessage(serverWs, '{"type":"prompt"}');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][1]).toBe('{"type":"prompt"}');
    });

    it("decodes ArrayBuffer data via TextDecoder", () => {
      const handler = vi.fn();
      transport.onMessage(handler);

      transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];

      const encoder = new TextEncoder();
      const buffer = encoder.encode('{"type":"ping"}').buffer;
      transport.handleMessage(serverWs, buffer as ArrayBuffer);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][1]).toBe('{"type":"ping"}');
    });

    it("recovers connection from hibernation via deserializeAttachment", () => {
      const handler = vi.fn();
      transport.onMessage(handler);

      // Simulate a WebSocket that was accepted before hibernation
      const { server } = createMockWebSocketPair();
      server.serializeAttachment({
        sessionId: "sess-123",
        connectionId: "conn-abc",
      });

      // Transport has no record of this ws (post-hibernation)
      transport.handleMessage(server, '{"type":"request_sync"}');

      expect(handler).toHaveBeenCalledOnce();
      const connection = handler.mock.calls[0][0];
      expect(connection.id).toBe("conn-abc");
      expect(connection.getSessionId()).toBe("sess-123");
      expect(connection.wasRestoredFromHibernation).toBe(true);
    });

    it("drops message when attachment has no sessionId", () => {
      const handler = vi.fn();
      transport.onMessage(handler);

      const { server } = createMockWebSocketPair();
      server.serializeAttachment({
        sessionId: "",
        connectionId: "conn-abc",
      });

      transport.handleMessage(server, '{"type":"ping"}');
      expect(handler).not.toHaveBeenCalled();
    });

    it("drops message when attachment has no connectionId", () => {
      const handler = vi.fn();
      transport.onMessage(handler);

      const { server } = createMockWebSocketPair();
      server.serializeAttachment({
        sessionId: "sess-123",
        connectionId: "",
      });

      transport.handleMessage(server, '{"type":"ping"}');
      expect(handler).not.toHaveBeenCalled();
    });

    it("drops message when attachment is null", () => {
      const handler = vi.fn();
      transport.onMessage(handler);

      const { server } = createMockWebSocketPair();
      // deserializeAttachment returns null by default (no prior serializeAttachment)

      transport.handleMessage(server, '{"type":"ping"}');
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not fire handler when no onMessage registered", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Should not throw
      expect(() => transport.handleMessage(serverWs, '{"type":"ping"}')).not.toThrow();
    });
  });

  describe("handleClose", () => {
    it("removes connection and fires onClose handler", () => {
      const closeHandler = vi.fn();
      transport.onClose(closeHandler);

      transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect([...transport.getConnections()]).toHaveLength(1);
      transport.handleClose(serverWs);
      expect([...transport.getConnections()]).toHaveLength(0);
      expect(closeHandler).toHaveBeenCalledOnce();
    });

    it("no-ops for unknown WebSocket", () => {
      const closeHandler = vi.fn();
      transport.onClose(closeHandler);

      const { server } = createMockWebSocketPair();
      transport.handleClose(server);

      expect(closeHandler).not.toHaveBeenCalled();
    });
  });

  describe("send", () => {
    it("delegates to connection.send()", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const connection = [...transport.getConnections()][0];
      const sendSpy = vi.spyOn(connection, "send");

      transport.send(connection, SAMPLE_MSG);
      expect(sendSpy).toHaveBeenCalledWith(SAMPLE_MSG);
    });
  });

  describe("broadcast", () => {
    it("sends to all connections", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      transport.handleUpgrade(new Request("http://fake/ws"));

      const connections = [...transport.getConnections()];
      const spies = connections.map((c) => vi.spyOn(c, "send"));

      transport.broadcast(SAMPLE_MSG);
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledWith(SAMPLE_MSG);
      }
    });
  });

  describe("broadcastToSession", () => {
    it("sends only to connections matching the session", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      transport.handleUpgrade(new Request("http://fake/ws"));

      const [conn1, conn2] = [...transport.getConnections()];
      conn1.setSessionId("sess-A");
      conn2.setSessionId("sess-B");

      const spy1 = vi.spyOn(conn1, "send");
      const spy2 = vi.spyOn(conn2, "send");

      transport.broadcastToSession("sess-A", SAMPLE_MSG);
      expect(spy1).toHaveBeenCalledWith(SAMPLE_MSG);
      expect(spy2).not.toHaveBeenCalled();
    });
  });

  describe("getConnectionsForSession", () => {
    it("yields only connections with matching sessionId", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      transport.handleUpgrade(new Request("http://fake/ws"));
      transport.handleUpgrade(new Request("http://fake/ws"));

      const [c1, c2, c3] = [...transport.getConnections()];
      c1.setSessionId("sess-X");
      c2.setSessionId("sess-Y");
      c3.setSessionId("sess-X");

      const matched = [...transport.getConnectionsForSession("sess-X")];
      expect(matched).toHaveLength(2);
      expect(matched.map((c) => c.id)).toContain(c1.id);
      expect(matched.map((c) => c.id)).toContain(c3.id);
    });

    it("yields nothing when no connections match", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const [c] = [...transport.getConnections()];
      c.setSessionId("sess-A");

      const matched = [...transport.getConnectionsForSession("sess-Z")];
      expect(matched).toHaveLength(0);
    });
  });

  describe("CfTransportConnection (via transport)", () => {
    it("connection.send() silently catches when ws.send throws", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Force ws.send to throw (simulates closed connection)
      serverWs.send = () => {
        throw new Error("WebSocket is closed");
      };

      const connection = [...transport.getConnections()][0];
      // Should not throw
      expect(() => connection.send(SAMPLE_MSG)).not.toThrow();
    });

    it("connection.close() forwards to the underlying WebSocket", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const closeSpy = vi.spyOn(serverWs, "close");

      const connection = [...transport.getConnections()][0];
      connection.close(1000, "Normal closure");

      expect(closeSpy).toHaveBeenCalledWith(1000, "Normal closure");
    });

    it("connection.close() works without arguments", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const serverWs = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const closeSpy = vi.spyOn(serverWs, "close");

      const connection = [...transport.getConnections()][0];
      connection.close();

      expect(closeSpy).toHaveBeenCalledWith(undefined, undefined);
    });

    it("connection.setSessionId() persists via serializeAttachment", () => {
      const { server } = createMockWebSocketPair();

      // Manually set up: recovery creates a connection we can then call setSessionId on
      server.serializeAttachment({
        sessionId: "old-sess",
        connectionId: "conn-1",
      });

      const handler = vi.fn();
      transport.onMessage(handler);
      transport.handleMessage(server, '"test"');

      const connection = handler.mock.calls[0][0];
      connection.setSessionId("new-sess");
      expect(connection.getSessionId()).toBe("new-sess");

      // Verify the attachment was updated
      const attachment = server.deserializeAttachment();
      expect(attachment).toEqual({
        sessionId: "new-sess",
        connectionId: "conn-1",
      });
    });

    it("connection.wasRestoredFromHibernation is false for new connections", () => {
      transport.handleUpgrade(new Request("http://fake/ws"));
      const connection = [...transport.getConnections()][0];
      expect(connection.wasRestoredFromHibernation).toBe(false);
    });
  });
});
