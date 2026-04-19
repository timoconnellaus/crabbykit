/**
 * Verify-only HKDF subkey derivation.
 *
 * Used by services and bundle code that should NEVER be able to mint tokens.
 * The returned CryptoKey has `usages: ["verify"]` only — attempting to
 * `crypto.subtle.sign` with it will throw, giving a hard runtime guarantee
 * on top of the compile-time package-boundary guarantee.
 *
 * The mint-side variant (with `usages: ["sign"]`) lives in
 * `@crabbykit/bundle-host/src/security/mint.ts`.
 */

/**
 * The single HKDF label used for all bundle capability token derivation —
 * both mint (host dispatcher) and verify (SpineService, LlmService, Tavily
 * and future shape-2 capability services).
 *
 * Domain separation between services is provided by the `scope` field in
 * the token payload, checked per-service via `verifyToken`'s `requiredScope`
 * option. The previous per-service labels (`claw/spine-v1`, `claw/llm-v1`)
 * are removed.
 *
 * Defined here (in `bundle-token`) so that capability services can import it
 * without taking a value-level dependency on `bundle-host`, which contains
 * the mint-side API that capabilities must never access.
 */
export const BUNDLE_SUBKEY_LABEL = "claw/bundle-v1";

/**
 * Derive a verify-only subkey from the master AGENT_AUTH_KEY.
 * Uses HKDF with SHA-256. Pass `BUNDLE_SUBKEY_LABEL` as the label.
 * The label provides domain separation for the key material; scope-based
 * authorization between services is enforced at verify time via
 * `verifyToken`'s `requiredScope` option.
 */
export async function deriveVerifyOnlySubkey(masterKey: string, label: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // fixed zero salt — label provides domain separation
      info: new TextEncoder().encode(label),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["verify"],
  );
}
