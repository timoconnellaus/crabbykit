## Context

`AgentDO` is 2,700 lines and does two unrelated jobs: (1) provides the Cloudflare Durable Object lifecycle host (fetch, alarm, webSocketMessage, webSocketClose) and (2) runs the agent business logic (session management, LLM loop, capability system, scheduling, A2A, HTTP routing). Previous changes abstracted the platform primitives (SqlStore, KvStore, Scheduler, Transport) behind interfaces. The class hierarchy and lifecycle methods are the remaining CF coupling.

On top of that, consumers interact with AgentDO via class inheritance. The `BasicAgent` example overrides 7 methods, 95% of which return declarative literals. The override surface has 16 possible hooks. A newcomer has to learn "AgentDO" as a concept before they write any code.

**Two problems, two fixes, one change:**
1. Extract `AgentRuntime` from `AgentDO` (platform portability).
2. Expose a `defineAgent()` factory (consumer ergonomics).

Research confirmed: capability factories need late-bound access to `env`, `agentId`, `sqlStore`, `sessionStore`, `transport`, and `resolveToolsForSession`. A static config object can't work — functions that receive a `setup` context are required for `capabilities`, `tools`, and similar runtime-dependent fields.

## Goals / Non-Goals

**Goals:**
- `defineAgent({ model, tools, capabilities, ... })` returns a DurableObject class exportable directly from a worker
- Consumer config is a flat object with autocomplete — no class hierarchy to navigate
- Hello world is `defineAgent({ model: ..., prompt: "..." })` — three concepts, no boilerplate
- All current consumer patterns in `BasicAgent` reproducible with the factory
- `AgentRuntime` class contains all business logic with zero platform imports
- `extends AgentDO` escape hatch remains for consumers needing arbitrary custom routes or direct `this.ctx` access
- `examples/basic-agent` rewritten to demonstrate the new API
- The extracted runtime is ready for a future `@claw/node` adapter

**Non-Goals:**
- Creating a Node.js or Bun adapter
- A new `@claw/core` package (AgentRuntime stays in `agent-runtime`)
- Changing the capability system, transport protocol, or session store
- Removing `AgentDO`
- Provider helper functions (`openrouter("...")`, `anthropic("...")`) — out of scope; deferred to a follow-up
- Type-safe environment bindings in `defineAgent` (use `defineAgent<Env>({...})` with a user-provided generic)
- Prototyping the fluent builder alternative (acknowledged as a possible future revisit)

## Decisions

### 1. `defineAgent()` definition shape

```ts
export function defineAgent<TEnv = unknown>(def: AgentDefinition<TEnv>): {
  new (ctx: DurableObjectState, env: TEnv): DurableObject;
};

interface AgentDefinition<TEnv> {
  /** LLM configuration. Literal or function of env. */
  model: AgentConfig | ((env: TEnv) => AgentConfig);

  /** System prompt. Literal string, options object (used with default builder), or omitted. */
  prompt?: string | PromptOptions;

  /** Tools — function receiving the per-session AgentContext. */
  tools?: (ctx: AgentContext) => AnyAgentTool[];

  /** Capabilities — function receiving the agent setup context. */
  capabilities?: (setup: AgentSetup<TEnv>) => Capability[];

  /** Subagent profiles. */
  subagentProfiles?: (setup: AgentSetup<TEnv>) => SubagentProfile[];

  /** Slash commands — per-session, receives CommandContext. */
  commands?: (ctx: CommandContext) => Command[];

  /** A2A client options. Omit to disable. */
  a2a?: (setup: AgentSetup<TEnv>) => A2AClientOptions;

  /** Lifecycle hooks. Factory function so hooks close over setup. */
  hooks?: (setup: AgentSetup<TEnv>) => {
    validateAuth?: (request: Request) => boolean | Promise<boolean>;
    onTurnEnd?: (messages: AgentMessage[], toolResults: unknown[]) => void | Promise<void>;
    onAgentEnd?: (messages: AgentMessage[]) => void | Promise<void>;
    onSessionCreated?: (session: { id: string; name: string }) => void | Promise<void>;
    onScheduleFire?: (schedule: Schedule) => Promise<{ skip?: boolean; prompt?: string } | undefined>;
  };

  /** Optional logger. Defaults to a no-op logger. */
  logger?: Logger;

  /** Error boundary. Called when tools throw, inference fails, hooks throw, or HTTP routes throw. */
  onError?: (error: Error, info: { source: "tool" | "inference" | "hook" | "http"; sessionId?: string; toolName?: string }) => void;

  /** Custom HTTP routes. Return null to fall through to runtime default routing. */
  fetch?: (request: Request, setup: AgentSetup<TEnv>) => Promise<Response | null> | Response | null;
}

interface AgentSetup<TEnv> {
  env: TEnv;
  agentId: string;                                                    // platform-agnostic identity
  sqlStore: SqlStore;                                                 // abstract interface, pre-constructed
  sessionStore: SessionStore;
  transport: Transport;
  resolveToolsForSession: (sessionId: string) => { tools: AnyAgentTool[]; context: AgentContext; resolved: ResolvedCapabilities };
}

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}
```

