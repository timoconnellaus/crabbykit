## ADDED Requirements

### Requirement: BundleCapability SHALL support an httpHandlers field

The `BundleCapability` interface in `@crabbykit/bundle-sdk` SHALL accept an optional `httpHandlers` field of type `(context: BundleContext) => BundleHttpHandler[]`. Each `BundleHttpHandler` SHALL be `{ method: "GET" | "POST" | "PUT" | "DELETE"; path: string; handler: (request: BundleHttpRequest, ctx: BundleHttpContext) => Promise<BundleHttpResponse> }`. The handler SHALL run inside the bundle isolate when the host dispatches a matched HTTP request.

#### Scenario: Bundle declares an httpHandler and the host dispatches a matching request

- **WHEN** a bundle declares `httpHandlers: () => [{ method: "GET", path: "/skills/registry", handler }]` and the host receives `GET /agent/:id/skills/registry`
- **THEN** the host SHALL forward the request to the bundle isolate, the bundle SHALL invoke `handler`, and the host SHALL return the bundle's response to the original caller

#### Scenario: Bundle does not declare a matching route

- **WHEN** a bundle does not declare any route matching the incoming request
- **THEN** the host SHALL fall through to the existing default 404 without instantiating the bundle isolate

### Requirement: BundleCapability SHALL support an onAction field

The `BundleCapability` interface SHALL accept an optional `onAction` field of type `(action: string, data: unknown, ctx: BundleActionContext) => Promise<void>`. The handler SHALL run inside the bundle isolate when the host receives a `capability_action` ClientMessage whose `capabilityId` matches the bundle capability's declared `id` AND no static handler took priority (per Requirement 8).

#### Scenario: Bundle declares onAction and a UI bridge dispatch arrives

- **WHEN** a bundle declares `BundleCapability { id: "files", onAction: handler }` and the host receives `capability_action { capabilityId: "files", action: "delete", data: {...}, sessionId: "s1" }` AND no host capability declares the same id
- **THEN** the host SHALL forward the action to the bundle isolate via `/action`, the bundle SHALL invoke `handler("delete", {...}, ctx)` with `ctx.sessionId === "s1"`, and the host SHALL NOT fall through to its default-case dispatch

### Requirement: BundleHttpContext SHALL expose params, query, headers, agentId, sessionId, kvStore, channel, publicUrl, emitCost

The `BundleHttpContext` passed to bundle HTTP handlers SHALL include:
- `capabilityId: string`
- `agentId: string`
- `sessionId: string | null` — null for session-less HTTP routes
- `publicUrl?: string` — sourced from the host's `RuntimeContext.publicUrl`. Required for any bundle webhook capability per the project convention that webhook capabilities MUST read `ctx.publicUrl` rather than accept it as a per-capability option
- `params: Record<string, string>` — path parameters extracted from the matched declaration's `:name` wildcards
- `query: Record<string, string>` — parsed query string
- `headers: Record<string, string>` — request headers, lowercased keys
- `kvStore: BundleKvStoreClient` — capability-scoped storage
- `channel: BundleSessionChannel` — `broadcast` / `broadcastGlobal` (broadcast is no-op when `sessionId` is null)
- `emitCost: (cost: BundleCostEvent) => Promise<void>` — emit a cost event, persisted to the session and broadcast as `cost_event`

`sendPrompt`, `sessionStore`, `rateLimit`, and `agentConfig` are explicitly NOT in v1 (see proposal Non-Goals and design Decisions 6 and 11).

#### Scenario: Path params are extracted from the matched declaration

- **WHEN** a bundle declares `path: "/telegram/webhook/:accountId"` and the host receives `POST /agent/:id/telegram/webhook/support`
- **THEN** the bundle handler SHALL receive `ctx.params === { accountId: "support" }`

#### Scenario: publicUrl propagates from the host runtime context

- **WHEN** the host worker has `PUBLIC_URL=https://agents.example.com` configured and a bundle HTTP handler runs
- **THEN** `ctx.publicUrl` SHALL equal `"https://agents.example.com"` (whitespace-trimmed, no trailing slash)

