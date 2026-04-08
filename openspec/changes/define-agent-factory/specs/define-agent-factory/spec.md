## ADDED Requirements

### Requirement: defineAgent returns a DurableObject class
The SDK SHALL export a `defineAgent<TEnv>(definition)` function that returns a class assignable to a Cloudflare Workers DurableObject export. The returned class SHALL accept `(ctx: DurableObjectState, env: TEnv)` in its constructor.

#### Scenario: Consumer exports a defined agent
- **WHEN** a consumer writes `export const MyAgent = defineAgent<Env>({ model: (env) => ({...}) })`
- **THEN** `MyAgent` is a class that can be bound as a Durable Object in `wrangler.toml` and instantiated by the Workers runtime

#### Scenario: Returned class extends AgentDO
- **WHEN** the class returned by `defineAgent()` is instantiated
- **THEN** it has all of AgentDO's behavior (lifecycle methods, store access, capability resolution) and provides concrete implementations for `getConfig` and `getTools` derived from the definition

### Requirement: AgentDefinition model field
The `definition.model` field SHALL be required and accept either an `AgentConfig` literal or a function `(env: TEnv) => AgentConfig`. It SHALL be called once per session before each inference (or used directly if a literal). Internally, it provides the value returned by `getConfig()`.

#### Scenario: Model as literal
- **WHEN** `definition.model = { provider: "openrouter", modelId: "...", apiKey: "static" }`
- **THEN** the agent uses that config for every session without calling a function

#### Scenario: Model as function of env
- **WHEN** `definition.model = (env) => ({ provider: "openrouter", modelId: "...", apiKey: env.KEY })`
- **THEN** the function is called to produce the LLM config and `env.KEY` is read from the worker's environment

### Requirement: AgentDefinition tools field
The `definition.tools` field SHALL be an optional function `(ctx: AgentContext) => AnyAgentTool[]` returning the tool list. It SHALL be called per-session during tool resolution.

#### Scenario: Tools function returns array
- **WHEN** the agent resolves tools for a session
- **THEN** `definition.tools(context)` is called and the returned array is registered as session tools

#### Scenario: Tools default to empty
- **WHEN** `definition.tools` is omitted
- **THEN** the agent has zero base tools (capabilities may still contribute tools)

### Requirement: AgentDefinition prompt field accepts string or PromptOptions
The `definition.prompt` field SHALL accept one of: a string (used as-is, no capability prompt sections appended) or a `PromptOptions` object (used with the default builder, capability prompt sections still append). Builder functions are NOT accepted.

#### Scenario: String prompt
- **WHEN** `definition.prompt = "You are helpful."`
- **THEN** the system prompt is `"You are helpful."` for every session and capability prompt sections are NOT appended

#### Scenario: PromptOptions prompt with capability sections
- **WHEN** `definition.prompt = { agentName: "Helper", agentDescription: "..." }` and a capability contributes a prompt section
- **THEN** the prompt is built using `buildDefaultSystemPrompt({ agentName, agentDescription })` and the capability's section is appended

### Requirement: AgentDefinition capabilities field receives setup
The `definition.capabilities` field SHALL be an optional function `(setup: AgentSetup<TEnv>) => Capability[]` where `AgentSetup` provides `{ env, agentId, sqlStore, sessionStore, transport, resolveToolsForSession }`.

#### Scenario: Capability factory uses setup
- **WHEN** `definition.capabilities = ({ env, agentId }) => [r2Storage({ bucket: env.STORAGE, prefix: agentId })]`
- **THEN** the capability is constructed with the env binding and agent ID at runtime

### Requirement: AgentSetup is built once at construction
The `AgentSetup` object SHALL be constructed exactly once when the `defineAgent`-produced class is instantiated. Every subsequent call to a definition factory function (`capabilities`, `subagentProfiles`, `a2a`, `hooks`, `fetch`) SHALL receive the same setup reference.

