/**
 * Capability token verification.
 *
 * Verifies HMAC signature against a subkey, parses payload, checks
 * expiration, (optionally) consumes a nonce for replay protection, and
 * (optionally) checks that the token's `scope` array includes a required
 * scope string.
 *
 * Minting lives in `@crabbykit/bundle-host/src/security/mint.ts` —
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
 * Options for {@link verifyToken}.
 */
export interface VerifyOptions {
  /**
   * Optional nonce tracker for single-use replay protection. When provided,
   * the nonce in the token payload is consumed; a replayed nonce returns
   * `ERR_TOKEN_REPLAY`. Production services (SpineService, LlmService) do
   * NOT use this — a single per-turn token carries many RPCs, so
   * single-use nonces would cap a turn at one call.
   */
  nonceTracker?: NonceTracker;
  /**
   * If provided, `payload.scope` must include this string for the token to
   * verify. Mismatch produces `ERR_SCOPE_DENIED`.
   *
   * Production services pass their canonical scope string:
   *   - SpineService: `"spine"`
   *   - LlmService: `"llm"`
   *   - TavilyService: `"tavily-web-search"`
   *   - Future shape-2 services: their capability's kebab-case id
   *
   * Tests may omit this option to exercise signature/TTL semantics in isolation.
   */
  requiredScope?: string;
}

/**
 * Verify a capability token against a subkey. Returns the verified payload
 * or a structured error.
 *
 * Checks are performed in order so that cheap failures short-circuit before
 * expensive ones:
 * 1. Token structure (base64url decode). Failure → `ERR_MALFORMED`.
 * 2. HMAC signature. Failure → `ERR_BAD_TOKEN`.
 * 3. Payload JSON parse. Failure → `ERR_MALFORMED`.
 * 4. Expiration check. Failure → `ERR_TOKEN_EXPIRED`.
 * 5. Nonce tracker (if provided). Failure → `ERR_TOKEN_REPLAY`.
 * 6. Scope check (if `options.requiredScope` provided). Failure → `ERR_SCOPE_DENIED`.
 *
 * @param token - The sealed token string (`base64url(payload).base64url(signature)`)
 * @param subkey - The HKDF-derived verify-only subkey (from `deriveVerifyOnlySubkey`)
 * @param options - Optional verification options (`nonceTracker`, `requiredScope`)
 */
export async function verifyToken(
  token: string,
  subkey: CryptoKey,
  options?: VerifyOptions,
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

  // Check replay (optional)
  if (options?.nonceTracker) {
    const consumed = options.nonceTracker.tryConsume(payload.nonce, payload.exp);
    if (!consumed) {
      return { valid: false, code: "ERR_TOKEN_REPLAY" };
    }
  }

  // Check scope (optional, step 6 — after all cheaper checks)
  if (options?.requiredScope) {
    if (!Array.isArray(payload.scope) || !payload.scope.includes(options.requiredScope)) {
      return { valid: false, code: "ERR_SCOPE_DENIED" };
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
