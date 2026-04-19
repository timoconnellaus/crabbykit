/**
 * FileToolsService unit tests (tasks 4.10 + 4.11).
 *
 * FileToolsService is a WorkerEntrypoint — tested in the pool-workers runtime.
 * We mock R2 (STORAGE_BUCKET) via the shared `createMockR2Bucket` helper and
 * verify for each of the nine methods:
 *  - token without "file-tools" scope throws ERR_SCOPE_DENIED
 *  - schema-hash mismatch throws ERR_SCHEMA_VERSION
 *  - path validation rejects traversal attempts (where applicable)
 *  - happy-path R2 operation produces a result matching the static-tool shape
 *
 * Task 4.11 — assert service makes no spine call. The env is structurally
 * typed as NOT containing a SPINE binding (type-level check), so structurally
 * the service has no way to reach spine. We also stick a `SPINE = vi.fn()`
 * onto an env at runtime and confirm the fn is never called.
 */

import { BUNDLE_SUBKEY_LABEL } from "@crabbykit/bundle-token";
import { describe, expect, it, vi } from "vitest";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { FileToolsServiceEnv } from "../service.js";
import { FileToolsService } from "../service.js";
import { createMockR2Bucket, seedBucket } from "./mock-r2.js";

const TEST_AUTH_KEY = "test-auth-key-aaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_SCOPE = ["spine", "llm", "file-tools"];

