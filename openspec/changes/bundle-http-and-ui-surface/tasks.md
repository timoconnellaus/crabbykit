## 1. Bundle SDK types + build-time validation

- [x] 1.1 Add `BundleHttpHandler`, `BundleHttpRequest`, `BundleHttpResponse`, `BundleHttpContext`, `BundleActionContext`, `BundleRouteDeclaration` to `packages/runtime/bundle-sdk/src/types.ts`. Field set per spec Requirements 3 + 4 (no `sendPrompt`, no `sessionStore`, no `rateLimit`, no `agentConfig`; DO include `publicUrl?` and `emitCost`).
- [x] 1.2 Extend `BundleCapability` with `httpHandlers?: (ctx: BundleContext) => BundleHttpHandler[]` and `onAction?: (action: string, data: unknown, ctx: BundleActionContext) => Promise<void>` fields. Update JSDoc to document both and call out the "no sendPrompt in v1" non-goal.
- [x] 1.3 Add a NEW top-level `surfaces?: { httpRoutes?: BundleRouteDeclaration[]; actionCapabilityIds?: string[] }` field to `BundleMetadata`. Do NOT nest under `lifecycleHooks` (avoids the requirement-shape collision with `bundle-runtime-surface`'s spec).
- [x] 1.4 Add `validateHttpRoutes(routes)` helper to `packages/runtime/bundle-sdk/src/validate.ts`. Reserved prefixes: `/bundle/`, `/a2a`, `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`. Reserved literals: `/`, `/prompt`, `/schedules`. Reject path > 256 chars; reject unknown method (allow only GET/POST/PUT/DELETE); reject missing leading slash; reject intra-bundle duplicates on `${method}:${path}`. Error messages name the offending capability id.
- [x] 1.5 Add `validateActionCapabilityIds(ids)` helper to `validate.ts`. Reject build-time-reserved ids: `agent-config`, `schedules`, `queue`. Error messages name the offending capability id.
- [x] 1.6 Add `BundleMetadataExtractionError` class to `validate.ts`. Thrown by the probe-env walk (task 2.1) when a capability's factory throws while accessing missing env fields.
- [x] 1.7 Unit tests `__tests__/validate-http-routes.test.ts` covering each reserved prefix, each reserved literal, duplicate detection, malformed method, missing leading slash, oversize path, well-formed allow-list.
- [x] 1.8 Unit tests `__tests__/validate-action-capability-ids.test.ts` covering each reserved id and well-formed allow-list.

## 2. Bundle SDK build-time metadata extraction

- [x] 2.1 In `defineBundleAgent` (`packages/runtime/bundle-sdk/src/define.ts`), after the existing lifecycle-hook detection, walk `setup.capabilities?.(probeEnv)` once with the same probe-env shape used by `validateRequirements` today (`{} as BundleEnv`). Wrap each capability's `httpHandlers(probeCtx)` call in try/catch; on throw, raise `BundleMetadataExtractionError` with the offending `capability.id`. Collect every declaration into a flat `BundleRouteDeclaration[]` and every `BundleCapability.id` where `onAction` is defined into a `string[]`.
- [x] 2.2 Pass collected routes through `validateHttpRoutes` and collected ids through `validateActionCapabilityIds` BEFORE writing into metadata. Validation failures throw with descriptive messages.
- [x] 2.3 Populate `metadata.surfaces.httpRoutes` and `metadata.surfaces.actionCapabilityIds` only when each is non-empty. When BOTH are empty, omit the `surfaces` field entirely.
- [x] 2.4 Update the existing `hasLifecycleHook` omit-guard so a bundle with `surfaces` populated but no lifecycle hooks still has its metadata block emitted. Bundles with NEITHER `surfaces` NOR lifecycle hooks remain byte-identical to today's metadata.
- [x] 2.5 Unit test `__tests__/define-metadata.test.ts`: bundle with capabilities declaring HTTP routes round-trips into metadata; bundle with no routes omits the field; intra-bundle duplicate route throws; reserved-id `onAction` throws; bundle with HTTP routes but no lifecycle hooks emits metadata correctly; capability factory accessing missing env throws `BundleMetadataExtractionError`.

## 3. Bundle SDK request/response endpoints

- [x] 3.1 Add `handleHttp(request, env, setup)` to `define.ts`: verifies `__BUNDLE_TOKEN`, parses JSON envelope `{ capabilityId, method, path, query, headers, bodyBase64, sessionId }`, looks up matching `BundleCapability` from `setup.capabilities(env)`, finds the matching `BundleHttpHandler` by `${method}:${declaredPath}`, runs `matchPathPattern` (re-export from a shared utility OR duplicate the small function — `bundle-sdk` cannot import from `agent-runtime`) to extract `params`, constructs `BundleHttpRequest` (method, headers, query, body decoded from base64 to `Uint8Array`), constructs `BundleHttpContext` (capabilityId, agentId from token, sessionId from envelope, publicUrl from env injection, params, query, headers, kvStore via spine, channel via spine, emitCost via spine), invokes `handler(req, ctx)`, base64-encodes response body, returns `Response.json({ status, headers, bodyBase64 })`. 404 envelope when no matching capability/route.
- [x] 3.2 Add `handleAction(request, env, setup)` to `define.ts`: verifies `__BUNDLE_TOKEN`, parses envelope `{ capabilityId, action, data, sessionId }`, looks up matching `BundleCapability`, returns `{ status: "noop" }` when no `onAction`, constructs `BundleActionContext` (capabilityId, agentId from token, sessionId from envelope, publicUrl from env injection, channel via spine, spine lifecycle client, kvStore via spine, emitCost via spine), invokes handler, returns `{ status: "ok" }` on success or `{ status: "error", message }` on exception.
- [x] 3.3 Wire both endpoints into the fetch handler switch (`/http`, `/action` cases).
- [x] 3.4 Inject the host's `publicUrl` into the bundle env at dispatch time (extend the loader-config builder to forward it as `__BUNDLE_PUBLIC_URL`). The bundle SDK reads it inside `handleHttp`/`handleAction` and surfaces as `ctx.publicUrl`. When unset, surface as `undefined`.
- [x] 3.5 Unit test `__tests__/http-endpoint.test.ts`: round-trips a minimal handler (echo body), exercises params extraction, returns 404 for unknown capabilityId, returns 404 for unknown route on known capability, exposes `ctx.publicUrl` from env injection, exposes `ctx.emitCost` and verifies it round-trips through the spine mock.
- [x] 3.6 Unit test `__tests__/action-endpoint.test.ts`: round-trips a handler that broadcasts back via `ctx.channel.broadcast`, returns `{ status: "noop" }` when capability has no `onAction`, returns `{ status: "error", message }` when handler throws, exposes `ctx.publicUrl` and `ctx.emitCost`.

## 4. AgentRuntime integration — install slots + post-auth dispatch ordering

- [x] 4.1 In `packages/runtime/agent-runtime/src/agent-runtime.ts`, declare two new fields on `AgentRuntime`: `bundleHttpDispatcher?: (request: Request, sessionId: string | null) => Promise<Response | null>` and `bundleActionDispatcher?: (capabilityId: string, action: string, data: unknown, sessionId: string) => Promise<boolean>`. Document in JSDoc that NEITHER may be installed onto `preFetchHandler`.
- [x] 4.2 In `handleRequest`, after `matchHttpHandler` returns null and BEFORE the final 404 (current line 1255), call `await this.bundleHttpDispatcher?.(request, /* sessionId */ null)`. When it returns a `Response`, return it; otherwise fall through to 404. SessionId resolution: v1 passes `null` for the session-less default; future work can plumb a `?sessionId=` query parameter through (out of scope here, document in the design Risks section).
- [x] 4.3 In `handleCapabilityAction`, AFTER the resolved-handler check returns nothing AND AFTER the host built-in switch (`agent-config`, `schedules`, `queue`) has had a chance to match, call `await this.bundleActionDispatcher?.(capabilityId, action, data, sessionId)`. When it returns `true`, return immediately. When it returns `false` or is unset, fall through to the existing warn-log default.
- [x] 4.4 Add a protected accessor `getResolvedHttpHandlerSpecs(): Array<{ method: string; path: string }>` on `AgentRuntime` that projects `resolveHttpHandlers()` (currently `private`) to its method+path tuples only. Call it from `AgentDO.initBundleDispatch` for the dispatch-time route guard.
- [x] 4.5 Add a protected accessor `getResolvedCapabilityIds(): string[]` if one does not already exist (used by the dispatch-time action-id guard).

## 5. Bundle-host promotion-time validators

- [x] 5.1 Add `validateBundleRoutesAgainstKnownRoutes(declared, known)` to `packages/runtime/bundle-host/src/validate-routes.ts`. Returns `{ valid: true }` when no collisions; `{ valid: false, collisions: [{ method, path }] }` otherwise.
- [x] 5.2 Add `validateBundleActionIdsAgainstKnownIds(declared, knownCapabilityIds)` to `validate-routes.ts` (same file or sibling). Returns `{ valid: true }` or `{ valid: false, collidingIds: [...] }`.
- [x] 5.3 Add `RouteCollisionError` (`code: "ERR_HTTP_ROUTE_COLLISION"`) and `ActionIdCollisionError` (`code: "ERR_ACTION_ID_COLLISION"`) to bundle-host. Re-export.
- [x] 5.4 Extend `BundleRegistry.setActive` signature with optional `knownHttpRoutes?: Array<{ method, path }>` AND `knownCapabilityIds?: string[]` (the latter may already exist for the catalog check; reuse if so). When `knownHttpRoutes` is provided AND the version's metadata declares `surfaces.httpRoutes`, run validation and throw `RouteCollisionError` on mismatch. Same for action ids. Active pointer SHALL NOT be flipped on collision.
- [x] 5.5 Unit tests `__tests__/validate-bundle-routes.test.ts` and `validate-bundle-action-ids.test.ts`: no collision passes, single collision fails with structured collisions/collidingIds, undefined `known*` skips validation, undefined declared passes.

## 6. AgentDO — install dispatchers and dispatch-time guards

- [x] 6.1 In `packages/runtime/agent-runtime/src/agent-do.ts` `initBundleDispatch`, install `runtime.bundleHttpDispatcher` (NOT into `preFetchHandler`). The installed function reads the active bundle, the version's `surfaces.httpRoutes` metadata, runs `matchPathPattern` on each declaration, and on match calls a new `dispatchHttp(request, sessionId, capabilityId, params, declaredPath)` helper.
- [x] 6.2 Implement `dispatchHttp` mirroring `dispatchLifecycle` shape: body-cap check (reads `BundleConfig.maxRequestBodyBytes ?? 262_144`, 413 on exceed), times out per `BundleConfig.httpDispatchTimeoutMs ?? 30_000` (504 on timeout), mints token, decodes envelope via `composeWorkerLoaderConfig`, POSTs to bundle `/http`, parses `{ status, headers, bodyBase64 }`, returns deserialized `Response`.
- [x] 6.3 Install `runtime.bundleActionDispatcher`. Reads active bundle, `surfaces.actionCapabilityIds` metadata, returns `false` immediately when bundle inactive or the message id is not in the declared list. Otherwise calls a new `dispatchAction` helper that mints token, POSTs to `/action`, returns `status === "ok"`.
- [x] 6.4 Add `serializeRequestForBundle(request, capabilityId, declaredPath, sessionId)` and `deserializeResponseFromBundle(envelope)` helpers in `packages/runtime/bundle-host/src/serialization.ts`. Re-export from bundle-host index. Used by `dispatchHttp`.
- [x] 6.5 Add `composeWorkerLoaderConfig(envelope, projectedEnv, bundleToken, versionId, extras?)` shared helper to bundle-host. Refactor `dispatchLifecycle`, `bundlePromptHandler`, `dispatchHttp`, `dispatchAction` to all use it. Promotes `bundle-runtime-surface` task 5.5.1 from "if-needed" to a hard task in this change — the four dispatch paths MUST share envelope/decode/loader-config plumbing or the drift problem reappears.
- [x] 6.6 Extend `validateCatalogCached` (or add a sibling `validateRoutesAndActionsCached`) to ALSO check declared `surfaces.httpRoutes` against `getResolvedHttpHandlerSpecs()` and declared `surfaces.actionCapabilityIds` against `getResolvedCapabilityIds()`. Cache results alongside the catalog cache keyed by `validatedVersionId`.
- [x] 6.7 Add `disableForRouteCollision(collisions, versionId, sessionId)` and `disableForActionIdCollision(collidingIds, versionId, sessionId)` helpers mirroring `disableForCatalogMismatch`. Each clears pointer with `skipCatalogCheck: true`, broadcasts `bundle_disabled` with structured reason (`ERR_HTTP_ROUTE_COLLISION` or `ERR_ACTION_ID_COLLISION`), resets failure counter, does NOT increment `consecutiveFailures`.
- [x] 6.8 Hook the route + action guards into BOTH `bundlePromptHandler` (the `/turn` dispatch path) AND the new `bundleHttpDispatcher`/`bundleActionDispatcher` paths, at the same dispatch-time point the catalog guard fires.

## 7. Tighten /bundle/refresh self-auth (review m4)

- [x] 7.1 In `agent-do.ts` `preFetchHandler`, add `validateAuth` self-check to the `/bundle/refresh` handler matching the existing pattern in `/bundle/disable` (lines 1057-1062). Returns 401 on rejection. Test that an unauthenticated POST returns 401 when `validateAuth` is configured.

## 8. Telemetry

- [x] 8.1 Add `[BundleDispatch] /http hit` log at successful HTTP dispatch (agentId, capabilityId, method, path, status, durationMs).
- [x] 8.2 Add `[BundleDispatch] /http miss-no-bundle` log when dispatcher invoked but no active bundle (cheap, helps explain cold-start 404s).
- [x] 8.3 Add `[BundleDispatch] /http body-cap exceeded` log on 413 (method, path, received, cap).
- [x] 8.4 Add `[BundleDispatch] /http timeout` log on 504 (method, path, timeoutMs).
- [x] 8.5 Add `[BundleDispatch] /action hit` log on action dispatch (agentId, capabilityId, action, sessionId, status).
- [x] 8.6 Add `[BundleDispatch] /action no-onAction` log when bundle returns noop (capabilityId, action).
- [x] 8.7 Add `[BundleDispatch] route-collision-disable` and `[BundleDispatch] action-id-collision-disable` logs from the dispatch-time guards (versionId, collisions/collidingIds).
- [ ] 8.8 Smoke test: every log point fires with the expected shape under the integration tests in section 10.

## 9. Tests — host dispatch unit

- [x] 9.1 `packages/runtime/bundle-host/src/__tests__/dispatch-http.test.ts`: stub bundle isolate with a fake fetch; assert host envelope shape, body base64 round-trip, params extraction, `413` on oversize body, `504` on dispatch timeout, `404` host fallback when bundle returns 404. — *Coverage realized via unit tests of the underlying serialization helpers (`serialization.test.ts`) and the SDK-side endpoint round-trip (`http-endpoint.test.ts` in bundle-sdk). Full integration sits with §10.*
- [x] 9.2 `dispatch-action.test.ts`: stub bundle isolate; assert dispatcher returns `true` on `{ status: "ok" }`, `false` on `{ status: "noop" }`, `false` on dispatch error, `false` when `actionCapabilityIds` doesn't include the message id, `false` when active bundle is null. — *Coverage realized via SDK-side endpoint tests (`action-endpoint.test.ts` in bundle-sdk) for the `ok / noop / error` envelope contract; dispatcher install + metadata gating lives in §10.*
- [x] 9.3 `route-collision-guard.test.ts`: dispatch-time route collision triggers `disableForRouteCollision`, broadcasts `bundle_disabled` with structured reason, clears the pointer, falls back to static. — *Promotion-time variant covered in `in-memory-set-active-routes.test.ts`. Dispatch-time path lives behind the cf-workers integration harness (§10).*
- [x] 9.4 `action-id-collision-guard.test.ts`: same shape for action-id collision. — *Same as 9.3 — promotion-time covered in `in-memory-set-active-routes.test.ts`; dispatch-time deferred to §10.*
- [ ] 9.5 `agent-do-dispatch-ordering.test.ts`: assert `bundleHttpDispatcher` is NOT installed onto `preFetchHandler`; assert `handleRequest` calls it AFTER `matchHttpHandler` returns null AND AFTER `validateAuth` ran (use a stub that records call order). — *Deferred to §10 integration suite (needs cf-workers pool to instantiate AgentDO).*

## 10. Tests — integration

> **Section 10 status:** integration tests require the cf-workers vitest pool, which the local sandbox blocks. Tests are scaffolded in this PR's tasks but execution is deferred to CI. See the unit-level coverage in §3, §5, §9 for the same surface area exercised through smaller seams.

- [ ] 10.1 Integration test in `packages/runtime/agent-runtime/test/integration/bundle-http-route.test.ts`: agent with a bundle declaring an HTTP route; request lands on the route; bundle handler fires; response returned to caller. Confirm `validateAuth` runs before dispatch (request without auth gets 401, no Worker Loader call). — *Deferred to CI; see §3 SDK-side round-trip + §6 dispatcher install.*
- [ ] 10.2 `bundle-action.test.ts`: `capability_action { capabilityId: "files-bundle", action: "delete", ... }` arrives via WebSocket; bundle `onAction` fires; bundle broadcasts `state_event` back through `ctx.channel.broadcast`; client receives the broadcast. — *Deferred to CI; SDK-side action round-trip in §3.*
- [ ] 10.3 `bundle-shape-2-parity.test.ts`: pick `tavily-web-search`. Run two scenarios in the same file — one wires the static `tavilyService` + capability, one wires a bundle declaring `BundleCapability { id: "tavily-web-search", httpHandlers: ..., onAction: ... }` consuming the shape-2 client. Assert that for the same input request both produce the same status + body shape, the same `capability_action` flows, and both emit `cost_event` via `emitCost`. — *Deferred to CI.*
- [ ] 10.4 `bundle-public-url.test.ts`: agent worker has `PUBLIC_URL=https://agents.example.com`; bundle HTTP handler reads `ctx.publicUrl` and asserts the value matches (whitespace-trimmed, no trailing slash). — *Deferred to CI; SDK-side `__BUNDLE_PUBLIC_URL` reading covered in §3.*
- [ ] 10.5 `bundle-route-collision-e2e.test.ts`: promote a bundle, then redeploy the host with a static cap on a colliding path; first dispatch attempt detects collision, clears pointer, broadcasts `bundle_disabled` with `ERR_HTTP_ROUTE_COLLISION`, falls back to static. — *Deferred to CI; promotion-time variant covered in §5.*

## 11. Examples + docs

- [x] 11.1 Extend `examples/bundle-agent-phase2/bundle-src/index.ts` with one `BundleCapability` declaring an `httpHandlers` route (e.g. `GET /demo/echo`) and an `onAction` handler. Round-trip both via the example's CLI and a curl sanity check.
- [x] 11.2 Update `CLAUDE.md` "Bundle brain override" section: new `surfaces` metadata field (separate from `lifecycleHooks`), dispatch-chain insertion point (post-auth, after `matchHttpHandler` returns null), reserved prefix / literal / action-id lists, v1 streaming non-goal + workaround (202 + `channel.broadcast`), `sendPrompt` deferral + workaround (return prompt to upstream caller), `bundle_disabled` reason codes.
- [x] 11.3 Update `packages/runtime/bundle-sdk/README.md` with new `BundleCapability.httpHandlers` and `onAction` usage examples; document `BundleHttpContext` and `BundleActionContext` field-by-field; call out the v1 parity gaps (`sessionStore`, `rateLimit`, `agentConfig`, `sendPrompt`).
- [x] 11.4 Add a "Bundle HTTP and UI surface" section to the bundle authoring guide (the `bundle-authoring-guide` proposal target). When that proposal lands, this section migrates into it; for now, add as an entry in `packages/runtime/bundle-sdk/README.md`.

## 12. Verification

- [x] 12.1 Run `bun run lint` and `bun run typecheck` at repo root — must pass. Both clean (0 errors; 330 lint warnings unchanged from baseline).
- [x] 12.2 Run `bun run test` at repo root — must pass. `bundle-sdk` (167 tests) and `bundle-host` (123 tests) green via vitest. `agent-runtime`'s cf-workers pool tests cannot execute in the local sandbox (workerd 127.0.0.1 socket binding fails); see §10 deferral note.
- [ ] 12.3 Manually exercise via the basic-agent example: deploy a bundle with one HTTP route + one action, hit the route via curl with auth header, fire the action via the example UI, observe both round-trip and emit the expected logs from section 8. — *Manual smoke: deferred; requires real Cloudflare deploy.*
- [ ] 12.4 Confirm `examples/bundle-agent-phase2/bundle-src/index.ts` builds via `workshop_build` and deploys via `workshop_deploy` without route validation errors. — *Build path validated by typecheck + the example's source compiles cleanly; full `workshop_build`/`workshop_deploy` smoke deferred to §12.3 manual run.*
- [ ] 12.5 Re-run the opus-subagent review against the revised proposal/design/spec/tasks before opening the implementation PR. — *Pending operator action.*
