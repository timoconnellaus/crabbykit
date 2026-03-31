## Context

CLAW's `AgentDO` class is both the Cloudflare Durable Object lifecycle host and the agent business logic engine. Previous changes have abstracted the individual platform dependencies:

| Change | What it abstracted | Interface |
|--------|--------------------|-----------|
| extract-storage-interfaces | SqlStorage, DurableObjectStorage | SqlStore, KvStore |
| abstract-scheduling-alarms | DO alarms | Scheduler |
| abstract-websocket-transport | WebSocketPair, hibernation | Transport, TransportConnection |
| migrate-a2a-taskstore | A2A TaskStore to SqlStore | (used SqlStore) |

The remaining CF coupling in AgentDO is structural:
- `extends DurableObject` -- the class hierarchy
- `fetch()` / `alarm()` / `webSocketMessage()` / `webSocketClose()` -- DO lifecycle methods
- `this.ctx.id` -- used for A2A callback agent identity
- `this.ctx.waitUntil()` -- fire-and-forget async operation tracking

This change extracts the ~2200 lines of business logic into a platform-agnostic `AgentRuntime` class, leaving AgentDO as a thin CF shell (~50 lines).

## Goals / Non-Goals

**Goals:**
- Define an `AgentRuntime` abstract class that contains all agent business logic with zero platform imports
- Define a `RuntimeContext` interface for the two remaining platform-specific needs (identity + background work)
- AgentDO becomes a thin wrapper: creates CF adapters, instantiates AgentRuntime (via composition), delegates lifecycle methods
- Consumers extending AgentDO continue to work with zero changes (backwards compatible)
- Consumers targeting non-CF platforms can extend AgentRuntime directly
- The abstract method surface (getConfig, getTools, buildSystemPrompt, getCapabilities, getCommands) stays identical
- All lifecycle hooks (onTurnEnd, onAgentEnd, onSessionCreated, onScheduleFire) stay identical

**Non-Goals:**
- Creating a Node.js or Bun adapter (only the interface + extraction)
- Creating a new `@claw/core` package (AgentRuntime stays in agent-runtime for now)
- Changing the transport protocol, session store, or capability system
- Abstracting the lazy pi-SDK loading pattern (it remains as-is in AgentRuntime)
- Splitting AgentRuntime into smaller classes (single class, same as today)

## Decisions

### 1. Composition over inheritance for AgentDO -> AgentRuntime

**Decision**: AgentDO does NOT extend AgentRuntime. Instead, AgentDO creates an internal `AgentRuntime` subclass instance and delegates to it. AgentDO continues to extend `DurableObject`.

**Rationale**: TypeScript does not support multiple inheritance. AgentDO must extend `DurableObject` (CF requirement) and cannot also extend `AgentRuntime`. Composition is the natural pattern: AgentDO constructs a runtime instance, forwarding the abstract method implementations from its own overrides.

The internal runtime subclass is a private class created in the AgentDO constructor that bridges AgentDO's abstract methods to AgentRuntime's abstract methods:

```ts
class AgentDO extends DurableObject {
  private runtime: AgentRuntime;

  constructor(ctx, env) {
    super(ctx, env);
    const self = this;
    // Anonymous subclass that delegates abstract methods back to AgentDO
    this.runtime = new (class extends AgentRuntime {
      getConfig() { return self.getConfig(); }
      getTools(ctx) { return self.getTools(ctx); }
      // ... etc
    })(sqlStore, kvStore, scheduler, transport, runtimeContext);
  }
}
```

**Alternative considered**: AgentDO extends AgentRuntime (which does not extend DurableObject). This would require AgentRuntime to have the DO lifecycle methods or AgentDO to re-implement them. It also breaks the type system -- CF expects the export to extend DurableObject.

### 2. RuntimeContext interface for identity and background work

**Decision**: Define a `RuntimeContext` interface with two concerns:

```ts
interface RuntimeContext {
  /** Stable identifier for this agent instance (used in A2A callback URLs). */
  readonly agentId: string;
  /** Track a fire-and-forget async operation so the platform keeps the process alive. */
  waitUntil(promise: Promise<unknown>): void;
}
```

**Rationale**: These are the only two `ctx` usages that cannot be modeled by the existing interfaces:
- `ctx.id.toString()` is used in A2A tool options for callback URL construction. Renamed to `agentId` for clarity.
- `ctx.waitUntil()` is used in the A2A callback handler to keep the DO alive while a fire-and-forget prompt runs. A Node.js adapter would implement this as a no-op (process stays alive anyway) or with a pending-promise tracker.

**Alternative considered**: Adding `agentId` as a constructor parameter and `waitUntil` as a method on AgentRuntime. Rejected -- these are platform concerns, not business logic. Grouping them in an interface keeps the constructor clean and makes it clear what a platform adapter must provide.

### 3. AgentRuntime receives all adapters via constructor

**Decision**: AgentRuntime constructor takes all platform adapters:

