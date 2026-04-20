/**
 * Build-time input validation for bundle author declarations.
 *
 * These helpers run inside the bundle's compiled code at
 * {@link defineBundleAgent} time — a malicious or buggy bundle could
 * otherwise inject control characters, unbounded strings, or bloated
 * arrays into `BundleMetadata`. Every validation error throws with a
 * message naming the offending entry index.
 */

import type { BundleCapabilityRequirement, BundleRouteDeclaration } from "./types.js";

/** Regex for a valid kebab-case capability id: starts with a letter,
 *  contains only lowercase letters, digits, and hyphens, does not end
 *  with a hyphen. Matches the charset constraint on host `Capability.id`. */
const CAPABILITY_ID_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Reserved scope strings that cannot be used as capability ids.
 * These are the two non-negotiable bundle→host channels that the dispatcher
 * unconditionally prepends to every minted token's scope array.
 * Allowing a capability id to collide with these strings would let a bundle
 * obtain a reserved-scope token via a declaration that looks like a capability
 * requirement — breaking the invariant that reserved scopes are author-independent.
 */
const RESERVED_SCOPE_IDS = new Set(["spine", "llm"]);

/** Minimum characters in a capability id. 2 is the floor (a valid kebab
 *  id cannot be shorter than `ab`). */
const CAPABILITY_ID_MIN_LENGTH = 2;

/** Maximum characters in a capability id. 64 is enough for reasonably
 *  descriptive names without inviting metadata-bloat attacks. */
const CAPABILITY_ID_MAX_LENGTH = 64;

/** Maximum number of required-capability entries in a single bundle. */
const REQUIRED_CAPABILITIES_MAX_ENTRIES = 64;

/**
 * Validate and normalize a `requiredCapabilities` declaration.
 *
 * Accepts `undefined` (returns `[]`), rejects non-array inputs, and
 * validates each entry:
 *
 * - Each entry must be an object with a string `id`.
 * - Each `id` must match the kebab-case regex and be 2..64 chars long.
 * - At most 64 entries total.
 * - Duplicate ids are deduplicated silently (keep first occurrence).
 *
 * Returns the normalized array of unique, validated requirements.
 * Throws `TypeError` or `RangeError` on invalid input, naming the
 * offending entry index.
 */
export function validateRequirements(raw: unknown): BundleCapabilityRequirement[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError(
      `requiredCapabilities must be an array, got ${typeof raw === "object" ? (raw === null ? "null" : "object") : typeof raw}`,
    );
  }

  if (raw.length > REQUIRED_CAPABILITIES_MAX_ENTRIES) {
    throw new RangeError(
      `requiredCapabilities cannot exceed ${REQUIRED_CAPABILITIES_MAX_ENTRIES} entries (got ${raw.length})`,
    );
  }

  const seen = new Set<string>();
  const result: BundleCapabilityRequirement[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];

    if (entry === null || entry === undefined) {
      throw new TypeError(`requiredCapabilities[${i}] must not be null or undefined`);
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `requiredCapabilities[${i}] must be an object, got ${Array.isArray(entry) ? "array" : typeof entry}`,
      );
    }

    const entryRecord = entry as Record<string, unknown>;
    const id = entryRecord.id;

    if (typeof id !== "string") {
      throw new TypeError(
        `requiredCapabilities[${i}].id must be a string, got ${id === null ? "null" : typeof id}`,
      );
    }

    if (id.length < CAPABILITY_ID_MIN_LENGTH || id.length > CAPABILITY_ID_MAX_LENGTH) {
      throw new RangeError(
        `requiredCapabilities[${i}].id must be ${CAPABILITY_ID_MIN_LENGTH}..${CAPABILITY_ID_MAX_LENGTH} characters (got ${id.length}: ${JSON.stringify(id)})`,
      );
    }

    if (!CAPABILITY_ID_REGEX.test(id)) {
      throw new TypeError(
        `requiredCapabilities[${i}].id must match /^[a-z][a-z0-9-]*[a-z0-9]$/ (got ${JSON.stringify(id)})`,
      );
    }

    if (RESERVED_SCOPE_IDS.has(id)) {
      throw new TypeError(
        `requiredCapabilities[${i}].id "${id}" is a reserved scope string and cannot be used as a capability id — the dispatcher unconditionally grants this scope to all bundles`,
      );
    }

    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id });
  }

  return result;
}

// --- HTTP route + action id validators (bundle-http-and-ui-surface) ---

/**
 * Path prefixes the host reserves for its own routes (or for routes the
 * bundle SDK reserves for itself). A bundle declaration whose path
 * starts with any of these throws at `defineBundleAgent` time.
 */
