# container-db Specification

## Purpose
TBD - created by archiving change container-bindings-and-vibe-skill. Update Purpose after archive.
## Requirements
### Requirement: createDB factory function
The package SHALL export a `createDB()` function that returns an object with `exec()` and `batch()` methods. It SHALL read `CLAW_DB_BACKEND_ID` from `process.env` for the backendId.

#### Scenario: Create DB client with default backendId
- **WHEN** `createDB()` is called and `CLAW_DB_BACKEND_ID` is set
- **THEN** it returns a DB client that includes the backendId in all requests to `db.internal`

#### Scenario: Create DB client with explicit backendId
- **WHEN** `createDB({ backendId: "custom-id" })` is called
- **THEN** it returns a DB client using `"custom-id"` regardless of env var

#### Scenario: Missing backendId
- **WHEN** `createDB()` is called without env var and no explicit backendId
- **THEN** it throws an error: "CLAW_DB_BACKEND_ID not set"

### Requirement: exec method
The `exec(sql, params?)` method SHALL send `POST http://db.internal/exec` with `{ sql, params, backendId }` and return `{ columns: string[], rows: unknown[][] }`.

#### Scenario: Execute SELECT query
- **WHEN** `db.exec("SELECT * FROM items")` is called
- **THEN** it sends the query to `db.internal` and returns `{ columns, rows }`

#### Scenario: Execute parameterized INSERT
- **WHEN** `db.exec("INSERT INTO items (name) VALUES (?)", ["Item A"])` is called
- **THEN** it sends the parameterized query and returns the result

#### Scenario: Database error
- **WHEN** the SQL query is invalid
- **THEN** the method throws with the error message from the response

### Requirement: batch method
The `batch(statements)` method SHALL send `POST http://db.internal/batch` with `{ statements, backendId }` where statements is an array of `{ sql, params }` objects.

#### Scenario: Execute multiple statements
- **WHEN** `db.batch([{ sql: "INSERT ...", params: [...] }, { sql: "INSERT ...", params: [...] }])` is called
- **THEN** all statements are sent in a single request and executed

### Requirement: API compatibility with deployed env.DB
The interface returned by `createDB()` SHALL match the interface that deployed workers see via `env.DB` (as created by the `start_backend` wrapper). Both provide `exec(sql, params)` and `batch(statements)` with the same return types.

#### Scenario: Same code works in container and deployed worker
- **WHEN** app code calls `db.exec("SELECT * FROM items")`
- **THEN** it works both when `db` is from `createDB()` (container) and from `env.DB` (deployed worker)

