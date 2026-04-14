## 1. Capability interface and tool source tracking

- [ ] 1.1 Add `inheritable?: boolean` field to `Capability` interface in `packages/agent-runtime/src/capabilities/types.ts`
- [ ] 1.2 Add tool source tracking mechanism (WeakMap or tagged wrapper) to associate each tool with its source capability ID in `collectAllTools()`
- [ ] 1.3 Add unit tests for `inheritable` default behavior and tool source attribution

## 2. Internal config capability

- [ ] 2.1 Create `configCapability()` factory in `packages/agent-runtime/src/config/capability.ts` — accepts `getNamespaces` callback, returns Capability with id `"config"`, `inheritable: false`, contributing config_get/set/schema tools and a prompt section
- [ ] 2.2 Wire config capability into `AgentRuntime` — register as internal capability, provide the `getNamespaces` callback that aggregates capability + consumer namespaces
- [ ] 2.3 Remove inline config tool creation from `collectAllTools()`
- [ ] 2.4 Update existing config tests to verify tools come through the capability path

## 3. Internal mode-manager capability

- [ ] 3.1 Create `modeManagerCapability()` factory in `packages/agent-runtime/src/modes/capability.ts` — returns Capability with id `"mode-manager"`, `inheritable: false`, conditionally contributing enter_mode/exit_mode tools when modes are active
- [ ] 3.2 Wire mode-manager capability into `AgentRuntime` — register when `modesActive` is true
- [ ] 3.3 Remove inline mode tool creation from `collectAllTools()`
- [ ] 3.4 Update existing mode tool tests

## 4. Internal A2A client capability

- [ ] 4.1 Create `a2aClientCapability()` factory in `packages/agent-runtime/src/a2a/client-capability.ts` (or alongside existing A2A code) — returns Capability with id `"a2a-client"`, `inheritable: true`, conditionally contributing call_agent/start_task/check_task/cancel_task tools when A2A is configured
- [ ] 4.2 Wire A2A client capability into `AgentRuntime` — register when A2A client options are present
- [ ] 4.3 Remove inline A2A client tool creation from `collectAllTools()`
- [ ] 4.4 Update existing A2A client tests

## 5. Simplify collectAllTools

- [ ] 5.1 Collapse `collectAllTools()` to return only `baseTools + resolved.tools` — verify no inline tool creation remains
- [ ] 5.2 Remove the auto-derive dead-cap logic from `applyMode` (the implicit capability-section-exclusion heuristic added earlier in this session)

## 6. Subagent inheritable filtering

- [ ] 6.1 Update `resolveSubagentSpawn()` in `packages/subagent/src/resolve.ts` to accept tool source metadata and filter out tools from non-inheritable capabilities before Mode filtering
- [ ] 6.2 Update the subagent capability's `getParentTools()` call site to pass source metadata
- [ ] 6.3 Add tests: subagent does not receive config/mode tools, does receive a2a/storage tools

## 7. Set inheritable on existing capabilities

- [ ] 7.1 Set `inheritable: false` on `promptScheduler()` in `packages/prompt-scheduler/src/capability.ts`
- [ ] 7.2 Set `inheritable: false` on `bundleWorkshop()` in `packages/bundle-workshop/`
- [ ] 7.3 Verify all other capabilities default to `inheritable: true` (no changes needed)

## 8. Update basic-agent example

- [ ] 8.1 Simplify plan mode in `examples/basic-agent/src/worker.ts` — add `capabilities: { deny: ["config", "prompt-scheduler"] }` alongside the existing tool allow-list (or convert from allow-list to deny-list if cleaner)

## 9. Integration verification

- [ ] 9.1 Run full agent-runtime test suite — all existing tests pass
- [ ] 9.2 Run typecheck across workspace
- [ ] 9.3 Manual verification: start basic-agent, enter plan mode, open prompt panel — filtered capabilities and their sections should not appear
