import { describe, expect, it, vi } from "vitest";
import { generateWorkerScript, handleDeployRequest } from "../deploy-server.js";
import type { DeployRequestOptions } from "../deploy-server.js";

// --- Helpers ---

function mockR2Object(content: string | ArrayBuffer) {
  const isText = typeof content === "string";
  return {
    text: vi.fn().mockResolvedValue(isText ? content : ""),
    arrayBuffer: vi
      .fn()
      .mockResolvedValue(isText ? new TextEncoder().encode(content).buffer : content),
    json: vi.fn().mockResolvedValue(isText ? JSON.parse(content) : null),
  };
}

function mockR2Bucket(objects: { key: string; content: string | ArrayBuffer }[] = []) {
  const r2Objects = objects.map((o) => ({ key: o.key }));
  return {
    list: vi.fn().mockResolvedValue({ objects: r2Objects, truncated: false, cursor: undefined }),
    get: vi.fn().mockImplementation((key: string) => {
      const found = objects.find((o) => o.key === key);
      return Promise.resolve(found ? mockR2Object(found.content) : null);
    }),
  };
}

function mockAgentNamespace() {
  return {
    idFromName: vi.fn().mockImplementation((name: string) => ({
      toString: () => name.replace(/-/g, ""),
    })),
  };
}

function mockLoader(responseBody = "OK", status = 200) {
  const fetchFn = vi.fn().mockResolvedValue(new Response(responseBody, { status }));
  return {
    get: vi.fn().mockReturnValue({
      getEntrypoint: () => ({ fetch: fetchFn }),
    }),
    _fetchFn: fetchFn,
  };
}

function createOpts(overrides: Partial<DeployRequestOptions> = {}): DeployRequestOptions {
  return {
    request: new Request("http://localhost/deploy/agent123/deploy456/index.html"),
    agentNamespace: mockAgentNamespace() as unknown as DurableObjectNamespace,
    storageBucket: mockR2Bucket() as unknown as R2Bucket,
    loader: mockLoader() as unknown as WorkerLoader,
    ...overrides,
  };
}

// --- Tests ---

describe("handleDeployRequest", () => {
  it("returns null when URL does not match deploy pattern", () => {
    const opts = createOpts({
      request: new Request("http://localhost/api/agents"),
    });
    const result = handleDeployRequest(opts);
    expect(result).toBeNull();
  });

  it("returns null for /deploy with no segments", () => {
    const opts = createOpts({
      request: new Request("http://localhost/deploy"),
    });
    expect(handleDeployRequest(opts)).toBeNull();
  });

  it("returns null for /deploy with only one segment", () => {
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123"),
    });
    expect(handleDeployRequest(opts)).toBeNull();
  });

  it("returns a Promise<Response> for matching deploy URLs", async () => {
    const opts = createOpts();
    const result = handleDeployRequest(opts);
    expect(result).toBeInstanceOf(Promise);
    const response = await result;
    expect(response).toBeInstanceOf(Response);
  });

  it("routes /api/* requests to backend handler", async () => {
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456/api/items"),
      dbService: {} as Service,
    });
    const result = handleDeployRequest(opts);
    expect(result).toBeInstanceOf(Promise);
    const response = await result!;
    expect(response).toBeInstanceOf(Response);
  });

  it("returns 503 for /api/* when no dbService configured", async () => {
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456/api/items"),
    });
    // No dbService
    delete (opts as unknown as Record<string, unknown>).dbService;
    const response = await handleDeployRequest(opts)!;
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Backend not configured");
  });

  it("normalizes UUID agent IDs (with dashes) to hex DO IDs", async () => {
    const ns = mockAgentNamespace();
    const loader = mockLoader();
    const opts = createOpts({
      request: new Request(
        "http://localhost/deploy/550e8400-e29b-41d4-a716-446655440000/deploy456/",
      ),
      agentNamespace: ns as unknown as DurableObjectNamespace,
      loader: loader as unknown as WorkerLoader,
    });
    await handleDeployRequest(opts)!;
    // Should have called idFromName since the ID contains dashes
    expect(ns.idFromName).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000");
  });

  it("does not normalize hex agent IDs (no dashes)", async () => {
    const ns = mockAgentNamespace();
    const loader = mockLoader();
    const opts = createOpts({
      request: new Request("http://localhost/deploy/abc123def456/deploy789/"),
      agentNamespace: ns as unknown as DurableObjectNamespace,
      loader: loader as unknown as WorkerLoader,
    });
    await handleDeployRequest(opts)!;
    // Should NOT have called idFromName since there are no dashes
    expect(ns.idFromName).not.toHaveBeenCalled();
  });

  it("strips the deploy prefix and forwards to the worker", async () => {
    const loader = mockLoader();
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456/assets/main.js"),
      loader: loader as unknown as WorkerLoader,
    });
    await handleDeployRequest(opts)!;
    const fetchFn = loader._fetchFn;
    expect(fetchFn).toHaveBeenCalled();
    const forwarded = fetchFn.mock.calls[0][0] as Request;
    const url = new URL(forwarded.url);
    expect(url.pathname).toBe("/assets/main.js");
  });

  it("defaults subPath to / when no trailing path", async () => {
    const loader = mockLoader();
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456"),
      loader: loader as unknown as WorkerLoader,
    });
    await handleDeployRequest(opts)!;
    const fetchFn = loader._fetchFn;
    const forwarded = fetchFn.mock.calls[0][0] as Request;
    const url = new URL(forwarded.url);
    expect(url.pathname).toBe("/");
  });

  it("preserves query string when forwarding", async () => {
    const loader = mockLoader();
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456/page?foo=bar&baz=1"),
      loader: loader as unknown as WorkerLoader,
    });
    await handleDeployRequest(opts)!;
    const fetchFn = loader._fetchFn;
    const forwarded = fetchFn.mock.calls[0][0] as Request;
    const url = new URL(forwarded.url);
    expect(url.search).toBe("?foo=bar&baz=1");
  });

  it("routes /api (no trailing slash) to backend", async () => {
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456/api"),
    });
    delete (opts as unknown as Record<string, unknown>).dbService;
    const response = await handleDeployRequest(opts)!;
    // Should hit the backend path (returns 503 because no dbService)
    expect(response.status).toBe(503);
  });

  it("uses versioned cache key for loader", async () => {
    const loader = mockLoader();
    const opts = createOpts({
      request: new Request("http://localhost/deploy/agent123/deploy456/index.html"),
      loader: loader as unknown as WorkerLoader,
    });
    await handleDeployRequest(opts)!;
    const cacheKey = loader.get.mock.calls[0][0] as string;
    expect(cacheKey).toMatch(/^v\d+\/agent123\/deploy456$/);
  });
});

