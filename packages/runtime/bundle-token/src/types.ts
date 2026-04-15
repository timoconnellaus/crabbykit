/**
 * Capability token types shared between host (mint) and bundle/services (verify).
 *
 * Tokens bind {agentId, sessionId, expiresAt, nonce} to a specific turn.
 * Format: base64url(payload).base64url(hmac_sha256(subkey, base64url(payload)))
 *
 * Per-service HKDF subkeys ensure a compromised service cannot mint tokens
 * for other services. The host DO holds the master key; each service gets
 * only its own verify-only subkey.
 *
 * This micro-package is verify-only — it exposes NO mint functions. Minting
 * lives exclusively in `@claw-for-cloudflare/bundle-host/src/security/mint.ts`.
 */

/** Decoded token payload. */
export interface TokenPayload {
  /** Agent ID */
  aid: string;
  /** Session ID */
  sid: string;
  /** Expiration timestamp (ms since epoch) */
  exp: number;
  /** Unique nonce for replay protection */
  nonce: string;
}

/** Successful verification result. */
export interface VerifyResult {
  valid: true;
  payload: TokenPayload;
}

/** Failed verification result with a machine-readable code. */
export interface VerifyError {
  valid: false;
  code: "ERR_BAD_TOKEN" | "ERR_TOKEN_EXPIRED" | "ERR_TOKEN_REPLAY" | "ERR_MALFORMED";
}

/** Discriminated union returned by `verifyToken`. */
export type VerifyOutcome = VerifyResult | VerifyError;
