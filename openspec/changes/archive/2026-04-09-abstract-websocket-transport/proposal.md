## Why

AgentDO is directly coupled to Cloudflare's WebSocket APIs: `WebSocketPair()`, `ctx.acceptWebSocket()`, `serializeAttachment()`/`deserializeAttachment()`, and the DO hibernation lifecycle methods `webSocketMessage()`/`webSocketClose()`. This makes it impossible to run the agent runtime on Node.js, Bun, or Deno without Cloudflare's WebSocket primitives. After extracting storage interfaces (see `extract-storage-interfaces`), WebSocket transport is the next biggest coupling surface.

## What Changes

- Define a `Transport` interface that abstracts connection acceptance, message sending, broadcasting, and connection lifecycle (session mapping, state recovery after restart)
- Define a `TransportConnection` interface representing an individual connection with session affinity and state persistence
- Create a Cloudflare adapter (`CfWebSocketTransport`) that wraps `WebSocketPair()`, `ctx.acceptWebSocket()`, `serializeAttachment`/`deserializeAttachment`, and the `connections` Map behind the `Transport` interface
- Refactor `AgentDO` to use the `Transport` interface instead of raw WebSocket APIs — replace direct `connections` Map access, `ws.send()`, `ws.serializeAttachment()`, and broadcast loops with transport method calls
- **BREAKING**: `webSocketMessage()` and `webSocketClose()` are no longer implemented directly on `AgentDO` — the CF adapter registers them internally
- Move the `handleWebSocket()` upgrade logic into the CF transport adapter
- Extract `sendToSocket()`, `broadcastToSession()`, `broadcastToAll()` (schedule list, MCP status, session list) from AgentDO into Transport methods

## Capabilities

### New Capabilities
- `transport-interface`: Platform-agnostic `Transport` and `TransportConnection` interfaces that decouple AgentDO from Cloudflare WebSocket primitives, plus a Cloudflare adapter implementation

### Modified Capabilities

_None — no existing spec-level behaviors change. The transport protocol message types (`ServerMessage`, `ClientMessage`) remain identical. Consumer-facing API (`getConfig`, `getTools`, `buildSystemPrompt`) is unaffected._

## Impact

- **`packages/agent-runtime/src/agent-do.ts`**: Largest change. The `connections` Map, `sendToSocket()`, `broadcastToSession()`, `broadcastToAll()` methods, `handleWebSocket()`, `webSocketMessage()`, `webSocketClose()`, `handleClearCommand()` (uses `ws` param), and `handleCommand()` (uses `ws` param) all refactored to use `Transport` abstraction. The `handleClientMessage()` method signature changes from raw `WebSocket` to `TransportConnection`.
- **`packages/agent-runtime/src/transport/`**: New files for interface definitions and CF adapter.
- **`packages/agent-runtime/src/transport/types.ts`**: Unchanged — protocol message types are already platform-agnostic.
- **Tests**: Integration tests in Workers pool need the CF adapter wired up (transparent — AgentDO constructor creates it). Unit tests that mock WebSocket connections will mock `TransportConnection` instead.
- **Consumer API**: No change — consumers extend `AgentDO` and don't interact with WebSocket APIs directly. The `validateAuth` hook continues to receive a `Request` object.
- **Dependencies**: No new external dependencies. A future Node/Bun adapter would depend on the `ws` library but is out of scope.