**Why `model` not `config`:** `config` is too generic — it tells you nothing about what's inside. `model` clearly identifies the LLM configuration. Vercel AI SDK uses `model`. The provider/modelId/apiKey triple inside `AgentConfig` will eventually be wrapped by provider helper functions (`openrouter("...")`, etc.) — out of scope here, but the rename leaves room.

**Why literal-or-function for `model`:** Allows `model: ({ provider: "...", modelId: "...", apiKey: "..." })` for static cases and `model: (env) => ({ ..., apiKey: env.KEY })` when env is needed. Same pattern as `prompt`.

**Why `AgentSetup` not `AgentInitContext`:** This codebase already has `AgentContext`, `ToolExecuteContext`, `RuntimeContext`, `CommandContext`, and `CapabilityHookContext`. A sixth "...Context" compounds confusion. `AgentSetup` is short and visually distinct from `AgentContext`.

**Why `(setup) => value` consistently for env-dependent fields:** Capabilities, subagentProfiles, a2a, hooks, and fetch all need env access. Making the late-binding pattern consistent (one function shape, one parameter name) is more discoverable than mixing styles.

**Why `hooks` is itself a function:** Hooks need env access (to call bindings), but threading `init` through every hook signature is noise. Wrapping the hooks object in a single `(setup) => ({...})` function lets all hooks close over setup naturally and keeps individual hook signatures matching `AgentDO`'s existing protected hooks (clean delegation).

**Why no `prompt` builder form:** Zero existing consumers override `buildSystemPrompt` for dynamic per-session prompts. The capability system already handles dynamic via `promptSections`. Ship simpler; add later if demand materializes.

**Dropped fields (vs original draft):** `name`/`description` (already in `PromptOptions.agentName`/`agentDescription`), `configNamespaces` (capability-level concern, not factory), `agentOptions` (untyped escape hatch — escape hatch users go via `extends AgentDO`).

**Why `prompt: PromptOptions` translates to `getPromptOptions` not `buildSystemPrompt`:** The default `buildSystemPrompt(getPromptOptions())` flow already appends capability-contributed prompt sections. Setting `prompt: { agentName: "...", ... }` should just override `getPromptOptions` so capability sections still append. Setting `prompt: "..."` (a string) overrides `buildSystemPrompt` to return that string verbatim — capability sections are NOT appended in that case (consumer chose a literal).

**Alternative considered (and acknowledged):** A fluent builder pattern (`defineAgent().model(...).prompt(...).capability(...)`). Hono uses this successfully. The flat object is being kept for now because it's consistent with `defineTool` (already in this codebase) and Vercel AI SDK conventions, but a future change could prototype the builder if real consumer feedback shows discoverability problems with the flat shape.

### 2. `defineAgent()` returns a class, not an instance

