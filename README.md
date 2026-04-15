# CLAW for Cloudflare

An open-source SDK for building AI agents on Cloudflare Workers.

## What It Does

CLAW gives you the primitives to build conversational AI agents that run on Cloudflare's edge infrastructure. You extend a base Durable Object class, register capabilities, and get a production-ready agent with:

- **Persistent sessions** — Immutable append-log backed by DO SQLite, with branching and compaction
- **Real-time streaming** — WebSocket transport with discriminated union protocol
- **Tool execution** — Schema-validated tools with structured responses
- **Capability system** — Composable extensions for adding tools, prompt sections, MCP servers, schedules, and lifecycle hooks
- **Modes** — Named filters over the agent's tool surface and prompt (planning, research, …). `/mode <id>`, `enter_mode`, `exit_mode`, and the mode badge are auto-registered when 1+ modes are defined — a single mode still gives you an "in vs out" toggle. `planMode` ships built-in. Imported from `@claw-for-cloudflare/agent-runtime/modes`.
- **Cost tracking** — Per-call cost emission, persistence, and real-time broadcast
- **React UI** — Drop-in chat components with styling isolation

## Packages

Packages are organised under `packages/<bucket>/<name>/` in seven role-based buckets. The dependency direction between buckets is enforced by `scripts/check-package-deps.ts` which runs during `bun run lint`.

### `runtime/` — engine and bundle plumbing

| Package | Description |
|---------|-------------|
| `agent-runtime` | Core runtime — AgentDO base class, session store, capability system, transport protocol, scheduling, MCP client |
| `agent-core` | LLM agent loop (internal, not published) |
| `ai` | Model provider abstraction (internal, not published) |
| `ai-proxy` | Host-side LLM inference proxy (`AiService` + `aiProxy`) |
| `bundle-token` | Verify-only capability token primitives (`verifyToken`, `NonceTracker`, `deriveVerifyOnlySubkey`) shared by bundle-host and bundle-sdk |
| `bundle-sdk` | Bundle authoring API — `defineBundleAgent`, prompt builders, bundle context types, runtime-source subpath (no path to mint code) |
| `bundle-host` | Host-side dispatcher, `SpineService` RPC bridge, `LlmService` multi-provider proxy, bundle-builder auto-rebuild, mint-side token helpers |
| `bundle-registry` | D1/KV bundle version store with content-addressed IDs, KV readback verification, atomic operations |
| `agent-workshop` | Agent-facing bundle authoring tools (init, build, test, deploy, disable, rollback, versions) |

### `infra/` — native-binding providers

| Package | Description |
|---------|-------------|
| `agent-storage` | Shared R2 identity (bucket + namespace prefix) passed to other capabilities |
| `agent-auth` | HTTP auth utilities |
| `credential-store` | Secure credential storage |
| `skill-registry` | D1-backed skill registry with self-seeding and `SkillRegistry` interface |
| `agent-registry` | D1-backed agent registry |
| `app-registry` | D1-backed app registry (deploy/rollback/delete tools) |
| `container-db` | Tiny client library for container apps providing `env.DB`-compatible interface over `db.internal` |
| `cloudflare-sandbox` | Sandbox provider implementation for Cloudflare Containers |

### `capabilities/` — brain-facing tools and hooks

| Package | Description |
|---------|-------------|
| `tavily-web-search` | Web search + fetch tools via Tavily API |
| `file-tools` | Nine file_* tools (read, write, edit, delete, list, tree, find, copy, move) backed by `agentStorage` |
| `vector-memory` | Semantic memory search backed by Cloudflare Vectorize + R2 |
| `browserbase` | Browser automation via Browserbase — CDP client, accessibility snapshots, cookie persistence |
| `skills` | On-demand procedural knowledge capability (skill_load tool, auto-update, agent-assisted merge) |
| `prompt-scheduler` | Schedule management exposed as agent tools |
| `task-tracker` | DAG task management |
| `sandbox` | Controlled shell execution with elevation model, tool surface, and `SandboxProvider` contract |
| `vibe-coder` | Live app preview with console capture (show_preview, hide_preview, get_console_logs) |
| `batch-tool` | Batch tool-call execution |
| `subagent` | Same-DO child agent spawning |
| `subagent-explorer` | Pre-built explorer subagent profile |
| `doom-loop-detection` | Repeated-tool-call loop detector |
| `tool-output-truncation` | Truncate oversized tool results |
| `compaction-summary` | LLM-based conversation compaction capability |
| `heartbeat` | Periodic heartbeat |

### `channels/` — input surfaces

| Package | Description |
|---------|-------------|
| `channel-telegram` | Telegram channel reference built on `defineChannel` — webhook verification, dual-bucket rate limiting, chunked outbound, bot-token redaction |

### `federation/` — multi-agent coordination

