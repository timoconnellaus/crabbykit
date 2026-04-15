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

// --- Bundle config types (inlined to avoid circular workspace dep) ---

/**
 * Registry interface for bundle version management.
 * Consumers provide a registry implementation (e.g., D1BundleRegistry).
 */
export interface BundleRegistry {
  getActiveForAgent(agentId: string): Promise<string | null>;
  setActive(
    agentId: string,
    versionId: string | null,
    opts?: { rationale?: string; sessionId?: string },
  ): Promise<void>;
  getBytes(versionId: string): Promise<ArrayBuffer | null>;
}

/**
 * Optional bundle config on {@link AgentDefinition}. When provided, the agent
 * gains the ability to dispatch turns into a registry-backed bundle loaded via
 * Worker Loader. When omitted, the agent is purely static — no new code paths,
 * no new dependencies, no overhead.
 */
export interface BundleConfig<TEnv = Record<string, unknown>> {
  /** Factory returning a BundleRegistry instance. */
  registry: (env: TEnv) => BundleRegistry;
  /** Factory returning the Worker Loader binding. */
  loader: (env: TEnv) => WorkerLoader;
  /** Factory returning the master HMAC key for capability token minting. */
  authKey: (env: TEnv) => string;
  /**
   * Factory projecting the bundle's env from the host env.
   * Only service bindings and serializable values. __SPINE_TOKEN is injected
   * automatically. Native bindings that aren't structured-cloneable cause
   * DataCloneError → fallback to static brain.
   */
  bundleEnv: (env: TEnv) => Record<string, unknown>;
  /** Consecutive load failures before auto-revert to static. Default: 3. */
  maxLoadFailures?: number;
}

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
        this._initBundleDispatch(ctx, env, definition.bundle);
      }
    }

    /**
     * Initialize bundle dispatch. Only called when `bundle` config is present.
     * Installs a prompt handler and HTTP routes for bundle management.
     */
    private _initBundleDispatch(
      ctx: DurableObjectState,
      env: TEnv,
      bundleConfig: BundleConfig<TEnv>,
    ): void {
      const agentId = this.runtime.runtimeContext.agentId;
      const registry = bundleConfig.registry(env);
      const loader = bundleConfig.loader(env);
      const masterKey = bundleConfig.authKey(env);
      const maxLoadFailures = bundleConfig.maxLoadFailures ?? 3;

      // Mutable dispatch state
      let consecutiveFailures = 0;
      let spineSubkeyPromise: Promise<CryptoKey> | null = null;
      let llmSubkeyPromise: Promise<CryptoKey> | null = null;

      const getSpineSubkey = async (): Promise<CryptoKey> => {
        if (!spineSubkeyPromise) {
          spineSubkeyPromise = (async () => {
            const { deriveSubkey } = await import("@claw-for-cloudflare/agent-bundle/security");
            return deriveSubkey(masterKey, "claw/spine-v1");
          })();
        }
        return spineSubkeyPromise;
      };

      const getLlmSubkey = async (): Promise<CryptoKey> => {
        if (!llmSubkeyPromise) {
          llmSubkeyPromise = (async () => {
            const { deriveSubkey } = await import("@claw-for-cloudflare/agent-bundle/security");
            return deriveSubkey(masterKey, "claw/llm-v1");
          })();
        }
        return llmSubkeyPromise;
      };

      const checkActiveBundle = async (): Promise<string | null> => {
        // Warm path: ctx.storage
        const cached = await ctx.storage.get<string | null>("activeBundleVersionId");
        if (cached !== undefined) {
          return cached;
        }
        // Cold path: registry query
        const id = await registry.getActiveForAgent(agentId);
        await ctx.storage.put("activeBundleVersionId", id);
        return id;
      };

      // Install the bundle pointer refresher on the runtime. This is the
      // single authoritative writer of `ctx.storage.activeBundleVersionId`
      // for in-process pointer mutations. Workshop tools (and any other
      // capability that calls `bundle-registry.setActive`) MUST call
      // `AgentContext.notifyBundlePointerChanged()` after a successful
      // mutation — that runs through here.
      this.runtime.bundlePointerRefresher = async () => {
        const id = await registry.getActiveForAgent(agentId);
        await ctx.storage.put("activeBundleVersionId", id);
        consecutiveFailures = 0;
      };

      // Install the bundle prompt handler on the runtime
      this.runtime.bundlePromptHandler = async (
        sessionId: string,
        _text: string,
      ): Promise<boolean> => {
        const versionId = await checkActiveBundle();
        if (!versionId) {
          return false; // No active bundle → static brain
        }

        try {
          const [spineSubkey, llmSubkey] = await Promise.all([getSpineSubkey(), getLlmSubkey()]);
          const { mintToken } = await import("@claw-for-cloudflare/agent-bundle/security");
          // Mint a separate token per service. Same payload (agentId,
          // sessionId, nonce, exp) but signed with each service's HKDF
          // subkey so SpineService and LlmService can verify
          // independently. Reusing one token across services would
          // require both services to share a subkey, which defeats the
          // domain-separation that HKDF labels were added for.
          const [spineToken, llmToken] = await Promise.all([
            mintToken({ agentId, sessionId }, spineSubkey),
            mintToken({ agentId, sessionId }, llmSubkey),
          ]);

          const projectedEnv = bundleConfig.bundleEnv(env);

          const worker = loader.get(versionId, async () => {
            const bytes = await registry.getBytes(versionId);
            if (!bytes) {
              throw new Error(`Bundle bytes not found for version ${versionId}`);
            }
            const source = new TextDecoder().decode(bytes);
            return {
              compatibilityDate: "2025-12-01",
              compatibilityFlags: ["nodejs_compat"],
              mainModule: "bundle.js",
              modules: { "bundle.js": source },
              env: {
                ...projectedEnv,
                __SPINE_TOKEN: spineToken,
                __LLM_TOKEN: llmToken,
              },
              globalOutbound: null,
            };
          });

          const res = await worker.getEntrypoint().fetch(
            new Request("https://bundle/turn", {
              method: "POST",
              body: JSON.stringify({ prompt: _text, agentId, sessionId }),
            }),
          );

          if (!res.ok) {
            throw new Error(`Bundle turn returned ${res.status}`);
          }

          // Drain the body so the bundle's ReadableStream work()
          // promise resolves and finally{} broadcasts agent_end before
          // we return. Bundle broadcasts streaming events live via
          // SpineService → transport.broadcastToSession; the HTTP body
          // itself is just a short ack.
          await res.text();

          consecutiveFailures = 0;
          return true;
        } catch (err) {
          consecutiveFailures++;
          const errMsg = err instanceof Error ? err.message : String(err);
          this.runtime.logger.error(
            `[BundleDispatch] Failure ${consecutiveFailures}/${maxLoadFailures}: ${errMsg}`,
          );

          if (consecutiveFailures >= maxLoadFailures) {
            this.runtime.logger.warn("[BundleDispatch] Auto-reverting to static brain");
            try {
              await registry.setActive(agentId, null, {
                rationale: "auto-revert: poison bundle",
              });
            } catch (revertErr) {
              this.runtime.logger.error("[BundleDispatch] Failed to auto-revert", {
                error: revertErr instanceof Error ? revertErr.message : String(revertErr),
              });
            }
            consecutiveFailures = 0;
            await ctx.storage.put("activeBundleVersionId", null);
          }

          return false; // Fall through to static brain
        }
      };

      // Install the client event handler for steer/abort during bundle turns.
      this.runtime.bundleClientEventHandler = async (
        sessionId: string,
        event: unknown,
      ): Promise<void> => {
        const versionId = await checkActiveBundle();
        if (!versionId) return;

        try {
          const [spineSubkey, llmSubkey] = await Promise.all([getSpineSubkey(), getLlmSubkey()]);
          const { mintToken: mint } = await import("@claw-for-cloudflare/agent-bundle/security");
          const [spineToken, llmToken] = await Promise.all([
            mint({ agentId, sessionId }, spineSubkey),
            mint({ agentId, sessionId }, llmSubkey),
          ]);
          const projectedEnv = bundleConfig.bundleEnv(env);

          const worker = loader.get(versionId, async () => {
            const bytes = await registry.getBytes(versionId);
            if (!bytes) throw new Error("Bundle bytes not found");
            const source = new TextDecoder().decode(bytes);
            return {
              compatibilityDate: "2025-12-01",
              compatibilityFlags: ["nodejs_compat"],
              mainModule: "bundle.js",
              modules: { "bundle.js": source },
              env: {
                ...projectedEnv,
                __SPINE_TOKEN: spineToken,
                __LLM_TOKEN: llmToken,
              },
              globalOutbound: null,
            };
          });

          await worker.getEntrypoint().fetch(
            new Request("https://bundle/client-event", {
              method: "POST",
              body: JSON.stringify(event),
            }),
          );
        } catch (err) {
          // Client event delivery is best-effort
          this.runtime.logger.warn("[BundleDispatch] Client event delivery failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      // Install the pre-fetch handler for bundle HTTP endpoints.
      // Chain with any existing pre-fetch handler.
      const existingPreFetch = this.runtime.preFetchHandler;
      this.runtime.preFetchHandler = async (request: Request) => {
        const url = new URL(request.url);

        // POST /bundle/disable — out-of-band privileged endpoint
        if (url.pathname === "/bundle/disable" && request.method === "POST") {
          // Auth check via the runtime's validateAuth (if configured)
          if (this.runtime.validateAuth) {
            const allowed = await this.runtime.validateAuth(request);
            if (!allowed) {
              return new Response("Unauthorized", { status: 401 });
            }
          }

          await registry.setActive(agentId, null, {
            rationale: "out-of-band disable",
          });
          consecutiveFailures = 0;
          await ctx.storage.put("activeBundleVersionId", null);

          return Response.json({ status: "disabled" });
        }

        // POST /bundle/refresh — signal to refresh the cached pointer.
        // Out-of-band escape hatch: another worker / admin script that
        // wrote `registry.setActive(...)` directly POSTs here to force
        // this DO to re-read the active pointer. Delegates to the same
        // refresher that in-process callers reach via
        // `AgentContext.notifyBundlePointerChanged`.
        if (url.pathname === "/bundle/refresh" && request.method === "POST") {
          await this.runtime.bundlePointerRefresher?.();
          const id = (await ctx.storage.get<string | null>("activeBundleVersionId")) ?? null;
          return Response.json({ status: "refreshed", activeVersionId: id });
        }

        // Reserve /bundle/* paths — never forward to bundle
        if (url.pathname.startsWith("/bundle/")) {
          return new Response("Not found", { status: 404 });
        }

        // Fall through to existing pre-fetch handler
        if (existingPreFetch) {
          return existingPreFetch(request);
        }
        return null;
      };
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
