/**
 * Mint-side capability token primitives.
 *
 * Only `@claw-for-cloudflare/bundle-host` may import from this file.
 * Neither `bundle-sdk` nor `bundle-token` has any path to the mint
 * helpers: that is the load-bearing security property of the host/sdk
 * split. The CryptoKey returned by {@link deriveMintSubkey} has
 * `usages: ["sign"]` only, so even if it escaped this package it
 * couldn't be used to verify tokens for another service — and the
 * verify-only `bundle-token` variant with `usages: ["verify"]` cannot
 * be used to sign.
 */

import type { TokenPayload } from "@claw-for-cloudflare/bundle-token";

/**
 * Default token TTL. Tokens are scoped to a single turn; a turn that
 * takes longer than this should re-mint. 60s is a generous ceiling on
 * realistic turn durations and keeps the replay window small.
 */
const DEFAULT_TTL_MS = 60 * 1000;

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Derive a per-service mint-only subkey from the master `AGENT_AUTH_KEY`.
 * Uses HKDF with SHA-256. Each service gets a distinct label
 * (e.g., `"claw/spine-v1"`, `"claw/llm-v1"`). The resulting CryptoKey
 * has `usages: ["sign"]` only — attempting `crypto.subtle.verify` with
 * it throws, giving a runtime guarantee on top of the package-boundary
 * compile-time guarantee.
 */
export async function deriveMintSubkey(masterKey: string, label: string): Promise<CryptoKey> {
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
    ["sign"],
  );
}

export interface MintOptions {
  agentId: string;
  sessionId: string;
  ttlMs?: number;
}

/**
 * Mint a sealed capability token. Only the host DO should call this.
 *
 * Format: `base64url(payload).base64url(hmac_sha256(subkey, base64url(payload)))`
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
