/**
 * Deploy server utility — serves deployed vibe-coder apps via Cloudflare worker loaders.
 *
 * The parent worker calls `handleDeployRequest()` from its fetch handler.
 * Requests matching `/deploy/{agentId}/{deployId}/*` are served by a
 * self-contained dynamic worker loaded via `LOADER.get()`.
 *
 * The dynamic worker embeds all assets in its source code — no R2 binding
 * needed at serve time. R2 is the source of truth; the worker loader cache
 * reconstructs the worker from R2 on first access or after eviction.
 */

import type { BackendBundle } from "./backend-api-proxy.js";

const COMPATIBILITY_DATE = "2025-03-01";

/**
 * Bump this when the generated worker script logic changes.
 * The worker loader caches by key — without a version, code changes
 * (like the HTML path rewrite) won't take effect until cache eviction.
 */
const WORKER_SCRIPT_VERSION = 2;

/** Options for the deploy request handler. */
export interface DeployRequestOptions {
  /** The incoming request from the worker fetch handler. */
  request: Request;
  /** The agent Durable Object namespace (used to normalize UUIDs to hex IDs). */
  agentNamespace: DurableObjectNamespace;
  /** The R2 bucket containing deploy assets. */
  storageBucket: R2Bucket;
  /** The worker loader binding. */
  loader: WorkerLoader;
  /** DbService service binding (required for deploys with backends). */
  dbService?: Service;
}

/**
 * Handle deploy requests matching `/deploy/:agentId/:deployId[/...]`.
 *
 * Returns a Promise<Response> if the request matches, or `null` if not.
 * Follows the same pattern as `handlePreviewRequest` in cloudflare-sandbox.
 */
export function handleDeployRequest(opts: DeployRequestOptions): Promise<Response> | null {
  const url = new URL(opts.request.url);
  const match = url.pathname.match(/^\/deploy\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const rawId = match[1];
  const deployId = match[2];
  const subPath = match[3] || "/";

  // Normalize agent ID: UUID (with dashes) → DO hex ID
  const agentDoId = rawId.includes("-") ? opts.agentNamespace.idFromName(rawId).toString() : rawId;
  const cacheKey = `v${WORKER_SCRIPT_VERSION}/${agentDoId}/${deployId}`;

  // Route /api/* to the backend worker if one exists
  if (subPath.startsWith("/api/") || subPath === "/api") {
    return serveDeployBackend(opts, agentDoId, deployId, subPath, url.search);
  }

  return serveDeployFrontend(opts, agentDoId, deployId, cacheKey, subPath, url.search);
}

async function serveDeployFrontend(
  opts: DeployRequestOptions,
  agentDoId: string,
  deployId: string,
  cacheKey: string,
  subPath: string,
  search: string,
): Promise<Response> {
  const worker = opts.loader.get(cacheKey, async () => {
    const assets = await loadAssetsFromR2(opts.storageBucket, agentDoId, deployId);
    if (assets.size === 0) {
      throw new Error(`No assets found for deploy ${deployId}`);
    }
    const script = generateWorkerScript(assets);
    return {
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "server.js",
      modules: { "server.js": script },
      globalOutbound: null, // block all outbound fetch
    };
  });

  // Forward the request with the prefix stripped
  const strippedUrl = new URL(opts.request.url);
  strippedUrl.pathname = subPath;
  strippedUrl.search = search;

  return worker.getEntrypoint().fetch(new Request(strippedUrl.toString(), opts.request));
}

/** R2 prefix where backend bundles are stored. */
const BACKEND_BUNDLE_KEY = ".backend/bundle.json";

async function serveDeployBackend(
  opts: DeployRequestOptions,
  agentDoId: string,
  deployId: string,
  subPath: string,
  search: string,
): Promise<Response> {
  if (!opts.dbService) {
    return new Response("Backend not configured", { status: 503 });
  }

  const backendCacheKey = `backend/v${WORKER_SCRIPT_VERSION}/${agentDoId}/${deployId}`;
  const dbService = opts.dbService;

  const worker = opts.loader.get(backendCacheKey, async () => {
    // Load the bundled backend from R2
    const bundleKey = `${agentDoId}/deploys/${deployId}/${BACKEND_BUNDLE_KEY}`;
    const obj = await opts.storageBucket.get(bundleKey);
    if (!obj) {
      throw new Error(`No backend bundle found for deploy ${deployId}`);
    }
    const bundle = (await obj.json()) as BackendBundle;

    return {
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      env: {
        __DB_SERVICE: dbService,
      },
    };
  });

  const strippedUrl = new URL(opts.request.url);
  strippedUrl.pathname = subPath;
  strippedUrl.search = search;

  return worker.getEntrypoint().fetch(new Request(strippedUrl.toString(), opts.request));
}

/** Text file extensions that are embedded as-is (not base64). */
const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".xml",
  ".webmanifest",
  ".map",
  ".md",
]);

function isTextFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/** Read all deploy assets from R2. */
async function loadAssetsFromR2(
  bucket: R2Bucket,
  agentDoId: string,
  deployId: string,
): Promise<Map<string, { content: string; binary: boolean }>> {
  const prefix = `${agentDoId}/deploys/${deployId}/`;
  const assets = new Map<string, { content: string; binary: boolean }>();

  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const object of listed.objects) {
      // Skip manifest
      if (object.key.endsWith(".manifest.json")) continue;

      const relativePath = `/${object.key.slice(prefix.length)}`;
      const obj = await bucket.get(object.key);
      if (!obj) continue;

      if (isTextFile(relativePath)) {
        let content = await obj.text();
        // Rewrite absolute asset paths in HTML to relative so they resolve
        // correctly when served under a /deploy/:agentId/:deployId/ prefix.
        if (relativePath.endsWith(".html")) {
          content = content.replace(/src="\//g, 'src="./').replace(/href="\//g, 'href="./');
        }
        assets.set(relativePath, { content, binary: false });
      } else {
        const buf = await obj.arrayBuffer();
        assets.set(relativePath, { content: arrayBufferToBase64(buf), binary: true });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return assets;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Content type map for common file extensions. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".md": "text/markdown; charset=utf-8",
};

/**
 * Generate a self-contained worker script that serves embedded assets.
 *
 * The generated worker:
 * - Maps URL paths to embedded text or base64-encoded binary assets
 * - Infers content-type from file extension
 * - Falls back to index.html for SPA routing
 * - Sets cache headers (immutable for hashed assets, no-cache for HTML)
 */
export function generateWorkerScript(
  assets: Map<string, { content: string; binary: boolean }>,
): string {
  const textEntries: string[] = [];
  const binaryEntries: string[] = [];

  for (const [path, { content, binary }] of assets) {
    const escaped = escapeStringForJS(content);
    if (binary) {
      binaryEntries.push(`  ${JSON.stringify(path)}: "${escaped}"`);
    } else {
      textEntries.push(`  ${JSON.stringify(path)}: ${JSON.stringify(content)}`);
    }
  }

  // Serialize the content-type map into the worker
  const ctEntries = Object.entries(CONTENT_TYPES)
    .map(([ext, ct]) => `  "${ext}": "${ct}"`)
    .join(",\n");

  return `
const TEXT_ASSETS = {
${textEntries.join(",\n")}
};

const BINARY_ASSETS = {
${binaryEntries.join(",\n")}
};

const CONTENT_TYPES = {
${ctEntries}
};

function getContentType(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = path.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isHashedAsset(path) {
  return /\\/assets\\/.*-[a-zA-Z0-9]{8,}\\.[a-z]+$/.test(path);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    const headers = new Headers();
    headers.set("content-type", getContentType(path));

    if (isHashedAsset(path)) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    } else {
      headers.set("cache-control", "no-cache");
    }

    if (TEXT_ASSETS[path] !== undefined) {
      return new Response(TEXT_ASSETS[path], { headers });
    }

    if (BINARY_ASSETS[path] !== undefined) {
      return new Response(base64ToBytes(BINARY_ASSETS[path]), { headers });
    }

    // SPA fallback
    if (TEXT_ASSETS["/index.html"] !== undefined) {
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "no-cache");
      return new Response(TEXT_ASSETS["/index.html"], { headers });
    }

    return new Response("Not Found", { status: 404 });
  }
};
`.trim();
}

/** Escape a string for use in a JS string literal (backtick-free). */
function escapeStringForJS(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}
