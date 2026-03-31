## 1. RuntimeContext Interface and CF Adapter

- [ ] 1.1 Create `packages/agent-runtime/src/runtime-context.ts` with the `RuntimeContext` interface (agentId: string, waitUntil: (promise: Promise<unknown>) => void)
- [ ] 1.2 Create `createCfRuntimeContext(ctx: DurableObjectState): RuntimeContext` factory function in `packages/agent-runtime/src/runtime-context-cloudflare.ts`

## 2. Extract AgentRuntime Class

- [ ] 2.1 Create `packages/agent-runtime/src/agent-runtime.ts` with the `AgentRuntime` abstract class. Move all business logic from AgentDO: constructor initialization (SessionStore, ScheduleStore, ConfigStore, McpManager, TaskStore from injected SqlStore/KvStore), transport event wiring, all private/protected methods
- [ ] 2.2 Move type definitions (AgentConfig, AgentContext, ScheduleManager, A2AConfig, A2AConfig) from agent-do.ts into agent-runtime.ts
- [ ] 2.3 Move all abstract methods (getConfig, getTools) and overridable methods (buildSystemPrompt, getCapabilities, getCommands, getPromptOptions, getConfigNamespaces, getA2AClientOptions, getAgentOptions) to AgentRuntime
- [ ] 2.4 Move all lifecycle hooks (onTurnEnd, onAgentEnd, onSessionCreated, onScheduleFire, validateAuth) to AgentRuntime
- [ ] 2.5 Rename `fetch()` routing logic to `handleRequest(request: Request): Promise<Response>` on AgentRuntime
- [ ] 2.6 Make `handleAlarmFired()` public on AgentRuntime
- [ ] 2.7 Replace `this.ctx.id.toString()` with `this.runtimeContext.agentId` and `this.ctx.waitUntil()` with `this.runtimeContext.waitUntil()` in the extracted code

## 3. Refactor AgentDO as Thin Shell

- [ ] 3.1 Refactor AgentDO to create CF adapters in constructor and instantiate an anonymous AgentRuntime subclass that delegates abstract methods back to AgentDO
- [ ] 3.2 Implement fetch() as delegation to this.runtime.handleRequest(request)
- [ ] 3.3 Implement alarm() as delegation to this.runtime.handleAlarmFired()
- [ ] 3.4 Keep webSocketMessage() and webSocketClose() as thin delegators to transport (unchanged)
- [ ] 3.5 Expose protected store properties (sessionStore, scheduleStore, etc.) via getters that delegate to runtime instance
- [ ] 3.6 Re-export AgentConfig, AgentContext, ScheduleManager, A2AConfig from agent-do.ts for backwards compatibility

## 4. Barrel Exports and Types

- [ ] 4.1 Update `packages/agent-runtime/src/index.ts` to export AgentRuntime, RuntimeContext, and createCfRuntimeContext
- [ ] 4.2 Verify all existing exports (AgentDO, AgentConfig, AgentContext, etc.) continue to work

## 5. Verification

- [ ] 5.1 Run `bun run typecheck` -- all packages must compile with no errors
- [ ] 5.2 Run `bun run test` -- all existing tests must pass without modification
- [ ] 5.3 Run `bun run lint` -- no new lint violations
- [ ] 5.4 Verify agent-runtime.ts has zero imports from "cloudflare:workers" or CF-specific modules