```ts
// Consumer code:
export const MyAgent = defineAgent<Env>({
  model: (env) => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4", apiKey: env.KEY }),
  prompt: "You are a helpful assistant.",
});
// wrangler.toml binds MyAgent to the DO export
```

**Why a class:** Cloudflare Workers requires a DurableObject class export. Returning an instance would need a separate wrapping step.

**Internal implementation:** `defineAgent` returns an anonymous class that `extends AgentDO` and overrides each `get*` method to call the corresponding definition function via the `createDelegatingRuntime` helper. This means `defineAgent` sits on top of `AgentDO`, which sits on top of `AgentRuntime`. Three layers, each with one job: factory ergonomics, CF platform shell, business logic.

### 3. Extract `AgentRuntime` — composition via `createDelegatingRuntime`

Both `AgentDO` and `defineAgent` need to construct an `AgentRuntime` that forwards abstract methods to a host object. Rather than inline an anonymous-subclass-with-self-binding pattern in two places, define one helper:

```ts
// runtime-delegating.ts
export interface AgentDelegate<TEnv> {
  getConfig(): AgentConfig;
  getTools(ctx: AgentContext): AnyAgentTool[];
  buildSystemPrompt(ctx: AgentContext): string;
  getPromptOptions(): PromptOptions;
  getCapabilities(): Capability[];
  getSubagentProfiles(): SubagentProfile[];
  getConfigNamespaces(): ConfigNamespace[];
  getA2AClientOptions(): A2AClientOptions | null;
  getCommands(ctx: CommandContext): Command[];
  // Hooks (all optional)
  validateAuth?(request: Request): boolean | Promise<boolean>;
  onTurnEnd?(messages: AgentMessage[], toolResults: unknown[]): void | Promise<void>;
  onAgentEnd?(messages: AgentMessage[]): void | Promise<void>;
  onSessionCreated?(session: { id: string; name: string }): void | Promise<void>;
  onScheduleFire?(schedule: Schedule): Promise<{ skip?: boolean; prompt?: string } | undefined>;
}

export function createDelegatingRuntime<TEnv>(
  host: AgentDelegate<TEnv>,
  adapters: {
    sqlStore: SqlStore;
    kvStore: KvStore;
    scheduler: Scheduler;
    transport: Transport;
    runtimeContext: RuntimeContext;
    env: TEnv;
  },
): AgentRuntime<TEnv> {
  return new (class extends AgentRuntime<TEnv> {
    getConfig() { return host.getConfig(); }
    getTools(ctx: AgentContext) { return host.getTools(ctx); }
    buildSystemPrompt(ctx: AgentContext) { return host.buildSystemPrompt(ctx); }
    getPromptOptions() { return host.getPromptOptions(); }
    getCapabilities() { return host.getCapabilities(); }
    getSubagentProfiles() { return host.getSubagentProfiles(); }
    getConfigNamespaces() { return host.getConfigNamespaces(); }
    getA2AClientOptions() { return host.getA2AClientOptions(); }
    getCommands(ctx: CommandContext) { return host.getCommands(ctx); }
    // Hook delegations forward only if defined on host
    async validateAuth(request: Request) { return host.validateAuth?.(request) ?? true; }
    async onTurnEnd(messages, toolResults) { return host.onTurnEnd?.(messages, toolResults); }
    async onAgentEnd(messages) { return host.onAgentEnd?.(messages); }
    async onSessionCreated(session) { return host.onSessionCreated?.(session); }
    async onScheduleFire(schedule) { return host.onScheduleFire?.(schedule); }
  })(adapters.sqlStore, adapters.kvStore, adapters.scheduler, adapters.transport, adapters.runtimeContext, adapters.env);
}
```

**The delegation list is exactly:** 2 abstract methods + 8 optional overrides + 5 hooks. Nothing else. Internal helpers (`buildScheduleManager`, `handleAgentEvent`, `transformContext`, `resolveToolsForSession`, `createSessionBroadcast`, `broadcastCustomToAll`, etc.) are NOT delegated — they live entirely inside `AgentRuntime` and are not override points.

