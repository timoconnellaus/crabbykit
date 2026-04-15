import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

const PROXY_TOKEN_KEY = "proxyToken";

/** Generate a cryptographically random proxy token (64 hex chars). */
export function generateProxyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate a bearer token from the Authorization header against the stored proxy token.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function validateToken(
  storage: CapabilityStorage,
  authHeader: string | null,
): Promise<boolean> {
  if (!authHeader) return false;

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return false;

  const provided = match[1];
  const stored = await storage.get<string>(PROXY_TOKEN_KEY);
  if (!stored) return false;

  return constantTimeEqual(provided, stored);
}

/** Store a proxy token in capability storage. */
export async function storeToken(storage: CapabilityStorage, token: string): Promise<void> {
  await storage.put(PROXY_TOKEN_KEY, token);
}

/** Clear the proxy token from capability storage. */
export async function clearToken(storage: CapabilityStorage): Promise<void> {
  await storage.delete(PROXY_TOKEN_KEY);
}

/** Constant-time string comparison. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}
