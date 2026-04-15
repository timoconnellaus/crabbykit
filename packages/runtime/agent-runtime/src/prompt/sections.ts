/**
 * Re-export the default system prompt section builders from the canonical
 * location in `@claw-for-cloudflare/agent-bundle/bundle`. See
 * `./types.ts` for why the source lives in agent-bundle.
 */

export {
  identitySection,
  runtimeSection,
  safetySection,
} from "@claw-for-cloudflare/agent-bundle/bundle";
