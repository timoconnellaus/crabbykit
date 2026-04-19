## ADDED Requirements

### Requirement: SqlStore interface provides synchronous SQL execution
The `SqlStore` interface SHALL expose a single `exec` method that accepts a SQL query string with positional `?` parameter bindings and returns a `SqlResult` object. The `SqlResult` SHALL provide `toArray()`, `one()`, and `[Symbol.iterator]()` methods for accessing query results.

#### Scenario: Execute a SELECT query returning multiple rows
- **WHEN** `exec` is called with `"SELECT * FROM sessions ORDER BY created_at DESC"`
- **THEN** `toArray()` returns an array of all matching row objects and `[Symbol.iterator]()` yields each row

#### Scenario: Execute a SELECT query returning one row
- **WHEN** `exec` is called with `"SELECT * FROM sessions WHERE id = ?"` and a binding value
- **THEN** `one()` returns the matching row object, or `null` if no match

#### Scenario: Execute a write operation
- **WHEN** `exec` is called with an INSERT, UPDATE, or DELETE statement with bindings
- **THEN** the operation executes and `toArray()` returns an empty array

#### Scenario: Execute with no parameter bindings
- **WHEN** `exec` is called with a DDL statement like `"CREATE TABLE IF NOT EXISTS ..."`
- **THEN** the statement executes without error

### Requirement: KvStore interface provides async key-value operations
The `KvStore` interface SHALL expose `get`, `put`, `delete`, and `list` methods for typed key-value storage. All methods SHALL be async (return Promises).

#### Scenario: Get an existing key
- **WHEN** `get<T>(key)` is called with a key that has a stored value
- **THEN** the value is returned, typed as `T`

#### Scenario: Get a missing key
- **WHEN** `get(key)` is called with a key that has no stored value
- **THEN** `undefined` is returned

#### Scenario: Put a value
- **WHEN** `put(key, value)` is called
- **THEN** subsequent `get(key)` returns the stored value

#### Scenario: Delete a key
- **WHEN** `delete(key)` is called with an existing key
- **THEN** `true` is returned and subsequent `get(key)` returns `undefined`

#### Scenario: Delete a missing key
- **WHEN** `delete(key)` is called with a non-existent key
- **THEN** `false` is returned

#### Scenario: List with prefix filter
- **WHEN** `list(options)` is called with `{ prefix: "cap:search:" }`
- **THEN** a `Map<string, T>` is returned containing only entries whose keys start with the given prefix

#### Scenario: List without prefix
- **WHEN** `list()` is called with no options
- **THEN** a `Map<string, T>` is returned containing all entries

### Requirement: Cloudflare SqlStore adapter wraps SqlStorage
A `createCfSqlStore` function SHALL accept a Cloudflare `SqlStorage` instance and return a `SqlStore`. The adapter SHALL delegate `exec()` calls directly to `SqlStorage.exec()`, preserving the cursor's `toArray()`, `one()`, and iterator behavior.

#### Scenario: Adapter delegates to SqlStorage
- **WHEN** `createCfSqlStore(cfSql)` is called and `exec` is invoked on the result
- **THEN** the call is forwarded to `cfSql.exec()` with identical arguments and the returned cursor satisfies `SqlResult`

### Requirement: Cloudflare KvStore adapter wraps DurableObjectStorage
A `createCfKvStore` function SHALL accept a Cloudflare `DurableObjectStorage` instance and return a `KvStore`. The adapter SHALL delegate all operations to the corresponding `DurableObjectStorage` methods.

#### Scenario: Adapter delegates get
- **WHEN** `createCfKvStore(doStorage)` is called and `get(key)` is invoked
- **THEN** `doStorage.get(key)` is called and its result is returned

#### Scenario: Adapter delegates put
- **WHEN** `put(key, value)` is invoked on the adapter
- **THEN** `doStorage.put(key, value)` is called

#### Scenario: Adapter delegates delete
- **WHEN** `delete(key)` is invoked on the adapter
- **THEN** `doStorage.delete(key)` is called and its boolean result is returned

#### Scenario: Adapter delegates list with prefix
- **WHEN** `list({ prefix: "foo:" })` is invoked on the adapter
- **THEN** `doStorage.list({ prefix: "foo:" })` is called and its Map result is returned

### Requirement: SessionStore accepts SqlStore instead of SqlStorage
The `SessionStore` constructor SHALL accept a `SqlStore` parameter instead of Cloudflare's `SqlStorage`. All existing public methods SHALL retain their signatures and behavior.

