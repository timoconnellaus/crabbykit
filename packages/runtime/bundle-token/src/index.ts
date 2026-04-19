/**
 * `@claw-for-cloudflare/bundle-token` — verify-only capability token primitives.
 *
 * Shared between `@claw-for-cloudflare/bundle-host` (which also mints) and
 * `@claw-for-cloudflare/bundle-sdk` (which only verifies). The package
 * intentionally exposes NO mint functions — minting lives exclusively in
 * `bundle-host/src/security/mint.ts` behind a distinct package boundary.
 */

export { BUNDLE_SUBKEY_LABEL, deriveVerifyOnlySubkey } from "./subkey.js";
export type { TokenPayload, VerifyError, VerifyOutcome, VerifyResult } from "./types.js";
export type { VerifyOptions } from "./verify.js";
export { NonceTracker, verifyToken } from "./verify.js";
