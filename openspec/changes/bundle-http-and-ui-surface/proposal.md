## Why

`BundleCapability` today is narrower than the static `Capability` interface. Bundles can contribute tools, prompt sections, and `beforeInference` / `afterToolExecution` hooks — but **not** `httpHandlers` (mount routes on the agent's fetch surface) and **not** `onAction` (receive `capability_action` UI bridge dispatches). For any agent where part of the product is a bundle-owned HTTP endpoint (`/agent/:id/skills/registry`, webhook receiver, OAuth callback) or a bundle-owned UI bridge action (file browser action, capability state mutation from UI), the bundle brain is incomplete and the consumer must keep that capability host-side. This is the largest practical functional-parity gap remaining on `BundleCapability` after `bundle-runtime-surface` ships.

This change closes that gap. Bundle authors get `httpHandlers` and `onAction` fields on `BundleCapability` with the same semantic shape as the static `Capability` interface, and the host gains a cross-isolate dispatch path that forwards matched HTTP requests and `capability_action` messages into the bundle isolate via Worker Loader fetch — mirroring the existing lifecycle dispatch (`/alarm`, `/session-created`, `/client-event`).

## What Changes

- Add `httpHandlers` to `BundleCapability` returning `BundleHttpHandler[]` — same `{ method, path, handler }` shape as static `HttpHandler`. Bundle author writes the handler against a `BundleHttpContext` that mirrors the subset of `CapabilityHttpContext` we can safely cross the isolate (params, query, headers, agentId, sessionId, kvStore, channel, publicUrl, emitCost). `sendPrompt` is **NOT** in v1 — see the explicit non-goal below.
- Add `onAction` to `BundleCapability` matching the static signature `(action, data, ctx) => Promise<void>`. Receives a `BundleActionContext` carrying `capabilityId`, `agentId`, `sessionId`, the bundle-side spine clients, `kvStore`, `channel`, `publicUrl`, and `emitCost`.
- Extend `BundleMetadata` with a NEW top-level field `surfaces?: { httpRoutes?: BundleRouteDeclaration[]; actionCapabilityIds?: string[] }`. **Not nested under `lifecycleHooks`** — `lifecycleHooks` keeps its existing three-key shape from `bundle-runtime-surface` (Phase 2). HTTP routes and action ids are not lifecycle hooks; nesting them there would have collided with the in-flight `bundle-runtime-surface` spec.
- `defineBundleAgent` populates `surfaces.httpRoutes` and `surfaces.actionCapabilityIds` at build time by walking `setup.capabilities(probeEnv)` once with a minimal probe env. Validation failures (reserved-prefix collision, intra-bundle duplicates, reserved action id, env-access during probe) throw with descriptive messages naming the offending capability + route/id.
- Add a host-side dispatch hook `runtime.bundleHttpDispatcher?: (request, sessionId) => Promise<Response | null>`. Installed by `initBundleDispatch` in `agent-do.ts`. Called from `agent-runtime.ts` `handleRequest` **AFTER** `validateAuth` runs, **AFTER** static capability `httpHandlers` resolve (`matchHttpHandler` returns null), and **BEFORE** the final 404. This ordering preserves the single-auth-boundary contract (Decision 9) and the host-static-wins precedence (Decision 4). The dispatcher is NOT installed onto `preFetchHandler`.
- Add `runtime.bundleActionDispatcher?: (capabilityId, action, data, sessionId) => Promise<boolean>`. Installed by `initBundleDispatch`. Called from `handleCapabilityAction` after the resolved-handler check returns nothing and after the host's reserved built-in switch (`agent-config`, `schedules`, `queue`) returns no match — order: static onAction resolved → host built-in → bundle declared → warn-log default. Bundle declarations cannot shadow either reserved-builtin ids or host-registered capability ids (validated at promotion + dispatch).
- Add `/http` and `/action` endpoints to the bundle SDK fetch handler in `bundle-sdk/src/define.ts`. Both endpoints verify `__BUNDLE_TOKEN`, deserialize the JSON envelope, look up the declared bundle capability, and invoke its handler. Responses serialize back to the host as JSON envelopes.
- Build-time validation rejects:
  - **Reserved path prefixes** (kebab-case enforced): `/bundle/`, `/a2a`, `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`
  - **Reserved path literals**: `/`, `/prompt`, `/schedules`
  - **Reserved action capability ids**: `agent-config`, `schedules`, `queue`
  - **Intra-bundle duplicate routes** on `${method}:${path}`
  - **Path > 256 chars**, malformed method, missing leading slash
- Promotion-time validation extends `BundleRegistry.setActive` with `knownHttpRoutes?: Array<{ method, path }>` AND `knownCapabilityIds: string[]` (already exists for catalog) so that bundle-declared routes and bundle-declared action ids cannot collide with the host's currently-resolved static surface. Mismatch returns `ERR_HTTP_ROUTE_COLLISION` or `ERR_ACTION_ID_COLLISION`; pointer is NOT flipped.
- Dispatch-time guard mirrors the existing catalog guard: when collision is detected at dispatch, clear the pointer with `skipCatalogCheck: true`, broadcast `bundle_disabled` with structured reason, fall back to static.
- Functional parity test: shape-2 capabilities consumed statically vs. inside a bundle expose the same routes and accept the same `capability_action` traffic for the **subset of context** the bundle exposes (parity is not full — `sessionStore` raw access, `rateLimit`, `agentConfig` are not on `BundleHttpContext` in v1).
- Telemetry: structured logs at every dispatch boundary (`[BundleDispatch]` prefix, matching the existing pattern) for route hits, action hits, body-cap rejections, dispatch timeouts, route-collision disable, action-id-collision disable.
- **NOT in scope** (deferred to follow-ups, named explicitly):
  - **`sendPrompt` from bundle HTTP / action handlers** — requires a new spine RPC, a new scope, a new budget category, and a reentrancy guard against HTTP-route-driven prompt injection. Cut from v1; bundle authors who need to trigger inference from a webhook can have the webhook's response include the prompt text and let the host-side caller route it through `/prompt`. Tracked separately.
  - **Streaming request bodies, streaming response bodies, WebSocket upgrade, SSE.** v1 supports unary request + unary response only. `BundleConfig.maxRequestBodyBytes` defaults to 256 KiB (sized to typical webhook payload + envelope overhead, well under workerd's structured-clone practical limits) and is configurable up to 1 MiB.
  - **`sessionStore` raw access, `rateLimit`, `agentConfig` on `BundleHttpContext`.** These can be added in a follow-up; their absence is a documented parity gap, not silently broken behavior.
  - **Bundle MCP server hosting.** Separate proposal.
  - **Bundle-declared `agentConfig` schema.** Separate proposal (`bundle-config-namespaces`).

## Capabilities

### New Capabilities

- `bundle-http-and-ui-surface`: bundle-side authoring API + host-side dispatch path that lets bundle capabilities mount HTTP routes on the agent's fetch surface and receive `capability_action` UI bridge dispatches. Build-time route/action declaration is captured in a NEW `BundleMetadata.surfaces` field (intentionally not nested under `lifecycleHooks`). Promotion-time and dispatch-time guards enforce no collision with host static surface. Auth runs once at the host fetch boundary — bundle dispatchers do not self-auth, and they install into the post-auth handler chain rather than `preFetchHandler`.

### Modified Capabilities

_None._ The metadata extension uses a new top-level field (`surfaces`) rather than extending `bundle-runtime-surface`'s `lifecycleHooks` shape, so there is no requirement-shape collision when both specs eventually archive side-by-side under `openspec/specs/`.

## Impact

- **`packages/runtime/bundle-sdk/src/types.ts`** — extend `BundleCapability` with `httpHandlers` + `onAction`; add `BundleHttpContext`, `BundleActionContext`, `BundleHttpHandler`, `BundleHttpRequest`, `BundleHttpResponse`, `BundleRouteDeclaration` types; add `BundleMetadata.surfaces` field.
- **`packages/runtime/bundle-sdk/src/define.ts`** — add `/http` and `/action` endpoint handlers; extend build-time metadata population to walk capabilities for routes and action ids; update the existing `hasLifecycleHook` omit-guard to also consider `surfaces` so bundles with only HTTP routes (no lifecycle hooks) still emit metadata.
- **`packages/runtime/bundle-sdk/src/validate.ts`** — add `validateHttpRoutes` and `validateActionCapabilityIds` helpers (charset, reserved-prefix, reserved-literal, duplicate, length).
- **`packages/runtime/bundle-sdk/src/runtime.ts`** — surface bundle-side capabilities' declared `httpHandlers` + `onAction` to the dispatcher (resolve once on bundle boot per request, hand back to `define.ts` endpoint handlers).
- **`packages/runtime/agent-runtime/src/agent-runtime.ts`** —
  - Add `bundleHttpDispatcher?` and `bundleActionDispatcher?` fields on `AgentRuntime`.
  - In `handleRequest`, after `matchHttpHandler` returns null and before the final 404, call `bundleHttpDispatcher?.(request, sessionId)`; if it returns a `Response`, use it.
  - In `handleCapabilityAction`, after the resolved-handler check AND after the host built-in switch (the three reserved ids), call `bundleActionDispatcher?.(...)`; if it returns `true`, stop. Otherwise fall through to the warn-log default.
  - Expose `getResolvedHttpHandlerSpecs()` (protected) returning `Array<{ method, path }>` so the dispatch-time route guard can see the host's currently-resolved static handler shape without crossing a value boundary.
- **`packages/runtime/agent-runtime/src/agent-do.ts`** —
  - In `initBundleDispatch`, install `runtime.bundleHttpDispatcher` and `runtime.bundleActionDispatcher` (NOT into `preFetchHandler`).
  - Add `dispatchHttp(request, sessionId)` and `dispatchAction(capId, action, data, sessionId)` helpers that mint the unified `__BUNDLE_TOKEN`, decode the envelope, POST to the bundle's `/http` or `/action` endpoint, and parse the response.
  - Extend `validateCatalogCached` (or add `validateRoutesCached`) to also check declared `httpRoutes` against `getResolvedHttpHandlerSpecs()` and declared `actionCapabilityIds` against `getCachedCapabilities().map(c => c.id)`. On mismatch, route through `disableForRouteCollision` / `disableForActionIdCollision` (sibling helpers to the existing `disableForCatalogMismatch`).
- **`packages/runtime/bundle-host/src/`** — add `serializeRequestForBundle` / `deserializeResponseFromBundle` helpers (and inverse for action envelopes); add `validateBundleRoutesAgainstKnownRoutes` and `validateBundleActionIdsAgainstKnownIds` helpers; reuse `composeWorkerLoaderConfig` (extracted as part of this change if `bundle-runtime-surface` task 5.5.1 has not landed first — promote 8.1 from "if-needed" to a hard task).
- **`examples/bundle-agent-phase2/`** — extend the example bundle to register a small `httpHandlers` route and an `onAction` handler to exercise the new dispatch paths in dev.
- **CLAUDE.md** — under the bundle-brain section, document: the new `surfaces` metadata field (separate from `lifecycleHooks`), the dispatch-chain insertion point (post-auth, after `matchHttpHandler` returns null), the reserved prefix / literal / action-id lists, the v1 streaming non-goal, the `sendPrompt` deferral, the `bundle_disabled` reason codes (`ERR_HTTP_ROUTE_COLLISION`, `ERR_ACTION_ID_COLLISION`).
- **Spec corpus** — new `bundle-http-and-ui-surface` capability spec under `openspec/specs/`. No deltas against existing specs (clean ADDED).
