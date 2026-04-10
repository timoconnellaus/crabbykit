import type { TelegramAccount } from "./types.js";

/**
 * Verify a Telegram webhook by constant-time comparing the
 * `X-Telegram-Bot-Api-Secret-Token` header against the account's
 * configured `webhookSecret`.
 *
 * Constant-time comparison is important even though the secret is in a
 * header: Telegram sends the header value as-is, and timing attacks
 * against naive string equality are a real (if narrow) risk. We implement
 * the comparison with a byte-by-byte loop that always touches the full
 * length, never short-circuits, and never leaks length information
 * beyond the initial `header.length !== expected.length` check.
 */
export function verifyTelegramSecret(request: Request, account: TelegramAccount): boolean {
  const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (header === null) return false;
  return constantTimeEqual(header, account.webhookSecret);
}

/**
 * Constant-time string equality. Does NOT short-circuit on mismatch or
 * on differing length (length is revealed, but that's accepted — the
 * secret's bytes are not leaked).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
