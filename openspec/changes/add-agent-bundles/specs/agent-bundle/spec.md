## ADDED Requirements

### Requirement: Bundle authoring API

The system SHALL provide a `defineAgentBundle<BundleEnv>(setup)` function exported from `@claw-for-cloudflare/agent-runtime/bundle` that accepts a bundle setup object with the same declarative shape as `defineAgent()` minus DO-specific fields (no `getConfig`, `getSubagentProfiles`, `validateAuth`, WebSocket lifecycle overrides, `a2a.getAgentStub`, or `getCommands`). The function SHALL return a bundle descriptor object whose default export is callable by the loader host as a fetch handler discriminating on URL path.

#### Scenario: Minimal bundle authoring
- **WHEN** a developer writes `export default defineAgentBundle({ model: () => ({ provider: "workers-ai", modelId: "@cf/meta/llama-3.1-8b-instruct" }), prompt: { agentName: "Hello" } })`
- **THEN** the compiled bundle loads successfully in a Worker Loader isolate and produces an agent that answers prompts using the declared model

#### Scenario: Bundle with tools and capabilities
- **WHEN** a bundle declares `tools: () => [defineTool({ name: "x", ... })]` and `capabilities: (env) => [compactionSummary({ ... })]`
- **THEN** the runtime running inside the loader isolate executes the tool closures in-process and the capability lifecycle hooks are invoked in registration order

### Requirement: Restricted bundle env type

The bundle-authoring subpath SHALL export a `BundleEnv` marker/constraint type that excludes Cloudflare native binding types (`Ai`, `R2Bucket`, `DurableObjectNamespace`, `WorkerLoader`, `VectorizeIndex`, `D1Database`). Only `Service<T>` service bindings and structurally-serializable values (strings, numbers, booleans, plain objects) SHALL be assignable to a `BundleEnv` constraint. TypeScript compilation of a bundle attempting to declare a native binding in its env type SHALL fail. The runtime-projected env additionally includes `__SPINE_TOKEN: string` injected by the loader agent DO; this field SHALL be hidden from the `BundleEnv` constraint type so authors do not interact with it directly.

#### Scenario: Service binding allowed
- **WHEN** a bundle declares `interface BundleEnv { LLM: Service<LlmService>; TIMEZONE: string }`
- **THEN** the bundle type-checks and runs with `env.LLM` and `env.TIMEZONE` accessible

#### Scenario: Native binding rejected at compile time
- **WHEN** a bundle declares `interface BundleEnv { AI: Ai }` and compiles with the bundle tsconfig
- **THEN** TypeScript emits a type error identifying `Ai` as not assignable to the `BundleEnv` constraint

#### Scenario: Token injected but hidden from authoring type
- **WHEN** a bundle's runtime accesses `env.__SPINE_TOKEN` at runtime
- **THEN** the value is the host-minted capability token, but the `BundleEnv` constraint type does not declare this field, encouraging authors to let the runtime adapters consume it rather than touch it directly

### Requirement: Secret-free bundle model declaration

A bundle's `model` function SHALL NOT accept an `apiKey` field. Provider credentials SHALL be resolved host-side via `LlmService`. Bundles declare only `{ provider, modelId, inferenceParameters }` and the runtime routes inference through a host-provided LLM service via service binding.

#### Scenario: Bundle declares model without key
- **WHEN** a bundle declares `model: () => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" })`
- **THEN** the bundle type-checks, loads, and inference calls are routed through `env.LLM_SERVICE` without ever exposing the OpenRouter API key to bundle-side code

#### Scenario: Bundle attempts to declare apiKey
- **WHEN** a bundle declares `model: (env) => ({ provider: "openrouter", modelId: "...", apiKey: "sk-..." })`
- **THEN** TypeScript rejects the `apiKey` field at compile time

### Requirement: Bundle default export contract

