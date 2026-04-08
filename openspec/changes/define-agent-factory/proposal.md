## Why

Building an agent today requires extending `AgentDO`, a 2,700-line base class with ~35 protected members, 2 abstract methods, 9 optional overrides, and 5 lifecycle hooks — 16 possible override points scattered across a class hierarchy. Consumers inherit every feature (scheduling, A2A, MCP, queues, subagents) whether they use them or not. The example agent's `BasicAgent` class is ~290 lines where 95% is declarative configuration wrapped in class boilerplate.

The name `AgentDO` also leaks Cloudflare jargon. A newcomer has to learn "DO = Durable Object" before they can write hello world. Compare to Vercel AI SDK's `streamText({ model, messages })` — two concepts, function call, done.

Separately, `AgentDO` is still welded to Cloudflare's `DurableObject` lifecycle. The `extract-agent-runtime-core` proposal (designed but never implemented) would extract the business logic into a platform-agnostic `AgentRuntime` class so non-CF adapters become possible. That proposal is ~90% still accurate but has drifted (missing `QueueStore` and `getSubagentProfiles`). Rather than update the stale proposal and then layer a factory on top as a follow-up, this change does both at once.

## What Changes

- **Add `defineAgent(definition)` factory.** Returns a `DurableObject` class. Definition has flat fields: `model`, `tools`, `prompt`, `capabilities`, `subagentProfiles`, `commands`, `a2a`, `hooks`, `logger`, `onError`, `fetch`. Fields that need late-bound state accept a function `(setup) => value` where `setup: AgentSetup` provides `{ env, agentId, sqlStore, sessionStore, transport, resolveToolsForSession }`. Fields that don't need late binding accept literal values directly.
- **Extract `AgentRuntime` from `AgentDO`.** Create a platform-agnostic `AgentRuntime` class containing all business logic. AgentDO becomes a thin Cloudflare shell that creates CF adapters, instantiates AgentRuntime, and delegates DO lifecycle methods.
- **Add `RuntimeContext` interface.** Abstracts the two remaining CF-specific needs: `agentId: string` and `waitUntil(promise): void`.
- **Add `QueueStore` and `getSubagentProfiles()` to AgentRuntime.** Both missing from the original extract proposal — added here.
- **Split `CfWebSocketTransport` ownership.** AgentDO holds `CfWebSocketTransport` directly (for `webSocketMessage`/`webSocketClose` delegation) and passes the abstract `Transport` interface to `AgentRuntime`. Avoids casting through the runtime.
- **`createDelegatingRuntime(host, adapters)` helper.** Replaces the inline anonymous-subclass-with-self-binding pattern. Both `AgentDO` and `defineAgent` use this single helper to construct an `AgentRuntime` that forwards abstract methods to a host object.
- **`defineAgent()` becomes the blessed primary API.** `examples/basic-agent` is rewritten. README quick start uses it. The class-based `extends AgentDO` path remains as an escape hatch.
- **Supersedes `extract-agent-runtime-core`.** The existing change is archived.

## Capabilities

### New Capabilities
- `define-agent-factory`: The `defineAgent()` function, `AgentDefinition` shape, `AgentSetup` type, and the consumer-facing factory contract.
- `agent-runtime-core`: The platform-agnostic `AgentRuntime` class, `RuntimeContext` interface, CF adapter, `createDelegatingRuntime` helper, and the separation of business logic from platform bindings. (Replaces the spec from the superseded `extract-agent-runtime-core` change with updates for QueueStore, SubagentProfile, and the transport split.)

### Modified Capabilities

(none — all consumer-visible types remain)

## Impact

- **`packages/agent-runtime/src/agent-runtime.ts`** (new): ~2600 lines containing extracted business logic. Zero imports from `cloudflare:workers`.
- **`packages/agent-runtime/src/runtime-context.ts`** (new): `RuntimeContext` interface. ~20 lines.
- **`packages/agent-runtime/src/runtime-context-cloudflare.ts`** (new): `createCfRuntimeContext(ctx)` factory. ~15 lines.
- **`packages/agent-runtime/src/runtime-delegating.ts`** (new): `createDelegatingRuntime(host, adapters)` helper. ~80 lines.
- **`packages/agent-runtime/src/define-agent.ts`** (new): `defineAgent()` factory implementation. ~250 lines.
- **`packages/agent-runtime/src/agent-do.ts`**: Refactored from ~2700 lines to ~150 lines. Holds `CfWebSocketTransport` directly. Constructs CF adapters. Calls `createDelegatingRuntime`. Forwards DO lifecycle.
- **`packages/agent-runtime/src/capabilities/types.ts`**: Update `AgentContext` import to come from `agent-runtime.js` instead of `agent-do.js`.
- **`packages/agent-runtime/vitest.config.ts`**: Exclude `agent-runtime.ts` from coverage thresholds (matching the current exclusion of `agent-do.ts`). Without this, the extraction subjects ~2600 lines of un-unit-tested code to 98% statements / 100% functions thresholds.
- **`packages/agent-runtime/src/index.ts`**: Export `defineAgent`, `AgentDefinition`, `AgentSetup`, `AgentRuntime`, `RuntimeContext`, `createCfRuntimeContext`, `createDelegatingRuntime`. Continue exporting `AgentDO`.
- **`examples/basic-agent/src/worker.ts`**: Rewritten to use `defineAgent()`. Expected reduction from ~375 lines to ~150 lines.
- **README.md**: Quick start updated to show `defineAgent()`.
- **Downstream capability packages**: No changes. Verified that `task-tracker`, `a2a`, and `app-registry` already accept the abstract `SqlStore` interface. The factory provides `sqlStore: SqlStore` pre-constructed in the setup context.
- **`openspec/changes/extract-agent-runtime-core/`**: Archived as superseded.
