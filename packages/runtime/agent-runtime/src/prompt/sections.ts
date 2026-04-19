/**
 * Re-export the default system prompt section builders from the canonical
 * location in `@crabbykit/bundle-sdk`. See `./types.ts` for why
 * the source lives in bundle-sdk.
 */

export {
  identitySection,
  runtimeSection,
  safetySection,
} from "@crabbykit/bundle-sdk";
