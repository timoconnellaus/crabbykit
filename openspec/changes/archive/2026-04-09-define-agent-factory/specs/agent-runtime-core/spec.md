## ADDED Requirements

### Requirement: AgentRuntime is a platform-agnostic abstract class
The SDK SHALL define an abstract class `AgentRuntime<TEnv>` containing all agent business logic with zero imports from `cloudflare:workers` or other platform-specific modules. It SHALL be importable from `@crabbykit/agent-runtime`.

#### Scenario: AgentRuntime has no Cloudflare imports
- **WHEN** `agent-runtime.ts` is inspected
- **THEN** there is no `import` statement referencing `cloudflare:workers` or any CF-specific module

#### Scenario: AgentRuntime can be tested without CF Workers pool
- **WHEN** unit tests construct `AgentRuntime` with mock adapters (`SqlStore`, `KvStore`, `Scheduler`, `Transport`, `RuntimeContext`)
- **THEN** tests run in any JavaScript environment without `@cloudflare/vitest-pool-workers`

### Requirement: AgentRuntime constructor takes platform adapters
The `AgentRuntime` constructor SHALL accept `(sqlStore: SqlStore, kvStore: KvStore, scheduler: Scheduler, transport: Transport, runtimeContext: RuntimeContext, env: TEnv)`. All platform primitives SHALL be injected — no internal construction of CF-specific objects.

#### Scenario: All adapters injected
- **WHEN** `AgentRuntime` is constructed
- **THEN** all six parameters are required and assigned to internal fields

### Requirement: AgentRuntime receives only the abstract Transport interface
`AgentRuntime` SHALL receive `Transport` (the abstract interface) in its constructor, NOT a concrete implementation like `CfWebSocketTransport`. The runtime SHALL NOT cast `this.transport` to any concrete subtype.

#### Scenario: No concrete transport casts in AgentRuntime
- **WHEN** `agent-runtime.ts` is inspected
- **THEN** there is no `as CfWebSocketTransport` or similar cast on `this.transport`

#### Scenario: WebSocket lifecycle methods stay on the platform shell
- **WHEN** AgentDO needs to call `handleMessage` or `handleClose` on the CF transport
- **THEN** AgentDO holds a separate `cfTransport: CfWebSocketTransport` reference and calls methods on it directly, while AgentRuntime uses only the abstract `Transport` interface

### Requirement: RuntimeContext interface provides identity and async tracking
The SDK SHALL define a `RuntimeContext` interface with `agentId: string` (stable identifier for A2A callback URLs) and `waitUntil(promise: Promise<unknown>): void` (fire-and-forget tracking).

#### Scenario: AgentRuntime uses RuntimeContext for identity
- **WHEN** AgentRuntime needs the agent ID (e.g., for A2A callback URL construction)
- **THEN** it reads `this.runtimeContext.agentId`, never `ctx.id.toString()`

#### Scenario: AgentRuntime uses RuntimeContext for waitUntil
- **WHEN** AgentRuntime needs to track a fire-and-forget promise
- **THEN** it calls `this.runtimeContext.waitUntil(promise)`, never `ctx.waitUntil(promise)`

### Requirement: AgentRuntime exposes all current store types
`AgentRuntime` SHALL initialize and expose `sessionStore`, `scheduleStore`, `configStore`, `mcpManager`, `taskStore`, `queueStore`, `kvStore`, `scheduler`, and `transport` as protected properties. Subclasses (including AgentDO) SHALL access them via the same names as today.

#### Scenario: All stores present including QueueStore
- **WHEN** `AgentRuntime` is constructed
- **THEN** `sessionStore`, `scheduleStore`, `configStore`, `mcpManager`, `taskStore`, `queueStore`, `kvStore`, `scheduler`, `transport` are all initialized and accessible to subclasses

