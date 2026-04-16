/**
 * D1BundleRegistry integration tests (tasks 5.11, 5.16).
 *
 * Runs under @cloudflare/vitest-pool-workers with real D1 and KV bindings.
 * Exercises the full registry lifecycle including:
 *   - self-seeding migration
 *   - content-addressed version creation
 *   - setActive atomic batch
 *   - rollback atomic batch
 *   - two sequential deploys
 *   - KV readback enforcement (happy path — real KV is fast)
 *   - deployment audit log ordering
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1BundleRegistry } from "../d1-registry.js";

interface TestEnv {
  BUNDLE_DB: D1Database;
  BUNDLE_KV: KVNamespace;
}

const testEnv = env as unknown as TestEnv;

async function resetTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS bundle_versions"),
    db.prepare("DROP TABLE IF EXISTS agent_bundles"),
    db.prepare("DROP TABLE IF EXISTS bundle_deployments"),
  ]);
}

function bytesFrom(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

function makeRegistry(): D1BundleRegistry {
  return new D1BundleRegistry(testEnv.BUNDLE_DB, testEnv.BUNDLE_KV);
}

beforeEach(async () => {
  await resetTables(testEnv.BUNDLE_DB);
});

describe("D1BundleRegistry self-seeding migration", () => {
  it("creates tables on first query against empty D1", async () => {
    const registry = makeRegistry();
    const result = await registry.getActiveForAgent("agent-1");
    expect(result).toBeNull();

    // Verify tables now exist
    const row = await testEnv.BUNDLE_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bundle_versions'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("bundle_versions");
  });

  it("is idempotent on repeated calls", async () => {
    const registry = makeRegistry();
    await registry.getActiveForAgent("a");
    await registry.getActiveForAgent("b");
    await expect(registry.getActiveForAgent("c")).resolves.toBeNull();
  });
});

describe("D1BundleRegistry.createVersion", () => {
  it("computes a content-addressed SHA-256 version ID", async () => {
    const registry = makeRegistry();
    const version = await registry.createVersion({
      bytes: bytesFrom("hello-world-1"),
    });
    expect(version.versionId).toMatch(/^[0-9a-f]{64}$/);
    expect(version.kvKey).toBe(`bundle:${version.versionId}`);
    expect(version.sizeBytes).toBeGreaterThan(0);
  });

  it("writes bytes to KV after readback verification", async () => {
    const registry = makeRegistry();
    const version = await registry.createVersion({
      bytes: bytesFrom("bytes-in-kv"),
    });
    const bytes = await registry.getBytes(version.versionId);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("bytes-in-kv");
  });

  it("deduplicates identical bytes (same hash = same version row)", async () => {
    const registry = makeRegistry();
    const v1 = await registry.createVersion({ bytes: bytesFrom("same") });
    const v2 = await registry.createVersion({ bytes: bytesFrom("same") });
    expect(v2.versionId).toBe(v1.versionId);

    // Only one D1 row
    const count = await testEnv.BUNDLE_DB.prepare(
      "SELECT COUNT(*) AS n FROM bundle_versions WHERE version_id = ?",
    )
      .bind(v1.versionId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects bundles exceeding the 25 MiB limit", async () => {
    const registry = makeRegistry();
    const huge = new Uint8Array(26 * 1024 * 1024).buffer;
    await expect(registry.createVersion({ bytes: huge })).rejects.toThrow(/exceeds .* byte limit/);
  });

  it("sanitizes metadata (strips unknown keys, enforces length limits)", async () => {
    const registry = makeRegistry();
    const longDescription = "x".repeat(2000);
    const version = await registry.createVersion({
      bytes: bytesFrom("sanitize-me"),
      metadata: {
        name: "my-bundle",
        description: longDescription,
        // @ts-expect-error — deliberately unknown key
        attacker: "evil",
      },
    });
    expect(version.metadata?.name).toBe("my-bundle");
    expect(version.metadata?.description?.length).toBeLessThanOrEqual(1024);
    expect((version.metadata as unknown as Record<string, unknown>).attacker).toBeUndefined();
  });
});

describe("D1BundleRegistry.setActive", () => {
  it("sets the active version and records a deployment", async () => {
    const registry = makeRegistry();
    const v = await registry.createVersion({ bytes: bytesFrom("v1") });
    await registry.setActive("agent-1", v.versionId, {
      sessionId: "s1",
      rationale: "initial deploy",
      skipCatalogCheck: true,
    });

    expect(await registry.getActiveForAgent("agent-1")).toBe(v.versionId);

    const deployments = await registry.listDeployments("agent-1");
    expect(deployments).toHaveLength(1);
    expect(deployments[0].versionId).toBe(v.versionId);
    expect(deployments[0].rationale).toBe("initial deploy");
    expect(deployments[0].deployedBySessionId).toBe("s1");
  });

  it("updates previous_version_id when the active version changes", async () => {
    const registry = makeRegistry();
    const v1 = await registry.createVersion({ bytes: bytesFrom("v1") });
    const v2 = await registry.createVersion({ bytes: bytesFrom("v2") });

    await registry.setActive("agent-1", v1.versionId, { skipCatalogCheck: true });
    await registry.setActive("agent-1", v2.versionId, { skipCatalogCheck: true });

    const agentBundle = await registry.getAgentBundle("agent-1");
    expect(agentBundle?.activeVersionId).toBe(v2.versionId);
    expect(agentBundle?.previousVersionId).toBe(v1.versionId);
  });

  it("null versionId reverts to static brain", async () => {
    const registry = makeRegistry();
    const v = await registry.createVersion({ bytes: bytesFrom("v") });
    await registry.setActive("agent-1", v.versionId, { skipCatalogCheck: true });
    await registry.setActive("agent-1", null, { rationale: "disable" });

    expect(await registry.getActiveForAgent("agent-1")).toBeNull();
    const deployments = await registry.listDeployments("agent-1");
    expect(deployments).toHaveLength(2);
    expect(deployments[0].versionId).toBeNull();
    expect(deployments[0].rationale).toBe("disable");
  });
});

describe("D1BundleRegistry.rollback", () => {
  it("swaps active and previous version IDs atomically", async () => {
    const registry = makeRegistry();
    const v1 = await registry.createVersion({ bytes: bytesFrom("v1") });
    const v2 = await registry.createVersion({ bytes: bytesFrom("v2") });

    await registry.setActive("agent-1", v1.versionId, { skipCatalogCheck: true });
    await registry.setActive("agent-1", v2.versionId, { skipCatalogCheck: true });
    await registry.rollback("agent-1", { rationale: "bad turn" });

    const bundle = await registry.getAgentBundle("agent-1");
    expect(bundle?.activeVersionId).toBe(v1.versionId);
    expect(bundle?.previousVersionId).toBe(v2.versionId);
  });

  it("appends a rollback entry to the deployment log", async () => {
    const registry = makeRegistry();
    const v1 = await registry.createVersion({ bytes: bytesFrom("v1") });
    const v2 = await registry.createVersion({ bytes: bytesFrom("v2") });
    await registry.setActive("agent-1", v1.versionId, { skipCatalogCheck: true });
    await registry.setActive("agent-1", v2.versionId, { skipCatalogCheck: true });
    await registry.rollback("agent-1", { rationale: "rollback-x" });

    const deployments = await registry.listDeployments("agent-1");
    expect(deployments[0].rationale).toBe("rollback-x");
    expect(deployments[0].versionId).toBe(v1.versionId);
  });

  it("throws when no previous version exists", async () => {
    const registry = makeRegistry();
    const v1 = await registry.createVersion({ bytes: bytesFrom("v1") });
    await registry.setActive("agent-1", v1.versionId, { skipCatalogCheck: true });
    // Single deploy — no previous to roll back to
    await expect(registry.rollback("agent-1")).rejects.toThrow(
      /No previous version to roll back to/,
    );
  });
});

describe("D1BundleRegistry.listDeployments", () => {
  it("returns deployments in descending order by deployed_at", async () => {
    const registry = makeRegistry();
    const v1 = await registry.createVersion({ bytes: bytesFrom("v1") });
    const v2 = await registry.createVersion({ bytes: bytesFrom("v2") });
    await registry.setActive("agent-1", v1.versionId, { skipCatalogCheck: true });
    await registry.setActive("agent-1", v2.versionId, { skipCatalogCheck: true });

    const deployments = await registry.listDeployments("agent-1");
    expect(deployments).toHaveLength(2);
    expect(deployments[0].versionId).toBe(v2.versionId);
    expect(deployments[1].versionId).toBe(v1.versionId);
    expect(deployments[0].deployedAt).toBeGreaterThanOrEqual(deployments[1].deployedAt);
  });

  it("caps limit at 100", async () => {
    const registry = makeRegistry();
    const v = await registry.createVersion({ bytes: bytesFrom("v") });
    await registry.setActive("agent-cap", v.versionId, { skipCatalogCheck: true });
    const out = await registry.listDeployments("agent-cap", 500);
    // Capped query — just verifies it doesn't throw; only 1 deployment exists
    expect(out).toHaveLength(1);
  });
});

describe("two sequential deploys", () => {
  it("both versions land in KV and D1 with correct hashes, and rollback restores the first", async () => {
    const registry = makeRegistry();

    // Deploy #1
    const v1 = await registry.createVersion({
      bytes: bytesFrom("bundle-v1"),
      metadata: { name: "demo", version: "1.0.0" },
    });
    await registry.setActive("agent-1", v1.versionId, { rationale: "v1", skipCatalogCheck: true });

    // Deploy #2
    const v2 = await registry.createVersion({
      bytes: bytesFrom("bundle-v2"),
      metadata: { name: "demo", version: "2.0.0" },
    });
    await registry.setActive("agent-1", v2.versionId, { rationale: "v2", skipCatalogCheck: true });

    // Both versions are in D1
    expect(await registry.getVersion(v1.versionId)).not.toBeNull();
    expect(await registry.getVersion(v2.versionId)).not.toBeNull();

    // Both versions are in KV
    const bytes1 = await registry.getBytes(v1.versionId);
    const bytes2 = await registry.getBytes(v2.versionId);
    expect(new TextDecoder().decode(bytes1!)).toBe("bundle-v1");
    expect(new TextDecoder().decode(bytes2!)).toBe("bundle-v2");

    // Pointer is v2; previous is v1
    expect(await registry.getActiveForAgent("agent-1")).toBe(v2.versionId);
    const bundle = await registry.getAgentBundle("agent-1");
    expect(bundle?.previousVersionId).toBe(v1.versionId);

    // Deployment log has both in reverse order
    const deployments = await registry.listDeployments("agent-1");
    expect(deployments).toHaveLength(2);
    expect(deployments[0].rationale).toBe("v2");
    expect(deployments[1].rationale).toBe("v1");

    // Rollback restores v1
    await registry.rollback("agent-1", { rationale: "undo v2" });
    expect(await registry.getActiveForAgent("agent-1")).toBe(v1.versionId);

    // Old version still cacheable (bytes still in KV)
    const stillThere = await registry.getBytes(v2.versionId);
    expect(stillThere).not.toBeNull();
  });

  it("content-addressed dedup: re-deploying identical bytes returns the same version ID", async () => {
    const registry = makeRegistry();
    const first = await registry.createVersion({
      bytes: bytesFrom("identical"),
    });
    const second = await registry.createVersion({
      bytes: bytesFrom("identical"),
    });
    expect(second.versionId).toBe(first.versionId);

    await registry.setActive("agent-dup", first.versionId, { skipCatalogCheck: true });
    await registry.setActive("agent-dup", second.versionId, { skipCatalogCheck: true });

    // Two deployment log entries; active pointer still the same hash
    const deployments = await registry.listDeployments("agent-dup");
    expect(deployments).toHaveLength(2);
    expect(deployments.every((d) => d.versionId === first.versionId)).toBe(true);
  });
});
