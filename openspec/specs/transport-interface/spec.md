# transport-interface Specification

## Purpose
TBD - created by archiving change abstract-websocket-transport. Update Purpose after archive.
## Requirements
### Requirement: TransportConnection interface represents a single client connection
The `TransportConnection` interface SHALL expose a stable `id` (string), methods to `send(msg: ServerMessage)`, `getSessionId()`, `setSessionId(sessionId: string)`, and `close(code?: number, reason?: string)`. It SHALL also expose a `wasRestoredFromHibernation` boolean property indicating whether the connection was reconstructed from persisted state after a runtime restart.

#### Scenario: Send a message to a connection
- **WHEN** `send(msg)` is called with a `ServerMessage`
- **THEN** the message is serialized to JSON and delivered to the connected client

#### Scenario: Get the current session ID
- **WHEN** `getSessionId()` is called on a connection
- **THEN** the session ID associated with that connection is returned

#### Scenario: Set a new session ID
- **WHEN** `setSessionId(newId)` is called on a connection
- **THEN** subsequent calls to `getSessionId()` return `newId` and the mapping is persisted for hibernation recovery

#### Scenario: Connection restored from hibernation
- **WHEN** a Cloudflare DO wakes from hibernation and a message arrives on a previously-established WebSocket
- **THEN** the CF adapter reconstructs the `TransportConnection` with `wasRestoredFromHibernation` set to `true`

#### Scenario: Fresh connection
- **WHEN** a new WebSocket connection is established
- **THEN** `wasRestoredFromHibernation` is `false`

### Requirement: Transport interface manages connections and message dispatch
The `Transport` interface SHALL expose methods for upgrading HTTP requests to WebSocket connections, iterating connections, broadcasting messages, and registering message/close/open handlers.

#### Scenario: Upgrade an HTTP request to WebSocket
- **WHEN** `handleUpgrade(request)` is called with a valid WebSocket upgrade request
- **THEN** a `Response` with status 101 is returned and the connection is tracked by the transport

#### Scenario: Broadcast to all connections
- **WHEN** `broadcast(msg)` is called with a `ServerMessage`
- **THEN** every tracked connection receives the message

#### Scenario: Broadcast to a specific session
- **WHEN** `broadcastToSession(sessionId, msg)` is called
- **THEN** only connections whose current session ID matches `sessionId` receive the message

#### Scenario: Send to a specific connection
- **WHEN** `send(connection, msg)` is called
- **THEN** only the specified connection receives the message

#### Scenario: Iterate all connections
- **WHEN** `getConnections()` is called
- **THEN** an iterable of all tracked `TransportConnection` instances is returned

#### Scenario: Iterate connections for a session
- **WHEN** `getConnectionsForSession(sessionId)` is called
- **THEN** an iterable of connections currently mapped to that session ID is returned

#### Scenario: Register message handler
- **WHEN** `onMessage(handler)` is called
- **THEN** the handler is invoked with `(connection, data)` for every incoming text message on any tracked connection

#### Scenario: Register close handler
- **WHEN** `onClose(handler)` is called
- **THEN** the handler is invoked with `(connection)` when a tracked connection closes

#### Scenario: Register open handler
- **WHEN** `onOpen(handler)` is called
- **THEN** the handler is invoked with `(connection)` when a new connection is established via `handleUpgrade`

### Requirement: Cloudflare Transport adapter wraps WebSocketPair and hibernation APIs
A `CfWebSocketTransport` class SHALL implement the `Transport` interface using Cloudflare's `WebSocketPair()`, `ctx.acceptWebSocket()`, `serializeAttachment()`/`deserializeAttachment()`. It SHALL accept a `DurableObjectState` (ctx) in its constructor.

#### Scenario: handleUpgrade creates a WebSocketPair
- **WHEN** `handleUpgrade(request)` is called
- **THEN** a new `WebSocketPair()` is created, the server socket is accepted via `ctx.acceptWebSocket()`, and the response includes the client socket

#### Scenario: Session ID is persisted via serializeAttachment
- **WHEN** `setSessionId(id)` is called on a CF transport connection
- **THEN** `ws.serializeAttachment({ sessionId: id, connectionId })` is called to persist the mapping for hibernation

#### Scenario: Hibernation recovery via deserializeAttachment
- **WHEN** the DO wakes from hibernation and `handleMessage(ws, data)` is called with an untracked WebSocket
- **THEN** `ws.deserializeAttachment()` is used to recover the connection ID and session ID, the connection is re-tracked, and `wasRestoredFromHibernation` is set to `true`

#### Scenario: Connection close cleans up tracking
- **WHEN** `handleClose(ws)` is called
- **THEN** the connection is removed from the transport's internal tracking

### Requirement: AgentDO delegates to Transport instead of using WebSocket APIs directly
`AgentDO` SHALL construct a `Transport` instance (via CF adapter) and use it for all connection management, message sending, and broadcasting. The `connections` Map and `connectionRateLimits` Map SHALL no longer use `WebSocket` as a key type.

#### Scenario: AgentDO constructs transport in constructor
- **WHEN** `AgentDO` is instantiated by the Cloudflare runtime
- **THEN** it creates a `CfWebSocketTransport` from `ctx` and registers `onMessage`, `onClose`, and `onOpen` handlers

#### Scenario: AgentDO.fetch delegates WebSocket upgrades to transport
- **WHEN** a WebSocket upgrade request arrives at `fetch()`
- **THEN** `this.transport.handleUpgrade(request)` is called and its response is returned

#### Scenario: broadcastToSession uses transport
- **WHEN** AgentDO needs to broadcast an event to a session
- **THEN** it calls `this.transport.broadcastToSession(sessionId, msg)` instead of iterating the connections Map

#### Scenario: webSocketMessage delegates to transport
- **WHEN** Cloudflare calls `webSocketMessage(ws, data)` on the DO
- **THEN** AgentDO calls `this.transport.handleMessage(ws, data)` which resolves the connection and fires the registered onMessage handler

#### Scenario: webSocketClose delegates to transport
- **WHEN** Cloudflare calls `webSocketClose(ws)` on the DO
- **THEN** AgentDO calls `this.transport.handleClose(ws)` which cleans up tracking and fires the registered onClose handler

#### Scenario: handleClientMessage receives TransportConnection instead of WebSocket
- **WHEN** `handleClientMessage` is called
- **THEN** it receives a `TransportConnection` parameter and uses `connection.send()`, `connection.setSessionId()` instead of raw WebSocket methods

### Requirement: Rate limiting uses connection ID instead of WebSocket reference
The `connectionRateLimits` Map SHALL use `string` keys (connection IDs from `TransportConnection.id`) instead of `WebSocket` keys.

#### Scenario: Rate limit tracked by connection ID
- **WHEN** a message is received from a connection
- **THEN** the rate limit check uses `connection.id` as the map key

#### Scenario: Rate limit cleaned up on close
- **WHEN** a connection closes
- **THEN** `connectionRateLimits.delete(connection.id)` is called

### Requirement: Transport interfaces are exported from barrel
The `Transport`, `TransportConnection` types SHALL be exported from `agent-runtime`'s public barrel (`index.ts`). The `CfWebSocketTransport` class SHALL also be exported for consumers who need to create transports in custom DO classes.

#### Scenario: Import types from package
- **WHEN** a consumer writes `import type { Transport, TransportConnection } from "@crabbykit/agent-runtime"`
- **THEN** the types resolve correctly

#### Scenario: Import CF adapter from package
- **WHEN** a consumer writes `import { CfWebSocketTransport } from "@crabbykit/agent-runtime"`
- **THEN** the class resolves correctly

