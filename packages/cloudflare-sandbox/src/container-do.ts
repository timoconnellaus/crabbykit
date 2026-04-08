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
  /** Service binding to DbService for proxying database requests from the container. */
  DB_SERVICE: {
    exec(backendId: string, sql: string, params?: unknown[]): Promise<unknown>;
    batch(backendId: string, statements: { sql: string; params?: unknown[] }[]): Promise<unknown>;
  };
  /** OpenRouter API key for proxying AI requests from the container. */
  OPENROUTER_API_KEY: string;
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
const DEFAULT_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";

export class SandboxContainer extends Container<SandboxContainerEnv> {
  defaultPort = 8080;
  sleepAfter = "2h";
  enableInternet = true;

  /** Intercept outbound HTTP from the container for virtual host bindings. */
  static outboundByHost = {
    "db.internal": (req: Request, env: SandboxContainerEnv) => dbHandlerImpl(req, env),
    "ai.internal": (req: Request, env: SandboxContainerEnv) => aiHandlerImpl(req, env),
  };

  constructor(ctx: DurableObject["ctx"], env: SandboxContainerEnv) {
    super(ctx, env);
    // AGENT_ID is derived from the DO name (set by idFromName in the provider).
    // R2 credentials are forwarded from the worker env to the container process
    // so tigrisfs can mount the correct bucket prefix at /workspace.
    const agentId = ctx.id.name ?? "default";
    this.envVars = {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_BUCKET_NAME: env.R2_BUCKET_NAME,
      AGENT_ID: agentId,
    };
  }

  /**
   * Handle intercepted requests to db.internal.
   * Routes SQL operations to the DbService binding.
   * Kept as an instance method so existing tests can call it directly.
   */
  async handleDbRequest(request: Request): Promise<Response> {
    return dbHandlerImpl(request, this.env);
  }

  /**
   * Handle intercepted requests to ai.internal.
   * Proxies to OpenRouter using the configured API key.
   * Kept as an instance method so existing tests can call it directly.
   */
  async handleAiRequest(request: Request): Promise<Response> {
    return aiHandlerImpl(request, this.env);
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Handle intercepted db.internal requests.
 * Module-level so it can be invoked from both the static `outboundByHost`
 * map (which receives `env` as a parameter) and the instance method
 * `handleDbRequest` (which passes `this.env`).
 */
async function dbHandlerImpl(
  request: Request,
  env: SandboxContainerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const backendId = body.backendId as string | undefined;
  if (!backendId) {
    return jsonResponse({ error: "backendId is required" }, 400);
  }

  if (path === "/exec") {
    const sql = body.sql as string | undefined;
    if (!sql) {
      return jsonResponse({ error: "sql is required" }, 400);
    }
    const params = (body.params as unknown[]) ?? [];

    try {
      const result = await env.DB_SERVICE.exec(backendId, sql, params);
      return jsonResponse(result, 200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonResponse({ error: message }, 500);
    }
  }

  if (path === "/batch") {
    const statements = body.statements as { sql: string; params?: unknown[] }[] | undefined;
    if (!statements || !Array.isArray(statements)) {
      return jsonResponse({ error: "statements array is required" }, 400);
    }

    try {
      const result = await env.DB_SERVICE.batch(backendId, statements);
      return jsonResponse(result, 200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonResponse({ error: message }, 500);
    }
  }

  return jsonResponse({ error: `Unknown path: ${path}` }, 404);
}

/**
 * Handle intercepted ai.internal requests.
 * Module-level for the same reason as `dbHandlerImpl`.
 */
async function aiHandlerImpl(
  request: Request,
  env: SandboxContainerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const apiKey = env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);
  }

  // GET /v1/models — return a minimal models list
  if (request.method === "GET" && path === "/v1/models") {
    return jsonResponse({ object: "list", data: [] }, 200);
  }

  // POST /v1/chat/completions — proxy to OpenRouter
  if (request.method === "POST" && path === "/v1/chat/completions") {
    const upstreamUrl = `${DEFAULT_UPSTREAM_BASE_URL}/chat/completions`;

    let body: string;
    try {
      body = await request.text();
    } catch {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      // Pass through the response (including streaming)
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonResponse({ error: `Upstream error: ${message}` }, 502);
    }
  }

  return jsonResponse({ error: `Unknown AI endpoint: ${request.method} ${path}` }, 404);
}