const RESERVED_PATH_PREFIXES = [
  "/bundle/",
  "/a2a-callback",
  "/a2a",
  "/.well-known/",
  "/__",
  "/mcp/",
  "/schedules",
] as const;

/**
 * Exact path literals the host reserves. A bundle declaration matching
 * any of these (regardless of method) throws at `defineBundleAgent` time.
 */
const RESERVED_PATH_LITERALS = new Set(["/", "/prompt", "/schedules"]);

/** Methods the v1 dispatch path supports. */
const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/** Maximum length of a bundle-declared HTTP path. */
const MAX_PATH_LENGTH = 256;

/**
 * Capability ids the host built-in `capability_action` switch claims.
 * A bundle that declares `BundleCapability { id: <reserved>, onAction }`
 * throws at `defineBundleAgent` time — the static dispatcher's switch
 * always runs first and the bundle's `onAction` would never see traffic.
 */
const RESERVED_ACTION_CAPABILITY_IDS = new Set(["agent-config", "schedules", "queue"]);

/**
 * Build-time validation for the flat list of HTTP route declarations
 * collected by `defineBundleAgent` from `setup.capabilities(probeEnv)`.
 *
 * Rejects:
 * - Method outside `{GET, POST, PUT, DELETE}`
 * - Missing leading slash
 * - Path > 256 chars
 * - Path matches a reserved literal (`/`, `/prompt`, `/schedules`)
 * - Path starts with a reserved prefix (`/bundle/`, `/a2a`,
 *   `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`)
 * - Two declarations share the same `${method}:${path}` key
 *
 * Error messages name the offending capability id and the offending
 * entry so authors can locate the problem without guessing.
 */
export function validateHttpRoutes(routes: BundleRouteDeclaration[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    const capLabel = route.capabilityId ? ` (capability "${route.capabilityId}")` : "";

    if (!ALLOWED_HTTP_METHODS.has(route.method)) {
      throw new TypeError(
        `Bundle route${capLabel} declares unsupported method "${route.method}" — allowed: GET, POST, PUT, DELETE`,
      );
    }
    if (typeof route.path !== "string" || route.path.length === 0) {
      throw new TypeError(`Bundle route${capLabel} must declare a non-empty path string`);
    }
    if (!route.path.startsWith("/")) {
      throw new TypeError(
        `Bundle route${capLabel} path "${route.path}" must start with a leading "/"`,
      );
    }
    if (route.path.length > MAX_PATH_LENGTH) {
      throw new RangeError(
        `Bundle route${capLabel} path "${route.path}" exceeds ${MAX_PATH_LENGTH} characters`,
      );
    }
    if (RESERVED_PATH_LITERALS.has(route.path)) {
      throw new TypeError(
        `Bundle route${capLabel} path "${route.path}" is a reserved host literal — choose a non-reserved path`,
      );
    }
    for (const prefix of RESERVED_PATH_PREFIXES) {
      if (route.path === prefix || route.path.startsWith(prefix)) {
        throw new TypeError(
          `Bundle route${capLabel} path "${route.path}" starts with reserved prefix "${prefix}"`,
        );
      }
    }
    const key = `${route.method}:${route.path}`;
    if (seen.has(key)) {
      throw new TypeError(
        `Bundle route${capLabel} duplicates an earlier declaration of "${route.method} ${route.path}" — each method+path pair may appear only once`,
      );
    }
    seen.add(key);
  }
}

/**
 * Build-time validation for the flat list of capability ids collected
 * by `defineBundleAgent` from `BundleCapability` entries that declared
 * an `onAction` handler. Rejects ids in the host built-in switch
 * (`agent-config`, `schedules`, `queue`) — the static dispatcher's
 * switch always wins and the bundle's `onAction` would never see traffic.
 *
 * Promotion-time validation against host-registered capability ids
 * lives in `bundle-host` (see `validateBundleActionIdsAgainstKnownIds`).
 */
export function validateActionCapabilityIds(ids: string[]): void {
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("Bundle action capability id must be a non-empty string");
    }
    if (RESERVED_ACTION_CAPABILITY_IDS.has(id)) {
      throw new TypeError(
        `Bundle capability "${id}" cannot declare onAction — "${id}" is reserved for the host built-in capability_action switch`,
      );
    }
  }
}

