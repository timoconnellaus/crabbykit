import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import type { DbService } from "./db-service.js";

/** Configuration for the deploy feature. */
export interface DeployOptions {
  /** Shared agent storage (R2 bucket + namespace). Used to build deploy URLs. */
  storage: AgentStorage;
}

/** Configuration for the backend feature. */
export interface BackendOptions {
  /** WorkerLoader binding for bundling and serving the backend worker. */
  loader: WorkerLoader;
  /**
   * Service binding to the DbService WorkerEntrypoint.
   * This is passed to dynamic workers as `env.DB` so they can call
   * `env.DB.exec(sql, params)` for database access.
   *
   * Register in wrangler.jsonc as:
   * ```jsonc
   * "services": [{ "binding": "DB_SERVICE", "service": "<worker-name>", "entrypoint": "DbService" }]
   * ```
   */
  dbService: Service<DbService>;
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
  /**
   * Enable backend support. When provided, agents can create full-stack apps
   * with a Hono backend and Durable Object SQLite database.
   */
  backend?: BackendOptions;
}
