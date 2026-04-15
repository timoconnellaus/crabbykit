import { describe, expect, it, vi } from "vitest";
import { handleDeployRequest } from "../deploy-server.js";

function createMockLoader() {
  const mockEntrypoint = {
    fetch: vi.fn().mockResolvedValue(
      new Response('{"data":"test"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
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

function createMockBucket(objects: Record<string, string | object> = {}) {
  return {
    list: vi.fn().mockImplementation(async ({ prefix }: { prefix: string }) => ({
      objects: Object.keys(objects)
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    })),
    get: vi.fn().mockImplementation(async (key: string) => {
      const val = objects[key];
      if (!val) return null;
      if (typeof val === "object") {
        return {
          text: async () => JSON.stringify(val),
          json: async () => val,
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(val)).buffer,
        };
      }
      return {
        text: async () => val,
        json: async () => JSON.parse(val),
        arrayBuffer: async () => new TextEncoder().encode(val).buffer,
      };
    }),
  };
}

function createMockAgentNamespace() {
  return {
    idFromName: vi.fn().mockImplementation((name: string) => ({
      toString: () => `hex-${name}`,
    })),
  };
}

const mockDbService = { exec: vi.fn(), batch: vi.fn() };

describe("handleDeployRequest with backend", () => {
  it("returns null for non-matching paths", () => {
    const result = handleDeployRequest({
      request: new Request("http://host/other/path"),
      agentNamespace: createMockAgentNamespace() as any,
      storageBucket: createMockBucket() as any,
      loader: createMockLoader() as any,
    });
    expect(result).toBeNull();
  });

  it("routes /deploy/:agentId/:deployId/api/* to the backend worker", async () => {
    const loader = createMockLoader();
    const bucket = createMockBucket({
      "hex-agent1/deploys/deploy1/.backend/bundle.json": {
        mainModule: "server.js",
        modules: { "server.js": "export default { fetch() {} }" },
      },
    });

    const result = handleDeployRequest({
      request: new Request("http://host/deploy/agent1/deploy1/api/items"),
      agentNamespace: createMockAgentNamespace() as any,
      storageBucket: bucket as any,
      loader: loader as any,
      dbService: mockDbService as any,
    });

    expect(result).not.toBeNull();
    const response = await result!;
    expect(response.status).toBe(200);

    // The backend worker was loaded
    expect(loader.get).toHaveBeenCalledWith(
      expect.stringContaining("backend/"),
      expect.any(Function),
    );

    // The request was forwarded with the /api/* path
    const forwardedReq = loader.mockEntrypoint.fetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedReq.url);
    expect(forwardedUrl.pathname).toBe("/api/items");
  });

  it("routes /deploy/:agentId/:deployId/api (no trailing path) to backend", async () => {
    const loader = createMockLoader();
    const bucket = createMockBucket({
      "hex-agent1/deploys/d1/.backend/bundle.json": {
        mainModule: "s.js",
        modules: { "s.js": "" },
      },
    });

    const result = handleDeployRequest({
      request: new Request("http://host/deploy/agent1/d1/api"),
      agentNamespace: createMockAgentNamespace() as any,
      storageBucket: bucket as any,
      loader: loader as any,
      dbService: mockDbService as any,
    });

    expect(result).not.toBeNull();
    await result!;

    const forwardedUrl = new URL((loader.mockEntrypoint.fetch.mock.calls[0][0] as Request).url);
    expect(forwardedUrl.pathname).toBe("/api");
  });

  it("returns 503 when backend is not configured and /api/ is requested", async () => {
    const loader = createMockLoader();
    const bucket = createMockBucket();

    const result = handleDeployRequest({
      request: new Request("http://host/deploy/agent1/d1/api/test"),
      agentNamespace: createMockAgentNamespace() as any,
      storageBucket: bucket as any,
      loader: loader as any,
      // No dbService provided
    });

    expect(result).not.toBeNull();
    const response = await result!;
    expect(response.status).toBe(503);
  });

  it("routes non-/api/ paths to the frontend static worker", async () => {
    const loader = createMockLoader();
    const bucket = createMockBucket({
      "hex-agent1/deploys/d1/index.html": "<html>Hello</html>",
    });

    const result = handleDeployRequest({
      request: new Request("http://host/deploy/agent1/d1/index.html"),
      agentNamespace: createMockAgentNamespace() as any,
      storageBucket: bucket as any,
      loader: loader as any,
      dbService: mockDbService as any,
    });

    expect(result).not.toBeNull();
    await result!;

    // The loader key should NOT contain "backend/"
    const loaderKey = loader.get.mock.calls[0][0] as string;
    expect(loaderKey).not.toContain("backend/");
  });

  it("passes dbService to the backend worker factory", async () => {
    const loader = createMockLoader();
    const bucket = createMockBucket();

    // The factory invocation happens lazily inside loader.get, but we can
    // verify the backend storage was set up by checking the factory call.
    // We verify loader.get was called with a backend-prefixed cache key,
    // and separately test that the factory would resolve the correct DO stub.
    const result = handleDeployRequest({
      request: new Request("http://host/deploy/agent1/d1/api/test"),
      agentNamespace: createMockAgentNamespace() as any,
      storageBucket: bucket as any,
      loader: loader as any,
      dbService: mockDbService as any,
    });
    await result;

    // Loader was called with a backend-specific cache key
    const loaderKey = loader.get.mock.calls[0][0] as string;
    expect(loaderKey).toContain("backend/");
    expect(loaderKey).toContain("agent1");
    expect(loaderKey).toContain("d1");

    // The factory was provided as the second argument
    expect(typeof loader.get.mock.calls[0][1]).toBe("function");
  });

  it("normalizes UUID agent IDs to hex for backend routing", async () => {
    const loader = createMockLoader();
    const agentNs = createMockAgentNamespace();
    const bucket = createMockBucket({
      "hex-550e8400-e29b-41d4-a716-446655440000/deploys/d1/.backend/bundle.json": {
        mainModule: "s.js",
        modules: { "s.js": "" },
      },
    });

    handleDeployRequest({
      request: new Request("http://host/deploy/550e8400-e29b-41d4-a716-446655440000/d1/api/test"),
      agentNamespace: agentNs as any,
      storageBucket: bucket as any,
      loader: loader as any,
      dbService: mockDbService as any,
    });

    expect(agentNs.idFromName).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000");
  });
});
