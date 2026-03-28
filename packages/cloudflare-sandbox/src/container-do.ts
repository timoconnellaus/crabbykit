import type { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";

/**
 * Environment variables the SandboxContainer reads from the worker env
 * to pass to the container process for FUSE mounting.
 */
export interface SandboxContainerEnv {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  [key: string]: unknown;
}

/**
 * Durable Object that manages a sandbox container lifecycle.
 * Passes R2 credentials and agent ID to the container process
 * so tigrisfs can mount the correct R2 bucket prefix.
 *
 * Consumers export this class from their worker and reference it
 * in wrangler.jsonc under both `durable_objects` and `containers`.
 *
 * @example
 * ```ts
 * // worker.ts
 * export { SandboxContainer } from "@claw-for-cloudflare/cloudflare-sandbox";
 * ```
 */
export class SandboxContainer extends Container<SandboxContainerEnv> {
  defaultPort = 8080;
  sleepAfter = "2h";
  enableInternet = true;

  constructor(ctx: DurableObject["ctx"], env: SandboxContainerEnv) {
    super(ctx, env);
    // AGENT_ID is derived from the DO name (set by idFromName in the provider).
    // R2 credentials are forwarded from the worker env to the container process
    // so tigrisfs can mount the correct bucket prefix at /mnt/r2.
    const agentId = ctx.id.name ?? "default";
    this.envVars = {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_BUCKET_NAME: env.R2_BUCKET_NAME,
      AGENT_ID: agentId,
    };
  }

  async fetch(request: Request): Promise<Response> {
    // Pick up agent ID and container mode from headers
    const headerAgentId = request.headers.get("x-agent-id");
    if (headerAgentId && this.envVars?.AGENT_ID === "default") {
      this.envVars = { ...this.envVars, AGENT_ID: headerAgentId };
    }
    const containerMode = request.headers.get("x-container-mode");
    if (containerMode && this.envVars) {
      this.envVars = { ...this.envVars, CONTAINER_MODE: containerMode };
    }
    return super.fetch(request);
  }
}