```ts
abstract class AgentRuntime {
  constructor(
    sqlStore: SqlStore,
    kvStore: KvStore,
    scheduler: Scheduler,
    transport: Transport,
    runtimeContext: RuntimeContext,
  )
}
```

**Rationale**: Constructor injection makes dependencies explicit and testable. All adapters are created by the platform shell (AgentDO) and passed in. No service locator or lazy initialization for platform primitives.

**Alternative considered**: A single `RuntimePlatform` bag-of-adapters object. Rejected because it adds a level of indirection for no benefit -- the constructor parameters are already a clear contract. A future refactor could bundle them if the parameter list grows, but five parameters is manageable.

### 4. handleRequest() replaces fetch() as the business logic entry point

**Decision**: AgentRuntime exposes `handleRequest(request: Request): Promise<Response>` containing all the HTTP routing logic currently in `fetch()`. AgentDO.fetch() calls `this.runtime.handleRequest(request)`.

**Rationale**: `fetch()` is a CF DO lifecycle method name. The business logic (auth check, WebSocket upgrade delegation, HTTP prompt, schedule API, A2A endpoints, capability HTTP handlers) is platform-agnostic -- it only needs `Request` and `Response` (Web standard types available in Node 18+, Bun, Deno, CF Workers).

The method name `handleRequest` avoids collision with the global `fetch` function and clearly communicates its role.

### 5. handleAlarmFired() becomes a public method on AgentRuntime

**Decision**: `handleAlarmFired()` moves from `protected` on AgentDO to `public` on AgentRuntime.

**Rationale**: Non-CF platforms need to call this from their own wake mechanism (setTimeout, node-cron, etc.). Making it public allows any platform adapter to trigger schedule processing. The CF adapter calls it from `alarm()`.

### 6. AgentRuntime stays in the agent-runtime package

**Decision**: The new `AgentRuntime` class lives at `packages/agent-runtime/src/agent-runtime.ts`. No new package is created.

**Rationale**: Consistent with the decisions made in extract-storage-interfaces and abstract-scheduling-alarms. Creating a `@claw/core` package is deferred until there is a second consumer (e.g., `@claw/node`). Extracting to a new package then is straightforward -- it is a move + re-export, not a redesign.

### 7. Protected stores and managers remain accessible

**Decision**: `sessionStore`, `scheduleStore`, `configStore`, `mcpManager`, `taskStore`, `kvStore`, `scheduler`, `transport` remain as `protected` properties on AgentRuntime.

**Rationale**: Consumers and tests currently access these via protected visibility on AgentDO. Maintaining the same visibility on AgentRuntime preserves this access pattern. The stores are created inside AgentRuntime's constructor from the injected SqlStore/KvStore.

### 8. Consumer-facing types stay in agent-do.ts re-exports

**Decision**: `AgentConfig`, `AgentContext`, `ScheduleManager`, `A2AConfig` type definitions move to AgentRuntime's file. `agent-do.ts` re-exports them. The barrel `index.ts` exports from both files.

**Rationale**: These types are part of the consumer API and must remain importable from `@claw-for-cloudflare/agent-runtime`. Moving them to the runtime file co-locates them with the class that uses them. Re-exporting from agent-do.ts ensures no import path breaks.

## Risks / Trade-offs

**[Risk] Anonymous inner class ergonomics** -- The AgentDO constructor creates an anonymous AgentRuntime subclass to bridge abstract methods. This pattern is slightly unusual in TypeScript and may confuse contributors.
-> *Mitigation*: Well-documented with comments explaining the composition pattern. The anonymous class is entirely internal to AgentDO -- consumers never see it.

**[Risk] Dual extension paths** -- Consumers can extend either AgentDO or AgentRuntime, which could cause confusion about which to use.
-> *Mitigation*: Documentation will be clear: extend AgentDO for Cloudflare, extend AgentRuntime for platform-agnostic. The examples will show AgentDO. AgentRuntime is for advanced use cases (SDK authors building platform adapters).

**[Risk] Breaking change for consumers accessing `this.ctx`** -- Any consumer that accesses `this.ctx` (the DO context) directly in their AgentDO subclass will still work, but this pattern is not available on AgentRuntime.
-> *Mitigation*: `this.ctx` is a DurableObject property, not something AgentDO exposes. Consumers who use it are already coupled to CF. They should continue using AgentDO.

**[Trade-off] Protected state duplication** -- AgentDO exposes protected stores (sessionStore etc.) via delegation to its internal runtime instance. This means `this.sessionStore` on AgentDO is actually `this.runtime.sessionStore` under the hood.
-> *Accepted*: The delegation is transparent. Consumers access `this.sessionStore` as before. The indirection is a single property access with no performance cost.

**[Trade-off] handleRequest uses Web standard Request/Response** -- Node.js 18+ has these globally, but older Node versions or edge cases may need polyfills.
-> *Accepted*: The SDK already targets modern runtimes (CF Workers, which has Web standards). Any future Node adapter would target Node 18+ where these are available.