#### Scenario: emitCost persists a cost event

- **WHEN** a bundle handler calls `await ctx.emitCost({ capabilityId: "tavily", toolName: "search", amount: 0.01, currency: "USD" })`
- **THEN** the spine SHALL persist a `cost` session entry and broadcast `cost_event` to connected clients

### Requirement: BundleActionContext SHALL expose capabilityId, agentId, sessionId, channel, spine, kvStore, publicUrl, emitCost

The `BundleActionContext` passed to bundle `onAction` handlers SHALL include `capabilityId`, `agentId`, `sessionId`, a `channel` for session-scoped broadcasts, a `spine` lifecycle client (`appendEntry`, `getEntries`, `buildContext`, `broadcast`), a `kvStore` capability-scoped client, `publicUrl?`, and `emitCost`.

#### Scenario: Bundle onAction broadcasts a state event back to the originating session

- **WHEN** a bundle `onAction` handler calls `ctx.channel.broadcast({ type: "state_event", capabilityId: "files", event: "deleted", data: { id: "f1" } })`
- **THEN** clients connected to `ctx.sessionId` SHALL receive the broadcast via the host's existing transport

### Requirement: defineBundleAgent SHALL populate BundleMetadata.surfaces with httpRoutes and actionCapabilityIds

`defineBundleAgent` SHALL emit a NEW top-level field `BundleMetadata.surfaces?: { httpRoutes?: BundleRouteDeclaration[]; actionCapabilityIds?: string[] }`. The field SHALL be populated by walking `setup.capabilities(probeEnv)` once with a minimal probe env and collecting:
- `{ method, path }` for every declared `BundleHttpHandler` into `httpRoutes`
- The `id` of every `BundleCapability` that declared an `onAction` into `actionCapabilityIds`

When BOTH inner fields would be empty, `surfaces` SHALL be omitted entirely from metadata. When ONE is empty and the other is non-empty, only the non-empty one SHALL be emitted. The existing `lifecycleHooks` field SHALL be unchanged in shape (still the three-key boolean record from `bundle-runtime-surface`); the `hasLifecycleHook` omit-guard in `define.ts` SHALL be updated to also consider whether `surfaces` is non-empty so a bundle declaring HTTP routes but no lifecycle hooks still emits its metadata.

#### Scenario: Bundle declares one route and one action

- **WHEN** a bundle exposes `BundleCapability { id: "files", httpHandlers: () => [{ method: "GET", path: "/files/list", handler }], onAction: handler }`
- **THEN** the metadata SHALL contain `surfaces: { httpRoutes: [{ method: "GET", path: "/files/list" }], actionCapabilityIds: ["files"] }`

#### Scenario: Bundle declares no routes or actions

- **WHEN** a bundle declares no `httpHandlers` and no `onAction` on any capability
- **THEN** the metadata SHALL omit the `surfaces` field entirely (legacy bundle byte-compatibility)

#### Scenario: Bundle declares only HTTP routes (no lifecycle hooks)

