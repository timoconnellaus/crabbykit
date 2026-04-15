/**
 * TavilyService unit tests (task 4.30).
 *
 * TavilyService is a WorkerEntrypoint — test it in the pool-workers runtime
 * directly. We mock global fetch and the SPINE binding to verify:
 *  - request shape to Tavily with credentials from env
 *  - error sanitization (401/429/generic → whitelisted ERR_ codes)
 *  - cost emission through SPINE on success
 *  - cost-emission failure does not block the response
 *  - schema drift rejection
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { TavilyServiceEnv } from "../service.js";
import { TavilyService } from "../service.js";

const TAVILY_SECRET = "tvly-secret-xyz-0123456789";

function buildEnv(): TavilyServiceEnv & {
  _emitCostMock: ReturnType<typeof vi.fn>;
} {
  const emitCostMock = vi.fn().mockResolvedValue(undefined);
  return {
    TAVILY_API_KEY: TAVILY_SECRET,
    TAVILY_SUBKEY: {} as CryptoKey,
    SPINE: {
      emitCost: emitCostMock,
    } as unknown as TavilyServiceEnv["SPINE"],
    _emitCostMock: emitCostMock,
  };
}

function makeService(env: TavilyServiceEnv): TavilyService {
  return new TavilyService({} as never, env);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TavilyService.search", () => {
  it("calls Tavily API with credentials from env and returns results", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        results: [{ title: "t", url: "https://a", content: "c" }],
      }),
    );

    const out = await svc.search("tok", { query: "rust ownership" });

    expect(out.results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.api_key).toBe(TAVILY_SECRET);
    expect(body.query).toBe("rust ownership");
  });

  it("forwards maxResults / searchDepth / domain filters", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [] }));

    await svc.search("tok", {
      query: "q",
      maxResults: 10,
      searchDepth: "advanced",
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.max_results).toBe(10);
    expect(body.search_depth).toBe("advanced");
    expect(body.include_domains).toEqual(["a.com"]);
    expect(body.exclude_domains).toEqual(["b.com"]);
  });

  it("emits cost via SPINE after a successful search", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [] }));

    await svc.search("tok-123", { query: "q" });

    expect(env._emitCostMock).toHaveBeenCalledOnce();
    const [forwardedToken, event] = env._emitCostMock.mock.calls[0];
    expect(forwardedToken).toBe("tok-123");
    expect(event.capabilityId).toBe("tavily");
    expect(event.toolName).toBe("web_search");
    expect(event.currency).toBe("USD");
    expect(event.amount).toBeGreaterThan(0);
  });

  it("does not block the response when cost emission fails", async () => {
    const env = buildEnv();
    env._emitCostMock.mockRejectedValue(new Error("spine down"));
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [] }));

    const out = await svc.search("tok", { query: "q" });
    expect(out.results).toEqual([]);
  });

  it("sanitizes upstream 401 to ERR_UPSTREAM_AUTH without leaking body", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(
      async () => new Response(`{"error":"bad key ${TAVILY_SECRET}"}`, { status: 401 }),
    );

    await expect(svc.search("tok", { query: "q" })).rejects.toThrow(/^ERR_UPSTREAM_AUTH$/);
  });

  it("sanitizes 429 to ERR_UPSTREAM_RATE", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => new Response("rate", { status: 429 }));

    await expect(svc.search("tok", { query: "q" })).rejects.toThrow("ERR_UPSTREAM_RATE");
  });

  it("sanitizes generic network errors to ERR_UPSTREAM_OTHER with no secret leakage", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => {
      throw new Error(`boom while using ${TAVILY_SECRET}`);
    });

    try {
      await svc.search("tok", { query: "q" });
      throw new Error("unreachable");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe("ERR_UPSTREAM_OTHER");
      expect(msg).not.toContain(TAVILY_SECRET);
    }
  });

  it("rejects calls whose schemaHash does not match the service's own hash", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    await expect(svc.search("tok", { query: "q" }, "mismatched-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepts calls whose schemaHash matches", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [] }));
    await expect(svc.search("tok", { query: "q" }, SCHEMA_CONTENT_HASH)).resolves.toBeDefined();
  });
});

describe("TavilyService.extract", () => {
  it("calls Tavily extract endpoint and returns raw_content", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () =>
      jsonResponse({ results: [{ raw_content: "page body" }] }),
    );

    const out = await svc.extract("tok", { url: "https://a" });
    expect(out.content).toBe("page body");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/extract");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.api_key).toBe(TAVILY_SECRET);
    expect(body.urls).toEqual(["https://a"]);
  });

  it("emits a cost event on success", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [{ raw_content: "x" }] }));

    await svc.extract("tok", { url: "https://a" });
    expect(env._emitCostMock).toHaveBeenCalledOnce();
    const event = env._emitCostMock.mock.calls[0][1];
    expect(event.capabilityId).toBe("tavily");
    expect(event.toolName).toBe("web_fetch");
  });

  it("returns empty content when upstream omits results", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [] }));

    const out = await svc.extract("tok", { url: "https://a" });
    expect(out.content).toBe("");
  });

  it("sanitizes 401 upstream errors", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => new Response("nope", { status: 403 }));
    await expect(svc.extract("tok", { url: "https://a" })).rejects.toThrow("ERR_UPSTREAM_AUTH");
  });

  it("rejects schema drift", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    await expect(svc.extract("tok", { url: "https://a" }, "bad-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });
});
