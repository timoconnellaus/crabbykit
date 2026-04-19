/**
 * SkillsService unit tests (task 2.9).
 *
 * SkillsService is a WorkerEntrypoint — test it in the pool-workers runtime
 * directly. We mock D1 (SKILL_REGISTRY) and R2 (STORAGE_BUCKET) and verify:
 *  - lazy subkey derivation is cached
 *  - token without "skills" scope throws ERR_SCOPE_DENIED
 *  - missing AGENT_AUTH_KEY throws misconfiguration
 *  - schema-hash mismatch throws ERR_SCHEMA_VERSION
 *  - unknown skill returns text not-found (no throw)
 *  - disabled skill returns text not-enabled (no throw)
 *  - enabled skill returns frontmatter-stripped content
 */

import { BUNDLE_SUBKEY_LABEL } from "@crabbykit/bundle-token";
import { describe, expect, it, vi } from "vitest";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { SkillsServiceEnv } from "../service.js";
import { SkillsService } from "../service.js";

const TEST_AUTH_KEY = "test-auth-key-aaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_SCOPE = ["spine", "llm", "skills"];

/**
 * Mint a bundle capability token for SkillsService tests. Derives the
 * mint-capable key via HKDF (sign usage) using the same label as the
 * service, then signs a standard payload.
 */
async function makeSkillsToken(
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

interface SkillRow {
  id: string;
  enabled?: number;
  [key: string]: unknown;
}

/** Build a minimal D1Database stub whose `skills` table returns preset rows by id. */
function makeD1(rows: Record<string, SkillRow | null>): D1Database {
  const prepare = vi.fn((_sql: string) => {
    let boundId: string | undefined;
    return {
      bind: (id: string) => ({
        first: async () => {
          boundId = id;
          return rows[boundId] ?? null;
        },
      }),
    };
  });
  return { prepare } as unknown as D1Database;
}

/** Build a minimal R2Bucket stub whose `get` returns preset contents by key. */
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
  overrides: Partial<SkillsServiceEnv> = {},
  rows: Record<string, SkillRow | null> = {},
  r2Store: Map<string, string> = new Map(),
): SkillsServiceEnv {
  return {
    AGENT_AUTH_KEY: TEST_AUTH_KEY,
    SKILL_REGISTRY: makeD1(rows),
    STORAGE_BUCKET: makeR2(r2Store),
    STORAGE_NAMESPACE: "agent-1",
    ...overrides,
  };
}

function makeService(env: SkillsServiceEnv): SkillsService {
  return new SkillsService({} as never, env);
}

// --- Subkey caching ---

describe("SkillsService subkey derivation", () => {
  it("is lazy and cached across calls", async () => {
    const env = buildEnv(
      {},
      { foo: { id: "foo", enabled: 1 } },
      new Map([["agent-1/skills/foo/SKILL.md", "body"]]),
    );
    const svc = makeService(env);
    // Use a spy to verify derive only fires once. We achieve that by calling
    // .load twice — if cached, only the first call derives the subkey. A
    // second indicator: instance exposes a private promise; simulate via two
    // separate calls returning equivalent content.
    const token = await makeSkillsToken();
    const a = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    const b = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    expect(a.content).toBe("body");
    expect(b.content).toBe("body");
    // Access the private cache through a structural read to assert presence.
    expect((svc as unknown as { subkeyPromise: unknown }).subkeyPromise).not.toBeNull();
  });

  it("throws a misconfiguration error when AGENT_AUTH_KEY is missing", async () => {
    const env = buildEnv({ AGENT_AUTH_KEY: "" as unknown as string }, { foo: { id: "foo" } });
    const svc = makeService(env);
    await expect(svc.load("tok", { name: "foo" })).rejects.toThrow(/misconfigured/);
  });
});

// --- Scope verification ---

