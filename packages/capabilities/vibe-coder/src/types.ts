import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import type { DbService } from "./db-service.js";

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
  /**
   * Optional service binding to the AiService WorkerEntrypoint.
   * When provided, dynamic workers get `env.AI` for LLM inference.
   * Costs are tracked by the AiService — the API key never reaches the app.
   *
   * Register in wrangler.jsonc as:
   * ```jsonc
   * "services": [{ "binding": "AI_SERVICE", "service": "<worker-name>", "entrypoint": "AiService" }]
   * ```
   */
  aiService?: Service;
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
   * Enable backend support. When provided, agents can create full-stack apps
   * with a Hono backend and Durable Object SQLite database.
   */
  backend?: BackendOptions;
}
