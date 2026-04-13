/**
 * defineBundleAgent — the authoring API for bundle brains.
 *
 * Returns a default export that implements the bundle fetch handler contract.
 * The compiled bundle's default export is this fetch handler, which the host
 * DO invokes via Worker Loader.
 */

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
          return handleTurn(request, env, setup, resolveModel);

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
  _setup: BundleAgentSetup<TEnv>,
  resolveModel: () => BundleModelConfig,
): Promise<Response> {
  const token = env.__SPINE_TOKEN;
  if (!token) {
    return Response.json({ error: "Missing __SPINE_TOKEN" }, { status: 401 });
  }

  let body: { prompt: string };
  try {
    body = (await request.json()) as { prompt: string };
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const model = resolveModel();

  // Attempt LLM inference via LlmService if available in env.
  // The bundle model config has no apiKey — credentials are on the host side.
  const llmService = (env as Record<string, unknown>).LLM as
    | { infer(token: string, request: unknown): Promise<{ content: unknown }> }
    | undefined;

  let responseText: string;

  if (llmService && typeof llmService.infer === "function") {
    try {
      const result = await llmService.infer(token, {
        provider: model.provider,
        modelId: model.modelId,
        messages: [{ role: "user", content: body.prompt }],
      });
      responseText =
        typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    } catch (err) {
      // LlmService call failed — return error as text
      responseText = `[Bundle brain error] LlmService.infer failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    // No LLM service available — return placeholder
    responseText = `[Bundle brain] Model: ${model.provider}/${model.modelId}. Prompt: ${body.prompt}. No LLM_SERVICE binding available — wire env.LLM in bundleEnv to enable inference.`;
  }

  const stream = new ReadableStream({
    start(controller) {
      const event = {
        type: "agent_event",
        event: "text",
        data: { text: responseText },
      };
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      const endEvent = { type: "agent_event", event: "agent_end", data: {} };
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(endEvent)}\n`));
      controller.close();
    },
  });

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
