import type { Cookie } from "./types.js";

/**
 * Unique key for a cookie, matching the domain+path+name identity.
 */
function cookieKey(c: Cookie): string {
  return `${c.domain}|${c.path}|${c.name}`;
}

/**
 * Merge incoming cookies from a closing browser session with the stored cookie jar.
 *
 * Strategy:
 * - New cookies (not in stored) → added
 * - Existing cookies with newer expiry → overwrite stored
 * - Stored cookies not in incoming → preserved (came from another session)
 * - Expired cookies → pruned (except session cookies with expires -1)
 */
export function mergeCookies(stored: Cookie[], incoming: Cookie[]): Cookie[] {
  const map = new Map<string, Cookie>();

  // Load stored as base
  for (const c of stored) {
    map.set(cookieKey(c), c);
  }

  // Overlay incoming — newer or new cookies win
  for (const c of incoming) {
    const key = cookieKey(c);
    const existing = map.get(key);
    if (!existing || c.expires > existing.expires) {
      map.set(key, c);
    }
  }

  // Remove expired (session cookies have expires === -1 or 0, keep those)
  const now = Date.now() / 1000;
  return [...map.values()].filter((c) => c.expires <= 0 || c.expires > now);
}
