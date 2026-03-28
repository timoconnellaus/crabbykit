/**
 * Persists capability config and consumer namespace values
 * in Durable Object key-value storage.
 */
export class ConfigStore {
  constructor(private storage: DurableObjectStorage) {}

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
}
