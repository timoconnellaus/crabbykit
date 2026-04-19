## ADDED Requirements

### Requirement: Three-subpath export convention

Capability packages that hold secrets SHALL expose three subpath exports: `index` (the existing static-agent capability factory, unchanged for backwards compatibility), `service` (a `WorkerEntrypoint` class that holds secrets and implements tool execution), and `client` (a bundle-side capability factory that takes a `Service<T>` binding and produces a capability whose tools RPC into the service). Package `exports` in `package.json` SHALL enforce the separation physically. A fourth subpath `schemas` SHALL host the shared tool schema declarations imported by both `service` and `client`.

#### Scenario: Tavily package exports four subpaths
- **WHEN** a developer imports from `@crabbykit/tavily-web-search`, `@crabbykit/tavily-web-search/service`, `@crabbykit/tavily-web-search/client`, and `@crabbykit/tavily-web-search/schemas`
- **THEN** each import resolves to a distinct module: the legacy `tavilyWebSearch({apiKey})` factory, the `TavilyService` WorkerEntrypoint class, the `tavilyWebSearchClient({service})` factory, and the shared schema declarations

### Requirement: Service class holds secrets exclusively

The `service.ts` module's WorkerEntrypoint class SHALL be the exclusive holder of capability credentials. Credentials SHALL be read from `this.env` inside method bodies and SHALL NOT be passed to, returned from, or referenced by any other subpath of the same package. The `client.ts` module SHALL NOT import from `service.ts`. Errors raised by upstream API calls SHALL be sanitized before being returned across the RPC boundary — only a whitelisted error code and a generic message SHALL be returned, never the upstream response body or stack trace.

#### Scenario: Client module does not import service
- **WHEN** static analysis of `client.ts` enumerates its imports
- **THEN** no import path resolves to `./service` or `./service.js`

#### Scenario: Client module never sees credentials
- **WHEN** a bundle imports `tavilyWebSearchClient` and instantiates it with a service binding
- **THEN** no code path in the bundle's isolate has any value read from or derived from the Tavily API key

#### Scenario: Upstream errors sanitized
- **WHEN** an upstream Tavily API call returns an authentication error containing the credential in an echo field
- **THEN** `TavilyService` catches the error, logs the sanitized error internally, and returns `ERR_UPSTREAM_AUTH` to the caller with a generic message; no upstream response body crosses the RPC boundary

### Requirement: Per-turn capability token verification in services

Every method on a capability service class SHALL take a sealed capability token as its first argument and verify it via the shared verification utility before performing any work. Verification SHALL reject invalid signatures, expired tokens, and replayed nonces. Identity (agentId, sessionId) for cost attribution and audit SHALL be derived from the verified token payload, NOT from any other argument.

#### Scenario: Service method verifies token
- **WHEN** a bundle's client calls `env.TAVILY.search(token, { query: "cats" })` with a valid token
- **THEN** `TavilyService.search` verifies the token, derives the sessionId, calls Tavily, emits a cost event keyed to the verified session, and returns the result

#### Scenario: Bad token rejected before any external call
- **WHEN** a bundle's client calls `env.TAVILY.search(badToken, ...)` with a tampered token
- **THEN** the service returns `ERR_BAD_TOKEN` without making any external Tavily call

### Requirement: Static tool schemas shared between service and client

Tool names, descriptions, and parameter schemas SHALL be declared in a shared `schemas.ts` module exported via the `schemas` subpath. Both `service.ts` and `client.ts` SHALL import their tool schemas from this shared module. The shared module SHALL also export a content hash of the schema declarations that both sides can compare at RPC time to detect cross-version drift.

#### Scenario: Schema change propagates to both sides
- **WHEN** a developer updates the `search` tool's parameter schema in the shared schemas file
- **THEN** both the service's execute implementation and the client's capability factory type-check against the new schema, and any inconsistency is caught at compile time

#### Scenario: Cross-version drift detected at runtime
- **WHEN** a bundle built against schemas v1 is run against a host worker whose `TavilyService` was built against schemas v2 with an incompatible parameter shape
- **THEN** the schema hash mismatch is detected on the first RPC call and the service returns `ERR_SCHEMA_VERSION` instead of attempting the call

### Requirement: Client capability proxies tools via RPC

The bundle-side `client.ts` capability factory SHALL produce a capability whose tool `execute` functions are thin RPC proxies that read the bundle's capability token from `env.__SPINE_TOKEN` and call corresponding methods on the service binding. Execution arguments SHALL be passed through verbatim (subject to RPC serializability) and results SHALL be returned verbatim. The client SHALL NOT implement any business logic beyond RPC marshaling.

#### Scenario: Client tool invocation RPCs to service
- **WHEN** a bundle's agent calls a client tool like `tavily_search({ query: "cats" })`
- **THEN** the client's execute function reads the token from the bundle env and issues `await env.TAVILY.search(token, { query: "cats" })`, returning the service's result wrapped in the standard tool result content/details shape

### Requirement: Service-side cost emission with token-derived identity

Capability services that incur external costs SHALL emit cost events via the spine service (`env.SPINE.emitCost(token, costEvent)`) inside their method implementations, before returning the result to the caller. The `costEvent` SHALL NOT include a `sessionId` field; sessionId is derived from the verified token by the spine. The bundle-side client SHALL NOT emit costs and SHALL NOT have the ability to observe, modify, or suppress cost emissions, nor to attribute them to a foreign session.

#### Scenario: Tavily service emits cost before returning
- **WHEN** `TavilyService.search()` successfully completes an external API call
- **THEN** the method calls `env.SPINE.emitCost(token, { capabilityId: "tavily-web-search", toolName: "search", amount: 0.01, currency: "USD" })` before its `return` statement

#### Scenario: Cost is unsuppressable by the bundle
- **WHEN** a bundle attempts to short-circuit a cost by never awaiting the service result or by catching an error before it propagates
- **THEN** the cost has already been persisted via spine RPC prior to the result returning to the bundle, and the cost entry remains in the session store regardless of how the bundle handles the returned promise

#### Scenario: Cost cannot target a foreign session
- **WHEN** a bundle holds a token for `session-A` and attempts to manipulate any argument to cause cost attribution to `session-B`
- **THEN** there is no method signature that accepts a target sessionId; the spine derives sessionId from the verified token only

### Requirement: Token propagation from client to service

The bundle-side client capability factory SHALL read the bundle's capability token from `env.__SPINE_TOKEN` at tool execute time and pass it as the first argument of every service RPC call. The token SHALL come from the bundle's projected env, NOT from any tool argument the LLM can forge. The client SHALL NOT cache or persist the token across turns.

#### Scenario: Token sourced from env, not arguments
- **WHEN** the client's tool `execute` runs
- **THEN** the RPC call's first argument is `env.__SPINE_TOKEN`, and any token-shaped value in the LLM's tool arguments is ignored

### Requirement: Legacy static-agent path unchanged

The existing `index.ts` export of a capability package SHALL continue to function identically for `defineAgent`-based static agents. Splitting a package into `service`/`client`/`schemas` subpaths SHALL NOT require any change to static-agent consumers of that package. Static agents SHALL continue to instantiate capabilities with direct `apiKey` arguments via the legacy factory.

#### Scenario: Static agent using tavilyWebSearch unaffected
- **WHEN** a pre-existing static agent imports `tavilyWebSearch` from the legacy entry point and instantiates it with an API key
- **THEN** the agent builds, runs, and executes Tavily tools with exactly the same behavior and cost emission as before the package split
