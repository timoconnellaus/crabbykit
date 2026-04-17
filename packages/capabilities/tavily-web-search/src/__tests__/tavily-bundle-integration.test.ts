/**
 * Tavily bundle integration test (task 4.32).
 *
 * Exercises the full capability-service pattern for a bundle-enabled agent:
 *   1. Host side runs TavilyService with credentials + a mock SPINE.
 *   2. Bundle side runs tavilyClient reading the capability token from
 *      its env.
 *   3. A synthetic capability hook context routes the tool's execute()
 *      call through the client's RPC boundary to the service.
 *   4. The service emits a cost event via the mocked SPINE keyed to the
 *      sessionId derived from the token.
 *   5. A filesystem grep asserts the tavily client module source never
 *      contains the TAVILY_API_KEY string.
 */

import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { BUNDLE_SUBKEY_LABEL } from "@claw-for-cloudflare/bundle-token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tavilyClient } from "../client.js";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { TavilyServiceEnv } from "../service.js";
import { TavilyService } from "../service.js";

const TAVILY_SECRET = "tvly-secret-xyz-4321";
const TEST_AUTH_KEY = "test-auth-key-aaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_SESSION = "session-42";

/**
 * Mint a real bundle capability token for integration tests.
 * Mirrors the dispatcher's mintToken logic — same HKDF label, same scope convention.
 */
async function mintTestToken(agentId = "agent-int", sessionId = TEST_SESSION): Promise<string> {
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
  const exp = Date.now() + 60_000;
  const nonce = crypto.randomUUID();
  const payload = { aid: agentId, sid: sessionId, exp, nonce, scope: ["spine", "llm", "tavily-web-search"] };
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = await crypto.subtle.sign("HMAC", mintKey, new TextEncoder().encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${payloadB64}.${sigB64}`;
}

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTestContext(token: string) {
  return {
    agentId: "agent-int",
    sessionId: TEST_SESSION,
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    storage: createNoopStorage(),
    schedules: {} as never,
    rateLimit: { consume: async () => ({ allowed: true }) },
    notifyBundlePointerChanged: async () => {},
    env: { __BUNDLE_TOKEN: token },
  };
}

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("Tavily bundle integration — client → service → cost emission", () => {
  it("routes a web_search call through the service, forwards the token, emits a cost", async () => {
    const testToken = await mintTestToken();
    // Host side: service with credentials + SPINE mock
    const emitCost = vi.fn().mockResolvedValue(undefined);
    const serviceEnv: TavilyServiceEnv = {
      TAVILY_API_KEY: TAVILY_SECRET,
      AGENT_AUTH_KEY: TEST_AUTH_KEY,
      SPINE: {
        emitCost,
      } as unknown as TavilyServiceEnv["SPINE"],
    };
    const service = new TavilyService({} as never, serviceEnv);

    // Mock Tavily API response
    mockFetch.mockImplementation(async () =>
      mockFetchResponse({
        results: [
          {
            title: "Ownership in Rust",
            url: "https://doc.rust-lang.org/book/ownership",
            content: "Each value has a single owner...",
          },
        ],
      }),
    );

    // Bundle side: capability factory wired to the service as an RPC stub
    const capability = tavilyClient({
      service: service as unknown as Service<TavilyService>,
    });

    const ctx = makeTestContext(testToken);
    const tools = capability.tools!(ctx) as unknown as AgentTool<any>[];
    const search = tools.find((t) => t.name === "web_search");
    expect(search).toBeDefined();

    const result = await search!.execute!({ query: "rust ownership" }, ctx as never);

    // 1. Bundle received the service response
    expect(textOf(result)).toContain("Ownership in Rust");

    // 2. Service hit Tavily with the host-held secret (and ONLY the host)
    expect(mockFetch).toHaveBeenCalledOnce();
    const tavilyBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(tavilyBody.api_key).toBe(TAVILY_SECRET);

    // 3. Service emitted a cost event via SPINE with the bundle's token
    expect(emitCost).toHaveBeenCalledOnce();
    const [forwardedToken, costEvent] = emitCost.mock.calls[0];
    expect(forwardedToken).toBe(testToken);
    expect(costEvent.capabilityId).toBe("tavily");
    expect(costEvent.toolName).toBe("web_search");
    expect(costEvent.amount).toBeGreaterThan(0);
    expect(costEvent.currency).toBe("USD");
  });

  it("passes the schema content hash for drift detection", async () => {
    const testToken = await mintTestToken();
    const service = new TavilyService({} as never, {
      TAVILY_API_KEY: TAVILY_SECRET,
      AGENT_AUTH_KEY: TEST_AUTH_KEY,
      SPINE: {
        emitCost: vi.fn().mockResolvedValue(undefined),
      } as unknown as TavilyServiceEnv["SPINE"],
    });
    const spy = vi.spyOn(service, "search");
    mockFetch.mockImplementation(async () => mockFetchResponse({ results: [] }));

    const cap = tavilyClient({
      service: service as unknown as Service<TavilyService>,
    });
    const ctx = makeTestContext(testToken);
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = tools.find((t) => t.name === "web_search")!;

    await search.execute!({ query: "anything" }, ctx as never);

    expect(spy).toHaveBeenCalledOnce();
    const [, , hash] = spy.mock.calls[0];
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("routes web_fetch through service and emits its own cost event", async () => {
    const testToken = await mintTestToken();
    const emitCost = vi.fn().mockResolvedValue(undefined);
    const service = new TavilyService({} as never, {
      TAVILY_API_KEY: TAVILY_SECRET,
      AGENT_AUTH_KEY: TEST_AUTH_KEY,
      SPINE: { emitCost } as unknown as TavilyServiceEnv["SPINE"],
    });

    mockFetch.mockImplementation(async () =>
      mockFetchResponse({ results: [{ raw_content: "page content" }] }),
    );

    const cap = tavilyClient({
      service: service as unknown as Service<TavilyService>,
    });
    const ctx = makeTestContext(testToken);
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const fetchTool = tools.find((t) => t.name === "web_fetch")!;

    const result = await fetchTool.execute!({ url: "https://example.com/post" }, ctx as never);
    expect(textOf(result)).toBe("page content");

    expect(emitCost).toHaveBeenCalledOnce();
    const event = emitCost.mock.calls[0][1];
    expect(event.toolName).toBe("web_fetch");
  });
});

// NOTE: credential-isolation source-grep assertions live in the bundle
// credential-isolation test file (under packages/agent-bundle), which runs
// under plain vitest with node fs access. Pool-workers doesn't expose fs.
