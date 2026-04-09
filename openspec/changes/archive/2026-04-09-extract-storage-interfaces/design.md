## Context

CLAW's agent-runtime has 5 stores that directly use Cloudflare-specific storage types:

| Store | CF Type Used | Usage Pattern |
|-------|-------------|---------------|
| `SessionStore` | `SqlStorage` | `sql.exec()` with SQL strings + positional params |
| `ScheduleStore` | `SqlStorage` | Same pattern |
| `McpManager` | `SqlStorage` | Same pattern |
| `ConfigStore` | `DurableObjectStorage` | `get()`, `put()` with string keys |
| `createCapabilityStorage()` | `DurableObjectStorage` | `get()`, `put()`, `delete()`, `list()` with prefix scoping |

The A2A package's `TaskStore` has the same `SqlStorage` dependency but lives in a separate package and can be addressed as a follow-up.

A `createMockSqlStorage()` test helper already exists that reimplements Cloudflare's `SqlStorage` interface in-memory (~300 lines of SQL parsing). This mock would be replaced by a simpler `SqlStore` implementation.

The `CapabilityStorage` interface is already platform-agnostic — only its factory function `createCapabilityStorage()` takes `DurableObjectStorage`. This validates the adapter pattern we're applying to the other stores.

## Goals / Non-Goals

**Goals:**
- Define `SqlStore` and `KvStore` interfaces that capture exactly what the stores need — no more, no less
- All stores accept generic interfaces instead of CF types
- Cloudflare adapter implementations that wrap CF primitives into the generic interfaces
- Existing test mock updated to implement `SqlStore` directly
- Zero changes to store public APIs (methods, return types, behavior)
- Zero changes to consumer-facing API (`AgentDO` subclass methods)

**Non-Goals:**
- Abstracting WebSocket transport, DO lifecycle, or alarm scheduling (future steps)
- Creating a Node.js/Bun adapter (this change only defines the interfaces + CF adapter)
- Abstracting the A2A `TaskStore` (separate package, follow-up)
- Changing SQL dialect or query patterns (stores continue to use SQLite-compatible SQL)
- Making `AgentDO` itself platform-agnostic (it still extends `DurableObject`)

## Decisions

### 1. Two interfaces, not one

**Decision**: Define `SqlStore` (for relational data) and `KvStore` (for key-value data) as separate interfaces.

**Rationale**: The stores split cleanly along this line — `SessionStore`/`ScheduleStore`/`McpManager` use SQL queries, while `ConfigStore`/`CapabilityStorage` use key-value operations. A single unified interface would be an awkward abstraction over fundamentally different access patterns.

**Alternative considered**: A single `StorageBackend` with both SQL and KV methods. Rejected because it forces every adapter to implement both, even if the platform only supports one pattern.

### 2. SqlStore mirrors Cloudflare's SqlStorage surface minimally

**Decision**: `SqlStore.exec()` returns a `SqlResult` object with `.toArray()`, `.one()`, and `[Symbol.iterator]()` methods. Parameter binding uses positional `?` markers with variadic args.

```ts
interface SqlResult<T> {
  toArray(): T[];
  one(): T | null;
  [Symbol.iterator](): Iterator<T>;
}

interface SqlStore {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T>;
}
```

**Rationale**: This is the exact subset of `SqlStorage`/`SqlStorageCursor` that the stores actually use. The interface is small enough to implement for any SQL database (Postgres via `pg`, SQLite via `better-sqlite3`, etc.). The `raw()`, `columnNames`, `rowsRead`, `rowsWritten` cursor properties are never used by any store and are excluded.

**Alternative considered**: Using a query-builder abstraction (like Knex or Drizzle patterns). Rejected — it would require rewriting every SQL string in every store. The stores already use plain SQL and it works fine across SQLite dialects.

### 3. KvStore matches the existing CapabilityStorage interface

**Decision**: `KvStore` provides `get`, `put`, `delete`, `list` — the same shape as `CapabilityStorage`.

```ts
interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}
```

**Rationale**: `CapabilityStorage` already proved this interface works. `ConfigStore` only uses `get` and `put`. The `list` with prefix is needed for `createCapabilityStorage()`. Making `KvStore` a superset of what's needed means a single adapter covers both use cases.

**Alternative considered**: Making `CapabilityStorage` extend `KvStore`. Rejected — `CapabilityStorage` is a consumer-facing type with scoped semantics (keys are auto-prefixed). `KvStore` is the raw backend. They happen to have the same shape but serve different roles.

### 4. Adapters are plain functions, not classes

**Decision**: `createCfSqlStore(sql: SqlStorage): SqlStore` and `createCfKvStore(storage: DurableObjectStorage): KvStore`.

**Rationale**: The adapters are trivially thin (1-3 lines per method). Classes would add ceremony for no benefit. Functions also compose better — you can wrap one adapter in another (e.g., a logging adapter).

### 5. Interfaces live in agent-runtime, not a new package

**Decision**: Create `packages/agent-runtime/src/storage/types.ts` for interfaces and `packages/agent-runtime/src/storage/cloudflare.ts` for CF adapters. Export from barrel.

**Rationale**: Creating a separate `@claw/core` package is premature — there's only one consumer (`agent-runtime`) today. When WebSocket and lifecycle abstractions are added later, that's the right time to extract a core package. For now, a `storage/` module within agent-runtime keeps things simple and avoids workspace/build churn.

**Alternative considered**: New `@claw-for-cloudflare/core` package. Deferred — too much build/publish infrastructure work for just two interfaces.

### 6. Stores keep synchronous constructors

**Decision**: `SqlStore.exec()` remains synchronous (matching CF's `SqlStorage.exec()`). `KvStore` methods remain async (matching CF's `DurableObjectStorage`).

**Rationale**: CF's DO SQLite is synchronous, and the stores are written synchronously throughout. Making exec async would require rewriting every store method to be async — a massive change for no benefit in this step. A future Node.js adapter using `better-sqlite3` is also synchronous. If a future adapter needs async SQL (e.g., Postgres), that's a bridge to cross when we build it — likely with an async variant of the interface.

## Risks / Trade-offs

**[Risk] SQL dialect lock-in** → The stores use SQLite-specific SQL (`datetime('now')`, `COALESCE`, `INTEGER` for booleans). A future Postgres adapter would need dialect translation or the stores would need to abstract date/time handling.
→ *Mitigation*: Accepted for now. The SQL is standard enough that SQLite ↔ Postgres differences are minor. Cross-dialect support is a concern for when we actually build a second adapter.

**[Risk] Interface too narrow** → If a future store needs cursor features like `rowsRead` or `columnNames`, the interface would need to grow.
→ *Mitigation*: We've audited every store — none use these properties. Growing the interface later is backwards-compatible (adding methods, not changing existing ones).

**[Risk] Breaking change for direct store consumers** → Anyone importing and constructing `SessionStore` directly (outside of `AgentDO`) will see a type error.
→ *Mitigation*: Stores are internal implementation details, not part of the public API. Consumers extend `AgentDO` and never construct stores. The barrel export doesn't re-export store classes.

**[Trade-off] Synchronous SqlStore limits future adapters** → Postgres, MySQL, and other networked databases have async drivers. A sync `exec()` can't wrap them.
→ *Accepted*: This is fine for the first step. When a networked-DB adapter is needed, we can add an `AsyncSqlStore` variant and migrate stores. The current sync interface correctly models what CF and SQLite provide.
