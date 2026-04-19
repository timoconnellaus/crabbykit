## ADDED Requirements

<!-- Section: Package layout -->

### Requirement: `@crabbykit/skills` SHALL expose four subpaths

The package `@crabbykit/skills` SHALL expose its public API via four `package.json` `exports` entries: `.` (legacy static factory), `./service` (host-side `WorkerEntrypoint`), `./client` (bundle-side capability factory), and `./schemas` (shared TypeBox schemas + drift hash).

The legacy `.` export SHALL preserve the existing `skills(options: SkillsOptions): Capability` factory unchanged. Static-brain consumers SHALL continue to wire the package via `import { skills } from "@crabbykit/skills"`.

#### Scenario: Package exports map lists four subpaths
- **WHEN** `package.json` is read
- **THEN** the `exports` object contains exactly the keys `"."`, `"./service"`, `"./client"`, `"./schemas"`

#### Scenario: Legacy import still resolves to the static capability factory
- **WHEN** a consumer imports `{ skills }` from `@crabbykit/skills`
- **THEN** the function returned matches the pre-change `skills` factory signature and behavior

<!-- Section: Service entrypoint -->

### Requirement: `SkillsService` SHALL verify the unified bundle token with `requiredScope: "skills"`

The `WorkerEntrypoint` exported from `@crabbykit/skills/service` SHALL be a class named `SkillsService`. It SHALL accept a service env with the following fields: `AGENT_AUTH_KEY: string` (master HMAC secret), `SKILL_REGISTRY: D1Database` (or equivalent registry binding), `STORAGE_BUCKET: R2Bucket`, `STORAGE_NAMESPACE: string` (R2 prefix for the agent's namespace), and `SPINE: Fetcher & { ... }` (host spine binding).

`SkillsService` SHALL lazily derive a verify-only HKDF subkey from `AGENT_AUTH_KEY` using the shared `BUNDLE_SUBKEY_LABEL` (`"claw/bundle-v1"`) on first call and cache it for the lifetime of the entrypoint instance. Every RPC method on `SkillsService` SHALL call `verifyToken(token, subkey, { requiredScope: "skills" })` before doing any other work and SHALL throw `new Error(verifyResult.code)` when verification fails (codes include `ERR_SCOPE_DENIED`, `ERR_EXPIRED`, `ERR_INVALID_TOKEN`).

#### Scenario: Subkey derivation is lazy and cached
- **WHEN** `SkillsService` receives its first RPC call
- **THEN** it calls `deriveVerifyOnlySubkey(env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL)` exactly once
- **AND** subsequent calls reuse the cached subkey without re-derivation

#### Scenario: Token without "skills" scope is rejected
- **WHEN** an RPC method is called with a `__BUNDLE_TOKEN` whose `scope` array does NOT contain `"skills"`
- **THEN** the method throws an Error whose message equals `ERR_SCOPE_DENIED`
- **AND** the method does not perform any registry lookup or R2 read

#### Scenario: Missing `AGENT_AUTH_KEY` in env is a misconfiguration error
- **WHEN** `SkillsService` is instantiated against an env without `AGENT_AUTH_KEY`
- **AND** receives an RPC call that triggers subkey derivation
- **THEN** the call throws an Error indicating the service is misconfigured

<!-- Section: load method -->

### Requirement: `SkillsService.load` SHALL return frontmatter-stripped skill content for an installed, enabled skill

`SkillsService` SHALL expose a method `load(token: string, args: { name: string }, schemaHash?: string): Promise<{ content: string }>`. After successful token verification, the method SHALL:

1. Validate `schemaHash` matches the service's `SCHEMA_CONTENT_HASH` (throw `ERR_SCHEMA_VERSION` on mismatch).
2. Look up the installed-skill record for `args.name` (returning `null` when not found, lookup mechanism implementation-defined per design.md Decision/Risk on R2-vs-storage).
3. Reject with a non-thrown text response when the skill is not installed or not enabled.
4. Read the skill content from R2 at the namespaced key.
5. Strip YAML frontmatter (the leading `---\n...\n---\n` block) from the content.
6. Return `{ content: <stripped content> }`.

#### Scenario: Schema hash mismatch fails closed
- **WHEN** `load` is called with a `schemaHash` that does not equal `SCHEMA_CONTENT_HASH`
- **THEN** the method throws an Error whose message equals `ERR_SCHEMA_VERSION`

#### Scenario: Unknown skill returns a textual not-found response
- **WHEN** `load` is called with a `name` that does not correspond to any installed skill
- **THEN** the method returns `{ content: "Skill 'X' not found" }` (or equivalent text indicating absence)
- **AND** the method does not throw

#### Scenario: Disabled skill returns a textual not-enabled response
- **WHEN** `load` is called with a `name` that is installed but disabled
- **THEN** the method returns text indicating the skill is not enabled
- **AND** the method does not throw

#### Scenario: Enabled skill returns frontmatter-stripped content
- **WHEN** `load` is called with the name of an installed, enabled skill whose R2 content begins with `---\nname: foo\n---\n# Body`
- **THEN** the method returns `{ content: "# Body" }`

<!-- Section: Bundle client -->

### Requirement: `skillsClient` factory SHALL return a `Capability` exposing the `skill_load` tool that proxies to the service

The function exported from `@crabbykit/skills/client` SHALL be `skillsClient(options: { service: Service<SkillsService> }): Capability`. The returned capability SHALL have `id: "skills"`, SHALL register a single tool named `skill_load`, and SHALL NOT register any lifecycle hooks, `httpHandlers`, `configNamespaces`, `onAction`, or `promptSections`.

The `skill_load` tool's `execute` function SHALL read `env.__BUNDLE_TOKEN` from the agent context, throw an Error containing the literal `"Missing __BUNDLE_TOKEN"` when undefined, and call `options.service.load(token, args, SCHEMA_CONTENT_HASH)` with the verified token + the bundle's schema-hash constant. The tool SHALL surface the service's `{ content }` response as the tool result text and SHALL NOT post-process the content.

#### Scenario: Capability id matches the catalog scope string
- **WHEN** `skillsClient(...)` is invoked
- **THEN** the returned capability's `id` is the literal string `"skills"`

#### Scenario: Bundle without `__BUNDLE_TOKEN` env field fails fast
- **WHEN** the `skill_load` tool is executed in a context whose `env.__BUNDLE_TOKEN` is undefined
- **THEN** the tool throws an Error containing `Missing __BUNDLE_TOKEN`

#### Scenario: Tool forwards the schema hash on every call
- **WHEN** `skill_load` is executed
- **THEN** `options.service.load` is called with three arguments: the token string, the user-supplied args object, and the constant `SCHEMA_CONTENT_HASH` from `@crabbykit/skills/schemas`

#### Scenario: Bundle client registers no host-only surfaces
- **WHEN** the returned capability is inspected
- **THEN** it has no `hooks`, no `httpHandlers`, no `configNamespaces`, no `onAction`, and no `promptSections` keys

<!-- Section: Shared schemas -->

### Requirement: `@crabbykit/skills/schemas` SHALL export tool-name, description, args schema, and a versioned content hash

The schemas subpath SHALL export named constants for the tool's name and description, a TypeBox `Type.Object(...)` args schema, and `SCHEMA_CONTENT_HASH: string`. The hash SHALL be a manually-maintained version string (initial value `"skills-schemas-v1"`) and SHALL be bumped only when the args schema changes in a way that would silently mistype older bundles against the newer host.

#### Scenario: Initial schema version constant
- **WHEN** the constant `SCHEMA_CONTENT_HASH` is read from `@crabbykit/skills/schemas`
- **THEN** its value is the string `"skills-schemas-v1"` until a future breaking schema change bumps it

#### Scenario: Args schema validates the `name` field
- **WHEN** the args schema is used to validate `{ name: "my-skill" }`
- **THEN** validation passes

#### Scenario: Args schema rejects missing name
- **WHEN** the args schema is used to validate `{}`
- **THEN** validation fails

<!-- Section: Static capability invariants under bundle wiring -->

### Requirement: Static `skills(...)` factory hooks SHALL remain host-side and unchanged

Wiring the bundle-side `skillsClient(...)` SHALL NOT alter, suppress, or duplicate any hook on the static `skills(...)` capability. The static capability's `onConnect` (registry sync), `beforeInference` (conflict injection), `afterToolExecution` (dirty tracking), `configNamespaces` (`skills` namespace), and `httpHandlers` (`/skills/registry`, `/skills/install`, `/skills/uninstall`) SHALL continue to fire on the host pipeline regardless of whether a bundle brain is also wired.

The bundle-side `skillsClient(...)` SHALL NOT mirror these hooks as no-ops. A consumer wiring both static `skills(...)` and bundle `skillsClient(...)` SHALL observe each hook firing exactly once (on the static capability), not twice.

#### Scenario: Hooks fire only on the static side under dual wiring
- **WHEN** a consumer wires both `skills({ ... })` in `defineAgent.capabilities` and `skillsClient({ service })` in `defineAgent.bundleCapabilities`
- **AND** an `onConnect` event fires
- **THEN** the static capability's `onConnect` runs exactly once
- **AND** no `onConnect` runs on the bundle client

#### Scenario: HTTP handlers remain on the host
- **WHEN** an HTTP request hits `/skills/registry` on a bundle-enabled agent
- **THEN** the static capability's handler responds
- **AND** the bundle isolate is not invoked for the request
