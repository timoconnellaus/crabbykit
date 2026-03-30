import type { ServerMessage } from "./types.js";

/**
 * Represents a single client connection with session affinity.
 * Abstracts the underlying transport mechanism (WebSocket, SSE, etc.).
 */
export interface TransportConnection {
  /** Stable identifier that survives hibernation/restart. */
  readonly id: string;
  /** Whether this connection was reconstructed from persisted state after a runtime restart. */
  readonly wasRestoredFromHibernation: boolean;
  /** Send a server message to this connection. */
  send(msg: ServerMessage): void;
  /** Get the session ID currently associated with this connection. */
  getSessionId(): string;
  /** Set the session ID for this connection (persisted for hibernation recovery). */
  setSessionId(sessionId: string): void;
  /** Close this connection. */
  close(code?: number, reason?: string): void;
}

/**
 * Manages client connections, message dispatch, and broadcasting.
 * Abstracts the underlying transport mechanism (WebSocket, SSE, etc.).
 */
export interface Transport {
  /** Upgrade an HTTP request to a persistent connection. Returns the upgrade response. */
  handleUpgrade(request: Request): Response;
  /** Get all tracked connections. */
  getConnections(): Iterable<TransportConnection>;
  /** Get connections currently mapped to a specific session. */
  getConnectionsForSession(sessionId: string): Iterable<TransportConnection>;
  /** Send a message to all tracked connections. */
  broadcast(msg: ServerMessage): void;
  /** Send a message to all connections mapped to a specific session. */
  broadcastToSession(sessionId: string, msg: ServerMessage): void;
  /** Send a message to a specific connection. */
  send(connection: TransportConnection, msg: ServerMessage): void;
  /** Register a handler for incoming messages. */
  onMessage(handler: (connection: TransportConnection, data: string) => void): void;
  /** Register a handler for connection close events. */
  onClose(handler: (connection: TransportConnection) => void): void;
  /** Register a handler for new connection events. */
  onOpen(handler: (connection: TransportConnection) => void): void;
}
