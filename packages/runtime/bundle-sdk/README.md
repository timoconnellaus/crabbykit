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
