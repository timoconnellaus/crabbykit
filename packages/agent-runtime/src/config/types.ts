import type { TObject } from "@sinclair/typebox";
import type { Capability } from "../capabilities/types.js";
import type { SessionStore } from "../session/session-store.js";
import type { ConfigStore } from "./config-store.js";

// Re-export from shared location
export type { ConfigNamespace } from "./config-namespace.js";

import type { ConfigNamespace } from "./config-namespace.js";

/**
 * Context passed to config tool factory functions.
 * Provides access to all stores and metadata needed by config_get/set/schema.
 */
export interface ConfigContext {
  /** The Durable Object ID of the agent (hex string). */
  agentId: string;
  /** Public base URL of the agent's host worker, if configured. See {@link CapabilityHookContext.publicUrl}. */
  publicUrl?: string;
  /** Current session ID. */
  sessionId: string;
  /** Session store for rename operations. */
  sessionStore: SessionStore;
  /** Config store for capability config persistence. */
  configStore: ConfigStore;
  /** All registered capabilities (for schema lookup and lifecycle hooks). */
  capabilities: Capability[];
  /** All config namespaces (from capabilities + consumer getConfigNamespaces). */
  namespaces: ConfigNamespace[];
  /**
   * Agent-level config schema declared on `defineAgent`'s `config` field.
   * Each top-level key is a namespace the config tools expose alongside
   * `capability:{id}` and custom namespaces.
   */
  agentConfigSchema: Record<string, TObject>;
  /**
   * Live snapshot of current agent-level config values. The runtime owns
   * this record — config_set mutates it in place (via
   * {@link onAgentConfigSet}) so subsequent tool executions see the new
   * values without waiting on `ConfigStore` reads.
   */
  agentConfigSnapshot: Record<string, unknown>;
  /**
   * Hook called by `config_set` after an agent-level namespace has been
   * validated and persisted. The runtime uses this to fire
   * `onAgentConfigChange` on mapped capabilities and broadcast the
   * `capability_state` update to clients. Optional in tests where the
   * broadcast/hook machinery isn't wired up.
   */
  onAgentConfigSet?: (namespace: string, oldValue: unknown, newValue: unknown) => Promise<void>;
}