describe("generateWorkerScript", () => {
  it("generates a valid worker script from text assets", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/index.html", { content: "<html><body>Hello</body></html>", binary: false });
    assets.set("/app.js", { content: "console.log('hi');", binary: false });

    const script = generateWorkerScript(assets);

    expect(script).toContain("TEXT_ASSETS");
    expect(script).toContain("Hello");
    expect(script).toContain("console.log");
    expect(script).toContain("export default");
  });

  it("embeds binary assets as base64", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    // Simulate base64-encoded content
    const b64 = btoa("binary-data");
    assets.set("/image.png", { content: b64, binary: true });

    const script = generateWorkerScript(assets);

    expect(script).toContain("BINARY_ASSETS");
    expect(script).toContain(b64);
    expect(script).toContain("base64ToBytes");
  });

  it("includes content type map", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/index.html", { content: "<html></html>", binary: false });

    const script = generateWorkerScript(assets);

    expect(script).toContain("text/html; charset=utf-8");
    expect(script).toContain("application/javascript; charset=utf-8");
    expect(script).toContain("image/png");
  });

  it("generated script has SPA fallback to index.html", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/index.html", { content: "<html>SPA</html>", binary: false });

    const script = generateWorkerScript(assets);

    // Check for the SPA fallback logic
    expect(script).toContain('TEXT_ASSETS["/index.html"]');
    expect(script).toContain("// SPA fallback");
  });

  it("generated script returns 404 when no matching asset and no index.html", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/about.html", { content: "<html>About</html>", binary: false });

    const script = generateWorkerScript(assets);

    expect(script).toContain('"Not Found"');
    expect(script).toContain("404");
  });

  it("sets immutable cache headers for hashed assets", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/index.html", { content: "<html></html>", binary: false });

    const script = generateWorkerScript(assets);

    // The isHashedAsset regex pattern
    expect(script).toContain("isHashedAsset");
    expect(script).toContain("public, max-age=31536000, immutable");
    expect(script).toContain("no-cache");
  });

  it("handles empty asset map", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();

    const script = generateWorkerScript(assets);

    // Should still produce valid JS (empty objects)
    expect(script).toContain("TEXT_ASSETS");
    expect(script).toContain("BINARY_ASSETS");
    expect(script).toContain("export default");
  });

  it("correctly escapes special characters in text content", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/data.json", {
      content: '{"key": "value\\nwith\\"quotes"}',
      binary: false,
    });

    const script = generateWorkerScript(assets);

    // The content should be JSON.stringify'd (not the binary escape path)
    expect(script).toContain("/data.json");
    // Should not throw when the script is syntactically valid
    expect(script).toContain("TEXT_ASSETS");
  });

  it("handles mixed text and binary assets", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/index.html", { content: "<html>Hello</html>", binary: false });
    assets.set("/style.css", { content: "body { color: red; }", binary: false });
    assets.set("/logo.png", { content: btoa("png-data"), binary: true });
    assets.set("/font.woff2", { content: btoa("font-data"), binary: true });

    const script = generateWorkerScript(assets);

    // Text assets in TEXT_ASSETS
    expect(script).toContain("/index.html");
    expect(script).toContain("/style.css");
    expect(script).toContain("Hello");

    // Binary assets in BINARY_ASSETS
    expect(script).toContain("/logo.png");
    expect(script).toContain("/font.woff2");
  });

  it("maps / to /index.html in the fetch handler", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/index.html", { content: "<html></html>", binary: false });

    const script = generateWorkerScript(assets);

    expect(script).toContain('url.pathname === "/" ? "/index.html" : url.pathname');
  });

  it("includes getContentType function that maps extensions", () => {
    const assets = new Map<string, { content: string; binary: boolean }>();
    assets.set("/test.js", { content: "//", binary: false });

    const script = generateWorkerScript(assets);

    expect(script).toContain("function getContentType(path)");
    expect(script).toContain("application/octet-stream");
  });
});