/**
 * Thrown by `defineBundleAgent`'s probe-env walk when a capability's
 * `httpHandlers` factory throws because the probe env lacked a field
 * the capability accessed. Bundle authors who need runtime-conditional
 * routes are documented as "metadata is the source of truth — runtime-
 * conditional routes that depend on env at probe time will fail
 * metadata extraction." Capability authors should make `httpHandlers`
 * return a static list keyed only on capability id / declared paths.
 */
// --- Config validators (bundle-config-namespaces) ---

/**
 * Reserved namespace ids rejected by `validateAgentConfigSchemas` and
 * `validateConfigNamespaces`. These correspond to:
 *
 * - `session` — dispatched to the session rename handler in
 *   `config-set.ts` (cannot route through agent-config).
 * - `agent-config`, `schedules`, `queue` — host built-in
 *   `capability_action` ids (routing collision would make the bundle's
 *   action invisible; likewise an agent-config write under `agent-config`
 *   would shadow the UI bridge).
 */
const RESERVED_CONFIG_NAMESPACE_IDS = new Set(["session", "agent-config", "schedules", "queue"]);

/**
 * TypeBox `Kind` strings whose JSON-Schema serialization loses
 * behavior: the runtime closures (Decode/Encode, constructor refs,
 * callable refs) cannot survive `JSON.parse(JSON.stringify(...))`.
 * Rejected at build time so bundle authors don't silently ship a
 * schema that validates host-side but skips the decoder.
 */
const REJECTED_SCHEMA_KINDS = new Set(["Transform", "Constructor", "Function"]);

/**
 * Recursive schema walker — descends into `properties`, `items`,
 * `anyOf`, `allOf`, `oneOf` — throwing when any node carries a
 * rejected TypeBox `Kind`. The walker reads the JSON-compatible
 * representation (the `Kind` field TypeBox writes into its schemas is
 * a regular enumerable string, separate from the `Symbol(TypeBox.Kind)`
 * runtime marker that drops on JSON round-trip).
 *
 * `pathLabel` is used purely for the error message — describes the
 * capability/namespace/field the schema is attached to so authors can
 * locate the problem without decoding JSON pointers.
 */
function assertSchemaKindsAllowed(schema: unknown, pathLabel: string): void {
  const walk = (node: unknown, trail: string): void => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    const kind = rec.Kind ?? rec.kind;
    if (typeof kind === "string" && REJECTED_SCHEMA_KINDS.has(kind)) {
      throw new TypeError(
        `${pathLabel} schema contains unsupported TypeBox Kind "${kind}" at ${trail || "<root>"} — Transform/Constructor/Function kinds carry runtime closures that cannot survive JSON serialization into bundle metadata. Remove the transform or move it to bundle-side execution.`,
      );
    }
    const properties = rec.properties;
    if (properties && typeof properties === "object") {
      for (const [key, prop] of Object.entries(properties)) {
        walk(prop, trail ? `${trail}.${key}` : key);
      }
    }
    if (rec.items !== undefined) {
      walk(rec.items, trail ? `${trail}[]` : "[]");
    }
    for (const key of ["anyOf", "allOf", "oneOf"] as const) {
      const arr = rec[key];
      if (Array.isArray(arr)) {
        arr.forEach((entry, idx) => {
          walk(entry, `${trail}.${key}[${idx}]`);
        });
      }
    }
  };
  walk(schema, "");
}

/**
 * Capability config metadata entry as collected by `defineBundleAgent`.
 * Intentionally loose (not `BundleCapability`) so validators operate
 * on the serialized JSON-Schema form that will be written into
 * `BundleMetadata.capabilityConfigs`.
 */
export interface CapabilityConfigEntry {
  id: string;
  schema: unknown;
  default?: Record<string, unknown>;
}

/**
 * Validate every declared capability-config entry:
 *
 * - Reject schemas carrying Transform / Constructor / Function kinds
 *   (recursive walker over `properties`, `items`, `anyOf`, `allOf`,
 *   `oneOf`).
 * - When `configDefault` is present, MUST validate against the
 *   capability's `configSchema` via `Value.Check`.
 *
 * Throws with a descriptive message naming the capability id and
 * the failing condition.
 */
export function validateCapabilityConfigs(
  entries: CapabilityConfigEntry[],
  // Optional runtime validator injection — host passes TypeBox's
  // `Value.Check` so `configDefault` can be verified against
  // `configSchema` at build time. Bundle-side callers (inside the
  // bundle isolate) pass `undefined` so we don't pull
  // `@sinclair/typebox/value` into the inlined bundle runtime
  // (would leak as an external in scaffolded builds). The host
  // revalidates any `configDefault` at promotion time where the
  // live TypeBox symbol is still on the schema.
  checkValue?: (schema: unknown, value: unknown) => boolean,
): void {
  for (const entry of entries) {
    assertSchemaKindsAllowed(entry.schema, `capability "${entry.id}"`);
    if (entry.default === undefined) continue;
    if (!checkValue) continue;
    if (!checkValue(entry.schema, entry.default)) {
      throw new TypeError(
        `Bundle capability "${entry.id}" configDefault does not validate against configSchema`,
      );
    }
  }
}