| Package | Description |
|---------|-------------|
| `a2a` | Agent-to-Agent protocol v1.0 |
| `agent-fleet` | Fleet management |
| `agent-peering` | HMAC peer-to-peer |

### `ui/` — client-side React

| Package | Description |
|---------|-------------|
| `agent-ui` | Composable React chat components (MessageList, ChatInput, StatusBar, ChannelsPanel, etc.) driven by the decomposed client hooks (`useChatSession`, `useSessions`, `useSchedules`, …) |

### `dev/` — build-time tooling

| Package | Description |
|---------|-------------|
| `vite-plugin` | Vite plugin for CLAW dev (bundled into containers) |

## Quick Start

```ts
import { defineAgent, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";

interface Env {
  OPENROUTER_API_KEY: string;
}

export const MyAgent = defineAgent<Env>({
  model: (env) => ({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
    apiKey: env.OPENROUTER_API_KEY,
  }),
  prompt: "You are a helpful assistant.",
  tools: () => [
    defineTool({
      name: "greet",
      description: "Greet a user",
      parameters: Type.Object({ name: Type.String() }),
      execute: async ({ name }) => ({
        content: [{ type: "text", text: `Hello, ${name}!` }],
        details: null,
      }),
    }),
  ],
});
```

Then bind `MyAgent` as a Durable Object in your `wrangler.toml` — it is
itself the DO class, no subclassing required.

### Customizing your agent

`defineAgent()` accepts a single flat configuration object. Every field is
optional except `model`:

```ts
defineAgent<Env>({
  // LLM configuration. Literal or function of env.
  model: (env) => ({ provider, modelId, apiKey: env.KEY }),

  // Literal string → override the full system prompt (no capability
  // sections appended). PromptOptions object → customize default sections.
  prompt: { agentName: "My Agent", agentDescription: "...", timezone: "UTC" },

  // Tools — receives the per-session AgentContext.
  tools: (ctx) => [/* defineTool(...) */],

  // Capabilities — receives AgentSetup with env, agentId, sqlStore,
  // sessionStore, transport, resolveToolsForSession.
  capabilities: ({ env, agentId, sqlStore }) => [
    compactionSummary({ /* ... */ }),
    fileTools({ /* ... */ }),
  ],

  // Session-level modes. With 1+ modes the runtime registers `/mode`,
  // `enter_mode`, `exit_mode`, and the mode badge — a single mode still
  // yields an "in vs out" toggle. Import `planMode` and `defineMode`
  // from `@claw-for-cloudflare/agent-runtime/modes`.
  modes: () => [planMode],

  // Modes used to spawn subagents via call_subagent / start_subagent.
  // Same `Mode` type as the `modes` slot above.
  subagentModes: ({ env }) => [/* ... */],
  commands: (ctx) => [/* defineCommand(...) */],
  a2a: ({ env }) => ({ getAgentStub: (id) => env.AGENT.get(env.AGENT.idFromName(id)) }),

  // Lifecycle hooks. Factory called once at construction with setup.
  hooks: ({ env }) => ({
    onTurnEnd: async (messages) => { /* ... */ },
    onAgentEnd: async (messages) => { /* ... */ },
  }),

  // Observability.
  logger: myLogger,
  onError: (err, info) => console.error(`[${info.source}]`, err),

  // Custom HTTP pre-routing. Return null to fall through.
  fetch: async (request, { sessionStore, transport }) => {
    // return Response or null
    return null;
  },
});
```

### Advanced Usage: `extends AgentDO`

If you need direct `this.ctx` / `this.env` access, custom constructor
logic, or more elaborate fetch routing, fall back to the class-based
escape hatch:

```ts
import { AgentDO, type AgentConfig, type AgentContext } from "@claw-for-cloudflare/agent-runtime";

export class MyAgent extends AgentDO<Env> {
  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
      apiKey: this.env.OPENROUTER_API_KEY,
    };
  }

  getTools(_context: AgentContext) {
    return [/* ... */];
  }

  // Override any of buildSystemPrompt, getPromptOptions, getCapabilities,
  // getCommands, getA2AClientOptions, validateAuth, onTurnEnd, etc.
}
```

Both paths run the same underlying `AgentRuntime` — the factory is a thin
wrapper. See `examples/basic-agent` for a full-featured sample using
`defineAgent`.

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects + SQLite
- **Frontend**: React 19 + Vite 6
- **Testing**: Vitest with @cloudflare/vitest-pool-workers
- **Package manager**: Bun workspaces
- **Linting**: Biome
- **Schema validation**: TypeBox

## Development

```bash
bun install                                      # Install dependencies
bun run test                                     # Run all tests
bun run typecheck                                # TypeScript check
bun run lint                                     # Biome lint + format check
cd examples/basic-agent && bun dev               # Run example
```

## License

MIT
