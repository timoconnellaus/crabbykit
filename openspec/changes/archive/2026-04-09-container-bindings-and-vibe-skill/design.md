## Context

Container apps cannot access Worker bindings directly — only string env vars can be passed. The AI proxy currently works around this with `host.docker.internal` HTTP callbacks and bearer tokens. DB access doesn't exist in containers at all, forcing agents to use `bun:sqlite` (non-persistent across deploy) in dev and `env.DB` (DO-backed) in deploy.

Cloudflare's `ctx.container.interceptOutboundHttp(hostname, fetcher)` API lets the SandboxContainer DO transparently intercept outbound HTTP from the container and route it through a Fetcher with full binding access. This eliminates env var injection, token management, and `host.docker.internal` dependencies.

## Goals / Non-Goals

**Goals:**
- Container apps can use `env.DB.exec(sql, params)` that works identically in dev (container) and deploy (worker loader)
- Container apps can use `fetch("http://ai.internal/v1/chat/completions")` for AI, replacing the current env var pattern
- Virtual host registration is generic — capabilities register hosts, the sandbox layer handles interception
- A comprehensive vibe-webapp skill teaches agents the correct fullstack pattern

**Non-Goals:**
- Migrating R2 access from FUSE to interception — FUSE is the right abstraction for filesystem access
- Adding new binding types beyond DB and AI — but the pattern is extensible
- Changing the deploy-time architecture — deployed workers use `WorkerLoader.env` bindings as today

## Decisions

### 1. Interception registration via SandboxContainer DO

The `SandboxContainer` DO class (which extends `Container` from `@cloudflare/containers`) gains a `static outboundByHost` map that routes virtual hosts to handler methods. This is the pattern supported by the `Container` base class.

```typescript
export class SandboxContainer extends Container<SandboxContainerEnv> {
  static outboundByHost = {
    "db.internal": "handleDbRequest",
    "ai.internal": "handleAiRequest",
  };

  async handleDbRequest(request: Request): Promise<Response> {
    // Route to DbService via env.DB_SERVICE
  }

  async handleAiRequest(request: Request): Promise<Response> {
    // Route to AI proxy handler
  }
}
```

Alternative: Dynamic registration via `ctx.container.interceptOutboundHttp()` at runtime. Rejected — the static `outboundByHost` map is simpler and matches the Container class API. It also works before the container starts (interception is set up when the DO initializes).

### 2. DB handler routes SQL to DbService

The `handleDbRequest` method on SandboxContainer accepts:
- `POST /exec` with `{ sql, params, backendId }` → calls `env.DB_SERVICE.exec(backendId, sql, params)`
- `POST /batch` with `{ statements, backendId }` → calls `env.DB_SERVICE.batch(backendId, statements)`

The `backendId` is derived from the agent ID + app name, consistent with how `start_backend` derives it today. It's injected as an env var (`CLAW_DB_BACKEND_ID`) into the container on elevate so the client library can include it automatically.

### 3. Container DB client library (`packages/container-db`)

A tiny (~50 line) package that container apps import:

```typescript
import { createDB } from "@crabbykit/container-db";
const db = createDB(); // reads CLAW_DB_BACKEND_ID from process.env

const { columns, rows } = await db.exec("SELECT * FROM items");
await db.batch([
  { sql: "INSERT INTO items (name) VALUES (?)", params: ["Item A"] },
  { sql: "INSERT INTO items (name) VALUES (?)", params: ["Item B"] },
]);
```

Under the hood, `db.exec()` does `fetch("http://db.internal/exec", { body: JSON.stringify({ sql, params, backendId }) })`. The API matches what deployed workers see via `env.DB` from the `start_backend` wrapper.

Alternative: Have the agent write the fetch calls directly. Rejected — too error-prone and verbose. A client library keeps app code clean and identical to the deployed pattern.

### 4. AI handler replaces env var injection

The `handleAiRequest` method forwards to the same proxy logic currently in the ai-proxy capability's HTTP handler. The ai-proxy capability no longer injects `CLAW_AI_BASE_URL`/`CLAW_AI_TOKEN` env vars on elevate. Instead, container apps use:

```typescript
const ai = new OpenAI({
  baseURL: "http://ai.internal/v1",
  apiKey: "internal", // placeholder, interception handles auth
});
```

The token validation is no longer needed — interception is only accessible from within the container, which is already a trusted context (the agent controls what code runs there).

### 5. SandboxContainer needs DB_SERVICE and AI proxy bindings

The `SandboxContainer` DO needs access to `DbService` and the AI proxy's API key. These come from the DO's `env`:
- `DB_SERVICE`: Service binding (already configured in wrangler.jsonc for the worker, needs adding to the container DO's env)
- `OPENROUTER_API_KEY`: Secret (already in the worker env)

The consumer configures these in their container DO class or passes them through the existing sandbox provider setup.

### 6. Vibe-webapp skill content

The skill teaches the Bun fullstack pattern:
- Single `Bun.serve()` with HTML imports + API route handlers
- `createDB()` from `@crabbykit/container-db` for database access
- Tailwind via `bun-plugin-tailwind` + `bunfig.toml`
- Deployment via `deploy_app` with backend entry
- Common mistakes section

The skill is added as a seed in the example app's `D1SkillRegistry` and enabled by default.

## Risks / Trade-offs

**`interceptOutboundHttp` is not widely used** → The API exists in workerd types and `Container` class supports `static outboundByHost`. If the API has issues, we can fall back to the HTTP callback pattern (Option A from exploration). Low risk since the `Container` base class explicitly supports this pattern.

**DB_SERVICE binding on SandboxContainer DO** → The container DO currently only has R2 credentials. Adding DB_SERVICE requires updating wrangler.jsonc. The service binding is already configured for the worker — it just needs to be accessible to the DO too.

**container-db package adds a dependency for container apps** → Apps need to `bun add @crabbykit/container-db`. This is a small package with no dependencies. The alternative (raw fetch calls) is worse DX.

**Removing AI proxy env vars is breaking** → Any existing container app code using `process.env.CLAW_AI_BASE_URL` will break. Mitigation: update the prompt sections to teach the new pattern. Old apps in containers are ephemeral anyway — they're rebuilt each session.
