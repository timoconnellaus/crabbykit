## 1. Agent config types and storage

- [x] 1.1 Add `config` field to `AgentSetup` type in `packages/agent-runtime/src/agent-setup.ts` — `Record<string, TObject>` or `(env, setup) => Record<string, TObject>`, optional
- [x] 1.2 Add `agentConfig` to `AgentContext` interface — typed as `unknown | undefined` (capabilities narrow via their mapping function)
- [x] 1.3 Add `agent:{namespace}` key pattern to `ConfigStore` — read/write helpers `getAgentConfig(namespace)` / `setAgentConfig(namespace, value)` alongside existing `getCapabilityConfig` / `setCapabilityConfig`
- [x] 1.4 Add `onAgentConfigChange` optional hook to `Capability` interface in `capabilities/types.ts`

## 2. defineAgent wiring

- [x] 2.1 Add `config` field to `defineAgent` options in `define-agent.ts` — resolve literal or function-of-env at setup time, store on `AgentSetup`
- [x] 2.2 Add optional `config` mapping parameter to capability factory type — `(agentConfig: Record<string, unknown>) => T`
- [x] 2.3 Wire config mapping into capability resolution in `capabilities/resolve.ts` — call each capability's `config` function with current agent config, inject result as `context.agentConfig`

## 3. Config tools integration

- [x] 3.1 Extend `config_set` to handle agent-level namespaces — resolve `agent:{namespace}` keys, validate against schema, persist via `ConfigStore.setAgentConfig`, fire `onAgentConfigChange` on mapped capabilities whose slice changed
- [x] 3.2 Extend `config_get` to handle agent-level namespaces — read from `ConfigStore.getAgentConfig`, fall back to `Value.Create(schema)` for defaults
- [x] 3.3 Extend `config_schema` to include agent-level namespaces in output — list them alongside existing `capability:{id}` and custom namespaces
- [x] 3.4 Update namespace resolution priority in all three tools: `capability:{id}` → `session` → agent-level → custom namespaces

## 4. Broadcast and client hook

- [x] 4.1 Broadcast full agent config as `capability_state { capabilityId: "agent-config", event: "sync" }` on WebSocket connect — in the `onConnect` path in `agent-runtime.ts`
- [x] 4.2 Broadcast namespace update as `capability_state { capabilityId: "agent-config", event: "update", data: { namespace, value } }` after successful `config_set`
- [x] 4.3 Add `useAgentConfig()` hook to client package — subscribes to `"agent-config"` capability state, returns `{ config, setConfig }`, exposes `setConfig(namespace, value)` that sends `capability_action`
- [x] 4.4 Handle `capability_action` for `capabilityId: "agent-config"` in the runtime — route `action: "set"` to the `config_set` path (so the UI can mutate config without going through a tool call)

## 5. Tests

- [x] 5.1 Unit tests for `ConfigStore` agent config read/write/default round-trip
- [x] 5.2 Unit tests for config tool namespace resolution priority (agent-level vs capability vs custom)
- [x] 5.3 Unit tests for config validation — valid accepted, invalid rejected, defaults generated
- [x] 5.4 Unit tests for `onAgentConfigChange` hook dispatch — fires on relevant change, skips unrelated, skips unchanged
- [x] 5.5 Integration test: `defineAgent` with `config` field, capability with `config` mapping, verify `context.agentConfig` in tool execution
- [x] 5.6 Client hook test: `useAgentConfig` receives sync and update events

## 6. Reference migrations (capabilities)

Each migration: export a TypeBox config schema, accept the new `config` mapping parameter on the factory, read mapped values from `context.agentConfig`, keep old constructor params as deprecated fallbacks for one release, add `onAgentConfigChange` only where the capability holds derived state.

- [x] 6.1 `packages/heartbeat` — export `HeartbeatConfigSchema` (`every`, `timezone`, `sessionPrefix`, `retention`, `prompt`, `enabled`). Implement `onAgentConfigChange` to re-sync the schedule when `every`/`enabled`/`timezone` change.
- [x] 6.2 `packages/tavily-web-search` — export `TavilyConfigSchema` (`maxResults`, `userAgent`, `maxFetchSize`, `searchDefaults`). `tavilyApiKey` stays in the closure. Tools read tunables from `context.agentConfig` per call.
- [x] 6.3 `packages/doom-loop-detection` — export `DoomLoopConfigSchema` (`threshold`, `lookbackWindow`, `allowRepeatTools`). Remove the unused `configSchema`/`configDefault` on the capability object. Hook reads from `context.agentConfig`.
- [x] 6.4 `packages/tool-output-truncation` — export `ToolOutputTruncationConfigSchema` (`maxTokens`). Hook reads from `context.agentConfig`.
- [x] 6.5 `packages/channel-telegram` — export `TelegramRateLimitSchema` (`perSenderRateLimit`, `perAccountRateLimit`). Account list remains in `CapabilityStorage`. Verify rate-limiter consults `context.agentConfig` on each inbound, not at construction.

## 7. Reference-migration tests

- [x] 7.1 Per-capability test: migrated capability + `defineAgent` with mapped `config` — verify tool/hook reads the mapped value.
- [x] 7.2 Per-capability test: `config_set` against mapped namespace — verify capability behaviour changes without restart.
- [x] 7.3 Heartbeat-specific: schedule re-syncs after `onAgentConfigChange` (cron string change reflected in next fire time).
- [x] 7.4 Backward-compat test: each migrated capability still works when consumer passes the old constructor parameters and omits `config` mapping.

## 8. Example and docs

- [x] 8.1 Update `examples/basic-agent` to demonstrate agent-level config: define a `personality` namespace and wire migrated `heartbeat` + `tavily-web-search` through `config` mappings.
- [x] 8.2 Update each migrated capability's README with the new schema export, mapping example, and the deprecated-fallback note.
- [x] 8.3 Update root `CLAUDE.md` "Runtime-mutable capability state belongs in ConfigStore" section to reference the new agent-level path as the preferred mechanism alongside `CapabilityStorage`.

## 9. Follow-up (NOT in this change — track separately)

- [ ] 9.1 Migrate `packages/sandbox` (`idleTimeout`, `activeTimeout`, `defaultCwd`, `defaultExecTimeout`).
- [ ] 9.2 Migrate `packages/browserbase` (`perMinuteCostUsd`, `idleTimeout`, `maxDuration`, `contextId`).
- [ ] 9.3 Migrate `packages/vector-memory` (`maxSearchResults`, `maxReadBytes`).
- [ ] 9.4 Migrate `packages/r2-storage` (`maxReadBytes`).
- [ ] 9.5 Migrate `packages/compaction-summary` (`provider`, `modelId`, `compaction.*`, `pruneBudget`) — gated on `add-bundle-brain-override` decision; this is the bridge migration.
