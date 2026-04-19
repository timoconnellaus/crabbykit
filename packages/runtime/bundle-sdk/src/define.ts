/**
 * defineBundleAgent — the authoring API for bundle brains.
 *
 * Returns a default export that implements the bundle fetch handler contract.
 * The compiled bundle's default export is this fetch handler, which the host
 * DO invokes via Worker Loader.
 */

import { buildBundleContext, runBundleTurn } from "./runtime.js";
import { createCostEmitter, createKvStoreClient, createSessionChannel } from "./spine-clients.js";
import type {
  BundleActionContext,
  BundleAgentSetup,
  BundleAlarmContext,
  BundleClientEvent,
  BundleClientEventContext,
  BundleContext,
  BundleEnv,
  BundleExport,
  BundleHttpContext,
  BundleHttpRequest,
  BundleHttpResponse,
  BundleMetadata,
  BundleModelConfig,
  BundleRouteDeclaration,
  BundleSchedule,
  BundleSessionContext,
  BundleSpineClientLifecycle,
} from "./types.js";
import {
  BundleMetadataExtractionError,
  validateActionCapabilityIds,
  validateHttpRoutes,
  validateRequirements,
} from "./validate.js";

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
 * Build a probe `BundleContext` for the build-time metadata extraction
 * walk. Capabilities call `httpHandlers(ctx)` with this stub — accessing
 * `ctx.env.SOMETHING` that's missing surfaces as a TypeError, which the
 * caller wraps in `BundleMetadataExtractionError`.
 *
 * Spine clients here intentionally throw on call: the probe walk only
 * inspects declared route shapes, never executes a handler.
 */
function buildProbeContext<TEnv extends BundleEnv>(probeEnv: TEnv): BundleContext {
  const reject = (): never => {
    throw new Error("Bundle probe context — RPC not available at build time");
  };
  return {
    agentId: "",
    sessionId: "",
    env: probeEnv,
    sessionStore: {
      appendEntry: reject,
      getEntries: reject,
      getSession: reject,
      createSession: reject,
      listSessions: reject,
      buildContext: reject,
      getCompactionCheckpoint: reject,
    },
    kvStore: {
      get: reject,
      put: reject,
      delete: reject,
      list: reject,
    },
    scheduler: {
      create: reject,
      update: reject,
      delete: reject,
      list: reject,
      setAlarm: reject,
    },
    channel: {
      broadcast: reject,
      broadcastGlobal: reject,
    },
    emitCost: reject,
    hookBridge: {
      recordToolExecution: reject,
      processBeforeInference: reject,
      processBeforeToolExecution: reject,
    },
  };
}

/**
 * Walk `setup.capabilities(probeEnv)` once to collect every declared
 * HTTP route and every capability id that hosts an `onAction`. Validates
 * the collected lists via `validateHttpRoutes` and
 * `validateActionCapabilityIds` before returning. Throws
 * `BundleMetadataExtractionError` when a capability factory throws —
 * including when its `httpHandlers(ctx)` reads a missing env field.
 */
