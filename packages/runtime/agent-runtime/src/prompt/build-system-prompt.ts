/**
 * Re-export the system prompt builder from the canonical location in
 * `@claw-for-cloudflare/agent-bundle/bundle`. See `./types.ts` for why
 * the source lives in agent-bundle.
 */

export {
  buildDefaultSystemPrompt,
  buildDefaultSystemPromptSections,
  estimateTextTokens,
  toPromptString,
} from "@claw-for-cloudflare/agent-bundle/bundle";
