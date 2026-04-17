/**
 * Build-time input validation for bundle author declarations.
 *
 * These helpers run inside the bundle's compiled code at
 * {@link defineBundleAgent} time — a malicious or buggy bundle could
 * otherwise inject control characters, unbounded strings, or bloated
 * arrays into `BundleMetadata`. Every validation error throws with a
 * message naming the offending entry index.
 */

import type { BundleCapabilityRequirement } from "./types.js";

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
