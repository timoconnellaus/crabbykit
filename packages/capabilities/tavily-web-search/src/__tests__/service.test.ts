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

import { BUNDLE_SUBKEY_LABEL } from "@crabbykit/bundle-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { TavilyServiceEnv } from "../service.js";
import { TavilyService } from "../service.js";

const TAVILY_SECRET = "tvly-secret-xyz-0123456789";
const TEST_AUTH_KEY = "test-auth-key-aaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * Mint a bundle capability token for TavilyService tests.
 * Derives the mint-capable key via HKDF (sign usage), then signs a payload.
 * `scope` defaults to the full set expected by TavilyService (includes
 * "tavily-web-search"). Pass an explicit scope to test denial paths.
 */
async function makeTavilyToken(
  agentId = "test-agent",
  sessionId = "test-session",
  scope = ["spine", "llm", "tavily-web-search"],
): Promise<string> {
  // Derive a sign-capable key directly (mirrors deriveMintSubkey logic)
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_AUTH_KEY),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const mintKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(BUNDLE_SUBKEY_LABEL),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );

  // Build payload matching TokenPayload shape
  const exp = Date.now() + 60_000;
  const nonce = crypto.randomUUID();
  const payload = {
    aid: agentId,
    sid: sessionId,
    exp,
    nonce,
    scope,
  };
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = await crypto.subtle.sign("HMAC", mintKey, new TextEncoder().encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payloadB64}.${sigB64}`;
}

function buildEnv(): TavilyServiceEnv & {
  _emitCostMock: ReturnType<typeof vi.fn>;
} {
  const emitCostMock = vi.fn().mockResolvedValue(undefined);
  return {
    TAVILY_API_KEY: TAVILY_SECRET,
    AGENT_AUTH_KEY: "test-auth-key-aaaaaaaaaaaaaaaaaaaaaaaaa",
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
    const token = await makeTavilyToken();
    const out = await svc.search(token, { query: "rust ownership" });

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
    const token = await makeTavilyToken();
    await svc.search(token, {
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
    const token = await makeTavilyToken();
    await svc.search(token, { query: "q" });

    expect(env._emitCostMock).toHaveBeenCalledOnce();
    const [forwardedToken, event] = env._emitCostMock.mock.calls[0];
    expect(forwardedToken).toBe(token);
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
    const token = await makeTavilyToken();
    const out = await svc.search(token, { query: "q" });
    expect(out.results).toEqual([]);
  });

  it("sanitizes upstream 401 to ERR_UPSTREAM_AUTH without leaking body", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(
      async () => new Response(`{"error":"bad key ${TAVILY_SECRET}"}`, { status: 401 }),
    );
    const token = await makeTavilyToken();
    await expect(svc.search(token, { query: "q" })).rejects.toThrow(/^ERR_UPSTREAM_AUTH$/);
  });

  it("sanitizes 429 to ERR_UPSTREAM_RATE", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => new Response("rate", { status: 429 }));
    const token = await makeTavilyToken();
    await expect(svc.search(token, { query: "q" })).rejects.toThrow("ERR_UPSTREAM_RATE");
  });

  it("sanitizes generic network errors to ERR_UPSTREAM_OTHER with no secret leakage", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => {
      throw new Error(`boom while using ${TAVILY_SECRET}`);
    });
    const token = await makeTavilyToken();
    try {
      await svc.search(token, { query: "q" });
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
    const token = await makeTavilyToken();
    await expect(svc.search(token, { query: "q" }, SCHEMA_CONTENT_HASH)).resolves.toBeDefined();
  });
});

describe("TavilyService.extract", () => {
  it("calls Tavily extract endpoint and returns raw_content", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () =>
      jsonResponse({ results: [{ raw_content: "page body" }] }),
    );
    const token = await makeTavilyToken();
    const out = await svc.extract(token, { url: "https://a" });
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
    const token = await makeTavilyToken();
    await svc.extract(token, { url: "https://a" });
    expect(env._emitCostMock).toHaveBeenCalledOnce();
    const event = env._emitCostMock.mock.calls[0][1];
    expect(event.capabilityId).toBe("tavily");
    expect(event.toolName).toBe("web_fetch");
  });

  it("returns empty content when upstream omits results", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => jsonResponse({ results: [] }));
    const token = await makeTavilyToken();
    const out = await svc.extract(token, { url: "https://a" });
    expect(out.content).toBe("");
  });

  it("sanitizes 401 upstream errors", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () => new Response("nope", { status: 403 }));
    const token = await makeTavilyToken();
    await expect(svc.extract(token, { url: "https://a" })).rejects.toThrow("ERR_UPSTREAM_AUTH");
  });

  it("rejects schema drift", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    await expect(svc.extract("tok", { url: "https://a" }, "bad-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });
});

// Gap 6: TavilyService scope-denial paths
describe("TavilyService scope verification (Gap 6)", () => {
  it("search rejects token that lacks 'tavily-web-search' scope with ERR_SCOPE_DENIED", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    // Token has "spine" and "llm" but NOT "tavily-web-search"
    const noTavilyToken = await makeTavilyToken("test-agent", "test-session", ["spine", "llm"]);
    await expect(svc.search(noTavilyToken, { query: "q" })).rejects.toThrow("ERR_SCOPE_DENIED");
    // No outbound fetch should have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("extract rejects token that lacks 'tavily-web-search' scope with ERR_SCOPE_DENIED", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const noTavilyToken = await makeTavilyToken("test-agent", "test-session", ["spine", "llm"]);
    await expect(svc.extract(noTavilyToken, { url: "https://a" })).rejects.toThrow(
      "ERR_SCOPE_DENIED",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("search rejects empty-scope token with ERR_SCOPE_DENIED", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const emptyToken = await makeTavilyToken("test-agent", "test-session", []);
    await expect(svc.search(emptyToken, { query: "q" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("search accepts token that includes 'tavily-web-search' scope", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () =>
      jsonResponse({ results: [{ title: "t", url: "https://a", content: "c" }] }),
    );
    const validToken = await makeTavilyToken();
    const out = await svc.search(validToken, { query: "q" });
    expect(out.results).toHaveLength(1);
  });
});
