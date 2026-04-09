## Context

AgentDO currently uses Cloudflare-specific WebSocket APIs throughout its transport layer:

| API | Usage |
|-----|-------|
| `new WebSocketPair()` | Creates client/server socket pair for upgrade |
| `ctx.acceptWebSocket(server)` | Registers server socket with DO runtime for hibernation |
| `ws.serializeAttachment({ sessionId })` | Persists session mapping across hibernation |
| `ws.deserializeAttachment()` | Recovers session mapping after hibernation wake |
| `webSocketMessage(ws, data)` | DO lifecycle method — called on incoming message |
| `webSocketClose(ws)` | DO lifecycle method — called on connection close |
| `new Response(null, { status: 101, webSocket: client })` | CF-specific upgrade response |

These are used across ~15 call sites in `agent-do.ts`. The `connections` Map (`Map<WebSocket, { sessionId: string }>`) is the central state that ties WebSocket connections to sessions. The `sendToSocket`, `broadcastToSession`, and various `broadcastXxxList` methods iterate this map to dispatch messages.

The transport protocol types (`ServerMessage`, `ClientMessage` in `transport/types.ts`) are already platform-agnostic — they contain no CF dependencies. This change targets the WebSocket plumbing, not the message format.

The `extract-storage-interfaces` change established the adapter pattern: define a minimal generic interface, create a CF adapter, refactor the consumer to use the interface. This change applies the same pattern to transport.

## Goals / Non-Goals

**Goals:**
- Define `Transport` and `TransportConnection` interfaces capturing connection acceptance, message send/receive, broadcasting, session affinity, and state persistence
- Cloudflare adapter that wraps WebSocketPair + hibernation APIs behind the generic interface
- AgentDO uses only the `Transport` interface — no direct WebSocket API calls
- Zero changes to transport protocol types (`ServerMessage`, `ClientMessage`)
- Zero changes to consumer-facing API (`getConfig`, `getTools`, `buildSystemPrompt`, `validateAuth`)
- The `handleClientMessage` callback pattern allows AgentDO to remain the message handler without the transport needing to know about business logic