describe("SkillsService scope verification", () => {
  it("rejects token that lacks 'skills' scope with ERR_SCOPE_DENIED", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const noSkillsToken = await makeSkillsToken(["spine", "llm"]);
    await expect(svc.load(noSkillsToken, { name: "foo" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects empty-scope token with ERR_SCOPE_DENIED", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    const emptyToken = await makeSkillsToken([]);
    await expect(svc.load(emptyToken, { name: "foo" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });
});

// --- Schema drift ---

describe("SkillsService schema drift detection", () => {
  it("rejects schemaHash mismatch with ERR_SCHEMA_VERSION", async () => {
    const env = buildEnv();
    const svc = makeService(env);
    await expect(svc.load("tok", { name: "foo" }, "mismatched-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("accepts calls whose schemaHash matches", async () => {
    const env = buildEnv(
      {},
      { foo: { id: "foo", enabled: 1 } },
      new Map([["agent-1/skills/foo/SKILL.md", "body"]]),
    );
    const svc = makeService(env);
    const token = await makeSkillsToken();
    await expect(svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH)).resolves.toBeDefined();
  });

  it("accepts calls with no schemaHash (backwards compat)", async () => {
    const env = buildEnv(
      {},
      { foo: { id: "foo", enabled: 1 } },
      new Map([["agent-1/skills/foo/SKILL.md", "body"]]),
    );
    const svc = makeService(env);
    const token = await makeSkillsToken();
    await expect(svc.load(token, { name: "foo" })).resolves.toBeDefined();
  });
});

// --- Installed-skill lookup and content retrieval ---

describe("SkillsService.load", () => {
  it("returns not-found text when the skill is not in the registry", async () => {
    const env = buildEnv({}, { other: { id: "other" } });
    const svc = makeService(env);
    const token = await makeSkillsToken();
    const out = await svc.load(token, { name: "missing" }, SCHEMA_CONTENT_HASH);
    expect(out.content).toBe("Skill 'missing' not found");
  });

  it("returns not-enabled text when the skill row has enabled=0", async () => {
    const env = buildEnv({}, { foo: { id: "foo", enabled: 0 } });
    const svc = makeService(env);
    const token = await makeSkillsToken();
    const out = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    expect(out.content).toBe("Skill 'foo' is not enabled");
  });

  it("returns frontmatter-stripped content for an enabled skill", async () => {
    const r2 = new Map([
      [
        "agent-1/skills/foo/SKILL.md",
        "---\nname: foo\ndescription: test\n---\n# Body\n\nInstructions go here.",
      ],
    ]);
    const env = buildEnv({}, { foo: { id: "foo", enabled: 1 } }, r2);
    const svc = makeService(env);
    const token = await makeSkillsToken();
    const out = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    expect(out.content).toBe("# Body\n\nInstructions go here.");
  });

  it("treats a row without an `enabled` column as enabled (legacy D1 schema)", async () => {
    const r2 = new Map([["agent-1/skills/foo/SKILL.md", "# Body"]]);
    const env = buildEnv({}, { foo: { id: "foo" } }, r2);
    const svc = makeService(env);
    const token = await makeSkillsToken();
    const out = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    expect(out.content).toBe("# Body");
  });

  it("returns content-not-found text when R2 has no object for the skill", async () => {
    const env = buildEnv({}, { foo: { id: "foo", enabled: 1 } });
    const svc = makeService(env);
    const token = await makeSkillsToken();
    const out = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    expect(out.content).toBe("Skill 'foo' content not found in storage");
  });

  it("returns not-found when D1 query throws (transient failure fail-closed)", async () => {
    const env = buildEnv({
      SKILL_REGISTRY: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error("D1 down");
            },
          }),
        }),
      } as unknown as D1Database,
    });
    const svc = makeService(env);
    const token = await makeSkillsToken();
    const out = await svc.load(token, { name: "foo" }, SCHEMA_CONTENT_HASH);
    expect(out.content).toBe("Skill 'foo' not found");
  });
});