/**
 * Validate agent-config namespace schemas declared via
 * `BundleAgentSetup.config`:
 *
 * - Reject ids equal to `session`, `agent-config`, `schedules`, `queue`.
 * - Reject ids starting with `capability:` (collides with
 *   per-capability routing in `config_set`).
 * - Reject ids colliding with the bundle's own `BundleCapability.id`s.
 * - Reject ids colliding with the bundle's own
 *   `surfaces.actionCapabilityIds`.
 * - Reject schemas with Transform/Constructor/Function kinds.
 */
export function validateAgentConfigSchemas(
  schemas: Record<string, unknown>,
  bundleCapabilityIds: readonly string[],
  actionCapabilityIds: readonly string[],
): void {
  const capabilitySet = new Set(bundleCapabilityIds);
  const actionSet = new Set(actionCapabilityIds);
  for (const [namespace, schema] of Object.entries(schemas)) {
    if (RESERVED_CONFIG_NAMESPACE_IDS.has(namespace)) {
      throw new TypeError(
        `Bundle agent-config namespace "${namespace}" collides with a reserved token (one of: ${Array.from(
          RESERVED_CONFIG_NAMESPACE_IDS,
        ).join(", ")})`,
      );
    }
    if (namespace.startsWith("capability:")) {
      throw new TypeError(
        `Bundle agent-config namespace "${namespace}" starts with reserved prefix "capability:" — reserved for per-capability config routing`,
      );
    }
    if (capabilitySet.has(namespace)) {
      throw new TypeError(
        `Bundle agent-config namespace "${namespace}" collides with a bundle-declared capability id — both would route under the same namespace shape`,
      );
    }
    if (actionSet.has(namespace)) {
      throw new TypeError(
        `Bundle agent-config namespace "${namespace}" collides with a bundle-declared onAction capability id — config_set and capability_action would route ambiguously`,
      );
    }
    assertSchemaKindsAllowed(schema, `agent-config namespace "${namespace}"`);
  }
}

/**
 * Validate custom `configNamespaces` declared by bundle capabilities:
 *
 * - Reject ids matching reserved tokens (`session`, `agent-config`,
 *   `schedules`, `queue`).
 * - Reject ids colliding with the bundle's own agent-config namespace
 *   ids.
 * - Reject ids colliding with the bundle's own capability ids.
 * - Reject any namespace declaring a `pattern` field (regex-based
 *   pattern-matched namespaces are a v1 Non-Goal).
 * - Reject schemas with Transform/Constructor/Function kinds.
 */
export function validateConfigNamespaces(
  namespaces: Array<{
    id: string;
    description: string;
    schema: unknown;
    pattern?: unknown;
  }>,
  agentNamespaceIds: readonly string[],
  bundleCapabilityIds: readonly string[],
): void {
  const agentSet = new Set(agentNamespaceIds);
  const capabilitySet = new Set(bundleCapabilityIds);
  const seen = new Set<string>();
  for (const ns of namespaces) {
    if (typeof ns.id !== "string" || ns.id.length === 0) {
      throw new TypeError("Bundle config namespace must declare a non-empty string id");
    }
    if (RESERVED_CONFIG_NAMESPACE_IDS.has(ns.id)) {
      throw new TypeError(
        `Bundle config namespace "${ns.id}" collides with a reserved token (one of: ${Array.from(
          RESERVED_CONFIG_NAMESPACE_IDS,
        ).join(", ")})`,
      );
    }
    if (ns.id.startsWith("capability:")) {
      throw new TypeError(
        `Bundle config namespace "${ns.id}" starts with reserved prefix "capability:"`,
      );
    }
    if (agentSet.has(ns.id)) {
      throw new TypeError(
        `Bundle config namespace "${ns.id}" collides with a bundle-declared agent-config namespace`,
      );
    }
    if (capabilitySet.has(ns.id)) {
      throw new TypeError(
        `Bundle config namespace "${ns.id}" collides with a bundle-declared capability id`,
      );
    }
    if (seen.has(ns.id)) {
      throw new TypeError(
        `Bundle config namespace "${ns.id}" is declared twice — namespace ids must be unique`,
      );
    }
    seen.add(ns.id);
    if ((ns as { pattern?: unknown }).pattern !== undefined) {
      throw new TypeError(
        `Bundle config namespace "${ns.id}" declares a "pattern" field — pattern-matched namespaces are deferred; see proposal Non-Goals`,
      );
    }
    assertSchemaKindsAllowed(ns.schema, `config namespace "${ns.id}"`);
  }
}