function extractBundleSurfaces<TEnv extends BundleEnv>(
  setup: BundleAgentSetup<TEnv>,
): { httpRoutes: BundleRouteDeclaration[]; actionCapabilityIds: string[] } {
  if (!setup.capabilities) {
    return { httpRoutes: [], actionCapabilityIds: [] };
  }

  const probeEnv = {} as TEnv;
  const probeCtx = buildProbeContext(probeEnv);

  const httpRoutes: BundleRouteDeclaration[] = [];
  const actionCapabilityIds: string[] = [];

  let capabilities: ReturnType<NonNullable<typeof setup.capabilities>>;
  try {
    capabilities = setup.capabilities(probeEnv);
  } catch (err) {
    throw new BundleMetadataExtractionError({
      capabilityId: "<setup.capabilities>",
      cause: err,
    });
  }

  for (const cap of capabilities ?? []) {
    if (cap.httpHandlers) {
      let declared: ReturnType<typeof cap.httpHandlers>;
      try {
        declared = cap.httpHandlers(probeCtx);
      } catch (err) {
        throw new BundleMetadataExtractionError({
          capabilityId: cap.id,
          cause: err,
        });
      }
      for (const h of declared ?? []) {
        httpRoutes.push({
          method: h.method,
          path: h.path,
          capabilityId: cap.id,
        });
      }
    }
    if (cap.onAction) {
      actionCapabilityIds.push(cap.id);
    }
  }

  validateHttpRoutes(httpRoutes);
  validateActionCapabilityIds(actionCapabilityIds);

  return { httpRoutes, actionCapabilityIds };
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
  // bundle doesn't have.
  const hasLifecycleHook =
    setup.onAlarm !== undefined ||
    setup.onSessionCreated !== undefined ||
    setup.onClientEvent !== undefined;

  // bundle-http-and-ui-surface: walk `setup.capabilities(probeEnv)`
  // once with a minimal probe env to extract every declared HTTP route
  // and every capability id that hosts an `onAction`. The host reads
  // these on dispatch to decide whether to forward an incoming request
  // / `capability_action` into the bundle isolate.
  const { httpRoutes, actionCapabilityIds } = extractBundleSurfaces(setup);
  const hasSurfaces = httpRoutes.length > 0 || actionCapabilityIds.length > 0;

  // When NEITHER lifecycleHooks nor surfaces is populated, omit both
  // so legacy bundles round-trip byte-identical to today's metadata.
  let metadata: BundleMetadata = withRequired;
  if (hasLifecycleHook) {
    metadata = {
      ...metadata,
      lifecycleHooks: {
        onAlarm: setup.onAlarm !== undefined,
        onSessionCreated: setup.onSessionCreated !== undefined,
        onClientEvent: setup.onClientEvent !== undefined,
      },
    };
  }
  if (hasSurfaces) {
    const surfaces: NonNullable<BundleMetadata["surfaces"]> = {};
    if (httpRoutes.length > 0) surfaces.httpRoutes = httpRoutes;
    if (actionCapabilityIds.length > 0) surfaces.actionCapabilityIds = actionCapabilityIds;
    metadata = { ...metadata, surfaces };
  }

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

        case "/http":
          return handleHttp(request, env, setup);

        case "/action":
          return handleAction(request, env, setup);

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

  // Phase 3: when the dispatcher injected __BUNDLE_ACTIVE_MODE, lift
  // its identity onto the BundleContext so bundle code can branch on
  // `ctx.activeMode?.id`. The mode's allow/deny lists stay
  // env-scoped (read by runBundleTurn for filter application).
  const activeMode = (env as Record<string, unknown>).__BUNDLE_ACTIVE_MODE as
    | { id: string; name: string }
    | undefined;
  const context = buildBundleContext(
    env,
    spine,
    body.agentId,
    body.sessionId,
    activeMode ? { id: activeMode.id, name: activeMode.name } : undefined,
  );
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

// --- /http and /action endpoints (bundle-http-and-ui-surface) ---

interface HttpEnvelope {
  capabilityId?: string;
  method?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyBase64?: string | null;
  sessionId?: string | null;
}

interface ActionEnvelope {
  capabilityId?: string;
  action?: string;
  data?: unknown;
  sessionId?: string;
}

interface HttpActionEnv {
  __BUNDLE_TOKEN?: string;
  __BUNDLE_PUBLIC_URL?: string;
  SPINE?: unknown;
}

/**
 * Same `/:name`-segment matcher used by the host-side `matchPathPattern`.
 * Duplicated here because `bundle-sdk` cannot import from `agent-runtime`.
 * Kept structurally identical so the host's match decision and the
 * bundle's param extraction agree on the same path shape.
 */
function bundleMatchPathPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i];
    const v = pathSegments[i];
    if (p.startsWith(":")) {
      if (v === "") return null;
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

/**
 * Decode the `aid` claim from an unverified `__BUNDLE_TOKEN`. The
 * host-side SpineService verifies signatures on RPC; the bundle SDK
 * trusts the host-injected token for its own context construction
 * because the bundle isolate is the host's tenanted environment.
 *
 * Returns `""` when the token is absent / malformed — the host's
 * dispatcher always injects a well-formed token, so the empty-string
 * branch only fires in tests that drive `/http` directly.
 */
function decodeAgentIdFromToken(token: string | undefined): string {
  if (!token || typeof token !== "string") return "";
  const dot = token.indexOf(".");
  if (dot <= 0) return "";
  const payloadB64 = token.slice(0, dot);
  try {
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const parsed = JSON.parse(json) as { aid?: unknown };
    return typeof parsed.aid === "string" ? parsed.aid : "";
  } catch {
    return "";
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function handleHttp<TEnv extends BundleEnv>(
  request: Request,
  env: TEnv,
  setup: BundleAgentSetup<TEnv>,
): Promise<Response> {
  const httpEnv = env as TEnv & HttpActionEnv;
  if (!httpEnv.__BUNDLE_TOKEN) {
    return Response.json(
      { status: 401, headers: {}, bodyBase64: null, error: "Missing __BUNDLE_TOKEN" },
      { status: 401 },
    );
  }
  if (!setup.capabilities) {
    return Response.json(
      { status: 404, headers: {}, bodyBase64: null, error: "Bundle declares no capabilities" },
      { status: 200 },
    );
  }

  let envelope: HttpEnvelope;
  try {
    envelope = (await request.json()) as HttpEnvelope;
  } catch {
    return Response.json(
      { status: 400, headers: {}, bodyBase64: null, error: "Invalid /http envelope JSON" },
      { status: 200 },
    );
  }

  const { capabilityId, method, path, query, headers, bodyBase64, sessionId } = envelope;
  if (typeof capabilityId !== "string" || typeof method !== "string" || typeof path !== "string") {
    return Response.json(
      {
        status: 400,
        headers: {},
        bodyBase64: null,
        error: "Envelope must include capabilityId, method, path",
      },
      { status: 200 },
    );
  }

  const probeCtx = buildProbeContext(env);
  const capabilities = setup.capabilities(env) ?? [];
  const cap = capabilities.find((c) => c.id === capabilityId);
  if (!cap || !cap.httpHandlers) {
    const body = `capability not found in bundle: ${capabilityId}`;
    return Response.json({
      status: 404,
      headers: { "content-type": "text/plain" },
      bodyBase64: uint8ArrayToBase64(new TextEncoder().encode(body)),
    });
  }

  const declared = cap.httpHandlers(probeCtx) ?? [];
  let match: {
    handler: (typeof declared)[number]["handler"];
    params: Record<string, string>;
  } | null = null;
  for (const decl of declared) {
    if (decl.method !== method) continue;
    const params = bundleMatchPathPattern(decl.path, path);
    if (params === null) continue;
    match = { handler: decl.handler, params };
    break;
  }
  if (!match) {
    const body = `route not found in bundle capability "${capabilityId}": ${method} ${path}`;
    return Response.json({
      status: 404,
      headers: { "content-type": "text/plain" },
      bodyBase64: uint8ArrayToBase64(new TextEncoder().encode(body)),
    });
  }

  const spine = httpEnv.SPINE as unknown as Parameters<typeof createKvStoreClient>[0] | undefined;
  if (!spine) {
    return Response.json({
      status: 500,
      headers: { "content-type": "text/plain" },
      bodyBase64: uint8ArrayToBase64(new TextEncoder().encode("Missing env.SPINE service binding")),
    });
  }

  const token = httpEnv.__BUNDLE_TOKEN;
  const getToken = (): string => token;
  const agentId = decodeAgentIdFromToken(token);
  const publicUrl =
    typeof httpEnv.__BUNDLE_PUBLIC_URL === "string" ? httpEnv.__BUNDLE_PUBLIC_URL : undefined;

  const httpRequest: BundleHttpRequest = {
    method,
    headers: headers ?? {},
    query: query ?? {},
    body:
      typeof bodyBase64 === "string" && bodyBase64.length > 0
        ? base64ToUint8Array(bodyBase64)
        : null,
  };

  const httpCtx: BundleHttpContext = {
    capabilityId,
    agentId,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    publicUrl,
    params: match.params,
    query: query ?? {},
    headers: headers ?? {},
    kvStore: createKvStoreClient(spine, getToken),
    channel: createSessionChannel(spine, getToken),
    emitCost: createCostEmitter(spine, getToken),
  };

  let response: BundleHttpResponse;
  try {
    response = await match.handler(httpRequest, httpCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({
      status: 500,
      headers: { "content-type": "text/plain" },
      bodyBase64: uint8ArrayToBase64(new TextEncoder().encode(message)),
    });
  }

  const responseBody =
    response.body && response.body.byteLength > 0 ? uint8ArrayToBase64(response.body) : null;
  return Response.json({
    status: response.status,
    headers: response.headers ?? {},
    bodyBase64: responseBody,
  });
}

async function handleAction<TEnv extends BundleEnv>(
  request: Request,
  env: TEnv,
  setup: BundleAgentSetup<TEnv>,
): Promise<Response> {
  const httpEnv = env as TEnv & HttpActionEnv;
  if (!httpEnv.__BUNDLE_TOKEN) {
    return Response.json({ status: "error", message: "Missing __BUNDLE_TOKEN" }, { status: 401 });
  }
  if (!setup.capabilities) {
    return Response.json({ status: "noop" });
  }

  let envelope: ActionEnvelope;
  try {
    envelope = (await request.json()) as ActionEnvelope;
  } catch {
    return Response.json(
      { status: "error", message: "Invalid /action envelope JSON" },
      { status: 200 },
    );
  }
  const { capabilityId, action, data, sessionId } = envelope;
  if (
    typeof capabilityId !== "string" ||
    typeof action !== "string" ||
    typeof sessionId !== "string"
  ) {
    return Response.json(
      { status: "error", message: "Envelope must include capabilityId, action, sessionId" },
      { status: 200 },
    );
  }

  const capabilities = setup.capabilities(env) ?? [];
  const cap = capabilities.find((c) => c.id === capabilityId);
  if (!cap || !cap.onAction) {
    return Response.json({ status: "noop" });
  }

  const spine = httpEnv.SPINE as unknown as Parameters<typeof createKvStoreClient>[0] | undefined;
  if (!spine) {
    return Response.json(
      { status: "error", message: "Missing env.SPINE service binding" },
      { status: 200 },
    );
  }

  const token = httpEnv.__BUNDLE_TOKEN;
  const getToken = (): string => token;
  const agentId = decodeAgentIdFromToken(token);
  const publicUrl =
    typeof httpEnv.__BUNDLE_PUBLIC_URL === "string" ? httpEnv.__BUNDLE_PUBLIC_URL : undefined;

  const actionCtx: BundleActionContext = {
    capabilityId,
    agentId,
    sessionId,
    publicUrl,
    kvStore: createKvStoreClient(spine, getToken),
    channel: createSessionChannel(spine, getToken),
    spine: buildLifecycleSpine(spine as unknown as SpineFetcher, token),
    emitCost: createCostEmitter(spine, getToken),
  };

  try {
    await cap.onAction(action, data, actionCtx);
    return Response.json({ status: "ok" });
  } catch (err) {
    return Response.json({
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
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
