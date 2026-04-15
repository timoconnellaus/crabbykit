import type { AppRequestOptions } from "./types.js";

/**
 * Handle app requests matching `/apps/:slug[/...]`.
 *
 * Resolves the app's current version by reading the CURRENT file from R2,
 * then delegates to the existing deploy serving infrastructure.
 *
 * Returns a Promise<Response> if the request matches, or `null` if not.
 */
export function handleAppRequest(opts: AppRequestOptions): Promise<Response> | null {
  const url = new URL(opts.request.url);
  const match = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const slug = match[1];
  const subPath = match[2] || "/";

  return serveApp(opts, slug, subPath, url.search);
}

async function serveApp(
  opts: AppRequestOptions,
  slug: string,
  subPath: string,
  search: string,
): Promise<Response> {
  // Read CURRENT file to determine active version
  const agentIds = await listAgentIds(opts.storageBucket);

  for (const agentDoId of agentIds) {
    const currentKey = `${agentDoId}/apps/${slug}/.deploys/CURRENT`;
    const currentObj = await opts.storageBucket.get(currentKey);
    if (!currentObj) continue;

    const versionStr = (await currentObj.text()).trim();
    const deployPrefix = `${agentDoId}/apps/${slug}/.deploys/v${versionStr}`;

    // Check if this is an API request and backend exists
    if (subPath.startsWith("/api/") || subPath === "/api") {
      if (!opts.dbService) {
        return new Response("Backend not configured", { status: 503 });
      }
      return serveBackend(opts, deployPrefix, subPath, search);
    }

    return serveFrontend(opts, deployPrefix, slug, versionStr, subPath, search);
  }

  return new Response("App not found", { status: 404 });
}

async function serveFrontend(
  opts: AppRequestOptions,
  deployPrefix: string,
  slug: string,
  version: string,
  subPath: string,
  search: string,
): Promise<Response> {
  const cacheKey = `app/v1/${slug}/${version}`;

  const worker = opts.loader.get(cacheKey, async () => {
    const assets = await loadAssetsFromR2(opts.storageBucket, deployPrefix);
    if (assets.size === 0) {
      throw new Error(`No assets found for app ${slug} v${version}`);
    }
    const script = generateWorkerScript(assets);
    return {
      compatibilityDate: "2025-03-01",
      mainModule: "server.js",
      modules: { "server.js": script },
      globalOutbound: null,
    };
  });

  const strippedUrl = new URL(opts.request.url);
  strippedUrl.pathname = subPath;
  strippedUrl.search = search;

  return worker.getEntrypoint().fetch(new Request(strippedUrl.toString(), opts.request));
}

async function serveBackend(
  opts: AppRequestOptions,
  deployPrefix: string,
  subPath: string,
  search: string,
): Promise<Response> {
  const bundleKey = `${deployPrefix}/.backend/bundle.json`;
  const backendCacheKey = `app-backend/v1/${deployPrefix}`;
  const dbService = opts.dbService;

  const worker = opts.loader.get(backendCacheKey, async () => {
    const obj = await opts.storageBucket.get(bundleKey);
    if (!obj) {
      throw new Error("No backend bundle found");
    }
    const bundle = (await obj.json()) as { mainModule: string; modules: Record<string, string> };
    return {
      compatibilityDate: "2025-03-01",
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      // biome-ignore lint/style/useNamingConvention: __DB_SERVICE is a Worker environment binding convention
      env: { __DB_SERVICE: dbService },
    };
  });

  const strippedUrl = new URL(opts.request.url);
  strippedUrl.pathname = subPath;
  strippedUrl.search = search;

  return worker.getEntrypoint().fetch(new Request(strippedUrl.toString(), opts.request));
}

/**
 * List all agent DO IDs that have apps deployed.
 * In practice there's usually one per worker, but we scan R2 prefixes.
 */
async function listAgentIds(bucket: R2Bucket): Promise<string[]> {
  const listed = await bucket.list({ delimiter: "/" });
  return listed.delimitedPrefixes.map((p) => p.replace(/\/$/, ""));
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

async function loadAssetsFromR2(
  bucket: R2Bucket,
  prefix: string,
): Promise<Map<string, { content: string; binary: boolean }>> {
  const fullPrefix = `${prefix}/`;
  const assets = new Map<string, { content: string; binary: boolean }>();

  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: fullPrefix, cursor });
    for (const object of listed.objects) {
      if (object.key.endsWith(".manifest.json")) continue;

      const relativePath = `/${object.key.slice(fullPrefix.length)}`;
      const obj = await bucket.get(object.key);
      if (!obj) continue;

      if (isTextFile(relativePath)) {
        let content = await obj.text();
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

function escapeStringForJS(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

function generateWorkerScript(assets: Map<string, { content: string; binary: boolean }>): string {
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
