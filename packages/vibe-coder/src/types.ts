import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

/** Configuration options for the vibe-coder capability. */
export interface VibeCoderOptions {
  /** The sandbox execution provider (must support setDevPort/clearDevPort). */
  provider: SandboxProvider;
  /**
   * Base path for the preview proxy (e.g. "/preview/abc123/").
   * Passed to the container so it can rewrite absolute paths in dev server responses,
   * ensuring sub-resources (JS, CSS) route through the preview proxy.
   */
  previewBasePath?: string;
}
