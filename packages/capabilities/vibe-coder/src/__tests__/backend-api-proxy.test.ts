import type { CapabilityStorage } from "@crabbykit/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { handleBackendApi, handlePreviewBackendProxy } from "../backend-api-proxy.js";

function createMockStorage(data: Record<string, unknown> = {}): CapabilityStorage {
  const store = new Map(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    list: vi.fn(async () => new Map()),
  } as CapabilityStorage;
}

function createMockLoader() {
  const mockEntrypoint = {
    fetch: vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })),
  };
  const mockWorker = {
    getEntrypoint: vi.fn().mockReturnValue(mockEntrypoint),
  };
  return {
    get: vi.fn().mockReturnValue(mockWorker),
    mockWorker,
    mockEntrypoint,
  };
}

function createMockDbService() {
  return { exec: vi.fn(), batch: vi.fn() };
}

describe("handleBackendApi", () => {
  it("returns null when no backend loaderKey in storage", async () => {
    const storage = createMockStorage({});
    const result = await handleBackendApi(new Request("http://agent/backend-api/api/items"), {
      storage,
      loader: createMockLoader() as any,
      dbService: createMockDbService() as any,
    });
    expect(result).toBeNull();
  });

  it("returns null when loaderKey exists but no bundle", async () => {
    const storage = createMockStorage({ "backend:loaderKey": "key-1" });
    const result = await handleBackendApi(new Request("http://agent/backend-api/api/items"), {
      storage,
      loader: createMockLoader() as any,
      dbService: createMockDbService() as any,
    });
    expect(result).toBeNull();
  });

  it("loads the backend worker and forwards the request with /api/* path", async () => {
    const storage = createMockStorage({
      "backend:loaderKey": "backend/test-agent/v1",
      "backend:bundle": {
        mainModule: "index.js",
        modules: { "index.js": "export default { fetch() { return new Response('ok') } }" },
      },
    });
    const loader = createMockLoader();
    const dbService = createMockDbService();

    const request = new Request("http://agent/backend-api/api/items?page=1");
    const result = await handleBackendApi(request, {
      storage,
      loader: loader as any,
      dbService: dbService as any,
    });

    // Loader was called with the stored key
    expect(loader.get).toHaveBeenCalledWith("backend/test-agent/v1", expect.any(Function));

    // Entrypoint.fetch was called with the stripped path
    expect(loader.mockEntrypoint.fetch).toHaveBeenCalled();
    const forwardedRequest = loader.mockEntrypoint.fetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.pathname).toBe("/api/items");
    expect(forwardedUrl.search).toBe("?page=1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
  });

  it("strips /backend-api prefix from the path", async () => {
    const storage = createMockStorage({
      "backend:loaderKey": "k",
      "backend:bundle": { mainModule: "m.js", modules: { "m.js": "" } },
    });
    const loader = createMockLoader();

    await handleBackendApi(new Request("http://agent/backend-api/api/users/42"), {
      storage,
      loader: loader as any,
      dbService: createMockDbService() as any,
    });

    const forwardedUrl = new URL((loader.mockEntrypoint.fetch.mock.calls[0][0] as Request).url);
    expect(forwardedUrl.pathname).toBe("/api/users/42");
  });

  it("provides dbService as env.DB in the loader factory", async () => {
    const storage = createMockStorage({
      "backend:loaderKey": "k",
      "backend:bundle": { mainModule: "m.js", modules: { "m.js": "code" } },
    });
    const loader = createMockLoader();
    const dbService = createMockDbService();

    await handleBackendApi(new Request("http://agent/backend-api/api/test"), {
      storage,
      loader: loader as any,
      dbService: dbService as any,
    });

    // The factory passed to loader.get should produce env with __DB_SERVICE
    const factory = loader.get.mock.calls[0][1] as () => Promise<unknown>;
    const workerDef = (await factory()) as any;
    expect(workerDef.env.__DB_SERVICE).toBe(dbService);
  });
});

describe("handlePreviewBackendProxy", () => {
  function createMockAgentNamespace() {
    const stub = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    return {
      idFromName: vi.fn().mockReturnValue("hex-id"),
      idFromString: vi.fn().mockReturnValue("hex-id"),
      get: vi.fn().mockReturnValue(stub),
      stub,
    };
  }

  it("returns null for non-matching paths", () => {
    const ns = createMockAgentNamespace();
    const result = handlePreviewBackendProxy({
      request: new Request("http://host/preview/agent1/index.html"),
      agentNamespace: ns as any,
    });
    expect(result).toBeNull();
  });

  it("returns null for /preview/:id without /api", () => {
    const ns = createMockAgentNamespace();
    const result = handlePreviewBackendProxy({
      request: new Request("http://host/preview/agent1/some/path"),
      agentNamespace: ns as any,
    });
    expect(result).toBeNull();
  });

  it("matches /preview/:id/api and forwards to agent DO at /backend-api/api/", async () => {
    const ns = createMockAgentNamespace();
    const result = handlePreviewBackendProxy({
      request: new Request("http://host/preview/agent1/api/items"),
      agentNamespace: ns as any,
    });

    expect(result).not.toBeNull();
    await result;

    expect(ns.stub.fetch).toHaveBeenCalled();
    const forwardedReq = ns.stub.fetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedReq.url);
    expect(forwardedUrl.pathname).toBe("/backend-api/api/items");
  });

  it("handles /preview/:id/api with no trailing path", async () => {
    const ns = createMockAgentNamespace();
    const result = handlePreviewBackendProxy({
      request: new Request("http://host/preview/agent1/api"),
      agentNamespace: ns as any,
    });

    expect(result).not.toBeNull();
    await result;

    const forwardedUrl = new URL((ns.stub.fetch.mock.calls[0][0] as Request).url);
    expect(forwardedUrl.pathname).toBe("/backend-api/api/");
  });

  it("resolves UUID agent IDs via idFromName", async () => {
    const ns = createMockAgentNamespace();
    handlePreviewBackendProxy({
      request: new Request("http://host/preview/550e8400-e29b-41d4-a716-446655440000/api/test"),
      agentNamespace: ns as any,
    });

    expect(ns.idFromName).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000");
  });

  it("resolves hex agent IDs via idFromString", async () => {
    const ns = createMockAgentNamespace();
    handlePreviewBackendProxy({
      request: new Request(
        "http://host/preview/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890/api/test",
      ),
      agentNamespace: ns as any,
    });

    expect(ns.idFromString).toHaveBeenCalled();
  });
});