### 4. `AgentDO` becomes a thin shell

```ts
class AgentDO<TEnv> extends DurableObject<TEnv> implements AgentDelegate<TEnv> {
  // Hold the CF transport directly so webSocketMessage/webSocketClose can call its methods
  // without casting through the abstract Transport interface.
  protected readonly cfTransport: CfWebSocketTransport;
  protected readonly runtime: AgentRuntime<TEnv>;

  // Abstract methods AgentDO subclasses still implement:
  abstract getConfig(): AgentConfig;
  abstract getTools(ctx: AgentContext): AnyAgentTool[];

  // Defaults for optional overrides:
  buildSystemPrompt(ctx: AgentContext): string { return buildDefaultSystemPrompt(this.getPromptOptions()); }
  getPromptOptions(): PromptOptions { return {}; }
  getCapabilities(): Capability[] { return []; }
  getSubagentProfiles(): SubagentProfile[] { return []; }
  getConfigNamespaces(): ConfigNamespace[] { return []; }
  getA2AClientOptions(): A2AClientOptions | null { return null; }
  getCommands(ctx: CommandContext): Command[] { return []; }
  // Hooks declared optional, no defaults

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
    const sqlStore = createCfSqlStore(ctx.storage.sql);
    const kvStore = createCfKvStore(ctx.storage);
    const scheduler = createCfScheduler(ctx.storage);
    this.cfTransport = new CfWebSocketTransport(ctx);
    const runtimeContext = createCfRuntimeContext(ctx);
    this.runtime = createDelegatingRuntime(this, {
      sqlStore, kvStore, scheduler, transport: this.cfTransport, runtimeContext, env,
    });
  }

  // Lifecycle delegators
  fetch(request: Request) { return this.runtime.handleRequest(request); }
  alarm() { return this.runtime.handleAlarmFired(); }
  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) { return this.cfTransport.handleMessage(ws, msg); }
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) { return this.cfTransport.handleClose(ws, code, reason, wasClean); }

  // Protected getters delegating to runtime stores
  protected get sessionStore() { return this.runtime.sessionStore; }
  protected get scheduleStore() { return this.runtime.scheduleStore; }
  // ...etc for all current protected store properties
}
```

**Why hold `cfTransport` separately:** The abstract `Transport` interface doesn't expose `handleMessage`/`handleClose`/`handleUpgrade` — those are CF-specific WebSocket lifecycle methods. Casting through `this.runtime.transport as CfWebSocketTransport` is a code smell. Holding the concrete CF transport on AgentDO directly and passing the abstract `Transport` to `AgentRuntime` keeps the runtime platform-agnostic and removes the cast.

**Realistic line count:** ~150 lines (not 60). 35 protected getters + ~15 method declarations + constructor + 4 lifecycle forwards. Updated estimate.

### 5. `RuntimeContext` interface

```ts
interface RuntimeContext {
  readonly agentId: string;
  waitUntil(promise: Promise<unknown>): void;
}
```

`agentId` replaces the 15 call sites of `this.ctx.id.toString()`. `waitUntil` replaces the 1 call site of `this.ctx.waitUntil()`. A Node adapter would implement `waitUntil` as a pending-promise tracker or no-op.

### 6. `AgentRuntime` constructor

