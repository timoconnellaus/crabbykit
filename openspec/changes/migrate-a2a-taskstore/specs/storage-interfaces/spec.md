## MODIFIED Requirements

### Requirement: AgentDO creates adapters from CF primitives
The `AgentDO` constructor SHALL create `SqlStore` and `KvStore` adapters from `ctx.storage.sql` and `ctx.storage`, then pass them to all stores including `TaskStore`. No Cloudflare storage types SHALL leak beyond the adapter creation point.

#### Scenario: Adapter creation in constructor
- **WHEN** `AgentDO` is instantiated by the Cloudflare runtime
- **THEN** it wraps `ctx.storage.sql` with `createCfSqlStore` and `ctx.storage` with `createCfKvStore` before constructing stores

#### Scenario: TaskStore receives SqlStore adapter
- **WHEN** `AgentDO` constructs `TaskStore` in its constructor
- **THEN** it passes the `SqlStore` adapter (not raw `ctx.storage.sql`) to `TaskStore`

## ADDED Requirements

### Requirement: TaskStore accepts SqlStore instead of SqlStorage
The `TaskStore` constructor SHALL accept a `SqlStore` parameter (from `@claw-for-cloudflare/agent-runtime`) instead of Cloudflare's `SqlStorage`. All existing public methods SHALL retain their signatures and behavior.

#### Scenario: Construct with SqlStore
- **WHEN** `new TaskStore(sqlStore)` is called with any `SqlStore` implementation
- **THEN** the store initializes its schema and all CRUD operations work as before

#### Scenario: Backward compatibility via CF adapter
- **WHEN** `new TaskStore(createCfSqlStore(cfSql))` is called in a Cloudflare Worker
- **THEN** behavior is identical to the current `new TaskStore(cfSql)`

#### Scenario: Create a task
- **WHEN** `create({ contextId, sessionId })` is called on a `TaskStore` constructed with `SqlStore`
- **THEN** a task is inserted into the database and a `Task` object is returned with state `"submitted"`

#### Scenario: Query tasks by context
- **WHEN** `list({ contextId: "ctx-1" })` is called
- **THEN** all tasks with that context ID are returned in descending creation order

#### Scenario: Update task status
- **WHEN** `updateStatus(taskId, { state: "working", timestamp })` is called
- **THEN** the task's state and timestamp are updated in the database

#### Scenario: Artifact operations
- **WHEN** `addArtifact`, `appendArtifactParts`, or `getArtifacts` is called
- **THEN** artifacts are stored, updated, and retrieved correctly via the `SqlStore` interface

#### Scenario: Push notification config operations
- **WHEN** `setPushConfig`, `getPushConfig`, or `deletePushConfig` is called
- **THEN** push notification configurations are stored and retrieved correctly via the `SqlStore` interface