- **WHEN** a bundle declares `httpHandlers` on a capability but no `onAlarm`/`onSessionCreated`/`onClientEvent`
- **THEN** the metadata SHALL emit `surfaces.httpRoutes` and SHALL omit `lifecycleHooks` (each field's omission is decided independently)

### Requirement: defineBundleAgent SHALL reject reserved-prefix paths and reserved action ids at build time

The bundle SDK's `validateHttpRoutes` helper SHALL reject any declared `path` that:
- Does not start with `/`
- Matches a reserved prefix: `/bundle/`, `/a2a`, `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`
- Matches a reserved literal: `/`, `/prompt`, `/schedules`
- Duplicates another declaration in the same bundle on the same `${method}:${path}` key
- Exceeds 256 characters
- Specifies a method outside `{GET, POST, PUT, DELETE}`

The bundle SDK's `validateActionCapabilityIds` helper SHALL reject any `BundleCapability.id` that hosts an `onAction` and is in the reserved list: `agent-config`, `schedules`, `queue`.

Validation failures SHALL throw at `defineBundleAgent` evaluation time with a descriptive error message naming the offending capability id and the offending entry.

#### Scenario: Bundle declares a route under /bundle

- **WHEN** a bundle declares `path: "/bundle/disable"`
- **THEN** `defineBundleAgent` SHALL throw with a message naming `/bundle/` as a reserved host prefix and the offending capability id

#### Scenario: Bundle declares the literal /prompt

- **WHEN** a bundle declares `path: "/prompt"`
- **THEN** `defineBundleAgent` SHALL throw with a message naming `/prompt` as a reserved host literal

#### Scenario: Bundle declares onAction on the reserved id "schedules"

- **WHEN** a bundle declares `BundleCapability { id: "schedules", onAction: handler }`
- **THEN** `defineBundleAgent` SHALL throw with a message naming `schedules` as a reserved action id

#### Scenario: Bundle declares two handlers on the same method+path

- **WHEN** a bundle declares two `BundleHttpHandler` entries with `method: "GET"` and `path: "/files/list"`
- **THEN** `defineBundleAgent` SHALL throw with a duplicate-route message

### Requirement: defineBundleAgent SHALL surface probe-env-extraction failures with capability id

When metadata extraction walks `setup.capabilities(probeEnv)` and a capability's `httpHandlers(ctx)` factory throws because the probe env lacks a field the capability accessed, `defineBundleAgent` SHALL throw a `BundleMetadataExtractionError` whose message names the offending capability id and instructs the author that metadata is the source of truth and runtime-conditional routes that depend on env will not dispatch.

#### Scenario: Capability factory accesses a missing env field during probe

- **WHEN** a bundle capability's `httpHandlers` factory reads `ctx.env.WEBHOOK_PATH` and that field is absent in the probe env
- **THEN** `defineBundleAgent` SHALL throw `BundleMetadataExtractionError` naming the capability id and the field-access constraint

### Requirement: BundleRegistry.setActive SHALL validate bundle routes and action ids against host static surface

When promoting a bundle version, `BundleRegistry.setActive` SHALL accept optional `knownHttpRoutes?: Array<{ method, path }>` AND `knownCapabilityIds?: string[]` parameters. When provided, the registry SHALL invoke `validateBundleRoutesAgainstKnownRoutes(declared, known)` AND `validateBundleActionIdsAgainstKnownIds(declared, known)` and reject the promotion with `ERR_HTTP_ROUTE_COLLISION` or `ERR_ACTION_ID_COLLISION` (respectively) on collision. The active pointer SHALL NOT be flipped on collision.

When `knownHttpRoutes` or `knownCapabilityIds` is `undefined`, the registry SHALL skip the corresponding check (mirrors the existing `skipCatalogCheck` semantic for cross-deployment promotions).

#### Scenario: Bundle declares a route that collides with a static handler

- **WHEN** the bundle declares `path: "/skills/registry"` and the host has a static `httpHandler` mounted on `/skills/registry`
- **THEN** `setActive` SHALL throw with `code: "ERR_HTTP_ROUTE_COLLISION"` and the active pointer SHALL remain unchanged

#### Scenario: Bundle declares onAction on an id that collides with a host capability

- **WHEN** the bundle declares `BundleCapability { id: "tavily-web-search", onAction }` and the host has a static `tavily-web-search` capability registered
- **THEN** `setActive` SHALL throw with `code: "ERR_ACTION_ID_COLLISION"` and the active pointer SHALL remain unchanged

#### Scenario: Cross-deployment promotion explicitly skips checks

- **WHEN** `setActive` is called with `knownHttpRoutes: undefined` AND `knownCapabilityIds: undefined` (cross-deployment promotion path)
- **THEN** the registry SHALL skip both validations and proceed with the promotion

### Requirement: AgentRuntime SHALL dispatch matched bundle HTTP requests AFTER validateAuth and AFTER static httpHandlers

`AgentRuntime` SHALL declare a slot `bundleHttpDispatcher?: (request: Request, sessionId: string | null) => Promise<Response | null>`. The slot SHALL NOT be installed onto `preFetchHandler`. In `handleRequest`, the runtime SHALL invoke `bundleHttpDispatcher` after `matchHttpHandler` returns null and before the final 404 — i.e. AFTER `validateAuth` has already run and AFTER all static capability handlers have had a chance to match. When the dispatcher returns a `Response`, the runtime SHALL return it. When it returns `null`, the runtime SHALL return the existing 404.

`initBundleDispatch` (in `agent-do.ts`) SHALL install the dispatcher. The installed function SHALL:
1. Read the active bundle version. If null, return `null` (no Worker Loader call).
2. Read `version.metadata.surfaces.httpRoutes`. If absent or empty, return `null`.
3. Run `matchPathPattern` against each declared `{ method, path }`. If no match, return `null`.
4. Buffer the request body up to `BundleConfig.maxRequestBodyBytes` (default 262_144 / 256 KiB; configurable up to 1 MiB).
5. Mint the unified `__BUNDLE_TOKEN`.
6. POST to the bundle's `/http` endpoint with envelope `{ capabilityId, method, path, query, headers, bodyBase64, sessionId }`.
7. Parse the bundle's response envelope `{ status, headers, bodyBase64 }` and return the corresponding `Response`.

When the request body exceeds `maxRequestBodyBytes`, the host SHALL return `413 Payload Too Large` without dispatching to the bundle. When the bundle dispatch exceeds `BundleConfig.httpDispatchTimeoutMs` (default 30 000 ms), the host SHALL return `504 Gateway Timeout`.

#### Scenario: Matched bundle route round-trips successfully

- **WHEN** the host receives `POST /skills/registry` with body `{"name":"x"}`, the user is authenticated, no static `httpHandler` matches, and the active bundle declares this route on capability `skills`
- **THEN** the host SHALL forward the envelope to the bundle and return the bundle's response (status, headers, body) to the original caller

#### Scenario: Bundle route declared but request fails auth

- **WHEN** `validateAuth` rejects the request
- **THEN** the host SHALL return `401 Unauthorized` and SHALL NOT invoke `bundleHttpDispatcher`

#### Scenario: Static handler matches before bundle gets a chance

- **WHEN** a static capability handler matches the path AND the bundle also declares the same route in metadata
- **THEN** the static handler SHALL run, the dispatcher SHALL NOT be invoked, AND the dispatch-time route guard SHALL fire (clearing the bundle pointer with `bundle_disabled` reason `ERR_HTTP_ROUTE_COLLISION`) on the next bundle dispatch attempt

#### Scenario: Request body exceeds maxRequestBodyBytes

- **WHEN** the incoming request body is larger than `maxRequestBodyBytes`
- **THEN** the host SHALL respond `413 Payload Too Large` and SHALL NOT dispatch to the bundle

#### Scenario: Bundle dispatch times out

- **WHEN** the bundle `/http` handler does not respond within `httpDispatchTimeoutMs`
- **THEN** the host SHALL return `504 Gateway Timeout` and log the timeout

### Requirement: AgentRuntime.handleCapabilityAction SHALL dispatch to the bundle when no static handler took priority

`handleCapabilityAction` SHALL consult an installed `bundleActionDispatcher?` (mounted by `initBundleDispatch`) AFTER the resolved static-handler check returns nothing AND AFTER the host built-in switch (`agent-config`, `schedules`, `queue`) has had a chance to match. The dispatcher SHALL:

1. Return `false` immediately when no active bundle is set, when `version.metadata.surfaces.actionCapabilityIds` is absent, or when the message's `capabilityId` is not in the declared list
2. Otherwise mint the unified `__BUNDLE_TOKEN` and POST to the bundle's `/action` endpoint with envelope `{ capabilityId, action, data, sessionId }`
3. Return `true` when the bundle responded `status: "ok"` (host stops); return `false` when the bundle responded `status: "noop"` or errored (host continues to warn-log default)

When dispatch returns `false`, `handleCapabilityAction` SHALL continue with the existing warn-log fallback unchanged.

#### Scenario: Bundle owns the action and handles it

- **WHEN** `capability_action { capabilityId: "files", action: "delete", ... }` arrives, no static `onAction` handler is registered for `files`, and the bundle declared `actionCapabilityIds: ["files"]`
- **THEN** the host SHALL dispatch to the bundle's `/action` endpoint, the bundle SHALL invoke its `onAction` handler, and the host's warn-log default SHALL NOT fire

#### Scenario: Static onAction shadows a bundle declaration

- **WHEN** the host has a static capability with `id: "files"` and `onAction` defined AND the bundle also declares `actionCapabilityIds: ["files"]`
- **THEN** the static handler SHALL run, the dispatcher SHALL NOT be invoked, AND the next bundle dispatch attempt SHALL fire the action-id collision guard (clearing the bundle pointer with `bundle_disabled` reason `ERR_ACTION_ID_COLLISION`)

#### Scenario: No active bundle

- **WHEN** the active bundle pointer is `null`
- **THEN** the bundle dispatcher SHALL return `false` without making a Worker Loader call

### Requirement: Bundle SDK SHALL serve /http and /action endpoints

The bundle SDK's default fetch handler in `define.ts` SHALL serve two new POST endpoints:

- **`POST /http`** — verifies `__BUNDLE_TOKEN`, parses the envelope, looks up the matching bundle capability by `capabilityId`, re-runs `matchPathPattern` on the declared route to extract `params`, constructs `BundleHttpRequest` and `BundleHttpContext`, invokes the handler, and serializes the response envelope. Returns `{ status, headers, bodyBase64 }`. Returns `404` when no matching capability/route is found inside the bundle (defense in depth).
- **`POST /action`** — verifies `__BUNDLE_TOKEN`, parses the envelope `{ capabilityId, action, data, sessionId }`, looks up the matching bundle capability's `onAction`, constructs `BundleActionContext`, invokes the handler. Returns `{ status: "ok" }` on success, `{ status: "noop" }` when the capability has no `onAction`, `{ status: "error", message }` on handler exception. Host treats `noop`/`error` as "not handled" and falls through.

#### Scenario: /http with valid envelope and matching route

- **WHEN** POST `/http` arrives with a valid token and a payload matching a declared route
- **THEN** the SDK SHALL invoke the handler and return the serialized response envelope

#### Scenario: /http with no matching capability inside the bundle

- **WHEN** POST `/http` arrives but no `BundleCapability` in `setup.capabilities` declares the requested `capabilityId`
- **THEN** the SDK SHALL respond `404` with a body indicating "capability not found in bundle"

#### Scenario: /action with no onAction declared

- **WHEN** POST `/action` arrives for a capabilityId whose `BundleCapability` has no `onAction`
- **THEN** the SDK SHALL respond `200` with body `{ status: "noop" }`

### Requirement: Dispatch-time guards SHALL fire bundle_disabled with structured reason on collision

When the host's resolved static surface differs from what the bundle's metadata declared at promotion time (newly-deployed static cap, out-of-band registry write, cold start with stale pointer), the dispatch-time guard SHALL detect the collision on the next bundle dispatch attempt. On detection:

- For HTTP route collision: clear the bundle pointer via `registry.setActive(..., null, { skipCatalogCheck: true })`, broadcast `bundle_disabled` with `reason: { code: "ERR_HTTP_ROUTE_COLLISION", collisions: [{ method, path }], versionId }`, fall back to static.
- For action id collision: same flow with `reason: { code: "ERR_ACTION_ID_COLLISION", collidingIds: [...], versionId }`.

In both cases the guard SHALL NOT increment `consecutiveFailures` (deterministic mismatch, orthogonal to transient failures).

#### Scenario: Static cap newly registered shadows a bundle route

- **WHEN** an already-promoted bundle declares `path: "/skills/registry"` and the host is redeployed with a new static `httpHandler` on the same path
- **THEN** the next bundle dispatch attempt SHALL detect the collision, clear the pointer, broadcast `bundle_disabled` with `ERR_HTTP_ROUTE_COLLISION`, and the request SHALL fall back to the static handler

### Requirement: /bundle/refresh SHALL self-auth like /bundle/disable

The existing `/bundle/refresh` admin endpoint (currently in `preFetchHandler`, runs before `validateAuth`) SHALL self-auth using the same pattern as `/bundle/disable`: when `runtime.validateAuth` is set, the handler SHALL call it and return `401` on rejection. This closes a small unauthenticated read path the substrate currently leaves open.

#### Scenario: Unauthenticated POST to /bundle/refresh

- **WHEN** an unauthenticated request POSTs to `/bundle/refresh` and the host has `validateAuth` configured
- **THEN** the handler SHALL return `401 Unauthorized` and SHALL NOT touch the registry

### Requirement: Functional parity with static shape-2 capability for the v1 context fields

A shape-2 capability (per `bundle-shape-2-rollout`) consumed statically — wiring its `service` worker entrypoint into the host's `defineAgent` — SHALL expose an identical HTTP and `capability_action` surface to the same capability declared inside a bundle that consumes the shape-2 `client`, **for the context fields BundleHttpContext / BundleActionContext expose in v1** (`params`, `query`, `headers`, `agentId`, `sessionId`, `kvStore`, `channel`, `publicUrl`, `emitCost`). Capabilities that depend on context fields not in v1 (`sessionStore` raw access, `rateLimit`, `agentConfig`, `sendPrompt`) cannot achieve full parity until follow-up proposals expose those fields.

#### Scenario: Tavily shape-2 capability consumed both ways

- **WHEN** a regression test consumes `tavily-web-search` once via static `defineAgent({ capabilities: () => [tavilyStatic(...)] })` and once via a bundle declaring `BundleCapability { id: "tavily-web-search", httpHandlers: ..., onAction: ... }` consuming the shape-2 client
- **THEN** both surfaces SHALL accept the same requests and return responses with the same status codes and body shape, AND both SHALL emit the same cost events via `emitCost`

### Requirement: Telemetry SHALL log every dispatch boundary with [BundleDispatch] prefix

The host SHALL emit structured logs with the `[BundleDispatch]` prefix for every dispatch boundary:
- `/http hit` — `{ agentId, capabilityId, method, path, status, durationMs }`
- `/http miss-no-bundle` — `{ method, path }` when dispatcher invoked but no active bundle
- `/http body-cap exceeded` — `{ method, path, received, cap }` on 413
- `/http timeout` — `{ method, path, timeoutMs }` on 504
- `/action hit` — `{ agentId, capabilityId, action, sessionId, status }`
- `/action no-onAction` — `{ capabilityId, action }` on bundle `noop` response
- `route-collision-disable` — `{ versionId, collisions }` when dispatch-time route guard fires
- `action-id-collision-disable` — `{ versionId, collidingIds }` when dispatch-time action guard fires

#### Scenario: Successful HTTP dispatch is logged

- **WHEN** the bundle `/http` dispatcher completes a successful round-trip
- **THEN** the host SHALL emit a `[BundleDispatch] /http hit` log line with the agentId, capabilityId, method, path, status, and durationMs

### Requirement: Bundle authoring guide SHALL document the v1 limits and workarounds

The bundle authoring guide SHALL document:
- The reserved-prefix list, reserved-literal list, and reserved action-id list (each enumerated)
- The `maxRequestBodyBytes` default (256 KiB) and configuration knob (cap 1 MiB)
- The `httpDispatchTimeoutMs` default (30 000 ms) and configuration knob
- The "metadata is the source of truth — runtime-conditional routes that depend on env at probe time will fail metadata extraction" constraint
- Streaming bodies and WebSocket upgrade are not supported in v1; workaround: return 202 + job id, then write streamed output via `channel.broadcast` to the connected client
- `sendPrompt` is not in v1; workaround: webhook handler returns prompt text in response body, upstream caller routes it through the host's `/prompt` endpoint

#### Scenario: Bundle author reads the guide before adding an HTTP handler

- **WHEN** a bundle author opens the bundle authoring guide for the HTTP/UI surface
- **THEN** they SHALL find a worked example, the reserved-prefix list, the request/response cap, the dispatch timeout, and the documented v1 workarounds for sendPrompt and streaming
