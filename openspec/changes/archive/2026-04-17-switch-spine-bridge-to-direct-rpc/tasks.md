## 1. Phase 1 — Preflight and scoping

- [x] 1.1 Confirm `split-agent-bundle-host-and-sdk` has landed. `packages/runtime/bundle-host/src/services/spine-service.ts`, `packages/runtime/bundle-sdk/`, and `packages/runtime/bundle-token/` should all exist at this path.
- [x] 1.2 Run `bun run typecheck` from the repo root to confirm a clean baseline. All packages must PASS.
- [x] 1.3 Grep the entire repo for `/spine/` route references: `grep -rn "/spine/" packages/ examples/ e2e/ scripts/ --include="*.ts" --include="*.tsx" --include="*.json"`. Record the file list. Expect hits only in:
  - `packages/runtime/bundle-host/src/services/spine-service.ts` (the SpineService methods — source of truth for what's called)
  - `packages/runtime/agent-runtime/src/agent-runtime.ts` (`handleSpineRequest` switch and the `fetch` dispatcher's `/spine/*` branch)
  - `packages/runtime/agent-runtime/test/integration/spine-host.test.ts` (direct DO surface test)
  - `packages/runtime/agent-runtime/test/integration/bundle-spine-bridge.test.ts` (end-to-end test)
  - Any SpineService unit tests under `packages/runtime/bundle-host/src/__tests__/`
  - Possibly a comment or two in `packages/runtime/agent-runtime/src/agent-do.ts`
- [x] 1.4 If the grep shows `/spine/` references outside this list — STOP. Those are out-of-repo consumers (admin tools, debug endpoints, external scripts) that would break when the routes are deleted. Investigate before proceeding. Either update them in this change, or preserve the HTTP routes alongside the method calls until they migrate.
- [x] 1.5 Capture current SpineHost method list from `packages/runtime/agent-runtime/src/spine-host.ts`. Note which methods are currently handled by `handleSpineRequest` with real logic and which fall through to `notImplemented`. The fallthrough set is what Phase 3 needs to implement for real.
- [x] 1.6 Run `bun run test` for `packages/runtime/agent-runtime` and `packages/runtime/bundle-host` to capture baseline test state. Any currently-failing tests should be noted so they're not attributed to this change later.

## 2. Phase 2 — Add public `spine*` methods on `AgentRuntime` mirroring existing switch cases

- [x] 2.1 In `packages/runtime/agent-runtime/src/agent-runtime.ts`, immediately below the existing `handleSpineRequest` method, add a dedicated "Spine host surface" section comment and begin adding public methods. These methods will replace the switch cases one-by-one. Keep `handleSpineRequest` intact during this phase; the methods and the switch both exist during the transition.
- [x] 2.2 Implement `spineAppendEntry(sessionId: string, entry: { type: SessionEntryType; data: Record<string, unknown> }): SessionEntry`. Body: `return this.sessionStore.appendEntry(sessionId, entry);` — lift from the `case "/spine/appendEntry"` block.
- [x] 2.3 Implement `spineGetEntries(sessionId: string, options?: unknown): SessionEntry[]`. Body: `return this.sessionStore.getEntries(sessionId);`. Accept `options` as in the existing route even if currently unused.
- [x] 2.4 Implement `spineGetSession(sessionId: string): Session | null`. Body: `return this.sessionStore.get(sessionId);`.
- [x] 2.5 Implement `spineCreateSession(init?: { name?: string; source?: string; sender?: string }): Session`. Body: `return this.sessionStore.create(init);`.
- [x] 2.6 Implement `spineListSessions(filter?: unknown): Session[]`. Body: `return this.sessionStore.list();`. Accept filter as future-proofing.
- [x] 2.7 Implement `spineBuildContext(sessionId: string): ContextBuild`. Body: `return this.sessionStore.buildContext(sessionId);`.
- [x] 2.8 Implement `spineBroadcast(sessionId: string, event: Record<string, unknown>): void`. Body: lift from `case "/spine/broadcast"` — stamp `sessionId` into the event before broadcasting, call `this.broadcastToSession(sessionId, msg)`. This is load-bearing: the spine method enforces session scoping so a bundle cannot target another session's transport.
- [x] 2.9 Implement `spineBroadcastGlobal(event: Record<string, unknown>): void`. Body: `this.transport.broadcast(event as unknown as ServerMessage);`.
- [x] 2.10 Implement `spineEmitCost(sessionId: string, costEvent: CostEvent): void`. Body: `this.handleCostEvent(costEvent, sessionId);`.
- [x] 2.11 Implement `spineKvGet(capabilityId: string, key: string): Promise<unknown>`. Body: lift from `case "/spine/kvGet"` — `createCapabilityStorage(this.kvStore, capabilityId).get(key)`.
- [x] 2.12 Implement `spineKvPut(capabilityId: string, key: string, value: unknown): Promise<void>`. Body: lift from `case "/spine/kvPut"`.
- [x] 2.13 Implement `spineKvDelete(capabilityId: string, key: string): Promise<{ deleted: boolean }>`. Body: lift from `case "/spine/kvDelete"`.
- [x] 2.14 Implement `spineKvList(capabilityId: string, prefix?: string): Promise<Array<{ key: string; value: unknown }>>`. Body: lift from `case "/spine/kvList"`, including the `Array.from(...entries().map(...))` conversion.
- [x] 2.15 At this point, every spine method that currently has a real implementation in `handleSpineRequest` also exists as a public method on `AgentRuntime`. Run `bun run typecheck` — expect PASS. Run `bun run test` for `packages/runtime/agent-runtime` — expect PASS (existing tests still use the switch, no regression).
- [x] 2.16 Commit: "feat(agent-runtime): add public spine method surface mirroring HTTP bridge"

## 3. Phase 3 — Implement the previously-501 spine methods for real

- [x] 3.1 Implement `spineGetCompactionCheckpoint(sessionId: string): CompactionCheckpoint | null`. Body: `return this.sessionStore.getCompactionCheckpoint(sessionId);` — the session store already exposes this for the runtime's own compaction walker; the spine method is a thin pass-through.
- [x] 3.2 Implement `spineScheduleCreate(schedule: ScheduleInput): Promise<Schedule>`. Body: `return this.scheduleStore.create(schedule);`. Use the scheduleStore's existing create method — same interface used by capability-side schedule tools.
- [x] 3.3 Implement `spineScheduleUpdate(scheduleId: string, patch: SchedulePatch): Promise<void>`. Body: `await this.scheduleStore.update(scheduleId, patch);`.
- [x] 3.4 Implement `spineScheduleDelete(scheduleId: string): Promise<void>`. Body: `await this.scheduleStore.delete(scheduleId);`.
- [x] 3.5 Implement `spineScheduleList(): Promise<Schedule[]>`. Body: `return this.scheduleStore.list();`.
- [x] 3.6 Implement `spineAlarmSet(timestamp: number): Promise<void>`. Body: `await this.scheduler.setAlarm(timestamp);`.
- [x] 3.7 Add unit tests covering each of the six new method implementations. Location: `packages/runtime/agent-runtime/test/integration/spine-host.test.ts` OR a new `spine-host-schedule.test.ts` if the existing file grows large. Each test exercises the method directly on a DO stub (using the current HTTP route pattern is fine for this phase since the method isn't yet reachable via HTTP — the routes still fall through to `notImplemented`; new tests call the method directly on the DO stub, which works because Phase 2 added the public methods).
- [x] 3.8 Run `bun run typecheck` — PASS. Run `bun run test` for `packages/runtime/agent-runtime` — PASS including new tests.
- [x] 3.9 Commit: "feat(agent-runtime): implement previously-501 spine methods (compaction checkpoint, schedule, alarm)"

## 4. Phase 4 — Switch SpineService to direct method calls

- [x] 4.1 Open `packages/runtime/bundle-host/src/services/spine-service.ts`. Locate the 19 methods that use the `host.fetch(new Request("https://internal/spine/...", { method: "POST", body: JSON.stringify(...) }))` pattern.
- [x] 4.2 Rewrite `appendEntry` to call `host.spineAppendEntry(sid, entry)` directly. Keep the token verification, budget check, and error sanitization unchanged. The diff per method is roughly:
  ```diff
  - const res = await host.fetch(
  -   new Request("https://internal/spine/appendEntry", {
  -     method: "POST",
  -     body: JSON.stringify({ sessionId: sid, entry }),
  -   }),
  - );
  - return res.json();
  + return await host.spineAppendEntry(sid, entry);
  ```
- [x] 4.3 Rewrite `getEntries` analogously: `return await host.spineGetEntries(sid, options);`.
- [x] 4.4 Rewrite `getSession`: `return await host.spineGetSession(sid);`.
- [x] 4.5 Rewrite `createSession`: `return await host.spineCreateSession(init);` — note this method takes no `sid` parameter because session creation is agent-scoped, not session-scoped.
- [x] 4.6 Rewrite `listSessions`: `return await host.spineListSessions(filter);`.
- [x] 4.7 Rewrite `buildContext`: `return await host.spineBuildContext(sid);`.
- [x] 4.8 Rewrite `getCompactionCheckpoint`: `return await host.spineGetCompactionCheckpoint(sid);`.
- [x] 4.9 Rewrite `kvGet`: `return await host.spineKvGet(capabilityId, key);`.
- [x] 4.10 Rewrite `kvPut`: `await host.spineKvPut(capabilityId, key, value);`. No return value.
- [x] 4.11 Rewrite `kvDelete`: `await host.spineKvDelete(capabilityId, key);`.
- [x] 4.12 Rewrite `kvList`: `return await host.spineKvList(capabilityId, prefix);`.
- [x] 4.13 Rewrite `scheduleCreate`: `return await host.spineScheduleCreate(schedule);`.
- [x] 4.14 Rewrite `scheduleUpdate`: `await host.spineScheduleUpdate(scheduleId, patch);`.
- [x] 4.15 Rewrite `scheduleDelete`: `await host.spineScheduleDelete(scheduleId);`.
- [x] 4.16 Rewrite `scheduleList`: `return await host.spineScheduleList();`.
- [x] 4.17 Rewrite `alarmSet`: `await host.spineAlarmSet(timestamp);`.
- [x] 4.18 Rewrite `broadcast`: `host.spineBroadcast(sid, event as Record<string, unknown>);`. Note: the broadcast method returns `void`, so no `await` on return, but the call itself can be `await`ed if the DO method is async. Match the method declaration.
- [x] 4.19 Rewrite `broadcastGlobal`: `host.spineBroadcastGlobal(event as Record<string, unknown>);`.
- [x] 4.20 Rewrite `emitCost`: `host.spineEmitCost(sid, costEvent as CostEvent);`.
- [x] 4.21 Verify that every method still: (a) calls `this.verify(token)` first, (b) calls `this.budget.check(nonce, category)` before the host call, (c) wraps the host call in `try { ... } catch (err) { throw this.sanitize(err); }`. These are the security invariants and they stay byte-identical.
- [x] 4.22 Update the `SpineHost` import in `spine-service.ts` if needed. The interface is imported from `@claw-for-cloudflare/agent-runtime` (per P2 phase 5) and should be used as the type of the return value of `getHost(...)`.
- [x] 4.23 Update `private getHost(agentId: string): DurableObjectStub` to return `DurableObjectStub<SpineHost>` so the method calls are typed. In Cloudflare Workers types, `DurableObjectStub<T>` narrows the stub's method surface to `T`, enabling compile-time checking of method calls.
- [x] 4.24 Run `cd packages/runtime/bundle-host && bun run typecheck` — PASS. If it fails, the most likely cause is a method signature mismatch between SpineService's call site and AgentRuntime's method signature. Fix the method signatures in `AgentRuntime` to match.
- [x] 4.25 Commit: "refactor(bundle-host): switch SpineService to direct DO method calls"

## 5. Phase 5 — Add compile-time `SpineHost` satisfaction assertion

- [x] 5.1 Open `packages/runtime/agent-runtime/src/agent-do.ts`. Locate the documentation block added in P2 phase 5 that explains why the structural assertion doesn't compile — it's around line 720. Delete that documentation block.
- [x] 5.2 Replace with a working type-level assertion. The exact idiom:
  ```ts
  // Compile-time assertion that AgentDO structurally satisfies SpineHost.
  // If this line fails to compile, a spine method has been added, removed,
  // renamed, or had its signature changed on SpineHost without a
  // corresponding change on AgentRuntime / AgentDO. Fix the drift.
  type _SpineHostCheck = SpineHost extends ReturnType<typeof assertSpineHost>
    ? true
    : never;
  function assertSpineHost<T extends SpineHost>(x: T): T {
    return x;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _spineHostTypeCheck = (runtime: AgentRuntime<unknown>): SpineHost => runtime;
  ```
  The exact form can vary — any idiom that type-checks `AgentRuntime<TEnv>` (or `AgentDO<TEnv>`) against `SpineHost` and fails to compile on drift is acceptable. Pick the shortest form that survives Biome lint and TypeScript strict checks.
- [x] 5.3 Confirm the assertion compiles. `bun run typecheck` — PASS.
- [x] 5.4 (Optional, nice-to-have) Add a negative test using `@ts-expect-error`: a sibling assertion that deliberately constructs a `SpineHost`-shaped object missing one method, and proves the compile error occurs. Low priority — skip if the primary assertion is already clear.
- [x] 5.5 Commit: "feat(agent-runtime): enforce SpineHost satisfaction at compile time"

## 6. Phase 6 — Delete `handleSpineRequest` and the `/spine/*` route match

- [x] 6.1 In `packages/runtime/agent-runtime/src/agent-runtime.ts`, locate the fetch handler's `/spine/*` branch (around line 998). Delete it. The fetch handler no longer routes `/spine/*` anywhere.
- [x] 6.2 Delete the entire `handleSpineRequest` method (around line 3329). The method and its ~120 lines of switch statement are gone.
- [x] 6.3 Delete any unused helper functions that were only used by `handleSpineRequest`: `json<T>()`, `ok(value)`, `notImplemented(op)` if they were local to the method. If they were shared with another method, leave them.
- [x] 6.4 Delete unused imports in `agent-runtime.ts` that were only needed by `handleSpineRequest` — for example `createCapabilityStorage` if it's no longer referenced by anything else. (It probably still is, but check.) Run Biome to catch any unused imports that slip through.
- [x] 6.5 Run `bun run typecheck` from the repo root — PASS. If it fails because some other code expected the `handleSpineRequest` method to exist, investigate — likely a test helper. Update the test helper to use direct method calls.
- [x] 6.6 Run `grep -rn "/spine/" packages/runtime/agent-runtime/src` — expect zero hits in production code. There may still be references in test files at this point; that's Phase 7.
- [x] 6.7 Commit: "refactor(agent-runtime): delete handleSpineRequest HTTP routing"

## 7. Phase 7 — Rewrite `spine-host.test.ts` to exercise direct method calls

- [x] 7.1 Open `packages/runtime/agent-runtime/test/integration/spine-host.test.ts`. The file currently uses a `postJson(stub, path, body)` helper to post JSON requests to `/spine/*` routes on the DO stub.
- [x] 7.2 Delete the `postJson` helper.
- [x] 7.3 Rewrite each test case to call the corresponding method directly on the DO stub. Example:
  ```diff
  - const res = await postJson(stub, "/spine/appendEntry", { sessionId, entry });
  - expect(res.ok).toBe(true);
  - const entries = await (await postJson(stub, "/spine/getEntries", { sessionId })).json();
  + await stub.spineAppendEntry(sessionId, entry);
  + const entries = await stub.spineGetEntries(sessionId);
  ```
- [x] 7.4 Each scenario should retain its intent — "appendEntry persists", "broadcast reaches subscribers", "kvPut then kvGet round-trips", etc. Only the invocation mechanism changes.
- [x] 7.5 Update scenarios that tested specific HTTP response shapes (e.g., "expect 404 on unknown route") — delete them or rewrite them. There are no HTTP routes anymore; the scenario of "call an unknown spine method" now manifests as a TypeScript compile error at the call site, not a 404 at runtime.
- [x] 7.6 Add scenarios (if not already covered in Phase 3.7) for each of the six previously-501 methods. Demonstrate that they now succeed end-to-end.
- [x] 7.7 Run `cd packages/runtime/agent-runtime && bun test test/integration/spine-host.test.ts` — PASS.
- [x] 7.8 Commit: "test(agent-runtime): rewrite spine-host integration tests for direct method surface"

## 8. Phase 8 — Update `bundle-spine-bridge.test.ts` and any SpineService unit tests

- [x] 8.1 Open `packages/runtime/agent-runtime/test/integration/bundle-spine-bridge.test.ts`. Identify any code that mocks `host.fetch` to assert on Request URLs or body shapes. Update to mock the corresponding DO methods instead.
- [x] 8.2 If the test file uses the same `postJson` helper, update accordingly.
- [x] 8.3 Confirm the end-to-end flow (bundle → SpineService via service binding → SpineService → DO via direct method call → back out) still produces identical events and broadcasts to the client-facing transport.
- [x] 8.4 Open `packages/runtime/bundle-host/src/__tests__/*`. Look for tests that assert on SpineService's outgoing Request construction. Typical shape: `expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ url: "https://internal/spine/appendEntry" }))`. Rewrite to assert on DO method calls: `expect(hostMock.spineAppendEntry).toHaveBeenCalledWith(sessionId, entry)`.
- [x] 8.5 Run `cd packages/runtime/bundle-host && bun test` — PASS.
- [x] 8.6 Run `cd packages/runtime/agent-runtime && bun test test/integration/bundle-spine-bridge.test.ts` — PASS.
- [x] 8.7 Commit: "test: update bundle-spine-bridge and spine-service tests for direct RPC"

## 9. Phase 9 — Documentation

- [x] 9.1 Update `CLAUDE.md`'s "Bundle brain override" section. Remove any language that describes the spine bridge as HTTP-routed. Add a sentence clarifying that SpineService dispatches to the DO via direct RPC method calls on a typed `DurableObjectStub<SpineHost>`, and that the `SpineHost` interface is enforced at compile time.
- [x] 9.2 If any inline code comments in `spine-service.ts` or `agent-runtime.ts` reference the HTTP bridge or the `handleSpineRequest` pattern, remove or update them.
- [x] 9.3 Commit: "docs: update bundle system docs for direct spine RPC"

## 10. Phase 10 — Final verification

- [x] 10.1 Clean install: `rm -rf node_modules packages/*/*/node_modules && bun install`. Expect success.
- [x] 10.2 `bun run typecheck` from repo root — PASS across all 41 packages.
- [x] 10.3 `bun run lint` — compare error count to the P2 baseline. Should be equal or lower. Zero new errors introduced by this proposal's edits.
- [x] 10.4 `bun run test` — PASS on all bundle-related packages: `bundle-token`, `bundle-sdk`, `bundle-host`, `agent-runtime` (especially the spine integration tests), `agent-workshop`. Pre-existing miniflare flakes in `bundle-registry`, `cloudflare-sandbox`, and `e2e-agent-runtime` may still flake — compare to baseline and confirm this proposal introduced no new failures.
- [x] 10.5 Grep confirmation: `grep -rn "/spine/" packages/ examples/ e2e/ --include="*.ts" --include="*.tsx"` — expect zero hits in production source. Only comments/docs references should remain (if any).
- [x] 10.6 Grep confirmation: `grep -rn "handleSpineRequest" packages/` — expect zero hits. The method is gone.
- [x] 10.7 Grep confirmation: `grep -rn "host.fetch" packages/runtime/bundle-host/src/services/` — expect zero hits in spine-service.ts. (Other services or files may legitimately still use `host.fetch` for other purposes; this grep is scoped.)
- [x] 10.8 Spot-check: open `packages/runtime/agent-runtime/src/agent-do.ts`, confirm the compile-time `SpineHost` satisfaction assertion is present and unambiguously asserts on AgentRuntime / AgentDO.
- [x] 10.9 Spot-check: open `packages/runtime/bundle-host/src/services/spine-service.ts`, confirm `getHost` returns `DurableObjectStub<SpineHost>` and every method calls `host.spineX(...)` not `host.fetch(...)`.
- [x] 10.10 Manual smoke test: if a bundle-enabled example exists, run it locally with `bun dev` and exercise a turn. Confirm events stream to the client, entries persist, and no spine method errors appear in logs.
- [x] 10.11 (Optional, informational) Run the benchmark comparing before/after turn latency on a synthetic workload. Record numbers in the PR description or a follow-up issue. Not a gate.
