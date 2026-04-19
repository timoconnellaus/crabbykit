## Context

After `bundle-runtime-surface` ships, `BundleCapability` advertises its tools to the LLM, contributes prompt sections (with source attribution), participates in the host hook bus (`beforeInference`, `afterToolExecution`), and the bundle SDK exposes lifecycle hooks (`onAlarm`, `onSessionCreated`, `onClientEvent`) plus mode-aware dispatch. What it does **not** have:

1. **`httpHandlers`** — static `Capability.httpHandlers(ctx)` returns `HttpHandler[]` and the runtime mounts them onto the DO's fetch surface (`agent-runtime.ts:3009-3073` resolve + match, dispatched at `agent-runtime.ts:1250` after `validateAuth`). Bundle equivalent does not exist.
2. **`onAction`** — static `Capability.onAction(action, data, ctx)` is invoked from `handleCapabilityAction` (`agent-runtime.ts:1840-1938`) when the client sends `capability_action`. Bundle equivalent does not exist.

Both are cross-isolate problems: the trigger originates host-side (incoming `Request` or incoming `ClientMessage`), but the handler logic must run inside the bundle isolate where the bundle author defined it. The existing lifecycle dispatcher (`dispatchLifecycle` in `agent-do.ts:939-996`) is the proven pattern — mint token, decode envelope, POST a JSON body to a discriminated bundle endpoint, parse JSON response. That same pattern generalizes here, with two complications: HTTP requests carry methods/headers/bodies/responses with status codes, and `onAction` must dispatch session-scoped broadcasts back to the host.

The unified `__BUNDLE_TOKEN` (scope-checked at every spine RPC) is the existing security boundary. Bundle-declared HTTP routes and action ids do not cross any new trust boundary — they merely extend the bundle's already-existing surface inside the host's tenanted isolate.

**Substrate facts the design depends on (verified by reading the code):**

- `agent-runtime.ts:1110-1255` `handleRequest` ordering is: `preFetchHandler` chain → `validateAuth` → WebSocket upgrade → `/prompt` → `/schedules*` → `/mcp/callback` → A2A (`/.well-known/agent-card.json`, `/a2a`, `/a2a-callback*`) → `matchHttpHandler` (capability-contributed paths) → 404. Bundle dispatch as designed in this proposal lands between the last two steps.
- `agent-do.ts:1052-1094` `preFetchHandler` is currently used for `/bundle/*` admin routes (`/bundle/disable`, `/bundle/refresh`). It runs **before** `validateAuth`. `dispatchHttp` MUST NOT be installed onto `preFetchHandler` — that would silently bypass auth.
- `agent-runtime.ts:3009` `resolveHttpHandlers` and `agent-runtime.ts:3041` `matchHttpHandler` are both `private`. The dispatch-time route guard needs a route-only projection — added as a new protected `getResolvedHttpHandlerSpecs()` accessor.
- Reserved host paths (literal): `/prompt`, `/schedules`. Reserved prefixes: `/bundle/`, `/a2a`, `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`. Reserved built-in action ids (in `handleCapabilityAction` default switch): `agent-config`, `schedules`, `queue`. **Plus** every host-registered capability id collides at runtime via the resolved-handler check at `agent-runtime.ts:1877`.

**Stakeholders:** bundle authors (need parity to migrate static caps), host operators (need to know which paths/actions a deployed bundle owns and to enforce reserved-prefix invariants), the workshop tools (must surface validation failures at `workshop_build`).

## Goals / Non-Goals

