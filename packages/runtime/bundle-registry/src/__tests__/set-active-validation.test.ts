/**
 * Catalog validation on `D1BundleRegistry.setActive`.
 *
 * The registry reads `BundleMetadata.requiredCapabilities` from the
 * version row and compares it against the caller-supplied
 * `knownCapabilityIds`. Mismatch throws `CapabilityMismatchError` before
 * any pointer mutation. Clearing to null and `skipCatalogCheck: true`
 * both short-circuit validation.
 */

import { env } from "cloudflare:test";
import { CapabilityMismatchError } from "@claw-for-cloudflare/agent-runtime";
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

function makeRegistry(): D1BundleRegistry {
  return new D1BundleRegistry(testEnv.BUNDLE_DB, testEnv.BUNDLE_KV);
}

function bytesFrom(s: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  return buf;
}

describe("D1BundleRegistry.setActive catalog validation", () => {
  beforeEach(async () => {
    await resetTables(testEnv.BUNDLE_DB);
  });

  it("flips the pointer when declared capabilities are present", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-ok"),
      metadata: { requiredCapabilities: [{ id: "tavily-web-search" }] },
    });
    await r.setActive("agent-ok", v.versionId, {
      knownCapabilityIds: ["tavily-web-search", "file-tools"],
    });
    expect(await r.getActiveForAgent("agent-ok")).toBe(v.versionId);
  });

  it("throws CapabilityMismatchError when a declared capability is missing", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-miss"),
      metadata: { requiredCapabilities: [{ id: "tavily-web-search" }] },
    });
    const prior = await r.getActiveForAgent("agent-miss");

    await expect(
      r.setActive("agent-miss", v.versionId, {
        knownCapabilityIds: ["file-tools"],
      }),
    ).rejects.toBeInstanceOf(CapabilityMismatchError);

    // Pointer stays at whatever it was before (null for a fresh agent).
    expect(await r.getActiveForAgent("agent-miss")).toBe(prior);
  });

  it("error lists the missing ids and preserves versionId", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-miss-names"),
      metadata: {
        requiredCapabilities: [{ id: "tavily-web-search" }, { id: "vector-memory" }],
      },
    });
    try {
      await r.setActive("agent-miss-names", v.versionId, {
        knownCapabilityIds: ["file-tools"],
      });
      expect.fail("expected CapabilityMismatchError");
    } catch (err) {
      const e = err as CapabilityMismatchError;
      expect(e).toBeInstanceOf(CapabilityMismatchError);
      expect(e.missingIds).toEqual(["tavily-web-search", "vector-memory"]);
      expect(e.versionId).toBe(v.versionId);
      expect(e.code).toBe("ERR_CAPABILITY_MISMATCH");
    }
  });

  it("skipCatalogCheck: true bypasses validation", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-skip"),
      metadata: { requiredCapabilities: [{ id: "tavily-web-search" }] },
    });
    await r.setActive("agent-skip", v.versionId, { skipCatalogCheck: true });
    expect(await r.getActiveForAgent("agent-skip")).toBe(v.versionId);
  });

  it("clearing the pointer (versionId: null) never reads metadata", async () => {
    const r = makeRegistry();
    // No options — null always short-circuits.
    await r.setActive("agent-clear", null);
    expect(await r.getActiveForAgent("agent-clear")).toBeNull();
  });

  it("throws TypeError when knownCapabilityIds is omitted and skipCatalogCheck is not true", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({ bytes: bytesFrom("v-require") });
    await expect(r.setActive("agent-req", v.versionId, {})).rejects.toThrow(TypeError);
  });

  it("legacy metadata (no requiredCapabilities) passes with any knownCapabilityIds", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-legacy"),
      metadata: { sourceName: "legacy" },
    });
    await r.setActive("agent-legacy", v.versionId, { knownCapabilityIds: [] });
    expect(await r.getActiveForAgent("agent-legacy")).toBe(v.versionId);
  });

  it("duplicate required ids do not produce duplicate missing ids", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-dup"),
      metadata: {
        requiredCapabilities: [{ id: "tavily-web-search" }, { id: "tavily-web-search" }],
      },
    });
    try {
      await r.setActive("agent-dup", v.versionId, { knownCapabilityIds: [] });
      expect.fail("expected CapabilityMismatchError");
    } catch (err) {
      const e = err as CapabilityMismatchError;
      expect(e.missingIds).toEqual(["tavily-web-search"]);
    }
  });

  it("skipCatalogCheck: true wins over missing knownCapabilityIds", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-skip-wins"),
      metadata: { requiredCapabilities: [{ id: "tavily-web-search" }] },
    });
    await r.setActive("agent-skip-wins", v.versionId, { skipCatalogCheck: true });
    expect(await r.getActiveForAgent("agent-skip-wins")).toBe(v.versionId);
  });

  it("CapabilityMismatchError code survives structured-clone", async () => {
    const err = new CapabilityMismatchError({ missingIds: ["x"], versionId: "v" });
    // Round-trip via structured clone (or a JSON fallback that preserves own fields)
    const serialized = {
      name: err.name,
      message: err.message,
      code: err.code,
      missingIds: err.missingIds,
      versionId: err.versionId,
    };
    const parsed = JSON.parse(JSON.stringify(serialized));
    expect(parsed.code).toBe("ERR_CAPABILITY_MISMATCH");
    expect(parsed.missingIds).toEqual(["x"]);
  });

  // Reserved-scope rejection (Gap 2): independent of catalog-check
  it('throws TypeError when requiredCapabilities contains reserved id "spine"', async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-reserved-spine"),
      metadata: { requiredCapabilities: [{ id: "spine" }] },
    });
    await expect(
      r.setActive("agent-reserved-spine", v.versionId, {
        knownCapabilityIds: ["spine"],
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      r.setActive("agent-reserved-spine", v.versionId, {
        knownCapabilityIds: ["spine"],
      }),
    ).rejects.toThrow(/reserved scope/);
    // Pointer must NOT have been flipped
    expect(await r.getActiveForAgent("agent-reserved-spine")).toBeNull();
  });

  it('throws TypeError when requiredCapabilities contains reserved id "llm"', async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-reserved-llm"),
      metadata: { requiredCapabilities: [{ id: "llm" }] },
    });
    await expect(
      r.setActive("agent-reserved-llm", v.versionId, {
        knownCapabilityIds: ["llm"],
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      r.setActive("agent-reserved-llm", v.versionId, {
        knownCapabilityIds: ["llm"],
      }),
    ).rejects.toThrow(/reserved scope/);
    expect(await r.getActiveForAgent("agent-reserved-llm")).toBeNull();
  });

  // Gap 4 (D1 side): reserved-id check is NOT bypassable by skipCatalogCheck
  it("reserved-id rejection fires even with skipCatalogCheck: true", async () => {
    const r = makeRegistry();
    const v = await r.createVersion({
      bytes: bytesFrom("v-reserved-skip"),
      metadata: { requiredCapabilities: [{ id: "spine" }] },
    });
    await expect(
      r.setActive("agent-reserved-skip", v.versionId, { skipCatalogCheck: true }),
    ).rejects.toThrow(TypeError);
    // Pointer stays null — reserved-id check precedes the skipCatalogCheck branch
    expect(await r.getActiveForAgent("agent-reserved-skip")).toBeNull();
  });
});
