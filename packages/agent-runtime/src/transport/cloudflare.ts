import type { Transport, TransportConnection } from "./transport.js";
import type { ServerMessage } from "./types.js";

/** Serialized attachment shape persisted via CF hibernation API. */
interface CfAttachment {
  sessionId: string;
  connectionId: string;
}

/**
 * A TransportConnection backed by a Cloudflare WebSocket.
 * Session mapping is persisted via serializeAttachment for hibernation recovery.
 */
class CfTransportConnection implements TransportConnection {
  readonly id: string;
  wasRestoredFromHibernation: boolean;
  private sessionId: string;
  private readonly ws: WebSocket;

  constructor(
    ws: WebSocket,
    connectionId: string,
    sessionId: string,
    wasRestoredFromHibernation: boolean,
  ) {
    this.ws = ws;
    this.id = connectionId;
    this.sessionId = sessionId;
    this.wasRestoredFromHibernation = wasRestoredFromHibernation;
  }

  send(msg: ServerMessage): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Connection may be closed — silent catch per error handling rules
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.ws.serializeAttachment({ sessionId, connectionId: this.id } satisfies CfAttachment);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  /** @internal — used by CfWebSocketTransport to match raw WebSocket to connection. */
  getRawWebSocket(): WebSocket {
    return this.ws;
  }
}

/**
 * Cloudflare Workers transport adapter.
 * Wraps WebSocketPair, ctx.acceptWebSocket, and serializeAttachment/deserializeAttachment
 * behind the generic Transport interface.
 */
export class CfWebSocketTransport implements Transport {
  private readonly ctx: DurableObjectState;
  private readonly connections = new Map<WebSocket, CfTransportConnection>();

  private messageHandler: ((connection: TransportConnection, data: string) => void) | null = null;
  private closeHandler: ((connection: TransportConnection) => void) | null = null;
  private openHandler: ((connection: TransportConnection) => void) | null = null;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  handleUpgrade(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const connectionId = crypto.randomUUID();
    // Session ID will be set by the onOpen handler via connection.setSessionId()
    const connection = new CfTransportConnection(server, connectionId, "", false);
    this.connections.set(server, connection);

    // Persist the initial attachment (session ID will be updated by onOpen handler)
    server.serializeAttachment({ sessionId: "", connectionId } satisfies CfAttachment);

    // Fire onOpen handler
    this.openHandler?.(connection);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Called by AgentDO.webSocketMessage() — the thin delegator.
   * Resolves the raw WebSocket to a TransportConnection (recovering from
   * hibernation if needed) and fires the registered onMessage handler.
   */
  handleMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    let connection = this.connections.get(ws);

    if (!connection) {
      // Hibernation recovery: reconstruct connection from serialized attachment
      const attachment = ws.deserializeAttachment() as CfAttachment | null;
      if (attachment?.sessionId && attachment?.connectionId) {
        connection = new CfTransportConnection(
          ws,
          attachment.connectionId,
          attachment.sessionId,
          true,
        );
        this.connections.set(ws, connection);
      } else {
        // Cannot recover — drop the message
        return;
      }
    }

    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.messageHandler?.(connection, text);
  }

  /**
   * Called by AgentDO.webSocketClose() — the thin delegator.
   * Cleans up tracking and fires the registered onClose handler.
   */
  handleClose(ws: WebSocket): void {
    const connection = this.connections.get(ws);
    if (connection) {
      this.connections.delete(ws);
      this.closeHandler?.(connection);
    }
  }

  getConnections(): Iterable<TransportConnection> {
    return this.connections.values();
  }

  *getConnectionsForSession(sessionId: string): Iterable<TransportConnection> {
    for (const connection of this.connections.values()) {
      if (connection.getSessionId() === sessionId) {
        yield connection;
      }
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const connection of this.connections.values()) {
      connection.send(msg);
    }
  }

  broadcastToSession(sessionId: string, msg: ServerMessage): void {
    for (const connection of this.connections.values()) {
      if (connection.getSessionId() === sessionId) {
        connection.send(msg);
      }
    }
  }

  send(connection: TransportConnection, msg: ServerMessage): void {
    connection.send(msg);
  }

  onMessage(handler: (connection: TransportConnection, data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (connection: TransportConnection) => void): void {
    this.closeHandler = handler;
  }

  onOpen(handler: (connection: TransportConnection) => void): void {
    this.openHandler = handler;
  }
}