### Requirement: AgentRuntime defines abstract and overridable methods
`AgentRuntime` SHALL declare `getConfig()` and `getTools(ctx)` as abstract methods. It SHALL provide default implementations for `buildSystemPrompt`, `getPromptOptions`, `getCapabilities`, `getSubagentProfiles`, `getConfigNamespaces`, `getA2AClientOptions`, `getCommands`, and lifecycle hooks (`validateAuth`, `onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire`).

#### Scenario: Required methods are abstract
- **WHEN** a class extends `AgentRuntime` without implementing `getConfig` or `getTools`
- **THEN** TypeScript reports a compile error

#### Scenario: Optional methods have defaults
- **WHEN** a class extends `AgentRuntime` without overriding `getCapabilities`
- **THEN** the default returns `[]`

#### Scenario: getSubagentProfiles is overridable
- **WHEN** a class extends `AgentRuntime` and overrides `getSubagentProfiles()`
- **THEN** the override is called during capability resolution and returned profiles are registered

### Requirement: Internal helpers stay inside AgentRuntime
The following internal helpers SHALL live entirely inside `AgentRuntime` and SHALL NOT be delegated to a host: `buildScheduleManager`, `createSchedule`/`updateSchedule`/`deleteSchedule`/`listSchedules`, `refreshAlarm`, `handleAgentEvent`, `handleCostEvent`, `transformContext`, `resolveToolsForSession`, `createSessionBroadcast`, `broadcastCustomToAll`, `createCapabilityBroadcastState`, `fireOnConnectHooks`, `disposeCapabilities`, `handleA2ARequest`, `handleMcpCallback`, `syncCapabilitySchedules`, `matchHttpHandler`, `ensureAgent`, `getCachedCapabilities`. These are not override points.

#### Scenario: Delegation list is exactly the override surface
- **WHEN** the `AgentDelegate` interface is inspected
- **THEN** it contains exactly: 2 abstract methods (`getConfig`, `getTools`), 7 optional overrides (`buildSystemPrompt`, `getPromptOptions`, `getCapabilities`, `getSubagentProfiles`, `getConfigNamespaces`, `getA2AClientOptions`, `getCommands`), and 5 hooks (`validateAuth`, `onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire`) — nothing else

### Requirement: AgentRuntime provides handleRequest and handleAlarmFired
`AgentRuntime` SHALL expose `handleRequest(request: Request): Promise<Response>` containing all HTTP routing logic, and `handleAlarmFired(): Promise<void>` containing schedule alarm processing. Both SHALL be callable from any platform shell.

#### Scenario: handleRequest routes auth, WebSocket, prompt, schedule, A2A, capability HTTP
- **WHEN** a Web standard `Request` is passed to `handleRequest`
- **THEN** it routes to the appropriate handler and returns a `Response`

#### Scenario: handleAlarmFired processes schedules
- **WHEN** `handleAlarmFired()` is called
- **THEN** due schedules are processed via the scheduler

### Requirement: createDelegatingRuntime helper
The SDK SHALL export `createDelegatingRuntime<TEnv>(host: AgentDelegate<TEnv>, adapters: { sqlStore, kvStore, scheduler, transport, runtimeContext, env }): AgentRuntime<TEnv>`. This helper SHALL construct an anonymous `AgentRuntime` subclass whose abstract method overrides forward to `host.*`. Both `AgentDO` and `defineAgent` SHALL use this helper instead of inlining the pattern.

#### Scenario: Helper produces a working runtime
- **WHEN** `createDelegatingRuntime(myHost, myAdapters)` is called
- **THEN** the returned object is an `AgentRuntime` instance whose `getConfig()` calls `myHost.getConfig()`, etc.

#### Scenario: Optional hooks fall back to no-ops
- **WHEN** the host does not provide `onTurnEnd`
- **THEN** the runtime's `onTurnEnd` does nothing (no error thrown)