/**
 * Mint a bundle capability token for FileToolsService tests. Derives the
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

// --- Type-level NO-SPINE guarantee (task 4.11) -------------------------------
// If a future change adds `SPINE` to FileToolsServiceEnv, this flips to
// `never` and the type-check at the use site below fails the build.

type _NoSpine = FileToolsServiceEnv extends { SPINE: unknown } ? never : true;
const NoSpineWitness: _NoSpine = true;
void NoSpineWitness;

// --- Helpers ----------------------------------------------------------------

const NAMESPACE = "agent-1";

interface BuildEnvOverrides {
  AGENT_AUTH_KEY?: string;
  STORAGE_NAMESPACE?: string;
  seed?: Record<string, string>;
}

function buildEnv(overrides: BuildEnvOverrides = {}): {
  env: FileToolsServiceEnv;
  bucket: R2Bucket;
} {
  const bucket = createMockR2Bucket();
  const env: FileToolsServiceEnv = {
    AGENT_AUTH_KEY: overrides.AGENT_AUTH_KEY ?? TEST_AUTH_KEY,
    STORAGE_BUCKET: bucket,
    STORAGE_NAMESPACE: overrides.STORAGE_NAMESPACE ?? NAMESPACE,
  };
  return { env, bucket };
}

function makeService(env: FileToolsServiceEnv): FileToolsService {
  return new FileToolsService({} as never, env);
}

// ---------------------------------------------------------------------------
// Subkey + misconfig
// ---------------------------------------------------------------------------

describe("FileToolsService subkey derivation", () => {
  it("is lazy and cached across calls", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    await svc.read(token, { path: "a.txt" }, SCHEMA_CONTENT_HASH);
    await svc.read(token, { path: "a.txt" }, SCHEMA_CONTENT_HASH);
    expect((svc as unknown as { subkeyPromise: unknown }).subkeyPromise).not.toBeNull();
  });

  it("throws a misconfiguration error when AGENT_AUTH_KEY is missing", async () => {
    const { env } = buildEnv({ AGENT_AUTH_KEY: "" });
    const svc = makeService(env);
    await expect(svc.read("tok", { path: "a.txt" })).rejects.toThrow(/misconfigured/);
  });
});

// ---------------------------------------------------------------------------
// Per-method scope + schema-drift + path-validation + happy-path
// ---------------------------------------------------------------------------

// Per-method small matrix. Every method is exercised for (1) scope denial,
// (2) schema mismatch, (3) traversal rejection where the method takes a
// path, (4) happy-path success producing a sensible result.

describe("FileToolsService.read", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.read(noScopeToken, { path: "a.txt" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects schema-hash mismatch with ERR_SCHEMA_VERSION", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.read("tok", { path: "a.txt" }, "bogus-hash")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects traversal paths with an invalid_path error text", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.read(token, { path: "../escape.txt" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toContain("'..'");
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("returns file content from R2 under the namespaced key", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "note.md": "hello world" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.read(token, { path: "note.md" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toBe("hello world");
    expect(r.details).toMatchObject({ path: "note.md" });
  });

  it("returns a not-found text when the file is missing", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.read(token, { path: "missing.md" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toContain("File not found");
  });
});

describe("FileToolsService.write", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.write(noScopeToken, { path: "a.txt", content: "x" })).rejects.toThrow(
      "ERR_SCOPE_DENIED",
    );
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.write("tok", { path: "a.txt", content: "x" }, "bogus")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects traversal paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.write(token, { path: "../x.txt", content: "hi" }, SCHEMA_CONTENT_HASH);
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("writes content to R2 and succeeds", async () => {
    const { env, bucket } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.write(
      token,
      { path: "hello.md", content: "hi there" },
      SCHEMA_CONTENT_HASH,
    );
    expect(r.text).toMatch(/Successfully wrote/);
    const obj = await bucket.get(`${NAMESPACE}/hello.md`);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe("hi there");
  });
});

describe("FileToolsService.edit", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(
      svc.edit(noScopeToken, { path: "a.txt", old_string: "a", new_string: "b" }),
    ).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(
      svc.edit("tok", { path: "a.txt", old_string: "a", new_string: "b" }, "bogus"),
    ).rejects.toThrow("ERR_SCHEMA_VERSION");
  });

  it("rejects traversal paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.edit(
      token,
      { path: "../x.txt", old_string: "a", new_string: "b" },
      SCHEMA_CONTENT_HASH,
    );
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("replaces a unique string and persists the result", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "f.md": "alpha beta gamma" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.edit(
      token,
      { path: "f.md", old_string: "beta", new_string: "BETA" },
      SCHEMA_CONTENT_HASH,
    );
    expect(r.text).toMatch(/Successfully replaced/);
    const obj = await bucket.get(`${NAMESPACE}/f.md`);
    expect(await obj!.text()).toBe("alpha BETA gamma");
  });
});

describe("FileToolsService.delete", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.delete(noScopeToken, { path: "a.txt" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.delete("tok", { path: "a.txt" }, "bogus")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects traversal paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.delete(token, { path: "../x.txt" }, SCHEMA_CONTENT_HASH);
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("deletes a file from R2", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "g.md": "bye" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.delete(token, { path: "g.md" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toMatch(/Successfully deleted/);
    expect(await bucket.get(`${NAMESPACE}/g.md`)).toBeNull();
  });
});

describe("FileToolsService.copy", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.copy(noScopeToken, { source: "a", destination: "b" })).rejects.toThrow(
      "ERR_SCOPE_DENIED",
    );
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.copy("tok", { source: "a", destination: "b" }, "bogus")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects traversal source paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.copy(token, { source: "../src", destination: "dst" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toContain("source path");
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("rejects traversal destination paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.copy(token, { source: "src", destination: "../dst" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toContain("destination path");
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("copies file content to the destination key", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "src.md": "contents" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.copy(
      token,
      { source: "src.md", destination: "dst.md" },
      SCHEMA_CONTENT_HASH,
    );
    expect(r.text).toMatch(/Copied/);
    const obj = await bucket.get(`${NAMESPACE}/dst.md`);
    expect(await obj!.text()).toBe("contents");
    // Source is preserved
    expect(await bucket.get(`${NAMESPACE}/src.md`)).not.toBeNull();
  });
});

describe("FileToolsService.move", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.move(noScopeToken, { source: "a", destination: "b" })).rejects.toThrow(
      "ERR_SCOPE_DENIED",
    );
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.move("tok", { source: "a", destination: "b" }, "bogus")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects traversal source/destination paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r1 = await svc.move(token, { source: "../src", destination: "dst" }, SCHEMA_CONTENT_HASH);
    expect(r1.details).toEqual({ error: "invalid_path" });
    const r2 = await svc.move(token, { source: "src", destination: "../dst" }, SCHEMA_CONTENT_HASH);
    expect(r2.details).toEqual({ error: "invalid_path" });
  });

  it("moves a file: destination written, source deleted", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "src.md": "contents" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.move(
      token,
      { source: "src.md", destination: "dst.md" },
      SCHEMA_CONTENT_HASH,
    );
    expect(r.text).toMatch(/Moved/);
    expect(await bucket.get(`${NAMESPACE}/src.md`)).toBeNull();
    const obj = await bucket.get(`${NAMESPACE}/dst.md`);
    expect(await obj!.text()).toBe("contents");
  });
});

describe("FileToolsService.list", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.list(noScopeToken, {})).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.list("tok", {}, "bogus")).rejects.toThrow("ERR_SCHEMA_VERSION");
  });

  it("rejects traversal paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.list(token, { path: "../x" }, SCHEMA_CONTENT_HASH);
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("lists entries at the namespace root", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "a.md": "", "b.md": "", "sub/c.md": "" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.list(token, {}, SCHEMA_CONTENT_HASH);
    expect(r.details.entries).toBeDefined();
    const names = (r.details.entries ?? []).map((e) => e.name).sort();
    expect(names).toContain("a.md");
    expect(names).toContain("b.md");
    expect(names).toContain("sub");
  });
});

describe("FileToolsService.tree", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.tree(noScopeToken, {})).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.tree("tok", {}, "bogus")).rejects.toThrow("ERR_SCHEMA_VERSION");
  });

  it("rejects traversal paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.tree(token, { path: "../x" }, SCHEMA_CONTENT_HASH);
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("renders an empty namespace as empty", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.tree(token, {}, SCHEMA_CONTENT_HASH);
    expect(r.text).toBe("Directory is empty.");
  });

  it("renders a flat tree for seeded files", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "x.md": "", "y.md": "" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.tree(token, {}, SCHEMA_CONTENT_HASH);
    expect(r.text).toContain("x.md");
    expect(r.text).toContain("y.md");
  });
});

describe("FileToolsService.find", () => {
  it("rejects token lacking 'file-tools' scope", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const noScopeToken = await makeToken(["spine", "llm"]);
    await expect(svc.find(noScopeToken, { pattern: "*.md" })).rejects.toThrow("ERR_SCOPE_DENIED");
  });

  it("rejects schema-hash mismatch", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    await expect(svc.find("tok", { pattern: "*.md" }, "bogus")).rejects.toThrow(
      "ERR_SCHEMA_VERSION",
    );
  });

  it("rejects traversal paths", async () => {
    const { env } = buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.find(token, { pattern: "*.md", path: "../x" }, SCHEMA_CONTENT_HASH);
    expect(r.details).toEqual({ error: "invalid_path" });
  });

  it("returns matches for a glob pattern", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, {
      "foo.md": "",
      "bar.md": "",
      "baz.txt": "",
      "sub/nested.md": "",
    });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.find(token, { pattern: "**/*.md" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toContain("foo.md");
    expect(r.text).toContain("bar.md");
    expect(r.text).toContain("sub/nested.md");
    expect(r.text).not.toContain("baz.txt");
  });

  it("returns a no-match sentinel when nothing matches", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "a.txt": "" });
    const svc = makeService(env);
    const token = await makeToken();
    const r = await svc.find(token, { pattern: "*.nope" }, SCHEMA_CONTENT_HASH);
    expect(r.text).toBe("No files matched the pattern.");
  });
});

