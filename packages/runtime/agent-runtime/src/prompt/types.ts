/**
 * Prompt types live in `@claw-for-cloudflare/agent-bundle/bundle` — the
 * bundle subpath is the single source of truth so both the host-side
 * runtime AND the bundle-side runtime (running inside an isolated Worker
 * Loader isolate that can't reach agent-runtime) compose prompts from
 * identical code. This file is a thin re-export for backwards compat and
 * to keep the `./prompt` import path on agent-runtime stable.
 */

export type {
  PromptOptions,
  PromptSection,
  PromptSectionSource,
} from "@claw-for-cloudflare/agent-bundle/bundle";
