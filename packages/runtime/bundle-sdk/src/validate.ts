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
