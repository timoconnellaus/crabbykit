/**
 * VectorMemoryService unit tests (task 3.10).
 *
 * VectorMemoryService is a WorkerEntrypoint — test it in the pool-workers
 * runtime directly. We mock Vectorize, Workers AI (`Ai`), and R2Bucket and
 * verify:
 *  - lazy subkey derivation is cached
 *  - token without "vector-memory" scope throws ERR_SCOPE_DENIED
 *  - missing AGENT_AUTH_KEY throws misconfiguration
 *  - schema-hash mismatch throws ERR_SCHEMA_VERSION
 *  - `search` embeds via the Workers AI binding
 *  - `search` defaults maxResults to 5
 *  - `search` returns empty results when Vectorize returns no matches
 *  - `get` reads at the namespace-prefixed R2 key
 *  - `get` returns `{ content: "" }` when R2 returns null (no throw)
 *  - `get` truncates when content exceeds MAX_CONTENT_BYTES
 */

import { BUNDLE_SUBKEY_LABEL } from "@crabbykit/bundle-token";
import { describe, expect, it, vi } from "vitest";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { VectorMemoryServiceEnv } from "../service.js";
import { VectorMemoryService } from "../service.js";

const TEST_AUTH_KEY = "test-auth-key-aaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_SCOPE = ["spine", "llm", "vector-memory"];
const MAX_CONTENT_BYTES = 512 * 1024;

/**
 * Mint a bundle capability token for VectorMemoryService tests. Derives the
 * mint-capable key via HKDF (sign usage) using the same label as the
 * service, then signs a standard payload.
 */
async function makeToken(
  scope: string[] = DEFAULT_SCOPE,
  agentId = "test-agent",
  sessionId = "test-session",
): Promise<string> {
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

  const payload = {
    aid: agentId,
    sid: sessionId,
    exp: Date.now() + 60_000,
    nonce: crypto.randomUUID(),
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

// --- Test doubles ---

interface MockAi {
  run: ReturnType<typeof vi.fn>;
}

function makeAi(vectors: number[][] = [[0.1, 0.2, 0.3]]): MockAi {
  return {
    run: vi.fn(async () => ({ data: vectors })),
  };
}

interface VectorizeMatchInput {
  id: string;
  score: number;
  metadata?: { path: string; startLine: number; endLine: number };
}

interface MockVectorize {
  query: ReturnType<typeof vi.fn>;
}

function makeVectorize(matches: VectorizeMatchInput[] = []): MockVectorize {
  return {
    query: vi.fn(async () => ({
      matches: matches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata ?? null,
        values: undefined,
      })),
      count: matches.length,
    })),
  };
}