```ts
abstract class AgentRuntime<TEnv = unknown> {
  constructor(
    sqlStore: SqlStore,
    kvStore: KvStore,
    scheduler: Scheduler,
    transport: Transport,           // Abstract — never CfWebSocketTransport
    runtimeContext: RuntimeContext,
    env: TEnv,
  );

  // Public entry points
  handleRequest(request: Request): Promise<Response>;
  handleAlarmFired(): Promise<void>;

  // Stores (protected, accessed by AgentDO via getters)
  protected readonly sessionStore: SessionStore;
  protected readonly scheduleStore: ScheduleStore;
  protected readonly configStore: ConfigStore;
  protected readonly mcpManager: McpManager;
  protected readonly taskStore: TaskStore;
  protected readonly queueStore: QueueStore;       // Added (drift fix)
  protected readonly kvStore: KvStore;
  protected readonly scheduler: Scheduler;
  protected readonly transport: Transport;

  // Abstract — must be provided by subclass or via createDelegatingRuntime
  abstract getConfig(): AgentConfig;
  abstract getTools(ctx: AgentContext): AnyAgentTool[];

  // Optional overrides with defaults
  buildSystemPrompt(ctx: AgentContext): string;
  getPromptOptions(): PromptOptions;
  getCapabilities(): Capability[];
  getSubagentProfiles(): SubagentProfile[];        // Added (drift fix)
  getConfigNamespaces(): ConfigNamespace[];
  getA2AClientOptions(): A2AClientOptions | null;
  getCommands(ctx: CommandContext): Command[];

  // Lifecycle hooks (optional, no defaults)
  validateAuth?(request: Request): boolean | Promise<boolean>;
  onTurnEnd?(messages: AgentMessage[], toolResults: unknown[]): void | Promise<void>;
  onAgentEnd?(messages: AgentMessage[]): void | Promise<void>;
  onSessionCreated?(session: { id: string; name: string }): void | Promise<void>;
  onScheduleFire?(schedule: Schedule): Promise<{ skip?: boolean; prompt?: string } | undefined>;
}
```

### 7. `AgentSetup` is built once at construction, not per session

The `defineAgent` factory builds `AgentSetup` exactly once in the constructor of the AgentDO subclass it produces, then reuses the same reference for every callback (`capabilities`, `subagentProfiles`, `a2a`, `hooks`, `fetch`).

**Why once:** All fields (`env`, `agentId`, `sqlStore`, `sessionStore`, `transport`) are agent-lifetime, not session-scoped. `getCapabilities()` is called lazily and cached until `agent_end`, then cleared and rebuilt — but the rebuild uses the same setup. There's no value in reconstructing it.

**`resolveToolsForSession` is the one lazy field.** It takes `sessionId` as an argument and is called per-tool-execution. The function reference is stable, but the result depends on the session. Internally it calls `getTools()` and `getCachedCapabilities()` — these can recursively resolve, which is already how `batchTool` works today.

**Critical signature fix:** The earlier draft said `resolveToolsForSession: (sessionId) => Promise<AnyAgentTool[]>`. The actual method is **synchronous** and returns `{ tools, context, resolved }`. Match the real shape: `(sessionId: string) => { tools: AnyAgentTool[]; context: AgentContext; resolved: ResolvedCapabilities }`.

### 8. Drift fixes

Two pieces have been added to AgentDO since `extract-agent-runtime-core` was written:

1. **`QueueStore`** — added by the durable message queue work. Constructed from `sqlStore`, no platform coupling. Move with the other stores.
2. **`getSubagentProfiles()`** — added with the subagent packages. Another overridable method that returns a declarative array. Add to the abstract method surface.

Both are zero-risk additions.

### 9. Coverage handling

`agent-do.ts` is currently excluded from coverage thresholds (per CLAUDE.md: "coverage excludes: index.ts barrel files, type-only files, test helpers, agent-do.ts (DO lifecycle), mcp-manager.ts"). Moving ~2600 lines into `agent-runtime.ts` would subject all of it to the 98% statements / 100% functions thresholds. Many internal helpers (WebSocket wiring, HTTP routing, A2A dispatch, MCP callback) have little or no unit coverage today.

**Decision:** Add `agent-runtime.ts` to the coverage exclusion list in `vitest.config.ts`. This matches the existing convention. The runtime is integration-tested via the existing `AgentDO` test suite (which exercises the runtime via the CF shell). Future work can backfill unit tests with mock adapters now that the runtime is platform-agnostic.

### 10. `capabilities/types.ts` circular import

`capabilities/types.ts` currently imports `AgentContext` from `agent-do.js`. After the extraction, `AgentContext` lives in `agent-runtime.js`. The import path must be updated to `agent-runtime.js` to avoid pulling AgentDO (and `cloudflare:workers`) into capability type files.

