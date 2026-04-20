import type { TObject } from "@sinclair/typebox";

/**
 * A config namespace that can be read/written via config tools.
 * Contributed by capabilities (via `configNamespaces`) or by
 * consumers (via `getConfigNamespaces()` on AgentDO).
 */
export interface ConfigNamespace {
  /**
   * Namespace identifier (e.g. "model", "schedules").
   * For prefix-matched namespaces (e.g. "schedule:{id}"), set `id` to the
   * prefix (e.g. "schedule") and `pattern` to a regex with a capture group.
   */
  id: string;
  /** Human-readable description shown by config_schema. */
  description: string;
  /** TypeBox schema for validation and introspection. */
  schema: TObject;
  /**
   * Optional regex pattern for prefix-matched namespaces.
   * When set, this namespace matches any string matching the pattern
   * instead of requiring exact `id` equality.
   * Example: /^schedule:(.+)$/ matches "schedule:abc123".
   */
  pattern?: RegExp;
  /**
   * Read the current value.
   * @param namespace - The full namespace string (e.g. "schedule:abc123").
   */
  get: (namespace: string) => Promise<unknown>;
  /**
   * Write a new value. Value has already been validated against `schema` for
   * exact-match namespaces. For pattern-matched namespaces, the capability
   * is responsible for validation since the schema may vary.
   * @param namespace - The full namespace string.
   * @param value - The value to write (null for delete operations).
   * @returns Optional display string for the agent.
   */
  set: (namespace: string, value: unknown) => Promise<string | void>;
}