### Requirement: AgentDO is a thin Cloudflare shell
`AgentDO<TEnv>` SHALL `extends DurableObject<TEnv>`, implement `AgentDelegate<TEnv>`, hold a concrete `cfTransport: CfWebSocketTransport` separately, construct an `AgentRuntime` via `createDelegatingRuntime(this, ...)`, and delegate `fetch()`, `alarm()`, `webSocketMessage()`, and `webSocketClose()` to the runtime or its CF transport.

#### Scenario: AgentDO holds CfWebSocketTransport directly
- **WHEN** `AgentDO` is constructed
- **THEN** it creates a `CfWebSocketTransport` instance, stores it in `this.cfTransport`, and passes it (typed as the abstract `Transport`) to `createDelegatingRuntime`

#### Scenario: webSocketMessage uses cfTransport directly
- **WHEN** `AgentDO.webSocketMessage(ws, msg)` is called
- **THEN** it calls `this.cfTransport.handleMessage(ws, msg)` without casting through `this.runtime.transport`

#### Scenario: AgentDO delegates fetch to runtime
- **WHEN** `AgentDO.fetch(request)` is called
- **THEN** it calls `this.runtime.handleRequest(request)` and returns the result

#### Scenario: AgentDO delegates alarm to runtime
- **WHEN** the DO alarm fires
- **THEN** `AgentDO.alarm()` calls `this.runtime.handleAlarmFired()`

### Requirement: createCfRuntimeContext factory
The SDK SHALL export `createCfRuntimeContext(ctx: DurableObjectState): RuntimeContext` that constructs a `RuntimeContext` from a CF `DurableObjectState`, mapping `ctx.id.toString()` to `agentId` and `ctx.waitUntil` to `waitUntil`.

#### Scenario: CF context produces a RuntimeContext
- **WHEN** `createCfRuntimeContext(ctx)` is called
- **THEN** the returned object has `agentId === ctx.id.toString()` and `waitUntil` delegates to `ctx.waitUntil`

### Requirement: AgentDO consumer API is preserved
All abstract methods, optional overrides, lifecycle hooks, and protected store/manager properties currently available on AgentDO SHALL continue to work without consumer changes.

#### Scenario: Protected store getters delegate to runtime
- **WHEN** an AgentDO subclass accesses `this.sessionStore`
- **THEN** the value is the runtime's `sessionStore` instance, accessed via a protected getter on AgentDO that delegates

### Requirement: AgentRuntime is excluded from coverage thresholds
`vitest.config.ts` SHALL exclude `agent-runtime.ts` from the coverage threshold config (matching the existing exclusion of `agent-do.ts`). This is acknowledged technical debt — the runtime is integration-tested via the AgentDO suite but lacks unit-test coverage of internal helpers.

#### Scenario: Coverage config excludes agent-runtime
- **WHEN** `vitest.config.ts` is inspected
- **THEN** `agent-runtime.ts` is in the coverage exclusion list

### Requirement: capabilities/types.ts imports from agent-runtime
After the extraction, `packages/agent-runtime/src/capabilities/types.ts` SHALL import `AgentContext` from `agent-runtime.js`, NOT from `agent-do.js`. This avoids pulling AgentDO (and `cloudflare:workers`) into capability type files.

#### Scenario: No agent-do import in capabilities/types
- **WHEN** `capabilities/types.ts` is inspected
- **THEN** there is no import statement referencing `agent-do.js` or `agent-do`

### Requirement: AgentRuntime stays in agent-runtime package
The `AgentRuntime` class, `RuntimeContext` interface, `createCfRuntimeContext` factory, and `createDelegatingRuntime` helper SHALL live in `packages/agent-runtime/src/`. No new package SHALL be created in this change.

#### Scenario: Files in expected locations
- **WHEN** the change is implemented
- **THEN** `packages/agent-runtime/src/agent-runtime.ts`, `runtime-context.ts`, `runtime-context-cloudflare.ts`, and `runtime-delegating.ts` exist and are exported from the package barrel
