## Why

AgentDO currently extends `DurableObject` and contains all business logic directly. Previous changes (extract-storage-interfaces, abstract-scheduling-alarms, abstract-websocket-transport, migrate-a2a-taskstore) abstracted the individual platform dependencies behind generic interfaces, but the class itself is still bound to Cloudflare's DO lifecycle. This prevents anyone from running the same agent logic on Node.js, Bun, or other runtimes. Extracting the business logic into a platform-agnostic `AgentRuntime` class is the capstone that makes `@claw/node` or `@claw/bun` adapters possible.

## What Changes

- **New `AgentRuntime` class**: A platform-agnostic base class that contains all current AgentDO business logic -- session management, agent loop, capability system, scheduling dispatch, A2A protocol handling, command execution, broadcasting, rate limiting, HTTP routing. Receives `SqlStore`, `KvStore`, `Scheduler`, and `Transport` via constructor injection.
- **New `RuntimeContext` interface**: Abstracts the two remaining CF-specific needs: agent identity (`ctx.id` for A2A callback URLs) and background work tracking (`ctx.waitUntil()` for fire-and-forget operations).
- **AgentDO becomes a thin CF shell**: Creates CF adapters (SqlStore, KvStore, Scheduler, Transport) and a CF RuntimeContext, then delegates everything to an internal `AgentRuntime` instance. The DO lifecycle methods (`fetch()`, `alarm()`, `webSocketMessage()`, `webSocketClose()`) become one-line delegators.
- **Consumer API preserved**: `getConfig()`, `getTools()`, `buildSystemPrompt()`, `getCapabilities()`, `getCommands()`, lifecycle hooks (`onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire`) -- all remain identical. Consumers can extend either `AgentDO` (CF-only, backwards compatible) or `AgentRuntime` (platform-agnostic).
- **`handleRequest()` method on AgentRuntime**: Replaces `fetch()` as the platform-agnostic HTTP entry point. Takes a `Request`, returns a `Response`. AgentDO.fetch() delegates to it.

## Capabilities

### New Capabilities
- `agent-runtime-core`: The platform-agnostic AgentRuntime class, RuntimeContext interface, and the separation of business logic from platform bindings. Covers constructor injection pattern, abstract method surface, lifecycle delegation, and request handling.

### Modified Capabilities

(none -- no existing spec-level requirements are changing)

## Impact

- **`packages/agent-runtime/src/agent-do.ts`**: Refactored from ~2300 lines of business logic to ~50 lines of CF adapter wiring + delegation.
- **`packages/agent-runtime/src/agent-runtime.ts`**: New file containing the extracted business logic (~2200 lines).
- **`packages/agent-runtime/src/runtime-context.ts`**: New file defining the `RuntimeContext` interface and CF adapter.
- **`packages/agent-runtime/src/index.ts`**: Updated barrel exports to include `AgentRuntime`, `RuntimeContext`.
- **Consumer code**: No changes required. Consumers extending `AgentDO` continue to work. New consumers targeting non-CF platforms extend `AgentRuntime` instead.
- **Test suite**: Existing integration tests continue to work via AgentDO. New unit tests for AgentRuntime can use mock adapters instead of the CF Workers pool.
- **Downstream packages**: Capability packages, A2A package -- no changes. They depend on `AgentContext`, `AgentTool`, and other interfaces that are already platform-agnostic.
