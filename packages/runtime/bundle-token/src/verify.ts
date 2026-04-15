/**
 * Capability token verification.
 *
 * Verifies HMAC signature against a subkey, parses payload, checks
 * expiration, and (optionally) consumes a nonce for replay protection.
 *
 * Minting lives in `@claw-for-cloudflare/bundle-host/src/security/mint.ts` —
 * this module is verify-only.
 */

import type { TokenPayload, VerifyOutcome } from "./types.js";

function base64urlDecode(str: string): ArrayBuffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Verify a capability token against a subkey. Returns the verified payload
 * or a structured error.
 *
 * @param token - The sealed token string (payload.signature)
 * @param subkey - The HKDF-derived verify-only subkey for this service
 * @param nonceTracker - Optional nonce tracker for replay protection
 */
export async function verifyToken(
  token: string,
  subkey: CryptoKey,
  nonceTracker?: NonceTracker,
): Promise<VerifyOutcome> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) {
    return { valid: false, code: "ERR_MALFORMED" };
  }

  const payloadB64 = token.substring(0, dotIndex);
  const signatureB64 = token.substring(dotIndex + 1);

  // Verify HMAC (constant-time via SubtleCrypto)
  let signatureValid: boolean;
  try {
    signatureValid = await crypto.subtle.verify(
      "HMAC",
      subkey,
      base64urlDecode(signatureB64),
      new TextEncoder().encode(payloadB64),
    );
  } catch {
    return { valid: false, code: "ERR_BAD_TOKEN" };
  }

  if (!signatureValid) {
    return { valid: false, code: "ERR_BAD_TOKEN" };
  }

  // Parse payload
  let payload: TokenPayload;
  try {
    const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
    payload = JSON.parse(payloadJson);
  } catch {
    return { valid: false, code: "ERR_MALFORMED" };
  }

  // Check expiration
  if (payload.exp <= Date.now()) {
    return { valid: false, code: "ERR_TOKEN_EXPIRED" };
  }

  // Check replay
  if (nonceTracker) {
    const consumed = nonceTracker.tryConsume(payload.nonce, payload.exp);
    if (!consumed) {
      return { valid: false, code: "ERR_TOKEN_REPLAY" };
    }
  }

  return { valid: true, payload };
}

/**
 * Bounded LRU nonce tracker with TTL eviction.
 * Tracks consumed nonces to prevent replay attacks.
 * Nonces older than their token's expiration are safe to evict.
 */
export class NonceTracker {
  private readonly consumed = new Map<string, number>(); // nonce → expiresAt
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  /**
   * Try to consume a nonce. Returns true if the nonce was fresh (first use),
   * false if it was already consumed (replay).
   */
  tryConsume(nonce: string, expiresAt: number): boolean {
    // Evict expired nonces if we're near capacity
    if (this.consumed.size >= this.maxSize * 0.9) {
      this.evictExpired();
    }

    // Check if already consumed
    if (this.consumed.has(nonce)) {
      return false;
    }

    // Reject if at hard capacity after eviction
    if (this.consumed.size >= this.maxSize) {
      this.evictExpired();
      if (this.consumed.size >= this.maxSize) {
        // Still full — this is the ERR_BUDGET_EXCEEDED case
        // But from the nonce tracker's perspective, we reject as replay
        // to prevent unbounded growth
        return false;
      }
    }

    this.consumed.set(nonce, expiresAt);
    return true;
  }

  /** Remove all nonces whose token has expired. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.consumed) {
      if (exp <= now) {
        this.consumed.delete(nonce);
      }
    }
  }

  /** Current number of tracked nonces. */
  get size(): number {
    return this.consumed.size;
  }
}