// ---------------------------------------------------------------------------
// Task 4.11 — service makes no SPINE call on success.
// ---------------------------------------------------------------------------

describe("FileToolsService does not invoke SPINE (task 4.11)", () => {
  it("leaves an accidentally-present SPINE fn uncalled on a successful write", async () => {
    const { env, bucket } = buildEnv();
    const spineFn = vi.fn();
    // Structurally, FileToolsServiceEnv has no SPINE binding (enforced
    // by the `_NoSpine` type-level check at the top of this file). At
    // runtime we stick a SPINE field onto the env anyway; the service
    // code has no reference to it and must never reach for it.
    const envWithSpine = env as FileToolsServiceEnv & { SPINE: typeof spineFn };
    envWithSpine.SPINE = spineFn;

    const svc = makeService(envWithSpine);
    const token = await makeToken();

    const r = await svc.write(
      token,
      { path: "mutated.md", content: "contents" },
      SCHEMA_CONTENT_HASH,
    );
    expect(r.text).toMatch(/Successfully wrote/);
    expect(await bucket.get(`${NAMESPACE}/mutated.md`)).not.toBeNull();
    expect(spineFn).not.toHaveBeenCalled();
  });

  it("leaves SPINE uncalled across all five mutation methods", async () => {
    const { env, bucket } = buildEnv();
    await seedBucket(bucket, NAMESPACE, { "a.md": "hello" });
    const spineFn = vi.fn();
    const envWithSpine = env as FileToolsServiceEnv & { SPINE: typeof spineFn };
    envWithSpine.SPINE = spineFn;

    const svc = makeService(envWithSpine);
    const token = await makeToken();

    await svc.write(token, { path: "b.md", content: "bye" }, SCHEMA_CONTENT_HASH);
    await svc.edit(
      token,
      { path: "a.md", old_string: "hello", new_string: "HELLO" },
      SCHEMA_CONTENT_HASH,
    );
    await svc.copy(token, { source: "a.md", destination: "c.md" }, SCHEMA_CONTENT_HASH);
    await svc.move(token, { source: "c.md", destination: "d.md" }, SCHEMA_CONTENT_HASH);
    await svc.delete(token, { path: "b.md" }, SCHEMA_CONTENT_HASH);

    expect(spineFn).not.toHaveBeenCalled();
  });
});
