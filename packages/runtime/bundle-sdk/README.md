# `@crabbykit/bundle-sdk`

Authoring API for CLAW bundle brains. Consumers import `defineBundleAgent` from this package and produce a default-export fetch handler the host loads via Worker Loader.

```ts
import { defineBundleAgent } from "@crabbykit/bundle-sdk";

export default defineBundleAgent({
  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
  prompt: { agentName: "Helper" },
});
```

This package has zero dependency on the host (`bundle-host`) and zero path to the mint-side token primitives by construction — `vitest` enforces the invariant in `__tests__/mint-unreachable.test.ts`. See `CLAUDE.md` "Bundle brain override" for the full architecture story.

## Bundle HTTP and UI surface (`bundle-http-and-ui-surface`)

`BundleCapability` advertises HTTP routes and `capability_action` handlers that the host dispatches into the bundle isolate after running its normal `validateAuth` gate.

### `BundleCapability.httpHandlers`

```ts
import type { BundleCapability } from "@crabbykit/bundle-sdk";

const skills: BundleCapability = {
  id: "skills",
  name: "Skills",
  description: "Bundle-owned skills registry",
  httpHandlers: () => [
    {
      method: "POST",
      path: "/skills/registry",
      handler: async (req, ctx) => {
        // ctx.publicUrl, ctx.params, ctx.query, ctx.headers, ctx.kvStore, ...
        await ctx.kvStore.put("skills", "lastWrite", new Date().toISOString());
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ ok: true })),
        };
      },
    },
  ],
};
```

`BundleHttpContext` exposes:

| field | description |
|---|---|
| `capabilityId` | the owning `BundleCapability.id` |
| `agentId` | derived from the host-injected `__BUNDLE_TOKEN` |
| `sessionId` | `string \| null` — `null` for session-less HTTP routes (v1 default) |
| `publicUrl?` | host worker's `RuntimeContext.publicUrl` (mandatory for webhook capabilities per CLAUDE.md) |
| `params` | path params extracted from `:name` wildcards |
| `query` | parsed query string |
| `headers` | request headers, lowercased keys |
| `kvStore` | capability-scoped KV proxy (calls back through SpineService) |
| `channel` | session-scoped broadcast — no-op when `sessionId` is `null` |
| `emitCost` | persists a cost session entry + broadcasts `cost_event` |

**v1 parity gaps (NOT exposed):** `sendPrompt`, `sessionStore` (raw access), `rateLimit`, `agentConfig`. Each has a documented workaround — see proposal Non-Goals. Webhook → inference flows return the prompt text in the response body and let the upstream caller route it through `/prompt`.

**Body cap.** `BundleConfig.maxRequestBodyBytes` defaults to 256 KiB and is configurable up to 1 MiB. Requests over the cap return `413 Payload Too Large` without dispatching.

**Dispatch timeout.** `BundleConfig.httpDispatchTimeoutMs` defaults to 30 000 ms. On expiry the host returns `504 Gateway Timeout`.

**Streaming is a non-goal in v1.** Bundle authors who need it return 202 + a job id and stream output via `channel.broadcast` — same shape as the host's existing `/turn` SSE.

### `BundleCapability.onAction`

```ts
const files: BundleCapability = {
  id: "files-bundle",
  name: "Files (bundle)",
  description: "",
  onAction: async (action, data, ctx) => {
    if (action === "delete") {
      await ctx.channel.broadcast({
        type: "state_event",
        capabilityId: "files-bundle",
        event: "deleted",
        data,
      });
    }
  },
};
```

`BundleActionContext` exposes `capabilityId`, `agentId`, `sessionId`, `publicUrl?`, `kvStore`, `channel`, `spine` (lifecycle client), and `emitCost`.

### Reserved values

Build-time validation rejects:

- **Reserved path prefixes:** `/bundle/`, `/a2a-callback`, `/a2a`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`
- **Reserved path literals:** `/`, `/prompt`, `/schedules`
- **Reserved action capability ids:** `agent-config`, `schedules`, `queue`
- Methods outside `{GET, POST, PUT, DELETE}`, paths > 256 chars, missing leading slash, and intra-bundle duplicate `${method}:${path}` pairs.

Promotion-time and dispatch-time guards reject collisions with the host's currently-resolved static surface (`ERR_HTTP_ROUTE_COLLISION`, `ERR_ACTION_ID_COLLISION`). Both broadcast a `bundle_disabled` event with a structured `reason.code` payload and fall back to static.

### Metadata extraction constraint

`defineBundleAgent` walks `setup.capabilities(probeEnv)` once at build time with a minimal probe env (`{} as BundleEnv`) to populate `BundleMetadata.surfaces`. A capability whose `httpHandlers(ctx)` factory throws while reading a missing env field surfaces as `BundleMetadataExtractionError` naming the offending capability id. Bundle metadata is the source of truth — runtime-conditional routes that depend on env at probe time will not dispatch.

## Bundle config (`bundle-config-namespaces`)

Bundles get the same three-layer config model as static capabilities — per-capability config, agent-level config namespaces, custom configNamespaces. All schemas serialize into `BundleMetadata` at build time; host-side validation + persistence reuses the existing `config_set` / `config_get` / `config_schema` tools.

### Per-capability config

```ts
import { Type } from "@sinclair/typebox";
import type { BundleCapability } from "@crabbykit/bundle-sdk";

