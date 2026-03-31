import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

/** Configuration for the deploy feature. */
export interface DeployOptions {
  /** Shared agent storage (R2 bucket + namespace). Used to build deploy URLs. */
  storage: AgentStorage;
}

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
  /**
   * Enable the deploy_app tool. When provided, agents can deploy built
   * Vite apps as static sites served via worker loaders.
   */
  deploy?: DeployOptions;
}
