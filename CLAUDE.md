# CLAW for Cloudflare

Agent runtime framework for Cloudflare Workers with React UI.

## Project Structure

```
packages/agent-runtime   — Core runtime (Durable Objects, sessions, tools, MCP, compaction)
packages/agent-ui        — React chat components (Radix UI based)
packages/compaction-summary — Compaction capability (summarization via LLM)
examples/basic-agent     — Full-stack example (Vite + Cloudflare Worker)
```

## Commands

```bash
bun install              # Install dependencies
bun run test             # Run all tests across workspaces
bun run typecheck        # TypeScript check across workspaces
bun run lint             # Biome lint + format check
bun run lint:fix         # Auto-fix Biome issues
bun run format           # Format all files
```

Package-level:
```bash
cd packages/agent-runtime && bun test           # Runtime tests (Workers pool)
cd packages/agent-runtime && bun test:coverage  # With coverage thresholds
cd examples/basic-agent && bun dev              # Dev server
```

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects + SQLite
- **Frontend**: React 19 + Vite 6
- **Testing**: Vitest with @cloudflare/vitest-pool-workers (runtime), jsdom (UI)
- **Package manager**: Bun with workspaces
- **Linting/Formatting**: Biome (configured in biome.json)
- **Schema validation**: TypeBox (@sinclair/typebox)
- **AI SDK**: @mariozechner/pi-agent-core + pi-ai

## Architecture Rules

### Capabilities are the extension model

All agent extensions go through the `Capability` interface. Capabilities are stateless factories — they receive `AgentContext`, return tools/prompts/hooks. No side effects in `tools()` or `promptSections()`.

Registration order determines hook execution order. Each `beforeInference` hook receives the output of the previous one.

### Session entries are an immutable append-log

Never mutate existing entries. The tree structure (parent_id) supports branching. Compaction entries act as checkpoints — `buildContext()` walks from leaf to the most recent compaction boundary.

### Transport protocol uses discriminated unions

All messages (both `ServerMessage` and `ClientMessage`) discriminate on the `type` field. Server messages include `sessionId` except for global broadcasts. Protocol types use snake_case for `type` values (e.g., `agent_event`, `tool_event`) — this is intentional and matches the underlying event types from pi-agent-core.

### AgentDO is the base class consumers extend

Consumers implement `getConfig()`, `getTools()`, `buildSystemPrompt()`, and optionally `getCapabilities()`. Lifecycle hooks use `on{Event}` naming: `onTurnEnd`, `onAgentEnd`, `onSessionCreated`.

## TypeScript Rules

### No `any` in production code (enforced by Biome)

- Use `unknown` + type guards or type narrowing instead of `any`
- Exception: the lazy-loaded pi-SDK pattern in `agent-do.ts` — annotated with comment explaining why
- SQL row conversions use `as` casts in `rowToSession`/`rowToEntry` — this is the boundary, keep casts contained there
- Tests are exempt from `noExplicitAny` (configured in biome.json overrides)

### Import conventions

- **Libraries** (`agent-runtime`, `compaction-summary`): Use `.js` extensions in imports (required for ESM resolution)
- **Bundled apps** (`agent-ui`, `examples`): No extensions needed (Vite handles resolution)
- Use `import type` for type-only imports (enforced by Biome `useImportType`)
- Use `export type` for type-only re-exports (enforced by Biome `useExportType`)

### Naming conventions (enforced by Biome)

- Types/interfaces: PascalCase (`AgentConfig`, `SessionEntry`)
- Functions/methods: camelCase (`buildContext`, `defineTool`)
- Constants: UPPER_SNAKE_CASE (`SAFETY_MARGIN`, `DEFAULT_BASE_CHUNK_RATIO`)
- React components: PascalCase (`ChatPanel`, `MessageList`)
- Hooks: `use` prefix (`useChat`, `useAgentChat`)
- Capability IDs: kebab-case (`"compaction-summary"`)

### Export conventions

- Barrel exports via `index.ts` in each package
- Separate `export type { ... }` from `export { ... }`
- Re-export upstream types consumers need (AgentTool, AgentMessage, etc.) from the main package
- Never export internal implementation types (McpConnection, etc.)

## Error Handling Rules

- **Throw** when a caller passed invalid input (session not found, bad config)
- **Return `null`** when absence is a normal outcome (nothing to compact, no session yet)
- **Silent catch only** for fire-and-forget (WebSocket send to a dead connection)
- Never catch an error just to log it — either handle it meaningfully or let it propagate
- Error messages sent to clients use `ErrorMessage` with a machine-readable `code` field

## Cost Tracking

Capabilities that incur per-call costs (paid APIs, metered services) emit costs via `context.emitCost()`. The framework handles persistence (as custom session entries) and real-time broadcast (as `cost_event` transport messages).

### How to emit costs

In a capability's `tools(context)` factory, pass `context` to tool creators. In the tool's `execute` function, call `context.emitCost()` after a successful paid API call:

```ts
context.emitCost({
  capabilityId: "my-capability",  // Must match the capability's id field
  toolName: "my_tool",            // The tool that incurred the cost
  amount: 0.01,                   // Monetary amount
  currency: "USD",                // ISO 4217 currency code
  detail: "Human-readable note",  // Optional
  metadata: { key: "value" },     // Optional
});
```

### Rules

- Only emit costs for paid external API calls, not free operations
- Emit after successful execution, not on error (don't charge for failed calls)
- Use a named constant for the cost amount (e.g., `TAVILY_SEARCH_COST_USD = 0.01`)
- The `capabilityId` must match the capability's `id` field
- Costs are persisted as custom session entries with `customType: "cost"` and broadcast as `cost_event` messages

## Testing Rules

### Coverage thresholds (agent-runtime)

- Statements: 98%, Branches: 90%, Functions: 100%, Lines: 99%
- Coverage excludes: index.ts barrel files, type-only files, test helpers, agent-do.ts (DO lifecycle), mcp-manager.ts (external SDK)

### Test patterns

- Integration tests run in Cloudflare Workers pool via `@cloudflare/vitest-pool-workers`
- UI tests run in jsdom
- Test fixtures are generated separately (`vitest.generate.config.ts`)
- No mocking of `SessionStore` — test against real SQLite via Workers pool
- Every public function must have at least one test

### Test file locations

- `packages/agent-runtime/test/` — integration tests
- `packages/agent-runtime/src/*/__tests__/` — unit tests colocated with source
- `packages/agent-ui/src/**/*.test.tsx` — component tests

## Hook Naming Conventions

- **AgentDO lifecycle overrides** (called by framework): `on{Event}` — `onTurnEnd`, `onAgentEnd`, `onSessionCreated`
- **Capability hooks** (transform data in pipeline): `before{Stage}` / `after{Stage}` — `beforeInference`
- **React hooks** (standard React): `use{Thing}` — `useChat`, `useAgentChat`

## Configuration Defaults

- Extract defaults to module-level named constants: `const DEFAULT_MAX_RECONNECT_DELAY = 30_000`
- Config interfaces use optional fields with JSDoc documenting the default value
- Never inline magic numbers — always use a named constant

## Known Constraints

- **Lazy SDK imports**: pi-agent-core imports pi-ai which has a partial-json CJS issue in Workers test pool. The `loadPiSdk()` pattern in `agent-do.ts` is a workaround. Don't eager-import pi-* at module level.
- **Single Agent instance**: The Agent is created once per DO and reused across sessions via `replaceMessages()`. This is a known concurrency concern for multi-session DOs — document any changes to this pattern.
