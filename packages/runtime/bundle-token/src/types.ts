/**
 * Capability token types shared between host (mint) and bundle/services (verify).
 *
 * Tokens bind {agentId, sessionId, expiresAt, nonce, scope} to a specific turn.
 * Format: base64url(payload).base64url(hmac_sha256(subkey, base64url(payload)))
 *
 * A single HKDF subkey (`claw/bundle-v1`) is used for all services. Domain
 * separation between services is provided by the `scope` field in the payload —
 * each service checks that its canonical scope string is present before
 * authorizing the call.
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
  /** Unique nonce for replay protection and budget keying */
  nonce: string;
  /**
   * Scopes this token authorizes. Reserved: `"spine"`, `"llm"`.
   * Capability scopes use the capability's kebab-case id
   * (e.g. `"tavily-web-search"`). Populated by the dispatcher from the
   * validated capability catalog plus the two reserved core scopes.
   */
  scope: string[];
}

/**
 * Successful verification result. The `payload` carries the full decoded
 * token payload including the `scope` array.
 */
export interface VerifyResult {
  valid: true;
  payload: TokenPayload;
}

/** Failed verification result with a machine-readable code. */
export interface VerifyError {
  valid: false;
  code:
    | "ERR_BAD_TOKEN"
    | "ERR_TOKEN_EXPIRED"
    | "ERR_TOKEN_REPLAY"
    | "ERR_MALFORMED"
    /**
     * The token's `scope` array does not include the service's required scope.
     * Only returned when `verifyToken` is called with a `requiredScope` option.
     * The token is otherwise valid (signature, TTL, nonce) — the bundle was
     * not authorized to call this service.
     */
    | "ERR_SCOPE_DENIED";
}

/** Discriminated union returned by `verifyToken`. */
export type VerifyOutcome = VerifyResult | VerifyError;
