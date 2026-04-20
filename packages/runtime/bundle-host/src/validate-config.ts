/**
 * Promotion-time and dispatch-time validators for
 * `bundle-config-namespaces`.
 *
 * - {@link validateBundleAgentConfigsAgainstKnownIds} compares a
 *   bundle's declared `agentConfigSchemas` (top-level namespace keys)
 *   against the host's currently-resolved `getAgentConfigSchema()`
 *   key set.
 * - {@link validateBundleConfigNamespacesAgainstKnownIds} compares a
 *   bundle's declared `configNamespaces` ids against the host's
 *   `getConfigNamespaces().map(n => n.id)` set.
 * - {@link validateBundleCapabilityConfigsAgainstKnownIds} compares a
 *   bundle's declared `capabilityConfigs.id` set against the host's
 *   REGISTERED capability id set — **distinct** from
 *   `requiredCapabilities` catalog validation.
 *
 * Each validator returns `{ valid: true }` or `{ valid: false,
 * collidingX: [...] }`. `BundleRegistry.setActive` throws the matching
 * error class on collision; pointer stays unflipped.
 */

export type AgentConfigValidationResult =
  | { valid: true }
  | { valid: false; collidingNamespaces: string[] };

export type ConfigNamespaceValidationResult =
  | { valid: true }
  | { valid: false; collidingIds: string[] };

export type CapabilityConfigValidationResult =
  | { valid: true }
  | { valid: false; collidingIds: string[] };

/**
 * Detect collisions between a bundle's declared agent-config namespace
 * ids and the host's currently-resolved agent-config schema key set.
 *
 * - `declared` undefined/empty → always valid.
 * - `known` undefined → always valid (caller opted out,
 *   cross-deployment promotion).
 */
export function validateBundleAgentConfigsAgainstKnownIds(
  declared: readonly string[] | undefined,
  known: readonly string[] | undefined,
): AgentConfigValidationResult {
  if (!declared || declared.length === 0) return { valid: true };
  if (!known) return { valid: true };

  const knownSet = new Set(known);
  if (knownSet.size === 0) return { valid: true };

  const collidingNamespaces: string[] = [];
  const seen = new Set<string>();
  for (const id of declared) {
    if (typeof id !== "string") continue;
    if (!knownSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    collidingNamespaces.push(id);
  }

  if (collidingNamespaces.length === 0) return { valid: true };
  return { valid: false, collidingNamespaces };
}

/**
 * Detect collisions between a bundle's declared custom configNamespace
 * ids and the host's currently-resolved namespace id set.
 */
export function validateBundleConfigNamespacesAgainstKnownIds(
  declared: readonly string[] | undefined,
  known: readonly string[] | undefined,
): ConfigNamespaceValidationResult {
  if (!declared || declared.length === 0) return { valid: true };
  if (!known) return { valid: true };

  const knownSet = new Set(known);
  if (knownSet.size === 0) return { valid: true };

  const collidingIds: string[] = [];
  const seen = new Set<string>();
  for (const id of declared) {
    if (typeof id !== "string") continue;
    if (!knownSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    collidingIds.push(id);
  }

  if (collidingIds.length === 0) return { valid: true };
  return { valid: false, collidingIds };
}

/**
 * Detect collisions between a bundle's declared `capabilityConfigs.id`
 * set and the host's REGISTERED capability id set. Distinct from
 * {@link validateCatalogAgainstKnownIds} (which checks
 * `requiredCapabilities` — capabilities the bundle NEEDS). This one
 * validates that the bundle is not re-declaring a schema for a host
 * capability that already owns `config:capability:{id}` — silent
 * dual-write would corrupt both.
 */
export function validateBundleCapabilityConfigsAgainstKnownIds(
  declared: readonly string[] | undefined,
  known: readonly string[] | undefined,
): CapabilityConfigValidationResult {
  if (!declared || declared.length === 0) return { valid: true };
  if (!known) return { valid: true };

  const knownSet = new Set(known);
  if (knownSet.size === 0) return { valid: true };

  const collidingIds: string[] = [];
  const seen = new Set<string>();
  for (const id of declared) {
    if (typeof id !== "string") continue;
    if (!knownSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    collidingIds.push(id);
  }

  if (collidingIds.length === 0) return { valid: true };
  return { valid: false, collidingIds };
}

/**
 * Thrown by `BundleRegistry.setActive` when a bundle's declared
 * `agentConfigSchemas` collides with host-declared agent-config
 * namespaces. Discriminate via `code === "ERR_AGENT_CONFIG_COLLISION"`.
 */
export class AgentConfigCollisionError extends Error {
  readonly code = "ERR_AGENT_CONFIG_COLLISION" as const;
  readonly collidingNamespaces: string[];
  readonly versionId: string;

  constructor(args: { collidingNamespaces: string[]; versionId: string; message?: string }) {
    const msg =
      args.message ??
      `bundle version '${args.versionId}' declares agent-config namespace(s) that collide with host-registered namespaces: ${args.collidingNamespaces.join(", ")}`;
    super(msg);
    this.name = "AgentConfigCollisionError";
    this.collidingNamespaces = args.collidingNamespaces;
    this.versionId = args.versionId;
  }
}

/**
 * Thrown by `BundleRegistry.setActive` when a bundle's declared
 * `configNamespaces` ids collide with host-registered namespaces.
 * Discriminate via `code === "ERR_CONFIG_NAMESPACE_COLLISION"`.
 */
export class ConfigNamespaceCollisionError extends Error {
  readonly code = "ERR_CONFIG_NAMESPACE_COLLISION" as const;
  readonly collidingIds: string[];
  readonly versionId: string;

  constructor(args: { collidingIds: string[]; versionId: string; message?: string }) {
    const msg =
      args.message ??
      `bundle version '${args.versionId}' declares config namespace id(s) that collide with host-registered namespaces: ${args.collidingIds.join(", ")}`;
    super(msg);
    this.name = "ConfigNamespaceCollisionError";
    this.collidingIds = args.collidingIds;
    this.versionId = args.versionId;
  }
}

/**
 * Thrown by `BundleRegistry.setActive` when a bundle's declared
 * `capabilityConfigs.id` set collides with host-registered capability
 * ids. Discriminate via `code === "ERR_CAPABILITY_CONFIG_COLLISION"`.
 */
export class CapabilityConfigCollisionError extends Error {
  readonly code = "ERR_CAPABILITY_CONFIG_COLLISION" as const;
  readonly collidingIds: string[];
  readonly versionId: string;

  constructor(args: { collidingIds: string[]; versionId: string; message?: string }) {
    const msg =
      args.message ??
      `bundle version '${args.versionId}' declares capability config for id(s) that collide with host-registered capabilities: ${args.collidingIds.join(", ")}`;
    super(msg);
    this.name = "CapabilityConfigCollisionError";
    this.collidingIds = args.collidingIds;
    this.versionId = args.versionId;
  }
}
