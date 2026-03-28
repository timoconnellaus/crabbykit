# CLAW for Cloudflare

An open-source SDK for building AI agents on Cloudflare Workers.

## What It Does

CLAW gives you the primitives to build conversational AI agents that run on Cloudflare's edge infrastructure. You extend a base Durable Object class, register capabilities, and get a production-ready agent with:

- **Persistent sessions** — Immutable append-log backed by DO SQLite, with branching and compaction
- **Real-time streaming** — WebSocket transport with discriminated union protocol
- **Tool execution** — Schema-validated tools with structured responses
- **Capability system** — Composable extensions for adding tools, prompt sections, MCP servers, schedules, and lifecycle hooks
- **Cost tracking** — Per-call cost emission, persistence, and real-time broadcast
- **React UI** — Drop-in chat components with styling isolation

## Packages

| Package | Description |
|---------|-------------|
| `agent-runtime` | Core runtime — AgentDO base class, session store, capability system, transport protocol, scheduling, MCP client |
| `agent-ui` | Composable React chat components (ChatPanel, MessageList, ChatInput, etc.) with `useAgentChat()` hook |
| `compaction-summary` | LLM-based conversation compaction capability |
| `tavily-web-search` | Web search + fetch tools via Tavily API |
| `prompt-scheduler` | Schedule management exposed as agent tools |
| `r2-storage` | R2-backed file storage (read, write, edit, delete, list, tree, find) |
| `vector-memory` | Semantic memory search backed by Cloudflare Vectorize + R2 |
| `sandbox` | Controlled shell execution with elevation model and process management |
| `cloudflare-sandbox` | Sandbox provider implementation for Cloudflare Containers |

Internal (not published): `agent-core` (LLM agent loop), `ai` (model provider abstraction).

## Quick Start

```ts
import { AgentDO, defineTool } from "@claw-for-cloudflare/agent-runtime";

export class MyAgent extends AgentDO {
  getConfig() {
    return { provider: "openrouter", model: "anthropic/claude-sonnet-4" };
  }

  buildSystemPrompt() {
    return "You are a helpful assistant.";
  }

  getTools() {
    return [
      defineTool({
        name: "greet",
        description: "Greet a user",
        parameters: Type.Object({ name: Type.String() }),
        execute: async ({ name }) => ({ content: `Hello, ${name}!` }),
      }),
    ];
  }
}
```

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
