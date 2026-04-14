## 1. SubagentHost implementation on AgentRuntime

- [ ] 1.1 Add private `asSubagentHost(): SubagentHost` method on `AgentRuntime` that returns an object implementing the `SubagentHost` interface, delegating to existing runtime methods
- [ ] 1.2 Implement `createSubagentSession` — calls `this.sessionStore.create()` with `source: "subagent"` and parent session reference
- [ ] 1.3 Implement `runSubagentBlocking`:
  - [ ] 1.3a Create a child Agent instance with the provided tools/prompt/model (reuse the `ensureAgent` pattern but scoped to the child session — do NOT call `ensureAgent` directly since it manages `sessionAgents` and cache lifecycle)
  - [ ] 1.3b Call `handlePrompt` on the child session to start inference
  - [ ] 1.3c Subscribe to the child agent's event stream, resolve on `agent_end`
  - [ ] 1.3d Extract the final assistant message from `sessionStore.buildContext(childSessionId)`
  - [ ] 1.3e Ensure child agent cleanup does NOT invalidate parent's `resolvedCapabilitiesCache` / `capabilitiesCache` — scope cache invalidation to the session that ended, not globally
- [ ] 1.4 Implement `startSubagentAsync` — same agent creation as 1.3 but return immediately, fire `onComplete` callback on `agent_end`
- [ ] 1.5 Implement `isSessionStreaming` — checks `this.sessionAgents.has(sessionId)`
- [ ] 1.6 Implement `steerSession` — delegates to `this.handleSteer(sessionId, text)`
- [ ] 1.7 Implement `promptSession` — delegates to `this.handlePrompt(sessionId, text)`
- [ ] 1.8 Implement `abortSession` — calls `this.sessionAgents.get(sessionId)?.abort()`
- [ ] 1.9 Implement `broadcastToSession` — delegates to `this.transport.broadcastToSession(sessionId, message)`

## 2. Fix resolvedCapabilitiesCache concurrency

- [ ] 2.1 Scope `agent_end` cache invalidation to the specific session that ended, not globally — the current code (lines 2057-2061) nulls `resolvedCapabilitiesCache` and `capabilitiesCache` on ANY `agent_end`, which breaks the parent when a child session ends mid-parent-turn
- [ ] 2.2 Test: parent session's capability cache survives a child session ending

## 3. Auto-register subagent tools in collectAllTools

- [ ] 3.1 Import subagent tool factories (`createCallSubagentTool`, `createStartSubagentTool`, `createCheckSubagentTool`, `createCancelSubagentTool`) from `@claw-for-cloudflare/subagent`
- [ ] 3.2 Add consumer-capability check: skip auto-registration if any registered capability has `id: "subagent"`
- [ ] 3.3 When `getSubagentModes().length > 0` and no consumer subagent capability exists, build `SubagentToolDeps` using `this.asSubagentHost()`, `getSubagentModes()`, current context's tools and prompt
- [ ] 3.4 Create a `PendingSubagentStore`-compatible storage from `this.kvStore` with `"subagent"` namespace
- [ ] 3.5 Register the four subagent tools in the `collectAllTools` return array alongside config/mode/a2a tools
- [ ] 3.6 Add a prompt section listing available subagent modes with descriptions, and guidance on blocking (`call_subagent`) vs non-blocking (`start_subagent`) usage

## 4. getParentTools and getSystemPrompt callbacks

- [ ] 4.1 Implement `getParentTools` callback that returns `collectAllTools()` for the current context (lazy — called at tool execution time, not at registration time)
- [ ] 4.2 Implement `getSystemPrompt` callback as a lazy closure — MUST NOT evaluate during `collectAllTools` since the prompt hasn't been assembled yet at that point. Captures `this` and reads the assembled prompt at tool execution time

## 5. Orphan detection for auto-wired subagents

- [ ] 5.1 Register an `onConnect` handler (or equivalent lifecycle hook) that checks `PendingSubagentStore` for async subagents that were running when the DO hibernated
- [ ] 5.2 Broadcast `subagent_orphaned` for any pending subagents whose sessions are no longer streaming
- [ ] 5.3 Test: after simulated hibernation wake, orphaned subagents are detected and broadcast

## 6. Tests

- [ ] 6.1 Unit test: `asSubagentHost()` returns an object implementing all `SubagentHost` methods
- [ ] 6.2 Unit test: `collectAllTools` includes subagent tools when `getSubagentModes()` returns modes
- [ ] 6.3 Unit test: `collectAllTools` excludes subagent tools when `getSubagentModes()` returns empty array
- [ ] 6.4 Unit test: `collectAllTools` skips auto-registration when a capability with `id: "subagent"` is registered
- [ ] 6.5 Unit test: subagent prompt section lists available modes
- [ ] 6.6 Integration test: `call_subagent` creates a child session, runs to completion, and returns result
- [ ] 6.7 Integration test: `start_subagent` returns immediately, delivers result on completion

## 7. Example and verification

- [ ] 7.1 Verify basic-agent's `subagentModes: () => [explorer(...)]` now produces working subagent tools without any capability wiring changes
- [ ] 7.2 Run `bun run typecheck` — zero errors
- [ ] 7.3 Run `bun run test` — all tests pass
- [ ] 7.4 Manual smoke test: start basic-agent, verify `call_subagent` tool appears, invoke it with explorer mode
