# @claw-for-cloudflare/agent-bundle

Bundle brain override for CLAW agents. Enables agents to swap their inference brain (system prompt, model, tools, capabilities) at runtime via bundles loaded through Cloudflare Worker Loader, without redeploying the worker.

## Architecture

The bundle is **not** a separate agent — it's an inference-loop override on the same agent. The static brain (defined at compile time via `defineAgent`) is always the fallback. Self-editing is safe by construction because removing the bundle reverts to the static brain.

```
┌─────────────────────────────────┐
│  Agent DO (defineAgent)         │
│  ┌───────────┐ ┌──────────────┐ │
│  │ Static    │ │ Bundle brain │ │
│  │ brain     │ │ (loaded via  │ │
│  │ (fallback)│ │ Worker Loader│ │
│  └───────────┘ └──────────────┘ │
│  Sessions • Transport • State   │
└─────────────────────────────────┘
```

## Authoring a Bundle

```ts
// my-bundle/src/index.ts
import { defineBundleAgent } from "@claw-for-cloudflare/agent-bundle/bundle";

export default defineBundleAgent({
  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
  prompt: { agentName: "CustomBrain" },
  metadata: { name: "CustomBrain", description: "My custom agent brain" },
});
```

Compile with `bun build`:
```bash
bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js \
  --external "cloudflare:workers" --external "cloudflare:sockets"
```

## Enabling Bundle Support

Add the `bundle` field to `defineAgent`:

```ts
export const MyAgent = defineAgent<Env>({
  // Static brain (always-available fallback)
  model: (env) => ({ provider: "openrouter", modelId: "...", apiKey: env.KEY }),
  prompt: { agentName: "MyAgent" },

  // Bundle config (opt-in)
  bundle: {
    registry: (env) => new D1BundleRegistry(env.BUNDLE_DB, env.BUNDLE_KV),
    loader: (env) => env.LOADER,
    authKey: (env) => env.AGENT_AUTH_KEY,
    bundleEnv: (env) => ({ LLM: env.LLM_SERVICE }),
  },
});
```

## BundleEnv Constraint

Bundle environments only accept service bindings and serializable values. Native Cloudflare bindings (`Ai`, `R2Bucket`, `D1Database`, etc.) are not allowed — they're not structured-cloneable across the loader boundary. The host's `bundleEnv` factory is the runtime gatekeeper.

## Security Model

- **Per-turn HMAC tokens**: Every SpineService/LlmService/capability-service method takes a sealed capability token as its first argument. Identity is derived from the verified payload — no method accepts sessionId as a caller-supplied argument.
- **HKDF per-service subkeys**: Each service gets its own verify-only subkey. A compromised service cannot mint tokens for other services.
- **globalOutbound: null**: Bundle isolates have no direct outbound network access. External services are reached via service bindings only.
- **Secrets never in bundles**: Provider API keys live in host-side LlmService. Capability credentials live in host-side capability services (e.g., TavilyService).

## Subpath Exports

| Subpath | Purpose | Consumers |
|---------|---------|-----------|
| `/bundle` | Bundle authoring API (`defineBundleAgent`, types) | Bundle source code |
| `/host` | Host-side services (`SpineService`, `LlmService`, `BundleDispatcher`) | Host worker |
| `/security` | Token mint/verify, HKDF derivation, nonce tracking | Both |

## Four-Layer Cache/Storage Model

1. **Worker Loader in-memory cache** — hot path, keyed by content hash (version ID)
2. **KV** — authoritative bundle bytes, keyed by `bundle:{versionId}`
3. **DO ctx.storage** — cached active version pointer per agent
4. **D1** — registry metadata, version pointers, deployment audit log
