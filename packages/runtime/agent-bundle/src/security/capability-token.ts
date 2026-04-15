/**
 * Capability token utilities for bundle ↔ host RPC authorization.
 *
 * Tokens bind {agentId, sessionId, expiresAt, nonce} to a specific turn.
 * Format: base64url(payload).base64url(hmac_sha256(subkey, base64url(payload)))
 *
 * Per-service HKDF subkeys ensure a compromised service cannot mint tokens
 * for other services. The host DO holds the master key; each service gets
 * only its own verify-only subkey.
 */

/**
 * Default token TTL. Tokens are scoped to a single turn; a turn that
 * takes longer than this should re-mint. 60s is a generous ceiling on
 * realistic turn durations and keeps the replay window small.
 */
const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds

// --- Base64url helpers ---

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): ArrayBuffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- Token payload ---

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

// --- HKDF subkey derivation ---

/**
 * Derive a per-service verify-only subkey from the master AGENT_AUTH_KEY.
 * Uses HKDF with SHA-256. Each service gets a distinct label
 * (e.g., "claw/spine-v1", "claw/llm-v1").
 */
export async function deriveSubkey(
  masterKey: string | CryptoKey,
  label: string,
): Promise<CryptoKey> {
  const keyMaterial =
    typeof masterKey === "string"
      ? await crypto.subtle.importKey("raw", new TextEncoder().encode(masterKey), "HKDF", false, [
          "deriveKey",
        ])
      : masterKey;

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
    ["sign", "verify"],
  );
}

/**
 * Derive a verify-only subkey (cannot sign, only verify).
 * Used by service entrypoints that should not be able to mint tokens.
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
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(label),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["verify"],
  );
}

// --- Token minting ---

export interface MintOptions {
  agentId: string;
  sessionId: string;
  ttlMs?: number;
}

/**
 * Mint a sealed capability token. Only the host DO should call this.
 */
export async function mintToken(opts: MintOptions, subkey: CryptoKey): Promise<string> {
  const payload: TokenPayload = {
    aid: opts.agentId,
    sid: opts.sessionId,
    exp: Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
    nonce: crypto.randomUUID(),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payloadJson));

  const signature = await crypto.subtle.sign("HMAC", subkey, new TextEncoder().encode(payloadB64));

  const signatureB64 = base64urlEncode(signature);

  return `${payloadB64}.${signatureB64}`;
}

// --- Token verification ---

export interface VerifyResult {
  valid: true;
  payload: TokenPayload;
}

export interface VerifyError {
  valid: false;
  code: "ERR_BAD_TOKEN" | "ERR_TOKEN_EXPIRED" | "ERR_TOKEN_REPLAY" | "ERR_MALFORMED";
}

export type VerifyOutcome = VerifyResult | VerifyError;

/**
 * Verify a capability token against a subkey. Returns the verified payload
 * or a structured error.
 *
 * @param token - The sealed token string (payload.signature)
 * @param subkey - The HKDF-derived subkey for this service
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

// --- Nonce tracking ---

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
