/**
 * Verify-only HKDF subkey derivation.
 *
 * Used by services and bundle code that should NEVER be able to mint tokens.
 * The returned CryptoKey has `usages: ["verify"]` only — attempting to
 * `crypto.subtle.sign` with it will throw, giving a hard runtime guarantee
 * on top of the compile-time package-boundary guarantee.
 *
 * The mint-side variant (with `usages: ["sign"]`) lives in
 * `@claw-for-cloudflare/bundle-host/src/security/mint.ts`.
 */

/**
 * Derive a per-service verify-only subkey from the master AGENT_AUTH_KEY.
 * Uses HKDF with SHA-256. Each service gets a distinct label
 * (e.g., "claw/spine-v1", "claw/llm-v1"). The label provides domain
 * separation so a key leak for one service cannot forge tokens for another.
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