#### Scenario: Same setup reference reused
- **WHEN** `getCapabilities()` is invoked multiple times (cached, cleared on agent_end, then rebuilt)
- **THEN** each invocation receives the same `AgentSetup` reference (object identity preserved)

#### Scenario: Setup built before any factory function called
- **WHEN** the defineAgent class is instantiated
- **THEN** the setup object is constructed in the constructor, after stores are initialized, before any user-provided factory function is called

### Requirement: AgentSetup provides pre-constructed sqlStore
`AgentSetup.sqlStore` SHALL be of type `SqlStore` (the abstract interface), pre-constructed by the runtime. Consumers SHALL NOT need to call `createCfSqlStore()` themselves when using `defineAgent`.

#### Scenario: Capability receives ready-to-use SqlStore
- **WHEN** `definition.capabilities = ({ sqlStore }) => [taskTracker({ sql: sqlStore })]`
- **THEN** the consumer does not call `createCfSqlStore()` and the taskTracker capability receives a working SqlStore

#### Scenario: No SqlStorage type leak in setup
- **WHEN** the `AgentSetup<TEnv>` type is inspected
- **THEN** it contains `sqlStore: SqlStore` and does NOT contain a `sql: SqlStorage` field

### Requirement: AgentSetup.resolveToolsForSession is synchronous and returns full resolution
`AgentSetup.resolveToolsForSession(sessionId)` SHALL be a synchronous function that returns `{ tools: AnyAgentTool[]; context: AgentContext; resolved: ResolvedCapabilities }`. It SHALL NOT return a Promise.

#### Scenario: Synchronous tool resolution
- **WHEN** a capability calls `resolveToolsForSession("abc")`
- **THEN** the function returns the resolution struct directly without await

#### Scenario: batchTool consumes the tools field
- **WHEN** `batchTool({ getTools: (sid) => resolveToolsForSession(sid).tools })` is registered
- **THEN** the batch tool receives a flat `AnyAgentTool[]` array

### Requirement: AgentDefinition lifecycle hooks via setup factory
The `definition.hooks` field SHALL be an optional function `(setup: AgentSetup<TEnv>) => HooksObject` where `HooksObject` contains `validateAuth`, `onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire` — all optional, all matching `AgentDO`'s hook signatures (no extra `init` parameter). Hooks close over `setup` via the factory.

#### Scenario: Hooks close over setup
- **WHEN** `definition.hooks = ({ env }) => ({ onTurnEnd: (msgs) => { /* uses env */ } })`
- **THEN** the `onTurnEnd` hook can access `env` via closure without it appearing in the parameter list

#### Scenario: Hook signatures match AgentDO
- **WHEN** comparing hook signatures from `definition.hooks` to AgentDO's protected hook methods
- **THEN** the signatures are identical (no trailing `init` parameter, no other additions)

#### Scenario: Hooks factory called once
- **WHEN** the agent is instantiated and `definition.hooks` is provided
- **THEN** the hooks factory is called exactly once with the setup, and the returned hook object is reused for the lifetime of the instance

### Requirement: AgentDefinition supports subagent profiles, commands, and A2A
The `definition` SHALL accept optional `subagentProfiles: (setup) => SubagentProfile[]`, `commands: (ctx: CommandContext) => Command[]`, and `a2a: (setup) => A2AClientOptions` fields. To disable A2A, the consumer omits the field — there is no `null` return convention.

#### Scenario: Subagent profiles defined
- **WHEN** `definition.subagentProfiles = ({ env }) => [{ id: "explorer", ... }]`
- **THEN** the profiles are registered for subagent spawning

