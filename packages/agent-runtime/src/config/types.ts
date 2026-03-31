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
}
