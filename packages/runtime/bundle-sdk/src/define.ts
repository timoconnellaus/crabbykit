/**
 * defineBundleAgent — the authoring API for bundle brains.
 *
 * Returns a default export that implements the bundle fetch handler contract.
 * The compiled bundle's default export is this fetch handler, which the host
 * DO invokes via Worker Loader.
 */

import { buildBundleContext, runBundleTurn } from "./runtime.js";
import type {
  BundleAgentSetup,
  BundleEnv,
  BundleExport,
  BundleMetadata,
  BundleModelConfig,
} from "./types.js";

/**
 * Create a bundle brain. Returns a fetch-handler default export that the
 * host DO loads via Worker Loader.
 *
 * ```ts
 * export default defineBundleAgent({
 *   model: () => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }),
 *   prompt: { agentName: "Helper" },
 * });
 * ```
 */
export function defineBundleAgent<TEnv extends BundleEnv = BundleEnv>(
  setup: BundleAgentSetup<TEnv>,
): BundleExport {
  const resolveModel = (): BundleModelConfig =>
    typeof setup.model === "function" ? setup.model() : setup.model;

  const metadata: BundleMetadata = setup.metadata ?? {};

  return {
    async fetch(request: Request, env: TEnv & BundleEnv): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      switch (path) {
        case "/turn":
          return handleTurn(request, env, setup);

        case "/client-event":
          return handleClientEvent(request, env);

        case "/alarm":
          return handleAlarm(request, env);

        case "/session-created":
          return handleSessionCreated(request, env);

        case "/smoke":
          return handleSmoke(env, resolveModel);

        case "/metadata":
          return Response.json(metadata);

        default:
          return new Response(`Unknown bundle endpoint: ${path}`, { status: 404 });
      }
    },
  } as BundleExport;
}

// --- Endpoint handlers ---

async function handleTurn<TEnv extends BundleEnv>(
  request: Request,
  env: TEnv,
  setup: BundleAgentSetup<TEnv>,
): Promise<Response> {
  // __SPINE_TOKEN authenticates the bundle's identity to SpineService
  // (session store, KV, transport). __LLM_TOKEN is a separate capability
  // token signed with the LLM HKDF subkey and is the ONLY token
  // LlmService will accept. Passing the spine token to LlmService fails
  // with ERR_BAD_TOKEN because the two services derive their verify
  // keys from different HKDF labels.
  if (!env.__SPINE_TOKEN) {
    return Response.json({ error: "Missing __SPINE_TOKEN" }, { status: 401 });
  }
  if (!env.__LLM_TOKEN) {
    return Response.json({ error: "Missing __LLM_TOKEN" }, { status: 401 });
  }

  let body: { prompt: string; agentId: string; sessionId: string };
  try {
    body = (await request.json()) as { prompt: string; agentId: string; sessionId: string };
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.prompt || !body.agentId || !body.sessionId) {
    return Response.json(
      { error: "Request body must include prompt, agentId, sessionId" },
      { status: 400 },
    );
  }

  // The SPINE binding is the WorkerEntrypoint RPC surface that proxies
  // session store, transport, KV, scheduler, and cost operations back
  // to the host DO. Without it the bundle cannot stream events or
  // persist entries.
  const spine = (env as Record<string, unknown>).SPINE as
    | {
        [method: string]: (...args: unknown[]) => Promise<unknown>;
      }
    | undefined;
  if (!spine) {
    return Response.json(
      {
        error:
          "Missing env.SPINE service binding — bundle cannot reach host state or stream events",
      },
      { status: 500 },
    );
  }

  const context = buildBundleContext(env, spine, body.agentId, body.sessionId);
  const stream = runBundleTurn(setup, env, body.prompt, context);
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function handleClientEvent<TEnv extends BundleEnv>(
  _request: Request,
  _env: TEnv,
): Promise<Response> {
  // Client events (steer, abort) are routed here by the host DO.
  // Implementation pending full runtime integration.
  return Response.json({ status: "acknowledged" });
}

async function handleAlarm<TEnv extends BundleEnv>(
  _request: Request,
  _env: TEnv,
): Promise<Response> {
  // Alarm handling — implementation pending.
  return Response.json({ status: "acknowledged" });
}

async function handleSessionCreated<TEnv extends BundleEnv>(
  _request: Request,
  _env: TEnv,
): Promise<Response> {
  // Session creation hook — implementation pending.
  return Response.json({ status: "acknowledged" });
}

async function handleSmoke<TEnv extends BundleEnv>(
  env: TEnv,
  resolveModel: () => BundleModelConfig,
): Promise<Response> {
  // Smoke test — verify the bundle loads and can construct its runtime.
  try {
    const model = resolveModel();
    return Response.json({
      status: "ok",
      model: `${model.provider}/${model.modelId}`,
      hasToken: Boolean(env.__SPINE_TOKEN),
    });
  } catch (err) {
    return Response.json(
      {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
