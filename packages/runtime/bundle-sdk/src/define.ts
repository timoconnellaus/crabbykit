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
  BundleAlarmContext,
  BundleClientEvent,
  BundleClientEventContext,
  BundleEnv,
  BundleExport,
  BundleMetadata,
  BundleModelConfig,
  BundleSchedule,
  BundleSessionContext,
  BundleSpineClientLifecycle,
} from "./types.js";
import { validateRequirements } from "./validate.js";

interface SpineFetcher {
  appendEntry(token: string, entry: unknown): Promise<unknown>;
  getEntries(token: string, options?: unknown): Promise<unknown[]>;
  buildContext(token: string): Promise<unknown>;
  broadcast(token: string, event: unknown): Promise<void>;
}

function buildLifecycleSpine(spine: SpineFetcher, token: string): BundleSpineClientLifecycle {
  return {
    appendEntry: (entry) => spine.appendEntry(token, entry).then(() => {}),
    getEntries: (options) => spine.getEntries(token, options),
    buildContext: () => spine.buildContext(token),
    broadcast: (event) => spine.broadcast(token, event),
  };
}

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

  // Validate `requiredCapabilities` at build time so malformed declarations
  // surface at `workshop_build` instead of at deploy/dispatch. Empty or
  // undefined declarations round-trip as `undefined` in metadata so legacy
  // bundles without a declaration remain byte-compatible.
  const validated = validateRequirements(setup.requiredCapabilities);

  const baseMetadata: BundleMetadata = setup.metadata ?? {};
  const withRequired: BundleMetadata =
    validated.length > 0 ? { ...baseMetadata, requiredCapabilities: validated } : baseMetadata;
  // Phase 2: declare which lifecycle hooks the bundle implements so
  // the host can skip Worker Loader instantiation for hooks the
  // bundle doesn't have. When all three are absent, omit the field
  // entirely so legacy bundles round-trip unchanged.
  const hasLifecycleHook =
    setup.onAlarm !== undefined ||
    setup.onSessionCreated !== undefined ||
    setup.onClientEvent !== undefined;
  const metadata: BundleMetadata = hasLifecycleHook
    ? {
        ...withRequired,
        lifecycleHooks: {
          onAlarm: setup.onAlarm !== undefined,
          onSessionCreated: setup.onSessionCreated !== undefined,
          onClientEvent: setup.onClientEvent !== undefined,
        },
      }
    : withRequired;

  return {
    async fetch(request: Request, env: TEnv & BundleEnv): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      switch (path) {
        case "/turn":
          return handleTurn(request, env, setup);

        case "/client-event":
          return handleClientEvent(request, env, setup);

        case "/alarm":
          return handleAlarm(request, env, setup);

        case "/session-created":
          return handleSessionCreated(request, env, setup);

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
  if (!env.__BUNDLE_TOKEN) {
    return Response.json({ error: "Missing __BUNDLE_TOKEN" }, { status: 401 });
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

interface LifecycleEnv {
  __BUNDLE_TOKEN?: string;
  SPINE?: SpineFetcher;
}

function checkLifecycleEnv<TEnv extends BundleEnv>(
  env: TEnv,
): { token: string; spine: SpineFetcher } | Response {
  const lifecycleEnv = env as TEnv & LifecycleEnv;
  if (!lifecycleEnv.__BUNDLE_TOKEN) {
    return Response.json({ status: "error", message: "Missing __BUNDLE_TOKEN" }, { status: 401 });
  }
  if (!lifecycleEnv.SPINE) {
    return Response.json(
      { status: "error", message: "Missing env.SPINE service binding" },
      { status: 500 },
    );
  }
  return { token: lifecycleEnv.__BUNDLE_TOKEN, spine: lifecycleEnv.SPINE };
}

function lifecycleErrorBody(err: unknown): Record<string, unknown> {
  return {
    status: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

async function handleAlarm<TEnv extends BundleEnv>(
  request: Request,
  env: TEnv,
  setup: BundleAgentSetup<TEnv>,
): Promise<Response> {
  const guard = checkLifecycleEnv(env);
  if (guard instanceof Response) return guard;

  if (!setup.onAlarm) {
    return Response.json({ status: "noop" });
  }
  let body: { schedule?: BundleSchedule };
  try {
    body = (await request.json()) as { schedule?: BundleSchedule };
  } catch {
    return Response.json({ status: "error", message: "Invalid request body" }, { status: 400 });
  }
  const schedule = body.schedule;
  if (!schedule || typeof schedule !== "object" || typeof schedule.id !== "string") {
    return Response.json(
      { status: "error", message: "Request body must include a schedule" },
      { status: 400 },
    );
  }
  const ctx: BundleAlarmContext = {
    schedule,
    spine: buildLifecycleSpine(guard.spine, guard.token),
  };
  try {
    const result = await setup.onAlarm(env, ctx);
    return Response.json({ status: "ok", result: result ?? null });
  } catch (err) {
    return Response.json(lifecycleErrorBody(err));
  }
}

async function handleSessionCreated<TEnv extends BundleEnv>(
  request: Request,
  env: TEnv,
  setup: BundleAgentSetup<TEnv>,
): Promise<Response> {
  const guard = checkLifecycleEnv(env);
  if (guard instanceof Response) return guard;

  if (!setup.onSessionCreated) {
    return Response.json({ status: "noop" });
  }
  let body: { session?: { id?: string; name?: string } };
  try {
    body = (await request.json()) as { session?: { id?: string; name?: string } };
  } catch {
    return Response.json({ status: "error", message: "Invalid request body" }, { status: 400 });
  }
  const sessionId = body.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return Response.json(
      { status: "error", message: "Request body must include session.id" },
      { status: 400 },
    );
  }
  const sessionName = typeof body.session?.name === "string" ? body.session.name : sessionId;
  const ctx: BundleSessionContext = {
    sessionId,
    spine: buildLifecycleSpine(guard.spine, guard.token),
  };
  try {
    await setup.onSessionCreated(env, { id: sessionId, name: sessionName }, ctx);
    return Response.json({ status: "ok" });
  } catch (err) {
    return Response.json(lifecycleErrorBody(err));
  }
}

async function handleClientEvent<TEnv extends BundleEnv>(
  request: Request,
  env: TEnv,
  setup: BundleAgentSetup<TEnv>,
): Promise<Response> {
  const guard = checkLifecycleEnv(env);
  if (guard instanceof Response) return guard;

  if (!setup.onClientEvent) {
    return Response.json({ status: "noop" });
  }
  let body: { sessionId?: string; event?: BundleClientEvent };
  try {
    body = (await request.json()) as { sessionId?: string; event?: BundleClientEvent };
  } catch {
    return Response.json({ status: "error", message: "Invalid request body" }, { status: 400 });
  }
  const sessionId = body.sessionId;
  const event = body.event;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    !event ||
    typeof event !== "object"
  ) {
    return Response.json(
      { status: "error", message: "Request body must include sessionId and event" },
      { status: 400 },
    );
  }
  const ctx: BundleClientEventContext = {
    sessionId,
    event,
    spine: buildLifecycleSpine(guard.spine, guard.token),
  };
  try {
    await setup.onClientEvent(env, event, ctx);
    return Response.json({ status: "ok" });
  } catch (err) {
    return Response.json(lifecycleErrorBody(err));
  }
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
      hasToken: Boolean(env.__BUNDLE_TOKEN),
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
