## 1. RuntimeContext

- [ ] 1.1 Create `packages/agent-runtime/src/runtime-context.ts` with the `RuntimeContext` interface (`agentId: string`, `waitUntil(promise): void`)
- [ ] 1.2 Create `packages/agent-runtime/src/runtime-context-cloudflare.ts` with `createCfRuntimeContext(ctx: DurableObjectState): RuntimeContext`

## 2. AgentRuntime Extraction

- [ ] 2.1 Create `packages/agent-runtime/src/agent-runtime.ts` with the `AgentRuntime<TEnv>` abstract class
- [ ] 2.2 Move all store initialization from AgentDO into AgentRuntime constructor: `sessionStore`, `scheduleStore`, `configStore`, `mcpManager`, `taskStore`, `queueStore`, `kvStore`
- [ ] 2.3 Move type definitions (`AgentConfig`, `AgentContext`, `ScheduleManager`, `A2AConfig`, `A2AClientOptions`) into agent-runtime.ts (re-exported from agent-do.ts for compat)
- [ ] 2.4 Update `packages/agent-runtime/src/capabilities/types.ts` to import `AgentContext` from `agent-runtime.js` instead of `agent-do.js` (fixes circular import)
- [ ] 2.5 Move all abstract methods (`getConfig`, `getTools`) and overridable methods (`buildSystemPrompt`, `getPromptOptions`, `getCapabilities`, `getSubagentProfiles`, `getConfigNamespaces`, `getA2AClientOptions`, `getCommands`) to AgentRuntime
- [ ] 2.6 Move all lifecycle hooks (`validateAuth`, `onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire`) to AgentRuntime
- [ ] 2.7 Move `handleRequest(request: Request): Promise<Response>` to AgentRuntime (extracted from `fetch()` routing logic)
- [ ] 2.8 Move `handleAlarmFired()` to AgentRuntime as a public method
- [ ] 2.9 Replace all `this.ctx.id.toString()` with `this.runtimeContext.agentId` (~15 sites)
- [ ] 2.10 Replace all `this.ctx.waitUntil()` with `this.runtimeContext.waitUntil()` (1 site)
- [ ] 2.11 Move all internal helpers wholesale into AgentRuntime: `buildScheduleManager`, schedule CRUD, `refreshAlarm`, `handleAgentEvent`, `handleCostEvent`, `transformContext`, `resolveToolsForSession`, `createSessionBroadcast`, `broadcastCustomToAll`, `createCapabilityBroadcastState`, `fireOnConnectHooks`, `disposeCapabilities`, `handleA2ARequest`, `handleMcpCallback`, `syncCapabilitySchedules`, `matchHttpHandler`, `ensureAgent`, `getCachedCapabilities`. These are NOT delegated.
- [ ] 2.12 Verify `agent-runtime.ts` has zero imports from `cloudflare:workers`
- [ ] 2.13 Verify `AgentRuntime` never casts `this.transport` — uses only the abstract `Transport` interface

## 3. createDelegatingRuntime Helper

- [ ] 3.1 Create `packages/agent-runtime/src/runtime-delegating.ts` with `AgentDelegate<TEnv>` interface listing exactly: 2 abstract methods + 7 optional overrides + 5 hooks (no internal helpers)
- [ ] 3.2 Implement `createDelegatingRuntime<TEnv>(host, adapters)` returning an anonymous AgentRuntime subclass that forwards each method to `host.*`
- [ ] 3.3 Optional hooks on the host produce no-op forwards (host hook absent → runtime hook does nothing)

## 4. AgentDO Refactor

