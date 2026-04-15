import { base64UrlEncode } from "./encoding.js";
import type { InterAgentPayload } from "./types.js";

const DEFAULT_TTL_MS = 60_000;

export async function signToken(
  sender: string,
  target: string,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<string> {
  void ttlMs; // TTL is used by verifier; included in signature for API symmetry

  const payload: InterAgentPayload = { sender, target, ts: Date.now() };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = base64UrlEncode(payloadBytes);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, payloadBytes);
  const signatureB64 = base64UrlEncode(new Uint8Array(signatureBuffer));

  return `${payloadB64}:${signatureB64}`;
}
