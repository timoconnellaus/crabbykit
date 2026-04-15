import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { Modules } from "@cloudflare/worker-bundler";
import type { DbService } from "./db-service.js";

const COMPATIBILITY_DATE = "2025-03-01";

/** Stored backend bundle data. */
export interface BackendBundle {
  mainModule: string;
  modules: Modules;
}

/** Options for creating a backend API handler on the agent DO. */
export interface BackendApiHandlerOptions {
  /** Capability storage scoped to the vibe-coder capability. */
  storage: CapabilityStorage;
  /** WorkerLoader binding for loading the backend worker. */
  loader: WorkerLoader;
  /** Service binding to DbService for SQL access. */
  dbService: Service<DbService>;
  /** Optional service binding to AiService for LLM inference. */
  aiService?: Service;
}

/**
 * Handle a backend API request from within the agent DO.
 *
 * The parent worker routes `/preview/{agentId}/api/*` to the agent DO
 * at `/backend-api/*`. This function handles those requests by loading
 * the bundled backend worker via WorkerLoader and forwarding the request.
 *
 * Returns a Response, or null if no backend is started.
 */
export async function handleBackendApi(
  request: Request,
  opts: BackendApiHandlerOptions,
): Promise<Response | null> {
  const loaderKey = await opts.storage.get<string>("backend:loaderKey");
  if (!loaderKey) {
    return null;
  }

  const bundle = await opts.storage.get<BackendBundle>("backend:bundle");
  if (!bundle) {
    return null;
  }

  const env: Record<string, unknown> = {
    __DB_SERVICE: opts.dbService,
  };
  if (opts.aiService) {
    env.__AI_SERVICE = opts.aiService;
  }

  const worker = opts.loader.get(loaderKey, async () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    env,
  }));

  // Strip the /backend-api prefix so the backend sees clean /api/* paths
  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/backend-api/, "") || "/";
  url.pathname = apiPath;

  const entrypoint = await worker.getEntrypoint();
  return entrypoint.fetch(new Request(url.toString(), request));
}

/** Options for the preview backend API proxy (called from parent worker fetch). */
export interface PreviewBackendProxyOptions {
  /** The incoming request. */
  request: Request;
  /** The agent DO namespace. */
  agentNamespace: DurableObjectNamespace;
}

/**
 * Proxy preview backend API requests to the agent DO.
 *
 * Matches `/preview/{agentId}/api/*` and forwards to the agent DO
 * at `/backend-api/*`. The agent DO handles the rest via `handleBackendApi`.
 *
 * Call this from the parent worker's fetch handler BEFORE `handlePreviewRequest`.
 *
 * Returns a Promise<Response> if the request matches, or `null` if not.
 */
export function handlePreviewBackendProxy(
  opts: PreviewBackendProxyOptions,
): Promise<Response> | null {
  const url = new URL(opts.request.url);
  const match = url.pathname.match(/^\/preview\/([^/]+)\/api(\/.*)?$/);
  if (!match) return null;

  const rawId = match[1];
  const id = rawId.includes("-")
    ? opts.agentNamespace.idFromName(rawId)
    : opts.agentNamespace.idFromString(rawId);
  const stub = opts.agentNamespace.get(id);

  const subPath = match[2] || "/";
  const doUrl = new URL(opts.request.url);
  doUrl.pathname = `/backend-api/api${subPath}`;

  return stub.fetch(new Request(doUrl.toString(), opts.request));
}
