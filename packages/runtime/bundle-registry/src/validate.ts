/**
 * Shared catalog validation helper used by both `D1BundleRegistry.setActive`
 * and `InMemoryBundleRegistry.setActive` (in `@claw-for-cloudflare/bundle-host`).
 *
 * Compares a bundle's declared `requiredCapabilities` against a set of
 * host-known capability ids. Returns a discriminated result that callers
 * translate into either a thrown `CapabilityMismatchError` (at setActive)
 * or a `disableForCatalogMismatch` path (at dispatch-time guard).
 */

/** Minimal shape of a declared capability requirement. The authoritative
 *  type is `BundleCapabilityRequirement` from
 *  `@claw-for-cloudflare/bundle-sdk`; we redeclare the shape locally to
 *  keep bundle-registry dependency-free from the SDK. */
export interface CapabilityRequirementLike {
  id: string;
}

export type CatalogValidationResult =
  | { valid: true }
  | { valid: false; missingIds: string[] };

/**
 * Validate a bundle's declared requirements against the host's known
 * capability set.
 *
 * - Empty/undefined declaration → always valid.
 * - Any declared id not present in `knownIds` → invalid. Missing ids
 *   are deduplicated in the result so repeat declarations do not bloat
 *   the error payload.
 */
export function validateCatalogAgainstKnownIds(
  required: readonly CapabilityRequirementLike[] | undefined,
  knownIds: ReadonlySet<string>,
): CatalogValidationResult {
  if (!required || required.length === 0) {
    return { valid: true };
  }

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const req of required) {
    if (!req || typeof req.id !== "string") continue;
    if (knownIds.has(req.id)) continue;
    if (seen.has(req.id)) continue;
    seen.add(req.id);
    missing.push(req.id);
  }

  if (missing.length === 0) return { valid: true };
  return { valid: false, missingIds: missing };
}