/**
 * Validate `agentConfigPath` entries against the bundle's OWN
 * `agentConfigSchemas`. For every capability with a declared path:
 *
 * - The first dotted segment either matches a top-level namespace in
 *   the bundle's own `agentConfigSchemas` (structural walk continues
 *   through `properties`, terminating at `additionalProperties: true`)
 *   OR is left for the dispatch-time guard — build-time emits nothing
 *   for cross-bundle paths because the host namespace set is not
 *   visible here.
 *
 * Invalid structural resolution within the bundle's own schemas
 * throws with a descriptive message naming the capability and path.
 */
export function validateAgentConfigPaths(
  capabilityEntries: Array<{ id: string; agentConfigPath?: string }>,
  agentConfigSchemas: Record<string, unknown>,
): void {
  for (const entry of capabilityEntries) {
    if (entry.agentConfigPath === undefined) continue;
    const path = entry.agentConfigPath;
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError(
        `Bundle capability "${entry.id}" agentConfigPath must be a non-empty string`,
      );
    }
    const segments = path.split(".");
    const first = segments[0];
    if (!first) {
      throw new TypeError(
        `Bundle capability "${entry.id}" agentConfigPath "${path}" has empty leading segment`,
      );
    }
    const localSchema = agentConfigSchemas[first];
    if (!localSchema) {
      // Defer to dispatch-time guard — bundle may legitimately target a
      // host-declared namespace it cannot see at build time.
      continue;
    }
    // Walk remaining segments through the schema's `properties`.
    let cursor: Record<string, unknown> = localSchema as Record<string, unknown>;
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) {
        throw new TypeError(
          `Bundle capability "${entry.id}" agentConfigPath "${path}" has empty segment at position ${i}`,
        );
      }
      if (cursor.additionalProperties === true) {
        // Open object — cannot validate further segments structurally.
        return;
      }
      const props = cursor.properties as Record<string, unknown> | undefined;
      const next = props?.[segment];
      if (!next || typeof next !== "object") {
        throw new TypeError(
          `Bundle capability "${entry.id}" agentConfigPath "${path}" segment "${segment}" does not exist in the bundle's declared schema for namespace "${first}"`,
        );
      }
      cursor = next as Record<string, unknown>;
    }
  }
}

/**
 * Validate every `BundleMetadata.capabilityConfigs` entry corresponds
 * to an actual `BundleCapability.id` in `setup.capabilities(probeEnv)`.
 * Catches typos where the metadata extraction would otherwise list a
 * config schema for a capability the bundle doesn't declare.
 */
export function validateBundleCapabilityConfigsAgainstBundleCaps(
  capabilityConfigs: ReadonlyArray<{ id: string }>,
  bundleCapIds: readonly string[],
): void {
  const capSet = new Set(bundleCapIds);
  for (const entry of capabilityConfigs) {
    if (!capSet.has(entry.id)) {
      throw new TypeError(
        `Bundle capabilityConfigs declares schema for "${entry.id}" but no BundleCapability with that id appears in setup.capabilities(...)`,
      );
    }
  }
}

/**
 * Re-export for runtime consumers that want the dotted-path evaluator
 * alongside the validators. Host dispatch reads this via
 * `@crabbykit/bundle-sdk` to project agent-config slices when
 * firing `onAgentConfigChange` on bundle capabilities.
 */
export { evaluateAgentConfigPath } from "./config-path.js";

export class BundleMetadataExtractionError extends Error {
  readonly capabilityId: string;
  readonly cause?: unknown;

  constructor(args: { capabilityId: string; cause?: unknown; message?: string }) {
    const causeMsg =
      args.cause instanceof Error ? args.cause.message : args.cause ? String(args.cause) : "";
    const msg =
      args.message ??
      `Failed to extract bundle metadata for capability "${args.capabilityId}": ${causeMsg}. Bundle metadata is the source of truth — runtime-conditional routes that depend on env at probe time cannot be dispatched.`;
    super(msg);
    this.name = "BundleMetadataExtractionError";
    this.capabilityId = args.capabilityId;
    this.cause = args.cause;
  }
}
