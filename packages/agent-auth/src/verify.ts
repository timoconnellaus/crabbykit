import { base64UrlDecode } from "./encoding.js";
import type { InterAgentPayload } from "./types.js";

const DEFAULT_TTL_MS = 60_000;

export async function verifyToken(
  token: string,
  expectedTarget: string,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<InterAgentPayload | null> {
  const separatorIndex = token.indexOf(":");
  if (separatorIndex === -1) return null;

  const payloadB64 = token.slice(0, separatorIndex);
  const signatureB64 = token.slice(separatorIndex + 1);

  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = base64UrlDecode(payloadB64);
    signatureBytes = base64UrlDecode(signatureB64);
  } catch {
    return null;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as unknown as ArrayBuffer,
    payloadBytes as unknown as ArrayBuffer,
  );
  if (!valid) return null;

  let payload: InterAgentPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as InterAgentPayload;
  } catch {
    return null;
  }

  if (payload.target !== expectedTarget) return null;
  if (Math.abs(Date.now() - payload.ts) > ttlMs) return null;

  return payload;
}