- [ ] 4.1 Refactor AgentDO to `implements AgentDelegate<TEnv>`
- [ ] 4.2 Hold `cfTransport: CfWebSocketTransport` directly on AgentDO (separate from the runtime's abstract `transport`)
- [ ] 4.3 Construct CF adapters (sqlStore, kvStore, scheduler, runtimeContext) in AgentDO constructor
- [ ] 4.4 Call `createDelegatingRuntime(this, { sqlStore, kvStore, scheduler, transport: this.cfTransport, runtimeContext, env })` in AgentDO constructor
- [ ] 4.5 Implement `fetch()` as a one-line delegator: `return this.runtime.handleRequest(request)`
- [ ] 4.6 Implement `alarm()` as a one-line delegator: `return this.runtime.handleAlarmFired()`
- [ ] 4.7 Implement `webSocketMessage()` and `webSocketClose()` as direct calls to `this.cfTransport.handleMessage` / `this.cfTransport.handleClose` — NO casts through `this.runtime.transport`
- [ ] 4.8 Expose protected store properties via getters that read from the runtime instance (preserves `this.sessionStore` access pattern)
- [ ] 4.9 Re-export `AgentConfig`, `AgentContext`, `ScheduleManager`, `A2AConfig` from agent-do.ts for backward compat
- [ ] 4.10 Verify AgentDO file is approximately 150 lines (down from ~2700) — realistic estimate accounts for ~35 protected getters + delegation forwards

## 5. defineAgent Factory

- [ ] 5.1 Create `packages/agent-runtime/src/define-agent.ts` with `defineAgent<TEnv>(definition)` function
- [ ] 5.2 Define `AgentDefinition<TEnv>` interface with fields: `model`, `prompt?`, `tools?`, `capabilities?`, `subagentProfiles?`, `commands?`, `a2a?`, `hooks?`, `logger?`, `onError?`, `fetch?`
- [ ] 5.3 Define `AgentSetup<TEnv>` interface (NOT `AgentInitContext`): `{ env, agentId, sqlStore: SqlStore, sessionStore, transport, resolveToolsForSession }`
- [ ] 5.4 Define `Logger` interface: `{ debug, info, warn, error }` with `(msg, ctx?) => void` signature
- [ ] 5.5 `AgentSetup.resolveToolsForSession` must be SYNCHRONOUS and return `{ tools, context, resolved }` — match the actual `resolveToolsForSession` signature on AgentDO/AgentRuntime
- [ ] 5.6 `definition.model` accepts literal `AgentConfig` OR function `(env) => AgentConfig`. Translate literal to function form internally.
- [ ] 5.7 `definition.prompt` accepts string OR `PromptOptions`. String → override `buildSystemPrompt` to return literal (no capability sections appended). PromptOptions → override `getPromptOptions` (capability sections still append).
- [ ] 5.8 `definition.hooks` is a function `(setup) => HooksObject`. The factory is called once at construction with the setup; the returned hooks object is reused for the lifetime of the instance. Hook signatures match AgentDO's hooks exactly (no extra `init` param).
- [ ] 5.9 Implement `defineAgent` to return an anonymous class extending AgentDO that implements `AgentDelegate<TEnv>` and forwards each delegate method to the corresponding definition function
- [ ] 5.10 Build `AgentSetup` exactly ONCE in the constructor of the returned class, after stores are initialized. Reuse the same reference for every factory callback.
- [ ] 5.11 Wire `definition.logger` into AgentRuntime (pass via constructor or setter; default to no-op if not provided)
- [ ] 5.12 Wire `definition.onError` to be called from AgentRuntime when tools throw, inference fails, hooks throw, or HTTP routes throw. Catch the error, call `onError(error, info)`, then continue or fail as appropriate per source.
- [ ] 5.13 Wire `definition.fetch` to run before AgentRuntime's default routing in `handleRequest`. If it returns null, fall through; if it returns a Response, send it directly.
- [ ] 5.14 No `name`/`description`/`configNamespaces`/`agentOptions` fields on `AgentDefinition` — explicitly omitted

## 6. AgentRuntime Logger and Error Boundaries

- [ ] 6.1 Add `logger: Logger` field to AgentRuntime constructor (or via separate setter); default to no-op `Logger`
- [ ] 6.2 Add `onError?: (error, info) => void` slot to AgentRuntime; AgentRuntime catches errors at the four boundaries (tool, inference, hook, http) and invokes `onError` if set
- [ ] 6.3 Tool errors: catch in tool execution wrapper, log via `this.logger.error`, call `this.onError`, return tool error result
- [ ] 6.4 Inference errors: catch in agent loop, log, call `this.onError`, surface via `agent_event` error
- [ ] 6.5 Hook errors: catch in hook invocation, log, call `this.onError`, do not propagate
- [ ] 6.6 HTTP route errors: catch in `handleRequest`, log, call `this.onError`, return 500 response

## 7. Coverage Configuration

- [ ] 7.1 Update `packages/agent-runtime/vitest.config.ts` to add `agent-runtime.ts` to the coverage threshold exclusion list (matching the existing `agent-do.ts` exclusion)
- [ ] 7.2 Document this in CLAUDE.md under "Coverage thresholds (agent-runtime)" — note that `agent-runtime.ts` joins `agent-do.ts` as excluded, with a follow-up note that unit-test backfill is technical debt
- [ ] 7.3 Also exclude `runtime-delegating.ts` and `define-agent.ts` (they are wiring; tested via integration)

## 8. Barrel Exports

- [ ] 8.1 Update `packages/agent-runtime/src/index.ts` to export `defineAgent`, `AgentDefinition`, `AgentSetup`, `Logger`, `AgentRuntime`, `RuntimeContext`, `createCfRuntimeContext`, `createDelegatingRuntime`, `AgentDelegate`
- [ ] 8.2 Verify all existing exports (`AgentDO`, `AgentConfig`, `AgentContext`, etc.) continue to work

## 9. Example Migration

- [ ] 9.1 Rewrite `examples/basic-agent/src/worker.ts` to use `defineAgent()` instead of `extends AgentDO`
- [ ] 9.2 Use `model: (env) => ({...})` instead of `getConfig()`
- [ ] 9.3 Use `prompt: { agentName, agentDescription }` (PromptOptions form) so capability prompt sections still append
- [ ] 9.4 Use `capabilities: ({ env, agentId, sqlStore, resolveToolsForSession }) => [...]` — no `createCfSqlStore` call, use `resolveToolsForSession(sid).tools` for batch-tool
- [ ] 9.5 Use `hooks: ({ env }) => ({ onTurnEnd: ... })` — no trailing init param
- [ ] 9.6 Move the debug `fetch()` route handling to `definition.fetch` (return null for non-debug paths)
- [ ] 9.7 Verify example works: `cd examples/basic-agent && bun dev`, sanity check chat + tool execution + capability features
- [ ] 9.8 Confirm example is approximately 150 lines (down from ~375)

## 10. Documentation

- [ ] 10.1 Update README.md quick start to use `defineAgent({ model, prompt })` — minimal hello world
- [ ] 10.2 Add a "Customizing your agent" section with the full `defineAgent` field reference
- [ ] 10.3 Add an "Advanced Usage: extends AgentDO" section showing the escape hatch
- [ ] 10.4 Update CLAUDE.md to reflect the new primary API and the coverage exclusion update

## 11. Cleanup

- [ ] 11.1 Delete `openspec/changes/extract-agent-runtime-core/` directory (superseded by this change)
- [ ] 11.2 Remove any references to `extract-agent-runtime-core` in other artifacts

## 12. Verification

- [ ] 12.1 Run `bun run typecheck` — all packages compile with no errors
- [ ] 12.2 Run `bun run test` — all existing tests pass without modification
- [ ] 12.3 Run `bun run lint` — no new lint violations
- [ ] 12.4 Verify `agent-runtime.ts` has zero imports from `cloudflare:workers`
- [ ] 12.5 Verify `agent-runtime.ts` has zero `as CfWebSocketTransport` casts
- [ ] 12.6 Verify `agent-do.ts` is approximately 150 lines
- [ ] 12.7 Verify `examples/basic-agent/src/worker.ts` is significantly shorter (~150 lines vs ~375)
- [ ] 12.8 Verify `AgentSetup` does not expose raw `SqlStorage` — only `sqlStore: SqlStore`
- [ ] 12.9 Confirm no remaining `createCfSqlStore()` calls in example or in `defineAgent` consumer paths
- [ ] 12.10 Verify `capabilities/types.ts` imports `AgentContext` from `agent-runtime.js`, not `agent-do.js`

## 13. Tests

- [ ] 13.1 Test `defineAgent()` returns a working DurableObject class
- [ ] 13.2 Test `definition.model` accepts both literal and function forms
- [ ] 13.3 Test `definition.prompt` string overrides `buildSystemPrompt` (no capability sections appended)
- [ ] 13.4 Test `definition.prompt` PromptOptions overrides `getPromptOptions` (capability sections appended)
- [ ] 13.5 Test `definition.capabilities` receives a properly populated `AgentSetup`
- [ ] 13.6 Test the same `AgentSetup` reference is passed across multiple `getCapabilities()` invocations (object identity)
- [ ] 13.7 Test `definition.hooks` is called once at construction, returns object reused for all hook invocations
- [ ] 13.8 Test hook signatures match AgentDO (no trailing init parameter)
- [ ] 13.9 Test `definition.logger` is wired and receives log events
- [ ] 13.10 Test `definition.onError` fires on tool error, hook error, and HTTP error
- [ ] 13.11 Test `definition.fetch` is called before default routing; null return falls through; Response return short-circuits
- [ ] 13.12 Test `extends AgentDO` escape hatch still works (existing AgentDO tests cover this)
- [ ] 13.13 Test `AgentRuntime` can be constructed and exercised with mock adapters (no CF Workers pool)
- [ ] 13.14 Test `createCfRuntimeContext` correctly maps DO state fields
- [ ] 13.15 Test `createDelegatingRuntime` produces a runtime that forwards all 14 delegate methods correctly (2 abstract + 7 overrides + 5 hooks)
- [ ] 13.16 Test that `getSubagentProfiles` and `QueueStore` work after extraction
- [ ] 13.17 Test `AgentSetup.resolveToolsForSession` is synchronous and returns the full struct
- [ ] 13.18 Test that AgentDO holds `cfTransport` separately and never casts through `this.runtime.transport`
