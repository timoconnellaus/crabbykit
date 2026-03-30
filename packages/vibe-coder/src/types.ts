import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

/** Configuration options for the vibe-coder capability. */
export interface VibeCoderOptions {
  /** The sandbox execution provider (must support setDevPort/clearDevPort). */
  provider: SandboxProvider;
}