A compiled bundle's default export SHALL be a fetch handler that discriminates on URL path:
- `POST /turn` — handle a prompt turn; body includes the prompt and any inputs
- `POST /alarm` — handle an alarm fire; body includes the alarm payload
- `POST /client-message` — handle an incoming WebSocket message routed from the host DO's transport layer
- `POST /tool-execute-smoke` — minimal smoke test invocation used by `bundle_deploy` pre-deploy verification
- `POST /metadata` — return the bundle's declared metadata for registry storage

The fetch handler SHALL construct an `AgentRuntime` (lazily, per invocation if needed) with spine-backed adapter clients reading the capability token from `env.__SPINE_TOKEN`, then dispatch to the appropriate runtime method based on the URL path. The contract SHALL be documented in `@claw-for-cloudflare/agent-runtime/bundle` type exports.

#### Scenario: Host invokes loaded bundle for a turn
- **WHEN** the loader host loads a bundle and calls `worker.getEntrypoint().fetch(new Request("https://bundle/turn", {method: "POST", body: JSON.stringify({prompt})}))`
- **THEN** the bundle constructs an `AgentRuntime` with spine-backed adapters using `env.__SPINE_TOKEN`, runs the turn to completion, and returns the response

#### Scenario: Smoke test endpoint responds without state
- **WHEN** the workshop calls `POST /tool-execute-smoke` against a candidate bundle in a scratch loader isolate
- **THEN** the bundle returns a well-formed response indicating the bundle loads and dispatches correctly, without requiring access to a real session store

#### Scenario: Metadata endpoint returns declared identity
- **WHEN** the workshop calls `POST /metadata` after building a candidate bundle
- **THEN** the bundle returns the JSON metadata object declared in `defineAgentBundle({ metadata: {...} })` (or an empty object if metadata was not declared)

### Requirement: Optional metadata declaration

`defineAgentBundle` SHALL accept an optional `metadata` field whose value is a JSON-serializable object describing the bundle: `{ name?, description?, capabilities?: string[], authoredBy?, version? }`. The metadata SHALL be accessible via the bundle's `POST /metadata` endpoint and SHALL be persisted in the registry by `bundle_deploy`.

#### Scenario: Metadata round-trips through registry
- **WHEN** a bundle declares `metadata: { name: "Archivist", description: "research assistant" }`
- **THEN** after deploy, `registry.getVersion(versionId).metadata` returns the same JSON object

### Requirement: Bundle subpath export boundary

The `@claw-for-cloudflare/agent-runtime/bundle` subpath export SHALL NOT re-export any type or value whose use requires access to a Cloudflare native binding or DO context. Attempting to import `AgentDO`, `defineAgent`, or CF-specific types from the bundle subpath SHALL fail at the module resolution level. The package's `exports` field SHALL physically enforce this separation.

#### Scenario: DO-specific import blocked from bundle
- **WHEN** a bundle file imports `AgentDO` from `@claw-for-cloudflare/agent-runtime/bundle`
- **THEN** TypeScript/bundler resolution fails because the symbol is not exported from that subpath

### Requirement: Bundle-side capability hook restriction

Capabilities consumed by a bundle SHALL be authored against the bundle-side capability interface, which permits `tools`, `promptSections`, `beforeInference`, `beforeToolExecution`, and `afterToolExecution` hooks. Hooks SHALL be plain async functions; they execute inside the loader isolate and have direct access to the bundle's local state. Capability factories that hold secrets or require host-side execution SHALL NOT be importable into a bundle — they must be rewritten as `client.ts` factories that proxy through a service binding (per the capability service pattern).

#### Scenario: Bundle uses a client capability
- **WHEN** a bundle imports `tavilyWebSearchClient` from `@claw-for-cloudflare/tavily-web-search/client` and instantiates it with `env.TAVILY`
- **THEN** the resulting capability's tools are available to the bundle's `AgentRuntime` and execute via RPC to the host-side `TavilyService`

#### Scenario: Bundle attempts to import a service-side capability
- **WHEN** a bundle imports `TavilyService` from `@claw-for-cloudflare/tavily-web-search/service`
- **THEN** the import either fails at module resolution (because `service` subpath is not in the bundle's allowed import set) or fails at type-check (because `WorkerEntrypoint` is not assignable inside a bundle)