**Goals:**
- Add `BundleCapability.httpHandlers` and `BundleCapability.onAction` matching the static `Capability` shape semantically, for the subset of `Capability*Context` this proposal exposes (see Decision 6 for the field-by-field mapping).
- Host dispatches matched HTTP requests and `capability_action` messages into the bundle isolate via the same Worker Loader fetch pattern used for lifecycle hooks, but inserted into the **post-auth** chain so that `validateAuth` covers bundle routes the same way it covers static routes (Decision 9).
- Build-time validation rejects malformed paths, reserved-prefix collisions, reserved literal collisions, reserved action-id collisions, and intra-bundle duplicates at `workshop_build` rather than at deploy or dispatch.
- Build-time metadata declaration lets the host fast-skip dispatch when nothing is declared (zero overhead for bundles that don't use the surface).
- Promotion-time and dispatch-time guards prevent and detect bundle/static collision against the *deployed* host (which may register different static capabilities than the bundle author saw at build time). Mirror the existing `ERR_CAPABILITY_MISMATCH` flow for two new codes.
- Functional parity test: `tavily-web-search` consumed statically vs. declared in a bundle exposes the same routes and accepts the same actions, **for the context fields the bundle exposes**. Parity is honestly partial — see Decision 6.
- Telemetry: every dispatch path emits structured `[BundleDispatch]` logs.

**Non-Goals:**
- Streaming request bodies. v1 buffers the full body in the host before forwarding (configurable cap).
- Streaming response bodies. v1 buffers the full bundle response before returning to the original caller. WebSocket upgrade and SSE are deferred — bundle author must provide unary HTTP semantics. **Workaround for LLM-proxy use cases:** bundle returns a 202 with a job id, then writes streamed output via `channel.broadcast` to the connected client, mimicking how the host's existing `/turn` SSE works.
- WebSocket upgrade handling from bundles.
- **`sendPrompt` from bundle HTTP / action handlers (Cut from v1, see Decision 11).** Bundle author who needs this can have their handler return data the upstream caller can route through the host's existing `/prompt` endpoint, or trigger a downstream A2A message.
- **`sessionStore`, `rateLimit`, `agentConfig` on `BundleHttpContext` / `BundleActionContext`.** The first is a heavy raw store; the second requires proxying a complex atomicity contract; the third is a separate proposal. Their absence is documented as a known parity gap, not silently broken behavior.
- Bundle-declared MCP server hosting (separate proposal).
- Bundle-declared `agentConfig` schema (separate proposal — `bundle-config-namespaces`).
- Authentication on bundle HTTP routes beyond what `validateAuth` already provides at the DO fetch boundary. Bundle author who needs additional auth on `/skills/registry` reads headers themselves.
- Re-routing the existing static `httpHandlers` and `onAction` paths through the bundle. Static handlers always win on collision; the bundle layer is additive.

## Decisions

### Decision 1 — Build-time metadata declaration is the routing index, in a NEW top-level `surfaces` field

**Context.** Two ways the host could decide whether to forward a given request to a bundle: (a) speculative dispatch — always forward, let the bundle 404 internally; (b) metadata-driven skip — bundle declares its routes/actions at build time, host consults the declaration before forwarding.

**Decision.** Use (b). Add a NEW top-level `BundleMetadata.surfaces` field — **NOT** nested under `lifecycleHooks`:

```ts
BundleMetadata {
  ...existing fields,
  lifecycleHooks?: { onAlarm?: boolean; onSessionCreated?: boolean; onClientEvent?: boolean }, // unchanged from bundle-runtime-surface
  surfaces?: {
    httpRoutes?: BundleRouteDeclaration[];   // [{ method, path }, ...]
    actionCapabilityIds?: string[];           // ["my-cap", ...]
  }
}
```

`defineBundleAgent` populates `surfaces.*` at build time by walking `setup.capabilities(probeEnv)` once with a minimal probe env. Metadata is stored on the registry version. Dispatch reads metadata via the existing `version.metadata` accessor.

The existing `hasLifecycleHook` omit-guard in `define.ts:71-84` MUST be updated to also consider `surfaces` — otherwise a bundle with HTTP routes but no `onAlarm`/`onSessionCreated`/`onClientEvent` would silently drop its routes (whole `lifecycleHooks` block omitted today; with this change, if EITHER `lifecycleHooks` or `surfaces` is non-empty, both fields are emitted, with the empty one omitted individually).

**Rationale.** Speculative dispatch wastes Worker Loader instantiation on every unmatched request. Metadata-driven skip mirrors the existing `lifecycleHooks` pattern. **Why a new field instead of nesting under `lifecycleHooks`:** the `bundle-runtime-surface` change publishes a spec defining `lifecycleHooks` as a fixed three-key boolean record. Adding `httpRoutes` and `actionCapabilityIds` under that key would be a requirement-shape collision when both specs archive; worse, it conflates "lifecycle hook" (an event source) with "route table" (a router declaration). Two separate fields, each with a clean semantic.

**Probe-env shape.** Same probe env used for `requiredCapabilities` validation today (empty object cast to `BundleEnv`). The probe walk MUST be wrapped in try/catch — when a capability's `httpHandlers(ctx)` factory throws because it accessed `ctx.env.SOMETHING` that's not in the probe, the error is reported as `BundleMetadataExtractionError` naming the offending capability id and the probe-env constraint. Bundle authors who legitimately need runtime-conditional routes are documented as "metadata is the source of truth — runtime-conditional routes that aren't in the probe-env walk won't dispatch."

**Alternative rejected.** "Forward all requests, let bundle 404." Amplifies cold-start cost on misses; loses the operator-facing "which routes does this bundle own" signal.

**Alternative rejected.** "Nest under `lifecycleHooks` to keep metadata flat." Causes the C3 spec collision (see review feedback) and conflates two distinct concepts.

### Decision 2 — Reserved-prefix list, validated at build AND at promotion (complete enumeration)

**Context.** Bundle-declared paths must not shadow host static routes. The host has its own paths and resolves capability-contributed paths from registered host capabilities.

**Decision.** Two-layer validation:

1. **Build-time (in `defineBundleAgent` / `validateHttpRoutes`)** — reject paths matching the static reserved list:
   - **Reserved prefixes:** `/bundle/`, `/a2a`, `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`
   - **Reserved literals:** `/`, `/prompt`, `/schedules`
   - These came from a grep of `agent-runtime.ts handleRequest` for every literal path the host serves today. `/health` and `/wait-idle` are NOT in the production codebase and are not reserved.
2. **Promotion-time (in a new `validateBundleRoutesAgainstKnownRoutes` host helper, called from `BundleRegistry.setActive`)** — pass the host's currently-resolved static `httpHandlers` paths and reject promotion if any bundle-declared path collides with a static one. Returns `ERR_HTTP_ROUTE_COLLISION`. Pointer NOT flipped on collision.
3. **Dispatch-time (in `validateRoutesCached`, sibling to `validateCatalogCached`)** — same check, runs on first dispatch after a pointer change. On mismatch, `disableForRouteCollision` clears the pointer with `skipCatalogCheck: true` and broadcasts `bundle_disabled` with structured reason.

**Action ids reserved list:**
- **Built-in dispatch ids** (rejected at build time): `agent-config`, `schedules`, `queue`.
- **Host-registered capability ids** (rejected at promotion + dispatch): every id present in `getResolvedCapabilityIds()`. This catches the case where bundle declares `BundleCapability { id: "tavily-web-search", onAction }` but the host already has the static `tavily-web-search` capability with its own `onAction`. Without this guard the static `onAction` always wins (resolved-handler check fires first) and the bundle's never sees traffic — a silent footgun.

**Rationale.** Build-time catches the obvious mistakes without needing a host. Promotion-time and dispatch-time mirror the catalog-mismatch flow. Three layers because: build is environment-agnostic, promotion is environment-aware but cross-deployment promotions skip it (matches `skipCatalogCheck`), dispatch handles cold-start with stale pointers + out-of-band registry writes.

**Alternative rejected.** "Force all bundle routes under `/bundle-cap/{capId}/...`". Violates the partial-functional-parity goal — `tavily-web-search` consumed statically mounts at the path the capability author chose, and a bundle declaring it should mount at the same path. Forcing a `/bundle-cap/` prefix would surface a different URL depending on how the capability is wired.

### Decision 3 — Request/response serialization is JSON, body is base64 when binary, default cap 256 KiB

**Context.** Worker Loader `getEntrypoint().fetch(req)` does serialize across the isolate boundary. The host needs to round-trip method/path/headers/body and pull back status/headers/body, with stable semantics across the isolate boundary including for binary payloads.

**Decision.** Serialize to a JSON envelope at the host edge, deserialize inside the bundle SDK, same in reverse for the response. Envelope shape:

```ts
// Host → bundle
POST /http
{
  capabilityId: "skills",
  method: "POST",
  path: "/skills/registry",
  query: { foo: "bar" },
  headers: { "content-type": "..." },
  bodyBase64: "..." | null,
  sessionId: "..." | null
}

// Bundle → host
{
  status: 200,
  headers: { "content-type": "..." },
  bodyBase64: "..." | null
}
```

Body cap enforced host-side. **Default `BundleConfig.maxRequestBodyBytes = 262_144` (256 KiB). Configurable up to 1 MiB.** Sized for typical webhook payloads (Telegram updates, OAuth callbacks, GitHub webhooks all fit comfortably) plus the JSON+base64 envelope overhead (~3-4× original-body in transient memory). 1 MiB hard cap because workerd's structured-clone payload limit between isolates is documented as "best-effort up to 32 MiB but unreliable past a few MiB"; staying conservative protects against unexpected workerd version drift. Larger bodies belong on direct-to-R2 presigned URLs, not bundle-routed dispatch.

Requests over cap return `413 Payload Too Large` with body `{"error":"...","cap":262144,"received":...}` from the host without dispatching.

**Rationale.** Base64 keeps the envelope JSON-safe across the structured-clone boundary. Body cap default chosen by surveying real webhook payload sizes (Telegram bot webhook: ~2 KiB, GitHub Issue webhook: ~30 KiB, OAuth code-exchange: <1 KiB) and adding margin. Streaming is out of scope for v1 (Non-Goal); buffering is the simplest correct semantic.

**Alternative rejected.** "Pass the live `Request` object directly." Cross-isolate body streaming has been a workerd footgun. Buffering once is debuggable.

**Alternative rejected.** "Use a binary protobuf envelope." 1.33× base64 overhead is dwarfed by Worker Loader cold-start. Not worth the second protocol.

### Decision 4 — Dispatch ordering: host-static > bundle-declared > 404

**Context.** Bundle is opt-in extension. If both a static capability and a bundle declare the same path, who wins?

**Decision.** Host static handlers always match first. Build-time and promotion-time validation prevent the obvious collisions; the dispatch-time guard handles the residual case (newly-deployed static cap shadows an already-promoted bundle, or out-of-band registry writes).

In `agent-runtime.ts handleRequest`, the new `bundleHttpDispatcher` slot is invoked **after** `matchHttpHandler` returns null and **before** the final 404. Same ordering for actions in `handleCapabilityAction`: resolved static onAction → host built-in switch → bundle dispatcher → warn-log default.

**Rationale.** Static is the safer default because a static handler is testable in isolation and shipped with the host code. Bundle dispatch failures must always fall back to a sensible host behavior — never to "request silently goes to the wrong place".

### Decision 5 — `onAction` dispatcher install pattern mirrors `bundleAlarmHandler`

**Context.** `handleCapabilityAction` is in `AgentRuntime`, not in `AgentDO`. The bundle dispatcher lives in `AgentDO.initBundleDispatch` and writes handlers onto `runtime.bundleAlarmHandler`, etc. Adding bundle action dispatch follows the same shape.

**Decision.** Install `runtime.bundleActionDispatcher?: (capabilityId, action, data, sessionId) => Promise<boolean>` from `initBundleDispatch`. Returns `true` when the bundle owned and handled the action (host stops); returns `false` when the bundle did not declare this `capabilityId` OR the dispatch errored OR the bundle's `onAction` returned a `noop` status (host falls through). No race: `initBundleDispatch` runs in the AgentDO constructor synchronously before the first message can be dispatched.

`handleCapabilityAction` checks `bundleActionDispatcher` AFTER the resolved-static-handler check AND AFTER the host built-in switch (`agent-config`, `schedules`, `queue`). The host built-in switch handlers cannot be shadowed because the build-time validator already rejects those ids; the resolved-static-handler check cannot be shadowed because the promotion-time validator (extended in this change) rejects bundle action ids that collide with host capability ids. Three layers of defense: build-time (static ids), promotion-time (host-registered ids), dispatch-time (deployment-state-aware).

### Decision 6 — Bundle-side context is partial parity with `Capability*Context` (honest)

**Context.** Static `CapabilityHttpContext` (`capabilities/types.ts:300-359`) has 12+ fields including `sessionStore` (raw access), `storage` (raw `CapabilityStorage`), `agentConfig`, `rateLimit` (the shared `RateLimiter`), `publicUrl`, `broadcastToAll`, `broadcastState`, `sendPrompt`, `params`. Static `CapabilityHookContext` (the shape onAction receives) has `sessionStore`, `storage`, `capabilityIds`, `publicUrl`, `agentConfig`, `broadcast`, `broadcastState`, `emitCost`.

Decision 8 in the previous draft punted on the parity claim. This decision lands an honest mapping.

**Decision.** v1 `BundleHttpContext`:

```ts
interface BundleHttpContext {
  capabilityId: string;
  agentId: string;
  sessionId: string | null;        // null for session-less HTTP routes
  publicUrl?: string;              // mirrors CapabilityHttpContext.publicUrl — required for webhook capabilities per CLAUDE.md
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>; // request headers, lowercased keys
  kvStore: BundleKvStoreClient;
  channel: BundleSessionChannel;   // broadcast / broadcastGlobal — broadcast is no-op when sessionId is null
  emitCost: (cost: BundleCostEvent) => Promise<void>;
}
```

v1 `BundleActionContext`:

```ts
interface BundleActionContext {
  capabilityId: string;
  agentId: string;
  sessionId: string;
  publicUrl?: string;
  kvStore: BundleKvStoreClient;
  channel: BundleSessionChannel;
  spine: BundleSpineClientLifecycle;
  emitCost: (cost: BundleCostEvent) => Promise<void>;
}
```

Documented parity gaps (NOT in v1):
- `sessionStore` raw access. Bundle uses spine `appendEntry`/`getEntries`/`buildContext` for the read paths it needs. Raw `SessionStore` is heavy and rarely needed.
- `rateLimit`. The shared `RateLimiter` enforces an atomicity contract that doesn't trivially proxy across the isolate boundary. Bundle authors who need rate limiting in v1 must implement it locally.
- `agentConfig`. Out of scope until `bundle-config-namespaces` lands.
- `sendPrompt`. See Decision 11.

**Rationale.** `publicUrl` and `emitCost` are non-negotiable — `publicUrl` because CLAUDE.md mandates webhook capabilities read it (rather than accept it as an option), and `emitCost` because cost tracking is a documented per-capability contract. The other fields can be added in follow-ups without breaking v1 contracts. Parity claim restricted to "the same surface for the fields exposed".

### Decision 7 — Validation for `onAction.capabilityId` ties to `BundleCapability.id`

**Context.** Static `onAction` is a method on `Capability` keyed by the capability's own `id`. Bundle equivalent could be free-form (bundle author picks any string) or constrained to declared `BundleCapability.id`s.

**Decision.** Constrained. `defineBundleAgent` walks the probe-env capability list, collects each `BundleCapability.id` for which `onAction` is defined, and emits those into `actionCapabilityIds`. Build-time validation rejects an `onAction` declared on a `BundleCapability` whose `id` is in the reserved list (`agent-config`, `schedules`, `queue`).

**Rationale.** A capability is the natural ownership unit; allowing free-form ids would let two bundle capabilities both claim `"foo"` actions and create routing ambiguity. Build-time validation matches static behavior — `onAction` on `Capability { id: "tavily" }` answers `capability_action { capabilityId: "tavily" }`.

### Decision 8 — Token scope reuses existing `__BUNDLE_TOKEN`; no new scope strings

**Context.** Bundle SDK already mints the unified `__BUNDLE_TOKEN` per dispatch with scope `["spine", "llm", ...catalogIds]`. The new `/http` and `/action` endpoints need a token check too.

**Decision.** The `/http` and `/action` SDK endpoint handlers verify `__BUNDLE_TOKEN` (presence + signature, same way `/turn` and lifecycle endpoints do). They do NOT add new scope strings to the token. The routing decision already happened host-side via metadata; the bundle's job is to find the matching declared `BundleCapability` and invoke its handler. The bundle SDK keys lookup by the `capabilityId` field on the envelope and calls the matching capability's `httpHandlers` factory result — no separate scope check is meaningful because the check would be "does the bundle declare this capabilityId" which is answered structurally by the resolved capability list.

**Rationale.** Scope strings exist to gate spine RPCs that cross the SpineService trust boundary. `/http` and `/action` do not cross that boundary — they're inside the bundle isolate's own surface. Doubling the token footprint per dispatch without raising the security bar is gratuitous.

### Decision 9 — `validateAuth` runs ONCE at the host fetch boundary; bundle dispatch installs into the post-auth chain

**Context.** Static `httpHandlers` resolve at `agent-runtime.ts:1250`, which is **after** `validateAuth` runs at line 1121. The previous draft of this design said "bundle dispatch happens after validateAuth" but proposed installing it onto `preFetchHandler`, which actually runs **before** `validateAuth` in `handleRequest`. The two statements were contradictory; the install-onto-preFetch path would have silently bypassed auth.

**Decision.** Bundle HTTP dispatch is NOT installed onto `preFetchHandler`. Instead:

1. `initBundleDispatch` installs `runtime.bundleHttpDispatcher?: (request, sessionId) => Promise<Response | null>`.
2. `agent-runtime.ts handleRequest` is modified to call `bundleHttpDispatcher` after `matchHttpHandler` returns null and before the final 404. By that point `validateAuth` has already run; bundle routes inherit the same auth gate as static routes.
3. `preFetchHandler` continues to host the existing `/bundle/disable` and `/bundle/refresh` admin paths. `/bundle/disable` self-auths (it has to — preFetch runs before `validateAuth`); `/bundle/refresh` does not (existing behavior, called out in `m4` of the review).

**Tightening (taken from review m4):** as part of this change, add the same self-auth pattern from `/bundle/disable` to `/bundle/refresh`. Without it, an unauthenticated caller can force a registry round-trip on every request. Low blast radius (it's a read), but no reason to leave the gap open while we're touching the file.

**Rationale.** Single auth boundary, no surprise difference between static and bundle HTTP. Bundle author who wants per-route gates handles them in-bundle reading headers from the envelope.

### Decision 10 — One bundle isolate dispatch per request; no batching, no caching

**Context.** Could the host coalesce multiple in-flight bundle HTTP requests into a single isolate spinup? In principle yes; in practice no — Worker Loader is per-version and the request-queue model is invocation-per-request.

**Decision.** Each matched bundle HTTP request and each matched bundle action triggers exactly one bundle isolate fetch. No batching, no caching of responses (bundle author's job — they have access to `kvStore`). Cold-start cost is paid per dispatch; warm-loader cost is paid per dispatch.

### Decision 11 — `sendPrompt` is cut from v1

**Context.** Static `CapabilityHttpContext.sendPrompt(opts)` calls `ensureAgent`, runs `agent.prompt`, awaits `waitForIdle`, walks the session for the assistant text, returns it. There is no spine RPC for this today. To add it for bundles requires:

- A new `SpineHost.spineHandleAgentPrompt` method on `AgentRuntime`.
- A `SpineService` wrapper with `requiredScope` (likely a new scope, e.g. `"prompt-injection"`).
- A new budget category — this is reentrancy: bundle HTTP route → `sendPrompt` → new turn → that turn dispatches back into the bundle → bundle route again. Without a hard recursion cap, an HTTP-route-triggered turn can `sendPrompt` itself into an infinite loop.
- A `SpineCaller` identity model for the new turn (current contract is one nonce per turn; this would be a turn dispatched on behalf of an HTTP request, not a normal user turn).
- A security review of HTTP-route-driven prompt injection bypassing the host's normal entry points (`/prompt` and channels).

**Decision.** Cut `sendPrompt` from v1 `BundleHttpContext` and `BundleActionContext`. Document the workaround in the bundle authoring guide:

- For webhook → inference flows, the bundle handler returns the prompt text in the response body and the upstream caller (the channel that delivered the webhook) routes it through the host's existing `/prompt` endpoint or `sendPrompt` from the channel's own static `httpHandlers`. This is how `channel-telegram` works today.
- For UI-action → inference flows, the action handler can append a session entry via `spine.appendEntry` and rely on the existing transport to route the next turn. Or the action can `broadcast` a state event the client interprets, then the client triggers the prompt.

This is an honest scope cut. The `sendPrompt` work needs its own proposal where the spine RPC, scope, budget, reentrancy guard, and security review can each get the attention they deserve. Doing it as a one-bullet task in this proposal would have been wrong.

**Rationale.** The proposal's review caught this as load-bearing-but-hand-waved (C2). Better to ship without it than to ship with a thin implementation.

### Decision 12 — Telemetry: every dispatch path emits structured `[BundleDispatch]` logs

**Context.** Operators need to answer "is bundle HTTP traffic flowing?" and "did the bundle author's route ever match?" from production logs.

**Decision.** Log lines emitted at:

- `[BundleDispatch] /http hit` with `{ agentId, capabilityId, method, path, status, durationMs }` on every successful HTTP dispatch.
- `[BundleDispatch] /http miss-no-bundle` with `{ method, path }` when the dispatcher was called but no active bundle is set (cheap, helps explain cold-start 404s).
- `[BundleDispatch] /http body-cap exceeded` with `{ method, path, received, cap }` on 413.
- `[BundleDispatch] /http timeout` with `{ method, path, timeoutMs }` on 504.
- `[BundleDispatch] /action hit` with `{ agentId, capabilityId, action, sessionId, status }`.
- `[BundleDispatch] /action no-onAction` with `{ capabilityId, action }` when the bundle returns `noop`.
- `[BundleDispatch] route-collision-disable` with `{ versionId, collisions }` when `disableForRouteCollision` fires.
- `[BundleDispatch] action-id-collision-disable` with `{ versionId, collidingIds }` when the action-id guard fires.

These pair with the broadcast `bundle_disabled` events for the disable paths, so both server logs and connected clients see the same diagnostic.

## Risks / Trade-offs

- **[Cold-start cost on first HTTP / action dispatch]** → Same as the existing `/turn` path — Worker Loader caches by version id. Document the cost in the bundle authoring guide; operators who care keep their bundles small.

- **[Probe-env metadata extraction misses runtime-conditional routes]** → Documented as "metadata is source of truth — runtime-conditional routes that aren't in metadata won't dispatch." Same constraint already applies to `requiredCapabilities`. Bundle authors can declare all conditional routes and short-circuit inside the handler. `BundleMetadataExtractionError` surfaces probe-env-access failures with the offending capability id.

- **[Route collision between newly-deployed static cap and already-promoted bundle]** → Dispatch-time guard fires `ERR_HTTP_ROUTE_COLLISION` (or `ERR_ACTION_ID_COLLISION`), clears the pointer, broadcasts `bundle_disabled` with structured reason. Operator re-promotes after resolving. Same pattern as `ERR_CAPABILITY_MISMATCH`.

- **[256 KiB body cap is too low for some legitimate use cases (file upload through bundle endpoint)]** → Configurable via `BundleConfig.maxRequestBodyBytes` up to 1 MiB. Document the cap, the override knob, and "for larger payloads use direct-to-R2 presigned URLs from the bundle, not bundle-routed bodies".

- **[Bundle handler hangs and blocks the original requester]** → Per-dispatch timeout (`BundleConfig.httpDispatchTimeoutMs`, default 30 000 ms). Timeout returns `504 Gateway Timeout` from the host and logs the event.

- **[Two bundle capabilities each declare the same path]** → `defineBundleAgent` rejects at build time via `validateHttpRoutes` (collision on `${method}:${path}`).

- **[`onAction` from UI fires for a bundle that isn't currently active]** → Bundle dispatch path respects `checkActiveBundle()` like `dispatchLifecycle` does. Inactive bundle short-circuits to `false` and the host falls through to the warn-log default.

- **[Functional-parity drift over time]** → Parity test in tasks.md (consume `tavily-web-search` both ways, assert identical surface for the v1 context fields) becomes a regression gate. Add to CI alongside the existing bundle integration tests.

- **[Bundle author wants `sendPrompt` and we cut it]** → Documented workaround in bundle authoring guide (return prompt to upstream caller; channel-telegram pattern). When the dedicated `sendPrompt` proposal lands, bundles can opt into the new field.

- **[Bundle author wants streaming responses for an LLM-proxy use case]** → Documented workaround: return 202 + job id, write streamed output via `channel.broadcast`. This mirrors how the host's existing `/turn` SSE works. Streaming responses can be added in a follow-up if real demand surfaces.
