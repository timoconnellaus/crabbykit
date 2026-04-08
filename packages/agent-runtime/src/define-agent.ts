import type { AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import { AgentDO } from "./agent-do.js";
import type {
  A2AClientOptions,
  AgentConfig,
  AgentContext,
  ErrorInfo,
  Logger,
  SubagentProfile,
} from "./agent-runtime.js";
import type { ResolvedCapabilities } from "./capabilities/resolve.js";
import type { Capability } from "./capabilities/types.js";
import type { Command, CommandContext } from "./commands/define-command.js";
import { buildDefaultSystemPrompt } from "./prompt/build-system-prompt.js";
import type { PromptOptions } from "./prompt/types.js";
import type { Schedule } from "./scheduling/types.js";
import type { SessionStore } from "./session/session-store.js";
import type { SqlStore } from "./storage/types.js";
import type { Transport } from "./transport/transport.js";

/**
 * Setup context passed to {@link AgentDefinition} factory functions that
 * need late-bound access to runtime state.
 *
 * Built exactly once at construction time by {@link defineAgent} and reused
 * for every factory callback invocation. Captures platform-agnostic identity
 * and stores — no raw Cloudflare primitives.
 */
export interface AgentSetup<TEnv> {
  /** The typed environment bindings object. */
  env: TEnv;
  /** Platform-agnostic agent identifier. */
  agentId: string;
  /** Abstract SQL store (not a raw `SqlStorage` handle). */
  sqlStore: SqlStore;
  /** Session store, already backed by {@link sqlStore}. */
  sessionStore: SessionStore;
  /** Abstract transport. */
  transport: Transport;
  /**
   * Resolve all tools (base + capability) for a given session. Synchronous —
   * matches the underlying {@link AgentRuntime.resolveToolsForSession}.
   */
  resolveToolsForSession: (sessionId: string) => {
    tools: AnyAgentTool[];
    context: AgentContext;
    resolved: ResolvedCapabilities;
  };
}

/**
 * Hooks object returned by {@link AgentDefinition.hooks}. The factory is
 * called once at construction time with the setup and its return value is
 * reused for the lifetime of the instance. Individual hook signatures match
 * {@link AgentDO}'s hook surface exactly.
 */
export interface AgentDefinitionHooks {
  validateAuth?: (request: Request) => boolean | Promise<boolean>;
  onTurnEnd?: (messages: AgentMessage[], toolResults: unknown[]) => void | Promise<void>;
  onAgentEnd?: (messages: AgentMessage[]) => void | Promise<void>;
  onSessionCreated?: (session: { id: string; name: string }) => void | Promise<void>;
  onScheduleFire?: (schedule: Schedule) => Promise<{ skip?: boolean; prompt?: string } | undefined>;
}

/**
 * Declarative agent definition consumed by {@link defineAgent}.
 *
 * Field-level design notes:
 * - `model` accepts a literal or a function of env (same pattern as `prompt`).
 * - `prompt: string` overrides the system prompt verbatim; capability sections
 *   are NOT appended. `prompt: PromptOptions` customizes the default sections;
 *   capability sections still append.
 * - `capabilities`, `subagentProfiles`, `a2a`, `hooks`, and `fetch` all receive
 *   the same {@link AgentSetup} reference so they can close over env bindings.
 * - There is no `name`/`description`/`configNamespaces`/`agentOptions` slot
 *   here — use {@link PromptOptions.agentName}/`agentDescription` for naming
 *   and fall back to `extends AgentDO` for the more advanced escape hatches.
 */
export interface AgentDefinition<TEnv = Record<string, unknown>> {
  /** LLM configuration. Literal or function of env. */
  model: AgentConfig | ((env: TEnv) => AgentConfig);

  /**
   * System prompt. A literal string replaces the default prompt (no capability
   * sections appended); a {@link PromptOptions} object customizes the default
   * sections (capability sections still append).
   */
  prompt?: string | PromptOptions;

  /** Tools — function receiving the per-session {@link AgentContext}. */
  tools?: (context: AgentContext) => AnyAgentTool[];

  /** Capabilities — function receiving the agent setup context. */
  capabilities?: (setup: AgentSetup<TEnv>) => Capability[];

  /** Subagent profiles — function receiving the agent setup context. */
  subagentProfiles?: (setup: AgentSetup<TEnv>) => SubagentProfile[];

  /** Slash commands — function receiving the per-session {@link CommandContext}. */
  commands?: (context: CommandContext) => Command[];

  /** A2A client options. Omit to disable. */
  a2a?: (setup: AgentSetup<TEnv>) => A2AClientOptions;

  /**
   * Lifecycle hooks factory. Called once at construction with the setup; the
   * returned object is reused for the lifetime of the instance.
   */
  hooks?: (setup: AgentSetup<TEnv>) => AgentDefinitionHooks;

  /** Optional logger. Defaults to a no-op logger. */
  logger?: Logger;

  /**
   * Error boundary. Called when tools throw, inference fails, hooks throw, or
   * HTTP routes throw. Observation-only; does not influence retry semantics.
   */
  onError?: (error: Error, info: ErrorInfo) => void;

  /**
   * Custom HTTP pre-routing handler. Runs before the runtime's default
   * routing. Return `null` to fall through; return a Response to short-circuit.
   */
  fetch?: (request: Request, setup: AgentSetup<TEnv>) => Promise<Response | null> | Response | null;
}

const CONSOLE_LOGGER: Logger = {
  debug: (msg, ctx) => console.debug(msg, ctx ?? ""),
  info: (msg, ctx) => console.info(msg, ctx ?? ""),
  warn: (msg, ctx) => console.warn(msg, ctx ?? ""),
  error: (msg, ctx) => console.error(msg, ctx ?? ""),
};

/**
 * Construct a Durable Object class from a flat {@link AgentDefinition}.
 *
 * The returned class extends {@link AgentDO} and wires each definition field
 * into the appropriate delegate method. Consumers bind it as a DO in their
 * wrangler config and use it directly — no subclassing required.
 *
 * ```ts
 * export const MyAgent = defineAgent<Env>({
 *   model: (env) => ({
 *     provider: "openrouter",
 *     modelId: "anthropic/claude-sonnet-4",
 *     apiKey: env.OPENROUTER_API_KEY,
 *   }),
 *   prompt: "You are a helpful assistant.",
 * });
 * ```
 */
export function defineAgent<TEnv = Record<string, unknown>>(
  definition: AgentDefinition<TEnv>,
): new (
  ctx: DurableObjectState,
  env: TEnv,
) => AgentDO<TEnv> {
  class GeneratedAgent extends AgentDO<TEnv> {
    private readonly _setup: AgentSetup<TEnv>;
    private readonly _hooks: AgentDefinitionHooks;

    constructor(ctx: DurableObjectState, env: TEnv) {
      super(ctx, env, {
        logger: definition.logger ?? CONSOLE_LOGGER,
        onError: definition.onError,
      });

      // Build setup once, after stores are initialized by super().
      this._setup = {
        env,
        agentId: this.runtime.runtimeContext.agentId,
        sqlStore: this.runtime.sqlStore,
        sessionStore: this.runtime.sessionStore,
        transport: this.runtime.transport,
        resolveToolsForSession: (sid) => this.runtime.resolveToolsForSession(sid),
      };

      // Build hooks once and remember the result.
      this._hooks = definition.hooks ? definition.hooks(this._setup) : {};

      // Wire hooks into the runtime so the runtime's optional-hook branches
      // actually fire.
      if (this._hooks.validateAuth) {
        this.validateAuth = this._hooks.validateAuth;
        this.runtime.validateAuth = this._hooks.validateAuth;
      }
      if (this._hooks.onTurnEnd) {
        this.onTurnEnd = this._hooks.onTurnEnd;
        this.runtime.onTurnEnd = this._hooks.onTurnEnd;
      }
      if (this._hooks.onAgentEnd) {
        this.onAgentEnd = this._hooks.onAgentEnd;
        this.runtime.onAgentEnd = this._hooks.onAgentEnd;
      }
      if (this._hooks.onSessionCreated) {
        this.onSessionCreated = this._hooks.onSessionCreated;
        this.runtime.onSessionCreated = this._hooks.onSessionCreated;
      }
      if (this._hooks.onScheduleFire) {
        this.onScheduleFire = this._hooks.onScheduleFire;
        this.runtime.onScheduleFire = this._hooks.onScheduleFire;
      }

      // Install the pre-fetch handler after setup is available.
      if (definition.fetch) {
        const userFetch = definition.fetch;
        const setup = this._setup;
        this.runtime.preFetchHandler = (request: Request) => userFetch(request, setup);
      }
    }

    getConfig(): AgentConfig {
      return typeof definition.model === "function"
        ? definition.model(this._setup.env)
        : definition.model;
    }

    getTools(context: AgentContext): AnyAgentTool[] {
      return definition.tools ? definition.tools(context) : [];
    }

    buildSystemPrompt(_context: AgentContext): string {
      if (typeof definition.prompt === "string") {
        return definition.prompt;
      }
      return buildDefaultSystemPrompt(this.getPromptOptions());
    }

    getPromptOptions(): PromptOptions {
      if (
        definition.prompt &&
        typeof definition.prompt === "object" &&
        !Array.isArray(definition.prompt)
      ) {
        return definition.prompt;
      }
      return {};
    }

    getCapabilities(): Capability[] {
      return definition.capabilities ? definition.capabilities(this._setup) : [];
    }

    getSubagentProfiles(): SubagentProfile[] {
      return definition.subagentProfiles ? definition.subagentProfiles(this._setup) : [];
    }

    getCommands(context: CommandContext): Command[] {
      return definition.commands ? definition.commands(context) : [];
    }

    getA2AClientOptions(): A2AClientOptions | null {
      return definition.a2a ? definition.a2a(this._setup) : null;
    }
  }

  return GeneratedAgent;
}