### 11. Rewriting `basic-agent`

```ts
// examples/basic-agent/src/worker.ts
import { defineAgent } from "@claw-for-cloudflare/agent-runtime";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { taskTracker } from "@claw-for-cloudflare/task-tracker";
import { appRegistry } from "@claw-for-cloudflare/app-registry";
import { batchTool } from "@claw-for-cloudflare/batch-tool";
// ... other capability imports
import { getCurrentTimeTool } from "./tools/get-current-time";

export const BasicAgent = defineAgent<Env>({
  model: (env) => ({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
    apiKey: env.OPENROUTER_API_KEY,
  }),
  prompt: { agentName: "Basic Agent", agentDescription: "Example agent demonstrating CLAW" },
  tools: () => [getCurrentTimeTool],
  capabilities: ({ env, agentId, sqlStore, resolveToolsForSession }) => [
    compactionSummary({ /* ... */ }),
    r2Storage({ bucket: env.STORAGE_BUCKET, prefix: `agents/${agentId}` }),
    tavilyWebSearch({ apiKey: env.TAVILY_API_KEY }),
    taskTracker({ sql: sqlStore }),
    appRegistry({ db: env.AGENT_DB, sql: sqlStore }),
    batchTool({ getTools: (sessionId) => resolveToolsForSession(sessionId).tools }),
    // ...
  ],
  subagentProfiles: ({ env }) => [/* ... */],
  a2a: ({ env }) => ({ getAgentStub: (id) => env.AGENT.get(env.AGENT.idFromName(id)) }),
  hooks: ({ env }) => ({
    onTurnEnd: async (messages) => { /* can use env via closure */ },
  }),
  onError: (error, info) => {
    console.error(`[${info.source}]`, error.message, info);
  },
});

export default { fetch: () => new Response("OK") };
```

**Expected reduction:** ~375 lines → ~150 lines. The debug `fetch()` route in the current example becomes either (a) a `definition.fetch` handler that intercepts `/debug/*`, or (b) a custom AgentDO subclass for the debug-specific routes.

### 12. Escape hatch — `extends AgentDO` still works

Consumers who need direct `this.ctx` / `this.env` access, custom constructor logic, or arbitrary fetch routes that aren't well-served by the `definition.fetch` slot can still `extends AgentDO` as before. Documented as the advanced path.

## Risks / Trade-offs

**[Risk] Three-layer hierarchy (defineAgent → AgentDO → AgentRuntime)** → Each layer has one job. The middle layer (AgentDO) exists because (a) consumers extend it as the escape hatch and (b) it shares construction logic with `defineAgent` via `createDelegatingRuntime`. Acceptable. Documentation must make the three layers visually clear.

**[Risk] `createDelegatingRuntime` uses an anonymous subclass internally** → Encapsulated in one helper instead of inlined in two places. The pattern is now documented and testable. Consumers never see it.

**[Risk] Coverage exclusion of `agent-runtime.ts` masks low test coverage** → Acknowledged. Mitigation: track unit-test backfill as follow-up work. Integration tests via the AgentDO suite continue to exercise the runtime fully.

**[Trade-off] `defineAgent` sits on top of `AgentDO`, not `AgentRuntime` directly** → Could be slightly simpler (2 layers) if AgentDO didn't exist. AgentDO exists for the escape hatch. Keeping the factory wrapping AgentDO means consumers can incrementally drop down to subclassing without rewriting.

**[Trade-off] `definition.fetch` returning `null` for fall-through** → A null sentinel feels less clean than throwing or returning undefined. But it lets the consumer explicitly opt out per-request, which is what custom-route consumers want.

**[Trade-off] Logger has no production default** → Defaults to no-op so `console` is not polluted in tests. Consumers who want logging must wire one in. This is correct — the framework should not assume a logger.

**[Trade-off] `onError` is fire-and-forget** → Cannot influence whether the agent retries or aborts. For now this is observation only — error recovery happens via the existing per-tool error result mechanism. A future change could add a return-value contract if needed.
