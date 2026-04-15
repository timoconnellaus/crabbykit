import type { AgentMessage, AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type { TObject } from "@sinclair/typebox";
import {
  type A2AClientOptions,
  type AgentConfig,
  type AgentContext,
  AgentRuntime,
  type AgentRuntimeOptions,
} from "./agent-runtime.js";
import type { Capability } from "./capabilities/types.js";
import type { Command, CommandContext } from "./commands/define-command.js";
import type { ConfigNamespace } from "./config/types.js";
import type { Mode } from "./modes/define-mode.js";
import type { PromptOptions, PromptSection } from "./prompt/types.js";
import type { RuntimeContext } from "./runtime-context.js";
import type { Scheduler } from "./scheduling/scheduler-types.js";
import type { Schedule } from "./scheduling/types.js";
import type { KvStore, SqlStore } from "./storage/types.js";
import type { Transport } from "./transport/transport.js";

/**
 * Host contract for {@link createDelegatingRuntime}.
 *
 * A host object implements the abstract methods and any optional overrides
 * / hooks it cares about; the anonymous {@link AgentRuntime} subclass returned
 * by the factory forwards each call back to `host.*`.
 *
 * This is used internally by {@link AgentDO} (the Cloudflare platform shell)
 * and by the `defineAgent` factory to wire consumer configuration into a
 * runtime instance without a second class hierarchy.
 */
export interface AgentDelegate<_TEnv = Record<string, unknown>> {
  // Abstract methods (required)
  getConfig(): AgentConfig;
  getTools(context: AgentContext): AnyAgentTool[];

  // Optional overrides (runtime has defaults)
  /** Preferred section-returning override. */
  buildSystemPromptSections?(context: AgentContext): PromptSection[];
  /** @deprecated Prefer `buildSystemPromptSections`. */
  buildSystemPrompt?(context: AgentContext): string;
  getPromptOptions?(): PromptOptions;
  getCapabilities?(): Capability[];
  getModes?(): Mode[];
  getSubagentModes?(): Mode[];
  getConfigNamespaces?(): ConfigNamespace[];
  getAgentConfigSchema?(): Record<string, TObject>;
  getA2AClientOptions?(): A2AClientOptions | null;
  getCommands?(context: CommandContext): Command[];
  /**
   * Inject a custom agent options object (e.g. mocked streamFn for tests).
   * Optional — runtime defaults to `{}`.
   */
  getAgentOptions?(): Record<string, unknown>;
  /**
   * Override the ensureAgent loop entirely (e.g. to plug in a mock LLM).
   * When present, the delegating runtime calls this instead of its default.
   */
  ensureAgent?(sessionId: string): Promise<void>;

  // Lifecycle hooks (all optional)
  validateAuth?(request: Request): boolean | Promise<boolean>;
  onTurnEnd?(messages: AgentMessage[], toolResults: unknown[]): void | Promise<void>;
  onAgentEnd?(messages: AgentMessage[]): void | Promise<void>;
  onSessionCreated?(session: { id: string; name: string }): void | Promise<void>;
  onScheduleFire?(schedule: Schedule): Promise<{ skip?: boolean; prompt?: string } | undefined>;
}

/**
 * Adapters and identity passed to {@link createDelegatingRuntime} alongside
 * the delegate host.
 */
export interface DelegatingRuntimeAdapters<TEnv> {
  sqlStore: SqlStore;
  kvStore: KvStore;
  scheduler: Scheduler;
  transport: Transport;
  runtimeContext: RuntimeContext;
  env: TEnv;
  options?: AgentRuntimeOptions;
}

/**
 * Construct an {@link AgentRuntime} subclass whose abstract methods and
 * optional overrides forward to `host`. Hooks are only installed on the
 * runtime instance when the host actually provides them — absent hooks
 * stay `undefined` on the runtime so the optional-hook branches in the
 * business logic work unchanged.
 */
export function createDelegatingRuntime<TEnv>(
  host: AgentDelegate<TEnv>,
  adapters: DelegatingRuntimeAdapters<TEnv>,
): AgentRuntime<TEnv> {
  class DelegatingRuntime extends AgentRuntime<TEnv> {
    getConfig(): AgentConfig {
      return host.getConfig();
    }

    getTools(context: AgentContext): AnyAgentTool[] {
      return host.getTools(context);
    }

    buildSystemPromptSections(context: AgentContext): PromptSection[] {
      return host.buildSystemPromptSections
        ? host.buildSystemPromptSections(context)
        : super.buildSystemPromptSections(context);
    }

    buildSystemPrompt(context: AgentContext): string {
      return host.buildSystemPrompt
        ? host.buildSystemPrompt(context)
        : super.buildSystemPrompt(context);
    }

    getPromptOptions(): PromptOptions {
      return host.getPromptOptions ? host.getPromptOptions() : super.getPromptOptions();
    }

    getCapabilities(): Capability[] {
      return host.getCapabilities ? host.getCapabilities() : super.getCapabilities();
    }

    getModes(): Mode[] {
      return host.getModes ? host.getModes() : super.getModes();
    }

    getSubagentModes(): Mode[] {
      return host.getSubagentModes ? host.getSubagentModes() : super.getSubagentModes();
    }

    getConfigNamespaces(): ConfigNamespace[] {
      return host.getConfigNamespaces ? host.getConfigNamespaces() : super.getConfigNamespaces();
    }

    getAgentConfigSchema(): Record<string, TObject> {
      return host.getAgentConfigSchema ? host.getAgentConfigSchema() : super.getAgentConfigSchema();
    }

    getA2AClientOptions(): A2AClientOptions | null {
      return host.getA2AClientOptions ? host.getA2AClientOptions() : super.getA2AClientOptions();
    }

    getCommands(context: CommandContext): Command[] {
      return host.getCommands ? host.getCommands(context) : super.getCommands(context);
    }

    getAgentOptions(): Record<string, unknown> {
      return host.getAgentOptions ? host.getAgentOptions() : super.getAgentOptions();
    }

    async ensureAgent(sessionId: string): Promise<void> {
      if (host.ensureAgent) {
        return host.ensureAgent(sessionId);
      }
      return super.ensureAgent(sessionId);
    }
  }

  // Attach hooks only when host provides them, so the optional-hook branches
  // in AgentRuntime behave correctly (undefined vs. a no-op).
  const inst = new DelegatingRuntime(
    adapters.sqlStore,
    adapters.kvStore,
    adapters.scheduler,
    adapters.transport,
    adapters.runtimeContext,
    adapters.env,
    adapters.options,
  );

  if (host.validateAuth) {
    (inst as AgentRuntime<TEnv>).validateAuth = (request: Request) =>
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      host.validateAuth!(request);
  }
  if (host.onTurnEnd) {
    (inst as AgentRuntime<TEnv>).onTurnEnd = (messages: AgentMessage[], toolResults: unknown[]) =>
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      host.onTurnEnd!(messages, toolResults);
  }
  if (host.onAgentEnd) {
    (inst as AgentRuntime<TEnv>).onAgentEnd = (messages: AgentMessage[]) =>
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      host.onAgentEnd!(messages);
  }
  if (host.onSessionCreated) {
    (inst as AgentRuntime<TEnv>).onSessionCreated = (session: { id: string; name: string }) =>
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      host.onSessionCreated!(session);
  }
  if (host.onScheduleFire) {
    (inst as AgentRuntime<TEnv>).onScheduleFire = (schedule: Schedule) =>
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      host.onScheduleFire!(schedule);
  }

  return inst;
}
