## Why

Container apps currently cannot access Worker bindings (DB, AI) natively. The AI proxy works around this with env vars and HTTP callbacks to `host.docker.internal`, and there's no DB access at all — apps must use `bun:sqlite` in dev (non-persistent across deploy) and `env.DB` in deploy (backed by Durable Object SQLite). This means the agent writes different backend code for dev vs deploy, and data doesn't carry over.

Cloudflare Containers support `interceptOutboundHttp(hostname, fetcher)` on the DO context, which transparently routes container HTTP requests to a Worker-side handler. This lets us expose `db.internal` and `ai.internal` virtual hosts that the container reaches without env vars, tokens, or `host.docker.internal`. The same app code works in both dev (interception) and deploy (service bindings via WorkerLoader).

With this infrastructure in place, we can write a comprehensive vibe-webapp skill that teaches agents the correct fullstack pattern using `env.DB` everywhere.

## What Changes

- **Container binding interception layer** in `packages/cloudflare-sandbox`: `SandboxContainer` DO registers outbound HTTP interceptions for virtual hosts (`db.internal`, `ai.internal`). Capabilities register their hosts via a new API on the sandbox provider.
- **DB interception handler**: Routes `http://db.internal/exec` and `http://db.internal/batch` to the `DbService` WorkerEntrypoint. Container app code uses a thin `env.DB` client that calls these endpoints.
- **AI interception handler**: Routes `http://ai.internal/v1/*` to the AI proxy handler. Replaces the current `CLAW_AI_BASE_URL` + `CLAW_AI_TOKEN` env var pattern.
- **Container DB client package** (`packages/container-db`): Tiny library that provides an `env.DB`-compatible interface backed by `fetch("http://db.internal/...")`. Apps import this in their server code.
- **AI proxy simplification**: Remove the env var injection from `ai-proxy` capability, switch to interception.
- **Vibe-webapp skill**: Comprehensive SKILL.md teaching the full Bun fullstack pattern with `env.DB`, styling, deployment. Added to example app skill seeds.
- **Prompt section update**: Update vibe-coder capability's prompt sections to reference `env.DB` (via container-db) instead of `bun:sqlite`.

## Capabilities

### New Capabilities
- `container-bindings`: Outbound HTTP interception layer on SandboxContainer DO for exposing Worker bindings to containers via virtual hosts.
- `container-db`: Client library for container apps providing `env.DB`-compatible interface over `http://db.internal`.
- `vibe-webapp-skill`: Skill content teaching fullstack Bun app development with env.DB, styling, and deployment.

### Modified Capabilities
- None at the spec level. The ai-proxy and vibe-coder prompt changes are implementation details, not spec-level requirement changes.

## Impact

- **`packages/cloudflare-sandbox`**: SandboxContainer DO gains interception registration and fetch handlers
- **`packages/ai-proxy`**: Simplified — drops env var injection, registers `ai.internal` interception instead
- **`packages/vibe-coder`**: Prompt sections updated to teach `env.DB` via container-db instead of `bun:sqlite`
- **New package `packages/container-db`**: Tiny client library (~50 lines) for container apps
- **`examples/basic-agent`**: Wiring for interceptions, new skill seed, updated vibe-coder config
- **Container apps**: Can now use `env.DB.exec(sql, params)` that works in both dev and deploy