**Non-Goals:**
- Creating a Node.js/Bun adapter (this change only defines the interface + CF adapter)
- Abstracting `fetch()` routing — AgentDO still owns the fetch handler and delegates to transport for WebSocket upgrades
- Abstracting DO lifecycle methods beyond WebSocket (`alarm()`, `constructor`) — future steps
- Making AgentDO itself platform-agnostic (it still extends `DurableObject` — that's the final step)
- Changing the client-side `useAgentChat` hook or any UI components

## Decisions

### 1. Two interfaces: Transport and TransportConnection

**Decision**: Define `Transport` (manages all connections, handles upgrades and broadcasting) and `TransportConnection` (represents a single connection with session affinity).

```ts
interface TransportConnection {
  readonly id: string;
  send(msg: ServerMessage): void;
  getSessionId(): string;
  setSessionId(sessionId: string): void;
  close(code?: number, reason?: string): void;
}

interface Transport {
  handleUpgrade(request: Request): Response;
  getConnections(): Iterable<TransportConnection>;
  getConnectionsForSession(sessionId: string): Iterable<TransportConnection>;
  broadcast(msg: ServerMessage): void;
  broadcastToSession(sessionId: string, msg: ServerMessage): void;
  send(connection: TransportConnection, msg: ServerMessage): void;
  onMessage(handler: (connection: TransportConnection, data: string) => void): void;
  onClose(handler: (connection: TransportConnection) => void): void;
  onOpen(handler: (connection: TransportConnection) => void): void;
}
```

**Rationale**: `TransportConnection` encapsulates the session affinity that currently lives in the `connections` Map and `serializeAttachment`. The `Transport` interface encapsulates connection management and broadcasting. This split mirrors the relationship between a WebSocket server and individual sockets.

**Alternative considered**: A single `Transport` interface with connection IDs instead of connection objects. Rejected because AgentDO needs to send messages to specific connections (e.g., the connection that sent a command), and passing opaque IDs would require the transport to maintain a lookup map that duplicates what it already does internally.

### 2. Transport owns the connections Map, not AgentDO

**Decision**: The `connections` Map (and the `connectionRateLimits` Map) move into the transport adapter. AgentDO no longer manages connection state directly.

**Rationale**: Connection tracking is transport implementation detail. The CF adapter needs the map to implement `serializeAttachment`/`deserializeAttachment` for hibernation recovery. A Node adapter using `ws` would track connections differently. AgentDO only needs the `Transport` interface methods to broadcast and send.

**Alternative considered**: Keeping the map in AgentDO and passing it to the transport. Rejected — the map's key type is `WebSocket`, which is CF-specific. The abstraction boundary must be at the transport.

### 3. Transport handles hibernation recovery transparently

**Decision**: The CF adapter's message handler restores the connection mapping from `deserializeAttachment` before invoking the `onMessage` callback. The `onMessage` handler receives a fully-resolved `TransportConnection` with a valid session ID, regardless of whether the DO was hibernated.

**Rationale**: Hibernation recovery is a CF-specific concern. AgentDO shouldn't need to know whether a connection was restored from hibernation or was already tracked. The CF adapter can expose a `wasRestoredFromHibernation` flag on the connection if AgentDO needs to send a sync message after wake (which it currently does).

### 4. AgentDO's fetch() still handles upgrade detection, delegates to transport

**Decision**: `AgentDO.fetch()` continues to check `request.headers.get("upgrade") === "websocket"` and calls `transport.handleUpgrade(request)`. The transport returns the upgrade response.

**Rationale**: The fetch handler owns routing (HTTP prompts, MCP callbacks, A2A endpoints, capability HTTP handlers). WebSocket upgrade is just one route. Keeping the routing in AgentDO and delegating only the upgrade mechanics to the transport is cleaner than having the transport intercept all requests.

**Alternative considered**: Having the transport provide middleware that wraps the fetch handler. Rejected — overengineered for a single conditional check.

### 5. Rate limiting stays in AgentDO, keyed by connection ID

**Decision**: The `connectionRateLimits` Map moves from `Map<WebSocket, ...>` to `Map<string, ...>` keyed by `TransportConnection.id`. Rate limit logic remains in AgentDO.

**Rationale**: Rate limiting is application-level policy, not transport concern. The transport provides a stable connection ID that AgentDO can use as a map key.

### 6. Interfaces live in transport/ module within agent-runtime

**Decision**: Create `packages/agent-runtime/src/transport/transport.ts` for interfaces and `packages/agent-runtime/src/transport/cloudflare.ts` for the CF adapter. Export from `transport/index.ts` barrel.

**Rationale**: Same reasoning as the storage interfaces decision — the `transport/` module already exists with `types.ts` (protocol messages) and `error-codes.ts`. Adding the transport interface alongside them is natural. Extracting to a separate `@claw/core` package is deferred until storage + transport + lifecycle abstractions are all complete.

### 7. TransportConnection exposes wasRestoredFromHibernation

**Decision**: `TransportConnection` includes a `wasRestoredFromHibernation: boolean` property, set by the CF adapter when it reconstructs the connection from a serialized attachment. The generic interface defaults this to `false`.

**Rationale**: AgentDO currently sends a `session_sync` after hibernation recovery for non-prompt/steer messages. This is transport-aware behavior that must survive the abstraction. Making it a property on the connection rather than a method on the transport keeps the check local to where it's used in `webSocketMessage`.

**Alternative considered**: Having the transport emit a separate `onRestore` event. Rejected — it would require a second callback path for what is essentially a flag check in one code location.

### 8. handleWebSocket initial sync logic stays in AgentDO

**Decision**: The `onOpen` callback (fired by `transport.handleUpgrade`) triggers AgentDO to send `session_sync`, `session_list`, `schedule_list`, and `command_list`. This logic stays in AgentDO, not the transport.

**Rationale**: What to send on connect is business logic (which sessions exist, what commands are available, etc.). The transport only knows about connections, not sessions or commands. The `onOpen` handler is where AgentDO wires the initial sync.

## Risks / Trade-offs

**[Risk] webSocketMessage/webSocketClose are DO class methods** → Cloudflare's runtime calls these as lifecycle methods on the DO class. If AgentDO no longer implements them directly, the CF adapter needs to be notified when they're called.
→ *Mitigation*: AgentDO still implements `webSocketMessage` and `webSocketClose` as thin delegators that call `this.transport.handleMessage(ws, data)` and `this.transport.handleClose(ws)`. The CF adapter maps the raw `WebSocket` back to a `TransportConnection` and fires the registered callbacks. This preserves the DO lifecycle contract while keeping the implementation in the adapter.

**[Risk] Breaking change for test patterns** → Tests that directly construct WebSocket mocks and call `webSocketMessage` on the DO will need to adapt.
→ *Mitigation*: Integration tests use the Workers pool which handles DO lifecycle automatically. Unit tests that mock connections will use `TransportConnection` mocks instead of raw `WebSocket` mocks. The change is mechanical.

**[Risk] Connection ID stability across hibernation** → The CF adapter needs a stable ID for each connection that survives hibernation. Cloudflare's WebSocket objects don't have a built-in ID.
→ *Mitigation*: Generate a UUID on initial connection and persist it via `serializeAttachment` alongside the session ID. On hibernation recovery, the ID is restored from the attachment.

**[Trade-off] AgentDO still implements webSocketMessage/webSocketClose** → These are CF-specific lifecycle methods. A fully platform-agnostic AgentDO wouldn't have them. But since AgentDO still extends `DurableObject`, removing them entirely is premature.
→ *Accepted*: The thin delegator pattern is the right interim step. When AgentDO is fully decoupled from DurableObject (the final step), these methods disappear and the transport handles the lifecycle internally.

**[Trade-off] handleUpgrade returns a Response** → The `Response` object with `status: 101` and `webSocket` property is CF-specific. A Node adapter would handle the upgrade differently (via the HTTP server's upgrade event).
→ *Accepted*: The `handleUpgrade(request: Request): Response` signature works for CF and can work for standards-based platforms where `Response` is available. A Node adapter might need `handleUpgrade(request: IncomingMessage, socket: Socket)` — when that adapter is built, we may need an overloaded or platform-specific upgrade method. For now, `Request → Response` matches how AgentDO's `fetch()` works.
