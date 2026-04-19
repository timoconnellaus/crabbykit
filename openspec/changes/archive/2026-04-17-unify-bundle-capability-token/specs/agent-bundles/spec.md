## MODIFIED Requirements

<!-- Section: Bundle env projection -->

### Requirement: Host SHALL project the bundle env with exactly one token field

The bundle env projected via `BundleConfig.bundleEnv(env)` SHALL be augmented by the dispatcher with a single `__BUNDLE_TOKEN: string` field carrying the per-turn unified capability token. The dispatcher SHALL NOT inject any other token-carrying env field.

Previously-reserved token env fields (`__SPINE_TOKEN`, `__LLM_TOKEN`, `__TAVILY_TOKEN`) SHALL NOT appear in the projected env. Both the reference `BundleDispatcher` (in `@crabbykit/bundle-host`) and the production inline dispatch closure (in `@crabbykit/agent-runtime`'s `AgentDO._initBundleDispatch`) SHALL follow this shape identically.

#### Scenario: Turn dispatch env has single token field
- **WHEN** a bundle turn dispatches via `bundlePromptHandler`
- **THEN** the env passed to `WorkerLoader.get(...)`'s factory contains `__BUNDLE_TOKEN: <string>` and none of `__SPINE_TOKEN`, `__LLM_TOKEN`, `__TAVILY_TOKEN`

#### Scenario: Client event dispatch env has single token field
- **WHEN** a steer or abort event dispatches via `bundleClientEventHandler`
- **THEN** the env follows the same single-token shape as the turn dispatch

#### Scenario: `bundleEnv` factory results are preserved
- **WHEN** the host declares `bundleEnv: (env) => ({ LLM: env.LLM_SERVICE, SPINE: env.SPINE_SERVICE, TAVILY: env.TAVILY_SERVICE })`
- **THEN** the projected env contains `{ LLM, SPINE, TAVILY, __BUNDLE_TOKEN }` — the factory's fields plus the single token slot

<!-- Section: Mint call shape -->

### Requirement: Dispatcher SHALL mint exactly one token per turn with catalog-derived scope

For each turn or client event, both dispatch paths SHALL call `mintToken` exactly once. The `scope` argument SHALL be computed as `["spine", "llm", ...validatedCatalogIds]`, where `validatedCatalogIds` is the list of `requiredCapabilities[].id` values from the bundle version's metadata that has already passed the dispatch-time catalog guard (per `define-bundle-capability-catalog`).

Dispatchers SHALL NOT mint multiple tokens, SHALL NOT mint per-service variants, SHALL NOT mint additional tokens for capability clients. The single minted token is the authoritative credential for every service call the bundle makes during the turn.

#### Scenario: Single mint per turn
- **WHEN** `bundlePromptHandler` runs for a turn
- **THEN** exactly one call to `mintToken` is made; the returned token is placed in `env.__BUNDLE_TOKEN`

#### Scenario: Scope derives from validated catalog
- **WHEN** the bundle's active version declares `requiredCapabilities: [{ id: "tavily-web-search" }]`
- **AND** the catalog has been validated successfully before the mint call
- **THEN** the mint's `scope` argument equals `["spine", "llm", "tavily-web-search"]` in declaration order

#### Scenario: Empty catalog produces minimal scope
- **WHEN** the bundle's active version has `requiredCapabilities: undefined` or `[]`
- **THEN** the mint's `scope` argument equals `["spine", "llm"]`

#### Scenario: Catalog validation failure short-circuits mint
- **WHEN** the dispatch-time catalog guard fails for a bundle version (e.g. missing host capability id)
- **THEN** the dispatcher does NOT call `mintToken`
- **AND** the env passed to the Worker Loader factory does NOT contain `__BUNDLE_TOKEN`
- **AND** the bundle isolate is not instantiated for this turn; the turn falls back to the static brain

#### Scenario: Catalog validation failure broadcasts structured reason without minting
- **WHEN** the catalog guard fails at dispatch time
- **THEN** the dispatcher broadcasts `bundle_disabled` with structured `reason.code = "ERR_CAPABILITY_MISMATCH"` and `missingIds`
- **AND** no token is minted, no env projection occurs, and no RPC to SpineService/LlmService/TavilyService is issued on behalf of the bundle

## REMOVED Requirements

<!-- Section: Per-service token env fields (removed) -->

### Requirement: Host SHALL inject per-service capability tokens into reserved bundle env fields

**Reason:** Replaced by the unified `__BUNDLE_TOKEN` env field — see the `bundle-capability-token` capability spec. The per-service token pattern (`__SPINE_TOKEN` + `__LLM_TOKEN` + `__TAVILY_TOKEN`) is removed in favor of a single token carrying an explicit scope array.

**Migration:** Capability client subpaths that read any of the removed env fields SHALL be updated to read `env.__BUNDLE_TOKEN`. The Tavily capability's `src/client.ts` is updated as part of this change; future shape-2 capabilities follow the same single-field pattern.

<!-- Section: Per-service HKDF subkey labels (removed) -->

### Requirement: Host SHALL derive per-service HKDF subkeys with distinct labels

**Reason:** Replaced by the unified `claw/bundle-v1` HKDF label — see the `bundle-capability-token` capability spec. Domain separation between services is preserved by per-service `requiredScope` checks on the token's `scope` payload field, not by separate HKDF subkeys.

**Migration:** Every `deriveMintSubkey` and `deriveVerifyOnlySubkey` call site passes the single `BUNDLE_SUBKEY_LABEL` constant. The former per-service constants (`SPINE_SUBKEY_LABEL`, `LLM_SUBKEY_LABEL`, and the intended-but-never-wired Tavily variant) are deleted.