#### Scenario: A2A configuration via omission
- **WHEN** `definition.a2a` is not set
- **THEN** A2A client tools are not registered (equivalent to today's `getA2AClientOptions(): null`)

### Requirement: AgentDefinition logger
The `definition.logger` field SHALL accept an optional `Logger` interface with methods `debug`, `info`, `warn`, `error`, each taking `(msg: string, ctx?: Record<string, unknown>) => void`. The default SHALL be a no-op logger.

#### Scenario: Custom logger receives runtime log events
- **WHEN** `definition.logger = myLogger` and the runtime logs an event
- **THEN** `myLogger.info(msg, ctx)` (or appropriate level) is called

#### Scenario: No logger means silent
- **WHEN** `definition.logger` is omitted
- **THEN** the runtime logs nothing to console or any other sink

### Requirement: AgentDefinition onError handler
The `definition.onError` field SHALL accept an optional function `(error: Error, info: { source: "tool" | "inference" | "hook" | "http"; sessionId?: string; toolName?: string }) => void`. It SHALL be called when a tool throws, inference fails, a hook throws, or an HTTP route handler throws. It is observation-only — its return value is ignored.

#### Scenario: Tool error reaches onError
- **WHEN** a tool's `execute` throws an error
- **THEN** `definition.onError(error, { source: "tool", sessionId, toolName })` is called

#### Scenario: Hook error reaches onError
- **WHEN** `onTurnEnd` throws
- **THEN** `definition.onError(error, { source: "hook" })` is called and the throw does not propagate to crash the agent loop

### Requirement: AgentDefinition fetch for custom HTTP routes
The `definition.fetch` field SHALL accept an optional function `(request: Request, setup: AgentSetup<TEnv>) => Promise<Response | null> | Response | null`. It SHALL be called before the runtime's default routing. If the function returns `null`, the runtime falls through to its default handlers (capability HTTP, /prompt, /schedules, A2A, WebSocket upgrade). If it returns a `Response`, that response is sent directly.

#### Scenario: Custom route handled
- **WHEN** `definition.fetch = (req) => req.url.endsWith("/health") ? new Response("ok") : null`
- **THEN** requests to `/health` get `"ok"` and other requests fall through to default routing

#### Scenario: Fall-through via null
- **WHEN** the custom fetch returns `null` for a `/prompt` request
- **THEN** the runtime processes the request with its default `/prompt` handler

### Requirement: defineAgent reproduces all current consumer patterns
Every override pattern available in `extends AgentDO` SHALL be expressible via `defineAgent()`. There SHALL be no consumer pattern (other than direct `this.ctx` / `this.env` access, custom constructor logic, or arbitrary multi-route fetch handlers) that requires subclassing.

#### Scenario: Example basic-agent migrated to factory
- **WHEN** `examples/basic-agent` is rewritten using `defineAgent()`
- **THEN** all current functionality (capabilities, tools, hooks, A2A) works identically without subclassing

### Requirement: extends AgentDO remains supported as escape hatch
Consumers SHALL still be able to write `class MyAgent extends AgentDO<Env> { ... }` for advanced cases. This path SHALL remain documented as the advanced/escape-hatch usage.

#### Scenario: Custom constructor logic via subclassing
- **WHEN** a consumer needs constructor-time setup that the factory doesn't expose
- **THEN** they extend AgentDO directly

### Requirement: AgentSetup naming
The setup type SHALL be named `AgentSetup`, NOT `AgentInitContext` or any other "...Context" name. This is to visually distinguish it from `AgentContext`, `ToolExecuteContext`, `RuntimeContext`, `CommandContext`, and `CapabilityHookContext` which already exist in the codebase.

#### Scenario: Type exported as AgentSetup
- **WHEN** importing the type from `@claw-for-cloudflare/agent-runtime`
- **THEN** `import type { AgentSetup } from "@claw-for-cloudflare/agent-runtime"` works

### Requirement: Consumer-facing exports
The `@claw-for-cloudflare/agent-runtime` package SHALL export `defineAgent`, `AgentDefinition`, `AgentSetup`, `Logger`, and continue exporting `AgentDO` and all existing types.

#### Scenario: Imports work from main barrel
- **WHEN** a consumer writes `import { defineAgent } from "@claw-for-cloudflare/agent-runtime"`
- **THEN** the function is available
