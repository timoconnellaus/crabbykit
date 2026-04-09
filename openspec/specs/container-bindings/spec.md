# container-bindings Specification

## Purpose
TBD - created by archiving change container-bindings-and-vibe-skill. Update Purpose after archive.
## Requirements
### Requirement: SandboxContainer intercepts db.internal
The SandboxContainer DO SHALL intercept outbound HTTP requests from the container to `db.internal` and route them to the DbService binding.

#### Scenario: Container exec SQL query
- **WHEN** the container sends `POST http://db.internal/exec` with `{ sql, params, backendId }`
- **THEN** the DO calls `env.DB_SERVICE.exec(backendId, sql, params)` and returns the result as JSON

#### Scenario: Container batch SQL statements
- **WHEN** the container sends `POST http://db.internal/batch` with `{ statements, backendId }`
- **THEN** the DO calls `env.DB_SERVICE.batch(backendId, statements)` and returns the result as JSON

#### Scenario: Container sends invalid request
- **WHEN** the container sends a request with missing sql or backendId
- **THEN** the DO returns a 400 response with an error message

### Requirement: SandboxContainer intercepts ai.internal
The SandboxContainer DO SHALL intercept outbound HTTP requests from the container to `ai.internal` and route them to the AI proxy handler.

#### Scenario: Container sends chat completion request
- **WHEN** the container sends `POST http://ai.internal/v1/chat/completions` with an OpenAI-format body
- **THEN** the DO proxies to OpenRouter using the configured API key and returns the response

#### Scenario: Container lists models
- **WHEN** the container sends `GET http://ai.internal/v1/models`
- **THEN** the DO returns the list of allowed models

### Requirement: Interception uses Container static outboundByHost
The interception SHALL use the `Container` class's `static outboundByHost` pattern, mapping hostnames to handler method names on the SandboxContainer class.

#### Scenario: Interception is active before container starts
- **WHEN** the SandboxContainer DO initializes
- **THEN** the `outboundByHost` map is registered and interception is ready before any container request

### Requirement: backendId injected as env var on elevate
When the sandbox elevates, the system SHALL inject `CLAW_DB_BACKEND_ID` as a container env var derived from the agent ID and a default app name. This allows the container-db client to include it in requests automatically.

#### Scenario: Elevate injects backendId
- **WHEN** the sandbox is elevated
- **THEN** the container receives `CLAW_DB_BACKEND_ID` env var with value `{agentId}:default`

### Requirement: SandboxContainer has DB_SERVICE binding
The SandboxContainer DO SHALL have access to the `DB_SERVICE` service binding for proxying database requests.

#### Scenario: DB_SERVICE configured in wrangler
- **WHEN** the SandboxContainer is deployed
- **THEN** it can access `this.env.DB_SERVICE` to call `exec()` and `batch()`