const search: BundleCapability = {
  id: "bundle-search",
  name: "Search",
  description: "",
  configSchema: Type.Object({
    defaultDepth: Type.Union([Type.Literal("basic"), Type.Literal("advanced")]),
    maxResults: Type.Number({ minimum: 1, maximum: 50 }),
  }),
  configDefault: { defaultDepth: "basic", maxResults: 5 },
  hooks: {
    onConfigChange: async (oldCfg, newCfg, ctx) => {
      // Fires BEFORE persistence. Throw to reject the write.
      await ctx.channel.broadcast({
        type: "state_event",
        capabilityId: "bundle-search",
        event: "config_changed",
        data: { oldCfg, newCfg },
      });
    },
  },
};
```

Persisted under `config:capability:bundle-search` — same key shape as static. Host surfaces the schema + default through `config_schema { namespace: "capability:bundle-search" }` and validates `config_set` input before dispatching `onConfigChange`.

### Agent-level config

```ts
import { Type } from "@sinclair/typebox";
import { defineBundleAgent, type BundleCapability } from "@crabbykit/bundle-sdk";

const cap: BundleCapability = {
  id: "search",
  name: "Search",
  description: "",
  agentConfigPath: "botConfig",        // dotted-path projection
  hooks: {
    onAgentConfigChange: async (oldSlice, newSlice, ctx) => {
      // ctx.agentConfig === newSlice (may be undefined — see safe-traversal)
    },
  },
};

export default defineBundleAgent({
  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
  config: {
    botConfig: Type.Object({
      rateLimit: Type.Number(),
      persona: Type.String(),
    }),
  },
  capabilities: () => [cap],
});
```

- `setup.config` maps top-level namespace id → TypeBox schema. Persisted under `config:agent:{ns}`.
- `BundleCapability.agentConfigPath` is a dotted-path expression evaluated host-side via `evaluateAgentConfigPath(snapshot, path)`. **Safe-traversal:** a missing intermediate segment returns `undefined`. Bundle authors MUST handle `ctx.agentConfig === undefined` defensively — the contract diverges from the static `agentConfigMapping: (s) => s.a.b.c` function, which would throw on a missing intermediate.
- The UI bridge `capability_action { capabilityId: "agent-config", action: "set", data: { namespace, value } }` works identically for bundle-declared and host-declared namespaces.

### Custom configNamespaces

```ts
const accounts: BundleCapability = {
  id: "bundle-telegram",
  name: "Telegram",
  description: "",
  configNamespaces: (ctx) => [
    {
      id: "telegram-accounts",
      description: "Telegram bot tokens keyed by account id",
      schema: Type.Object({ list: Type.Array(Type.String()) }),
      get: async () => (await ctx.kvStore.get("bundle-telegram", "accounts")) ?? { list: [] },
      set: async (_ns, value) => {
        await ctx.kvStore.put("bundle-telegram", "accounts", value);
        return "accounts saved";
      },
    },
  ],
};
```

Host validates the written value against `schema` BEFORE dispatching `set` to the bundle. Return type `string | void` matches the static `ConfigNamespace.set` contract — string becomes the tool output.

### Hook ordering

`onConfigChange` fires BEFORE `ConfigStore.setCapabilityConfig`. On `{ status: "error", message }` the tool returns the error and persistence is SKIPPED — matches static `config-set.ts:103-117` ordering. `onAgentConfigChange` fires AFTER `applyAgentConfigSet` persists — handler errors are logged but do NOT reverse persistence. Both dispatchers apply `BundleConfig.configHookTimeoutMs` (default 5 000 ms).

### Reserved values

Build-time validation rejects:

- **Reserved agent-config namespace ids:** `session`, `agent-config`, `schedules`, `queue`, anything starting with `capability:`, anything colliding with bundle-declared capability ids or `surfaces.actionCapabilityIds`.
- **Reserved configNamespace ids:** same reserved tokens; also rejects collisions with the bundle's own agent-config namespaces and capability ids.
- **`pattern` field on a configNamespace entry** — regex-based pattern-matched namespaces are a v1 Non-Goal. Use a single namespace with structured value (`{ schedules: { [id]: {...} } }`) instead.
- **TypeBox `Transform` / `Constructor` / `Function` Kinds** — runtime closures that cannot survive JSON serialization.

Promotion-time and dispatch-time guards reject collisions with the host's currently-resolved config surface: `ERR_AGENT_CONFIG_COLLISION`, `ERR_CONFIG_NAMESPACE_COLLISION`, `ERR_CAPABILITY_CONFIG_COLLISION`, `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE`. Each clears the bundle pointer and broadcasts `bundle_disabled` with a structured reason.

### Schema migration is the bundle author's responsibility

The framework does not auto-migrate `config:capability:{id}` or `config:agent:{ns}` payloads across schema changes. A bundle that renames `botConfig.rate` → `botConfig.rateLimit` ships its own migration (read old key in `onConfigChange`, write new shape, delete old). On a bundle-vs-host collision-disable, the persisted payload is retained under `config:agent:__orphans` so an operator can roll back and recover.

### Dual-API state: `agentConfigMapping` (static function) vs `agentConfigPath` (bundle declarative)

Static `Capability.agentConfigMapping: (snapshot) => slice` is a function — it can do arbitrary projection. Bundle `BundleCapability.agentConfigPath: string` is declarative — it covers simple projections (which is ~100% of observed use cases). If your bundle needs a transform, declare a derived agent-config namespace and project through it in a host-side capability. Documented asymmetry, not a parity break.
