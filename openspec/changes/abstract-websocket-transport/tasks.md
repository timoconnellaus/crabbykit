## 1. Define Transport Interfaces

- [x] 1.1 Create `packages/agent-runtime/src/transport/transport.ts` with `TransportConnection` and `Transport` interfaces
- [x] 1.2 Update `packages/agent-runtime/src/transport/index.ts` barrel to re-export new interfaces
- [x] 1.3 Add transport interface exports to `packages/agent-runtime/src/index.ts` barrel

## 2. Implement Cloudflare Transport Adapter

- [x] 2.1 Create `packages/agent-runtime/src/transport/cloudflare.ts` with `CfWebSocketTransport` class implementing `Transport`
- [x] 2.2 Implement `handleUpgrade` — create `WebSocketPair`, call `ctx.acceptWebSocket`, generate connection ID, persist via `serializeAttachment`, track connection, fire `onOpen` handler
- [x] 2.3 Implement `handleMessage(ws, data)` — restore connection from `deserializeAttachment` if untracked (hibernation recovery), set `wasRestoredFromHibernation`, fire `onMessage` handler
- [x] 2.4 Implement `handleClose(ws)` — remove from tracking, fire `onClose` handler
- [x] 2.5 Implement `broadcast`, `broadcastToSession`, `send`, `getConnections`, `getConnectionsForSession`
- [x] 2.6 Implement `CfTransportConnection` wrapping a raw `WebSocket` — `send` (JSON.stringify + ws.send), `getSessionId`/`setSessionId` (backed by internal map + serializeAttachment), `close`, `id`, `wasRestoredFromHibernation`
- [x] 2.7 Export `CfWebSocketTransport` from transport barrel and package barrel

## 3. Refactor AgentDO to Use Transport

- [x] 3.1 Add `transport` field to AgentDO, construct `CfWebSocketTransport` in constructor, register `onMessage`/`onClose`/`onOpen` handlers
- [x] 3.2 Replace `handleWebSocket()` with `this.transport.handleUpgrade(request)` — move initial sync logic into the `onOpen` handler
- [x] 3.3 Replace `webSocketMessage()` body with `this.transport.handleMessage(ws, data)` delegation (thin delegator)
- [x] 3.4 Replace `webSocketClose()` body with `this.transport.handleClose(ws)` delegation (thin delegator)
- [x] 3.5 Replace `broadcastToSession()` with `this.transport.broadcastToSession()`
- [x] 3.6 Replace `broadcastCustomToAll()`, `broadcastScheduleList()`, `broadcastMcpStatus()`, `broadcastSessionList()` to use `this.transport.broadcast()` or `this.transport.getConnections()`
- [x] 3.7 Replace `sendToSocket(ws, msg)` calls with `connection.send(msg)` or `this.transport.send(connection, msg)`
- [x] 3.8 Replace `sendSessionList(ws)` and `sendCommandList(ws, sessionId)` to accept `TransportConnection` instead of `WebSocket`
- [x] 3.9 Change `handleClientMessage(ws, msg)` signature from `WebSocket` to `TransportConnection` — update `switch_session`, `new_session`, `delete_session` branches to use `connection.setSessionId()` instead of `ws.serializeAttachment()`
- [x] 3.10 Change `handleClearCommand(ws, sessionId)` and `handleCommand(ws, ...)` to accept `TransportConnection`
- [x] 3.11 Change `connectionRateLimits` from `Map<WebSocket, ...>` to `Map<string, ...>` keyed by `connection.id`
- [x] 3.12 Remove the `connections` Map from AgentDO — it now lives in the transport
- [x] 3.13 Remove direct imports of `WebSocketPair` and WebSocket-related CF types from agent-do.ts (beyond the thin delegators)

## 4. Update Tests

- [x] 4.1 Verify integration tests pass with Workers pool (transport is transparent — AgentDO constructs CF adapter automatically)
- [x] 4.2 Update any unit tests that mock WebSocket connections to mock `TransportConnection` instead
- [x] 4.3 Add unit test for `CfWebSocketTransport` — connection tracking, session affinity, hibernation recovery

## 5. Verify

- [x] 5.1 Run `bun run typecheck` — no type errors across workspaces
- [x] 5.2 Run `bun run test` — all existing tests pass
- [x] 5.3 Run `bun run lint` — no lint violations in changed files
- [x] 5.4 Verify no remaining direct WebSocket API usage in agent-do.ts beyond the two thin delegator methods (`webSocketMessage`, `webSocketClose`)