function makeR2(store: Map<string, string>): R2Bucket {
  return {
    get: async (key: string) => {
      const val = store.get(key);
      if (val === undefined) return null;
      return { text: async () => val } as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

function buildEnv(
  overrides: Partial<VectorMemoryServiceEnv> = {},
  ai: MockAi = makeAi(),
  vectorize: MockVectorize = makeVectorize(),
  r2Store: Map<string, string> = new Map(),
): VectorMemoryServiceEnv {
  return {
    AGENT_AUTH_KEY: TEST_AUTH_KEY,
    STORAGE_BUCKET: makeR2(r2Store),
    STORAGE_NAMESPACE: "agent-1",
    MEMORY_INDEX: vectorize as unknown as VectorizeIndex,
    AI: ai as unknown as Ai,
    ...overrides,
  };
}

function makeService(env: VectorMemoryServiceEnv): VectorMemoryService {
  return new VectorMemoryService({} as never, env);
}

// --- Subkey + misconfig ---

describe("VectorMemoryService subkey derivation", () => {
  it("is lazy and cached across calls", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    await svc.search(token, { query: "hello" }, SCHEMA_CONTENT_HASH);
    await svc.search(token, { query: "hello" }, SCHEMA_CONTENT_HASH);
    expect((svc as unknown as { subkeyPromise: unknown }).subkeyPromise).not.toBeNull();
  });

  it("throws a misconfiguration error when AGENT_AUTH_KEY is missing", async () => {
    const env = buildEnv({ AGENT_AUTH_KEY: "" as unknown as string });
    const svc = makeService(env);
    await expect(svc.search("tok", { query: "x" })).rejects.toThrow(/misconfigured/);
    await expect(svc.get("tok", { path: "MEMORY.md" })).rejects.toThrow(/misconfigured/);
  });
});

// --- Scope verification ---

describe("VectorMemoryService scope verification", () => {
  it("rejects token lacking 'vector-memory' scope with ERR_SCOPE_DENIED (search)", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.search(noScopeToken, { query: "x" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects token lacking 'vector-memory' scope with ERR_SCOPE_DENIED (get)", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.get(noScopeToken, { path: "MEMORY.md" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("does not embed or query when scope is denied", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize();
    const env = buildEnv({}, ai, vectorize);
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.search(noScopeToken, { query: "x" })).rejects.toThrow("ERR_SCOPE_DENIED");
    expect(ai.run).not.toHaveBeenCalled();
    expect(vectorize.query).not.toHaveBeenCalled();
  });
});

// --- Schema drift ---

describe("VectorMemoryService schema drift detection", () => {
  it("rejects schemaHash mismatch with ERR_SCHEMA_VERSION on search", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    await expect(svc.search("tok", { query: "x" }, "mismatched-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects schemaHash mismatch with ERR_SCHEMA_VERSION on get", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    await expect(svc.get("tok", { path: "MEMORY.md" }, "mismatched-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("accepts calls whose schemaHash matches", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    await expect(svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH)).resolves.toBeDefined();
  });

  it("accepts calls with no schemaHash (backwards compat)", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    await expect(svc.search(token, { query: "x" })).resolves.toBeDefined();
  });
});

// --- search ---

describe("VectorMemoryService.search", () => {
  it("embeds the query via the Workers AI binding with the BGE model", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize();
    const env = buildEnv({}, ai, vectorize);
    const svc = makeService(env);
    const token = await makeToken();

    await svc.search(token, { query: "my query text" }, SCHEMA_CONTENT_HASH);

    expect(ai.run).toHaveBeenCalledOnce();
    const [model, payload] = ai.run.mock.calls[0];
    expect(model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(payload).toEqual({ text: ["my query text"] });
  });

  it("defaults maxResults to 5 when omitted", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize();
    const env = buildEnv({}, ai, vectorize);
    const svc = makeService(env);
    const token = await makeToken();

    await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);

    expect(vectorize.query).toHaveBeenCalledOnce();
    const [, options] = vectorize.query.mock.calls[0];
    expect(options.topK).toBe(5);
    expect(options.namespace).toBe("agent-1");
  });

  it("respects an explicit maxResults", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize();
    const env = buildEnv({}, ai, vectorize);
    const svc = makeService(env);
    const token = await makeToken();

    await svc.search(token, { query: "x", maxResults: 3 }, SCHEMA_CONTENT_HASH);

    const [, options] = vectorize.query.mock.calls[0];
    expect(options.topK).toBe(3);
  });

  it("returns an empty results array when Vectorize returns no matches", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);
    expect(result.results).toEqual([]);
  });

  it("returns empty results when the embedder produces no vectors", async () => {
    const ai = makeAi([]);
    const env = buildEnv({}, ai);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);
    expect(result.results).toEqual([]);
  });

  it("returns matched chunks with snippets from R2 at the namespaced key", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize([
      {
        id: "MEMORY.md:1",
        score: 0.92,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 2 },
      },
    ]);
    const r2 = new Map([["agent-1/MEMORY.md", "first line\nsecond line\nthird line"]]);
    const env = buildEnv({}, ai, vectorize, r2);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe("MEMORY.md");
    expect(result.results[0].score).toBeCloseTo(0.92);
    expect(result.results[0].snippet).toBe("first line\nsecond line");
  });

  it("deduplicates matches by path (keeps highest-score match per path)", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize([
      {
        id: "MEMORY.md:5",
        score: 0.5,
        metadata: { path: "MEMORY.md", startLine: 5, endLine: 6 },
      },
      {
        id: "MEMORY.md:1",
        score: 0.9,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 2 },
      },
    ]);
    const r2 = new Map([["agent-1/MEMORY.md", "line1\nline2\nline3\nline4\nline5\nline6"]]);
    const env = buildEnv({}, ai, vectorize, r2);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBeCloseTo(0.9);
    expect(result.results[0].snippet).toBe("line1\nline2");
  });

  it("skips matches with no chunk metadata", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize([{ id: "orphan", score: 0.8, metadata: undefined }]);
    const env = buildEnv({}, ai, vectorize);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);
    expect(result.results).toEqual([]);
  });

  it("returns a match with empty snippet when R2 has no object for the path", async () => {
    const ai = makeAi();
    const vectorize = makeVectorize([
      {
        id: "MEMORY.md:1",
        score: 0.7,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 2 },
      },
    ]);
    const env = buildEnv({}, ai, vectorize);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.search(token, { query: "x" }, SCHEMA_CONTENT_HASH);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].snippet).toBe("");
  });
});

// --- get ---

describe("VectorMemoryService.get", () => {
  it("reads R2 at the namespace-prefixed key", async () => {
    const r2 = new Map([["agent-1/MEMORY.md", "hello world"]]);
    const env = buildEnv({}, makeAi(), makeVectorize(), r2);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.get(token, { path: "MEMORY.md" }, SCHEMA_CONTENT_HASH);
    expect(result.content).toBe("hello world");
  });

  it("supports nested memory paths", async () => {
    const r2 = new Map([["agent-1/memory/notes.md", "nested content"]]);
    const env = buildEnv({}, makeAi(), makeVectorize(), r2);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.get(token, { path: "memory/notes.md" }, SCHEMA_CONTENT_HASH);
    expect(result.content).toBe("nested content");
  });

  it("returns { content: '' } when R2 returns null — no throw", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.get(token, { path: "missing.md" }, SCHEMA_CONTENT_HASH);
    expect(result.content).toBe("");
  });

  it("truncates content that exceeds MAX_CONTENT_BYTES", async () => {
    // Build a string whose UTF-8 byte length exceeds the cap. ASCII so
    // byteLength === length. Lines delimited by "\n" so the truncator has
    // a boundary to trim at.
    const line = `${"a".repeat(1023)}\n`; // 1024 bytes per line
    const lines = MAX_CONTENT_BYTES / 1024 + 2; // a few lines past the cap
    const content = line.repeat(lines);

    const r2 = new Map([["agent-1/big.md", content]]);
    const env = buildEnv({}, makeAi(), makeVectorize(), r2);
    const svc = makeService(env);
    const token = await makeToken();

    const result = await svc.get(token, { path: "big.md" }, SCHEMA_CONTENT_HASH);
    const encoded = new TextEncoder().encode(result.content);
    // The truncated body (up to the last newline) is at most MAX_CONTENT_BYTES
    // bytes, plus the trailing marker suffix the service appends.
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_CONTENT_BYTES + 128);
    expect(result.content).toContain("[Truncated");
  });
});
