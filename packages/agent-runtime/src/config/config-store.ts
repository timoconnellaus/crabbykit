import type { KvStore } from "../storage/types.js";

/**
 * Persists capability config and consumer namespace values
 * in key-value storage.
 */
export class ConfigStore {
  constructor(private storage: KvStore) {}

  /** Read a capability's config. Returns `undefined` if not set. */
  async getCapabilityConfig<T = unknown>(capabilityId: string): Promise<T | undefined> {
    return this.storage.get<T>(`config:capability:${capabilityId}`);
  }

  /** Write a capability's config. */
  async setCapabilityConfig(capabilityId: string, value: unknown): Promise<void> {
    await this.storage.put(`config:capability:${capabilityId}`, value);
  }

  /** Read a consumer namespace value. Returns `undefined` if not set. */
  async getNamespace<T = unknown>(namespace: string): Promise<T | undefined> {
    return this.storage.get<T>(`config:ns:${namespace}`);
  }

  /** Write a consumer namespace value. */
  async setNamespace(namespace: string, value: unknown): Promise<void> {
    await this.storage.put(`config:ns:${namespace}`, value);
  }

  /**
   * Read an agent-level config namespace value.
   *
   * Agent-level namespaces are declared via the `config` field on
   * `defineAgent` and persist under `config:agent:{namespace}`. Returns
   * `undefined` when nothing has been written yet — callers should fall
   * back to `Value.Create(schema)` for defaults.
   */
  async getAgentConfig<T = unknown>(namespace: string): Promise<T | undefined> {
    return this.storage.get<T>(`config:agent:${namespace}`);
  }

  /** Write an agent-level config namespace value. */
  async setAgentConfig(namespace: string, value: unknown): Promise<void> {
    await this.storage.put(`config:agent:${namespace}`, value);
  }
}
