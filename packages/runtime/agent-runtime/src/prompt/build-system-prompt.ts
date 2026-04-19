/**
 * Re-export the system prompt builder from the canonical location in
 * `@crabbykit/bundle-sdk`. See `./types.ts` for why the source
 * lives in bundle-sdk.
 */

export {
  buildDefaultSystemPrompt,
  buildDefaultSystemPromptSections,
  estimateTextTokens,
  toPromptString,
} from "@crabbykit/bundle-sdk";