#### Scenario: Construct with SqlStore
- **WHEN** `new SessionStore(sqlStore)` is called with any `SqlStore` implementation
- **THEN** the store initializes its schema and all CRUD operations work as before

#### Scenario: Backward compatibility via CF adapter
- **WHEN** `new SessionStore(createCfSqlStore(cfSql))` is called in a Cloudflare Worker
- **THEN** behavior is identical to the current `new SessionStore(cfSql)`

### Requirement: ScheduleStore accepts SqlStore instead of SqlStorage
The `ScheduleStore` constructor SHALL accept a `SqlStore` parameter instead of Cloudflare's `SqlStorage`. All existing public methods SHALL retain their signatures and behavior.

#### Scenario: Construct with SqlStore
- **WHEN** `new ScheduleStore(sqlStore)` is called with any `SqlStore` implementation
- **THEN** the store initializes its schema and all CRUD operations work as before

### Requirement: ConfigStore accepts KvStore instead of DurableObjectStorage
The `ConfigStore` constructor SHALL accept a `KvStore` parameter instead of Cloudflare's `DurableObjectStorage`. All existing public methods SHALL retain their signatures and behavior.

#### Scenario: Construct with KvStore
- **WHEN** `new ConfigStore(kvStore)` is called with any `KvStore` implementation
- **THEN** `getCapabilityConfig`, `setCapabilityConfig`, `getNamespace`, `setNamespace` work as before

### Requirement: McpManager accepts SqlStore instead of SqlStorage
The `McpManager` constructor SHALL accept a `SqlStore` parameter instead of Cloudflare's `SqlStorage`. All existing public methods SHALL retain their signatures and behavior.

#### Scenario: Construct with SqlStore
- **WHEN** `new McpManager(sqlStore)` is called with any `SqlStore` implementation
- **THEN** the manager initializes its schema and all MCP server operations work as before

### Requirement: createCapabilityStorage accepts KvStore instead of DurableObjectStorage
The `createCapabilityStorage` function SHALL accept a `KvStore` parameter instead of Cloudflare's `DurableObjectStorage`. The `CapabilityStorage` interface SHALL remain unchanged.

#### Scenario: Create with KvStore
- **WHEN** `createCapabilityStorage(kvStore, "my-cap")` is called
- **THEN** the returned `CapabilityStorage` auto-prefixes keys with `cap:my-cap:` and delegates to the `KvStore`

### Requirement: AgentDO creates adapters from CF primitives
The `AgentDO` constructor SHALL create `SqlStore` and `KvStore` adapters from `ctx.storage.sql` and `ctx.storage`, then pass them to all stores. No Cloudflare storage types SHALL leak beyond the adapter creation point.

#### Scenario: Adapter creation in constructor
- **WHEN** `AgentDO` is instantiated by the Cloudflare runtime
- **THEN** it wraps `ctx.storage.sql` with `createCfSqlStore` and `ctx.storage` with `createCfKvStore` before constructing stores

### Requirement: Storage interfaces are exported from barrel
The `SqlStore`, `SqlResult`, and `KvStore` types SHALL be exported from `agent-runtime`'s public barrel (`index.ts`). The CF adapter functions SHALL also be exported for consumers who need to create stores in custom DO classes.

#### Scenario: Import from package
- **WHEN** a consumer writes `import type { SqlStore, KvStore } from "@crabbykit/agent-runtime"`
- **THEN** the types resolve correctly

#### Scenario: Import CF adapters
- **WHEN** a consumer writes `import { createCfSqlStore, createCfKvStore } from "@crabbykit/agent-runtime"`
- **THEN** the adapter functions resolve correctly

### Requirement: Mock SqlStore for unit tests
The existing `createMockSqlStorage()` test helper SHALL be updated to return a `SqlStore` (renamed to `createMockSqlStore()`). The implementation SHALL drop the `as unknown as SqlStorage` cast and directly satisfy the `SqlStore` interface.

#### Scenario: Mock implements SqlStore
- **WHEN** `createMockSqlStore()` is called
- **THEN** the returned object satisfies the `SqlStore` interface without type casts

#### Scenario: Existing test behavior preserved
- **WHEN** unit tests use `createMockSqlStore()` to construct a `SessionStore` or `ScheduleStore`
- **THEN** all existing test assertions continue to pass
