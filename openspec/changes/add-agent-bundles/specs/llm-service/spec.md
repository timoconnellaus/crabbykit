## ADDED Requirements

### Requirement: LlmService host-side proxy

The system SHALL provide an `LlmService` class extending `WorkerEntrypoint` that proxies LLM inference calls for multiple providers. The class SHALL hold provider credentials and the `AGENT_AUTH_KEY` HMAC secret in its own env (e.g., `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, plus the native `Ai` binding for Workers AI) and expose an `infer(token, request)` method that callers — including loader-loaded bundles — invoke via a service binding. The callers SHALL NOT have access to any provider credentials nor to the HMAC secret.

#### Scenario: Host registers LlmService
- **WHEN** a host worker exports `class LlmService extends WorkerEntrypoint` and declares a service binding `{ binding: "LLM_SERVICE", service: "host-worker", entrypoint: "LlmService" }`
- **THEN** bundles that receive `env.LLM_SERVICE` can call `env.LLM_SERVICE.infer(token, request)` via JSRPC

### Requirement: Per-turn capability token verification

`LlmService.infer(token, request)` SHALL take a sealed capability token as its first argument and verify it before any provider call. Verification SHALL reject invalid signatures, expired tokens, and (optionally) replayed nonces. Identity (agentId, sessionId) for budget enforcement, cost attribution, and audit SHALL be derived from the verified token payload — NOT from any field in `request`.

#### Scenario: Valid token allows inference
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(token, { provider: "openrouter", modelId: "...", messages: [...] })` with a valid token
- **THEN** the service verifies the token, derives the agentId/sessionId, calls the upstream provider, emits a cost event attributed to the verified session, and returns the inference result

#### Scenario: Bad token rejected before any provider call
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(badToken, ...)` with a token whose HMAC fails verification
- **THEN** the service returns `ERR_BAD_TOKEN` without making any upstream provider call and without exposing any provider credential or internal state

### Requirement: Multi-provider routing

`LlmService.infer(token, request)` SHALL accept a request object with at least `{ provider, modelId, messages, tools?, stream? }` and route the call to the appropriate provider based on the `provider` discriminator. Supported providers SHALL include at minimum `openrouter`, `anthropic`, `openai`, and `workers-ai`. Unknown providers SHALL return a structured error without leaking credential state.

#### Scenario: OpenRouter request routed to OpenRouter
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(token, { provider: "openrouter", modelId: "anthropic/claude-sonnet-4", messages: [...] })`
- **THEN** the service uses `this.env.OPENROUTER_API_KEY` to call the OpenRouter API and returns the response

#### Scenario: Workers AI request routed to native binding
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(token, { provider: "workers-ai", modelId: "@cf/meta/llama-3.1-8b-instruct", messages: [...] })`
- **THEN** the service uses `this.env.AI.run(...)` on the native Workers AI binding and returns the response

#### Scenario: Unknown provider returns structured error
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(token, { provider: "fake-provider", modelId: "...", messages: [...] })`
- **THEN** the service returns a structured error identifying the provider as unsupported, without any reference to other provider credentials, key names, or internal service state

### Requirement: Provider credential isolation

`LlmService` SHALL be the exclusive holder of provider API keys in a worker that uses loader-backed agents. Provider credentials SHALL NOT be exposed via `bundleEnv`, via return values from `infer()`, or via error messages or stack traces. Credential access SHALL be scoped to the `LlmService` class's own `this.env` and SHALL NOT be passed to any other class or function. All upstream provider responses, including error responses, SHALL be sanitized before being returned to the caller — only a whitelisted error code and a generic message SHALL cross the RPC boundary.

#### Scenario: Credentials not in response
- **WHEN** an inference call succeeds and returns a response payload
- **THEN** the payload contains only the model output and usage metadata; no API key, bearer token, authorization header echo, or credential material appears anywhere in the response

#### Scenario: Credentials not in error
- **WHEN** an inference call fails with an authentication error from the upstream provider
- **THEN** the structured error returned to the caller is one of a whitelisted set of error codes (`ERR_UPSTREAM_AUTH`, `ERR_UPSTREAM_RATE`, `ERR_UPSTREAM_OTHER`) with a generic message; the upstream response body is NOT forwarded; the JS exception stack trace SHALL NOT cross the RPC boundary

### Requirement: Per-agent inference rate limiting

`LlmService` SHALL enforce per-agent inference rate limits keyed on the verified token's `agentId`. Default limit: 100 inference calls per minute per agent. Exceeding the limit SHALL return a structured `ERR_RATE_LIMITED` error. Rate limits SHALL be configurable via host worker config.

#### Scenario: Rate limit enforced
- **WHEN** a bundle's agent issues 101 inference calls within one minute (same agentId in token)
- **THEN** the 101st call returns `ERR_RATE_LIMITED`, and the rate limit window is per-agent, not per-session

### Requirement: Cost emission for inference

`LlmService` SHALL emit a cost event via spine RPC after every successful inference call, attributing the cost to the agentId/sessionId derived from the verified token. The cost event SHALL include the provider, model identifier, and computed amount. The bundle SHALL NOT have any path to suppress, fabricate, or misattribute these cost events.

#### Scenario: Successful inference emits cost
- **WHEN** a bundle's `infer` call completes successfully
- **THEN** before the result returns, `LlmService` calls `env.SPINE.emitCost(token, {capabilityId: "llm-service", toolName: "infer", amount, currency})` with the same token

### Requirement: Agent runtime integration

`AgentRuntime` running inside a loader bundle SHALL support an `LlmProviderAdapter` implementation that routes inference through a `Service<LlmService>` binding instead of calling pi-ai providers directly. When a bundle declares `model: { provider, modelId }` without an `apiKey`, the runtime SHALL select the service-backed adapter automatically. The adapter SHALL read the bundle's capability token from `env.__SPINE_TOKEN` and pass it as the first argument on every `infer` call.

#### Scenario: Bundle with no apiKey uses service adapter
- **WHEN** a bundle's `model()` factory returns `{ provider: "openrouter", modelId: "..." }` with no `apiKey`
- **THEN** `AgentRuntime` constructs a `ServiceLlmProvider` wired to `env.LLM_SERVICE` and uses it for all inference calls in that bundle's turns, passing the bundle's capability token

#### Scenario: Static agent keeps direct provider path
- **WHEN** a `defineAgent`-based static agent declares `model: (env) => ({ provider, modelId, apiKey: env.OPENROUTER_API_KEY })`
- **THEN** `AgentRuntime` constructs a direct pi-ai provider as it does today and no `LlmService` lookup occurs

### Requirement: Tool call and streaming parity

`LlmService.infer()` SHALL support tool-call requests and streaming responses with the same semantics as direct pi-ai provider calls. Streaming responses SHALL be returned as `ReadableStream` values, which Cloudflare JSRPC supports across service binding boundaries. A bundle using `LlmService` SHALL be able to run the full tool-calling inference loop, including receiving streamed content deltas.

#### Scenario: Tool call round-trip through service
- **WHEN** a bundle issues an inference request containing tool schemas and the model responds with a tool call
- **THEN** the service returns the tool-call response to the bundle in the same structure pi-ai would produce for a direct call, and the bundle can submit the tool result back via a follow-up `infer()` call

#### Scenario: Streaming response across RPC
- **WHEN** a bundle issues a streaming inference request (`stream: true`)
- **THEN** the service returns a `ReadableStream` and the bundle reads content deltas from it in order
