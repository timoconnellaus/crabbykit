import type { AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type { TObject } from "@sinclair/typebox";
import { AgentDO } from "./agent-do.js";
import type {
  A2AClientOptions,
  AgentConfig,
  AgentContext,
  ErrorInfo,
  Logger,
} from "./agent-runtime.js";
import type { BundleConfig, BundleRegistry } from "./bundle-config.js";
import type { ResolvedCapabilities } from "./capabilities/resolve.js";
import type { Capability } from "./capabilities/types.js";
import type { Command, CommandContext } from "./commands/define-command.js";
import type { Mode } from "./modes/define-mode.js";
import {
  buildDefaultSystemPromptSections,
  estimateTextTokens,
} from "./prompt/build-system-prompt.js";
import type { PromptOptions, PromptSection } from "./prompt/types.js";
import type { Schedule } from "./scheduling/types.js";
import type { SessionStore } from "./session/session-store.js";
import type { SqlStore } from "./storage/types.js";
import type { Transport } from "./transport/transport.js";

export type { BundleConfig, BundleRegistry };

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
  /**
   * Resolved public base URL of the agent's host worker, if configured.
   * Mirrors the value surfaced on every `AgentContext` /
   * `CapabilityHookContext` / `CapabilityHttpContext`, so capability
   * factories can read it directly at construction time as well.
   */
  publicUrl?: string;
  /** Abstract SQL store (not a raw `SqlStorage` handle). */
  sqlStore: SqlStore;
  /** Session store, already backed by {@link sqlStore}. */
  sessionStore: SessionStore;
  /** Abstract transport. */
  transport: Transport;
  /**
   * Resolved agent-level config schema — a flat record of TypeBox object
   * schemas keyed by namespace name. Populated from
   * {@link AgentDefinition.config} (literal or function of env/setup).
   * Empty object when the consumer declared no `config` field.
   */
  configSchema: Record<string, TObject>;
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
 * - `capabilities`, `modes`, `subagentModes`, `a2a`, `hooks`, and `fetch` all
 *   receive the same {@link AgentSetup} reference so they can close over env
 *   bindings.
 * - There is no `name`/`description`/`configNamespaces`/`agentOptions` slot
 *   here — use {@link PromptOptions.agentName}/`agentDescription` for naming
 *   and fall back to `extends AgentDO` for the more advanced escape hatches.
 */
export interface AgentDefinition<TEnv = Record<string, unknown>> {
  /** LLM configuration. Literal or function of env. */
  model: AgentConfig | ((env: TEnv) => AgentConfig);

  /**
   * Public base URL of the agent's host worker. Surfaced on every
   * `AgentContext`, `CapabilityHookContext`, and `CapabilityHttpContext` so
   * capabilities that need to register external webhooks (Telegram, Slack,
   * A2A callbacks, …) can read it without demanding their own option.
   *
   * Resolution order at construction:
   * 1. This field, if set (literal or function of env).
   * 2. `env.PUBLIC_URL`, if it's a non-empty string.
   * 3. Otherwise undefined. Capabilities that need a public URL are
   *    expected to surface a clear error or fall back to deriving it
   *    from the incoming request origin.
   */
  publicUrl?: string | ((env: TEnv) => string | undefined);

  /**
   * System prompt. A literal string replaces the default prompt (no capability
   * sections appended); a {@link PromptOptions} object customizes the default
   * sections (capability sections still append).
   */
  prompt?: string | PromptOptions;

  /**
   * Agent-level config schema. A flat record of TypeBox object schemas
   * keyed by namespace name. Each key becomes a namespace the agent can
   * read/write via the existing `config_get` / `config_set` /
   * `config_schema` tools, validated against the schema. Capabilities map
   * slices of this record into their own context via their factory's
   * `config` parameter (see capability factories for examples).
   *
   * Accepts a literal or a function of `(env, setup)` for consistency
   * with other `defineAgent` fields that need env access. When omitted,
   * the agent has no agent-level config namespaces (existing behaviour).
   */
  config?:
    | Record<string, TObject>
    | ((env: TEnv, setup: AgentSetup<TEnv>) => Record<string, TObject>);

  /** Tools — function receiving the per-session {@link AgentContext}. */
  tools?: (context: AgentContext) => AnyAgentTool[];

  /** Capabilities — function receiving the agent setup context. */
  capabilities?: (setup: AgentSetup<TEnv>) => Capability[];

  /**
   * Session-level modes. When the returned array has one or more
   * modes, the runtime conditionally registers `/mode`, `enter_mode`,
   * and `exit_mode` — even a single registered mode yields two
   * effective states (in the mode vs out, `null`) so the toggle is
   * meaningful. Zero modes keeps the feature dormant.
   */
  modes?: (setup: AgentSetup<TEnv>) => Mode[];

  /**
   * Subagent spawn modes. Each mode describes a named scoped view used
   * by `call_subagent` / `start_subagent` when constructing a child.
   * Shares the same {@link Mode} type as the main-session `modes` slot;
   * a mode can appear in both.
   */
  subagentModes?: (setup: AgentSetup<TEnv>) => Mode[];

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

  /**
   * Optional bundle brain override. When provided, the agent gains the ability
   * to dispatch turns into a registry-backed bundle loaded via Worker Loader.
   * When omitted, the agent is purely static — exact same code path, exact
   * same wrangler config, exact same dependencies.
   *
   * The static fields (`model`, `prompt`, `tools`, `capabilities`) remain the
   * agent's identity and are always the fallback when no bundle is active.
   */
  bundle?: BundleConfig<TEnv>;
}

const CONSOLE_LOGGER: Logger = {
  debug: (msg, ctx) => console.debug(msg, ctx ?? ""),
  info: (msg, ctx) => console.info(msg, ctx ?? ""),
  warn: (msg, ctx) => console.warn(msg, ctx ?? ""),
  error: (msg, ctx) => console.error(msg, ctx ?? ""),
};

/**
 * Resolve an {@link AgentDefinition.publicUrl} field at construction time.
 * Falls back to `env.PUBLIC_URL` (convention) when the definition doesn't
 * provide one. Returned value is raw — the runtime normalizes trimming and
 * trailing slashes via `normalizePublicUrl`.
 */
function resolvePublicUrl<TEnv>(definition: AgentDefinition<TEnv>, env: TEnv): string | undefined {
  if (typeof definition.publicUrl === "function") {
    return definition.publicUrl(env);
  }
  if (typeof definition.publicUrl === "string") {
    return definition.publicUrl;
  }
  // Convention: read PUBLIC_URL off the env bindings. TEnv is opaque here,
  // so go through `unknown` to avoid polluting the public signature with an
  // implicit index-signature constraint.
  const envRecord = env as unknown as Record<string, unknown>;
  const fromEnv = envRecord?.PUBLIC_URL;
  return typeof fromEnv === "string" ? fromEnv : undefined;
}

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
        publicUrl: resolvePublicUrl(definition, env),
      });

      // Build setup once, after stores are initialized by super().
      const partialSetup: Omit<AgentSetup<TEnv>, "configSchema"> = {
        env,
        agentId: this.runtime.runtimeContext.agentId,
        publicUrl: this.runtime.publicUrl,
        sqlStore: this.runtime.sqlStore,
        sessionStore: this.runtime.sessionStore,
        transport: this.runtime.transport,
        resolveToolsForSession: (sid) => this.runtime.resolveToolsForSession(sid),
      };
      const configSchema: Record<string, TObject> =
        typeof definition.config === "function"
          ? definition.config(env, partialSetup as AgentSetup<TEnv>)
          : (definition.config ?? {});
      this._setup = { ...partialSetup, configSchema };

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

      // --- Bundle dispatch (only when bundle config is present) ---
      if (definition.bundle) {
        this.initBundleDispatch(ctx, env, definition.bundle);
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

    buildSystemPromptSections(_context: AgentContext): PromptSection[] {
      if (typeof definition.prompt === "string") {
        const raw = definition.prompt;
        return [
          {
            name: "System Prompt",
            key: "custom",
            content: raw,
            lines: raw.split("\n").length,
            tokens: estimateTextTokens(raw),
            source: { type: "custom" },
            included: true,
          },
        ];
      }
      return buildDefaultSystemPromptSections(this.getPromptOptions());
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

    getAgentConfigSchema(): Record<string, TObject> {
      return this._setup.configSchema;
    }

    getModes(): Mode[] {
      return definition.modes ? definition.modes(this._setup) : [];
    }

    getSubagentModes(): Mode[] {
      return definition.subagentModes ? definition.subagentModes(this._setup) : [];
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
