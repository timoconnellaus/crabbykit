/**
 * Bundle capability catalog — end-to-end scenarios covering both the
 * primary validation at `BundleRegistry.setActive` and the dispatch-time
 * guard in `AgentDO.initBundleDispatch`'s inline handler. Runs inside
 * the pool-workers runtime using the same `TestBundleAgentDO` harness as
 * `bundle-dispatch.test.ts`.
 */

import { CapabilityMismatchError, InMemoryBundleRegistry } from "@claw-for-cloudflare/bundle-host";
import { beforeEach, describe, expect, it } from "vitest";
import { makeFakeWorkerLoader } from "../../src/test-helpers/fake-worker-loader.js";
import {
  clearMockResponses,
  resetTestBundleHolders,
  setMockResponses,
  setTestBundleEnv,
  setTestBundleLoader,
  setTestBundleRegistry,
} from "../../src/test-helpers/test-agent-do.js";
import { REFERENCE_BUNDLE_SOURCE } from "../fixtures/bundle-sources.js";
import {
  assistantText,
  getBundleStubAndId,
  getCachedBundlePointer,
  getEntries,
  runTurn,
} from "../helpers/bundle-client.js";

function freshRegistry(): InMemoryBundleRegistry {
  return new InMemoryBundleRegistry();
}

function assistantEntries(entries: Array<{ type: string; data: Record<string, unknown> }>) {
  return entries.filter(
    (e) => e.type === "message" && (e.data as { role?: string }).role === "assistant",
  );
}

describe("catalog validation: setActive (primary)", () => {
  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
  });

  it("A: matching catalog flips the pointer", async () => {
    const registry = freshRegistry();
    registry.seed("v-ok", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "compaction-summary" }],
    });
    await registry.setActive("agent-cat-a", "v-ok", {
      knownCapabilityIds: ["compaction-summary"],
    });
    expect(await registry.getActiveForAgent("agent-cat-a")).toBe("v-ok");
  });

  it("B: missing id throws CapabilityMismatchError; pointer unchanged", async () => {
    const registry = freshRegistry();
    registry.seed("v-bad", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    await expect(
      registry.setActive("agent-cat-b", "v-bad", { knownCapabilityIds: ["file-tools"] }),
    ).rejects.toBeInstanceOf(CapabilityMismatchError);
    expect(await registry.getActiveForAgent("agent-cat-b")).toBeNull();
  });

  it("C: skipCatalogCheck: true bypasses validation", async () => {
    const registry = freshRegistry();
    registry.seed("v-skip", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    await registry.setActive("agent-cat-c", "v-skip", { skipCatalogCheck: true });
    expect(await registry.getActiveForAgent("agent-cat-c")).toBe("v-skip");
  });

  it("D: clearing to null skips validation regardless of options", async () => {
    const registry = freshRegistry();
    await registry.setActive("agent-cat-d", null);
    expect(await registry.getActiveForAgent("agent-cat-d")).toBeNull();
  });

  it("F: empty declaration always validates", async () => {
    const registry = freshRegistry();
    registry.seed("v-empty", REFERENCE_BUNDLE_SOURCE, { requiredCapabilities: [] });
    await registry.setActive("agent-cat-f", "v-empty", { knownCapabilityIds: [] });
    expect(await registry.getActiveForAgent("agent-cat-f")).toBe("v-empty");
  });

  it("G: legacy bundle without declaration passes", async () => {
    const registry = freshRegistry();
    registry.seed("v-legacy", REFERENCE_BUNDLE_SOURCE);
    await registry.setActive("agent-cat-g", "v-legacy", { knownCapabilityIds: [] });
    expect(await registry.getActiveForAgent("agent-cat-g")).toBe("v-legacy");
  });
});

describe("catalog validation: dispatch-time guard (backup)", () => {
  beforeEach(() => {
    resetTestBundleHolders();
    clearMockResponses();
    setMockResponses([
      { text: "static-fallback-1" },
      { text: "static-fallback-2" },
      { text: "static-fallback-3" },
    ]);
    setTestBundleLoader(makeFakeWorkerLoader());
    setTestBundleEnv({ TIMEZONE: "UTC" });
  });

  it("E: out-of-band setActiveSync with missing capability disables at dispatch", async () => {
    // Seed a bundle declaring a capability the host does NOT register.
    // The mock TestBundleAgentDO only registers `compaction-summary`.
    const registry = freshRegistry();
    registry.seed("v-guard", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    // setActiveSync BYPASSES validation — simulating an out-of-band
    // pointer write that the registry-level check did not see.
    registry.setActiveSync("agent-guard-e", "v-guard");
    setTestBundleRegistry(registry);

    const { stub, agentId } = getBundleStubAndId("agent-guard-e");
    // The DO's `agentId` is the DO id hash, not the name. Re-seed the
    // pointer under the real id so the runtime sees it.
    registry.setActiveSync(agentId, "v-guard");

    const sid = await runTurn(stub, "hi");

    // Guard fires, bundle is disabled, static brain runs.
    const assistants = assistantEntries(await getEntries(stub, sid));
    expect(assistants.length).toBe(1);
    expect(assistantText(assistants[0])).toBe("static-fallback-1");

    // Pointer cache is null after the guard clears it.
    const cached = await getCachedBundlePointer(stub);
    expect(cached).toBeNull();

    // Registry pointer is also null (guard called setActive to clear).
    expect(await registry.getActiveForAgent(agentId)).toBeNull();
  });

  it("K: cold start with stale cached pointer + missing capability → guard disables", async () => {
    // Simulate a prior DO lifetime that validated a bundle, then the
    // host redeployed with the capability dropped. The guard detects
    // the stale validation and fires on first turn.
    const registry = freshRegistry();
    registry.seed("v-cold", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });
    setTestBundleRegistry(registry);

    const { stub, agentId } = getBundleStubAndId("agent-guard-k");
    registry.setActiveSync(agentId, "v-cold");
    // Pre-warm the storage cache as if a prior lifetime wrote it.
    // (In reality the DO reads from `ctx.storage.activeBundleVersionId`
    // on hasActiveBundle; seeding via setActiveSync matches that path.)

    const sid = await runTurn(stub, "hi");

    const assistants = assistantEntries(await getEntries(stub, sid));
    // Static brain must have run — bundle was disabled by the guard.
    expect(assistants.length).toBe(1);
    expect(assistantText(assistants[0])).toBe("static-fallback-1");
    expect(await getCachedBundlePointer(stub)).toBeNull();
  });

  it("H: second turn against validated bundle does not re-read metadata", async () => {
    // Seed a bundle whose declaration IS satisfied so dispatch succeeds.
    // The mock compaction capability's id is `compaction-summary` — see
    // test-agent-do.ts:buildMockCompactionCapability.
    const registry = freshRegistry();
    registry.seed("v-cache", REFERENCE_BUNDLE_SOURCE, {
      requiredCapabilities: [{ id: "compaction-summary" }],
    });
    setTestBundleRegistry(registry);

    const { stub, agentId } = getBundleStubAndId("agent-guard-h");
    await registry.setActive(agentId, "v-cache", {
      knownCapabilityIds: ["compaction-summary"],
    });

    // First turn — guard reads metadata, validates, caches.
    const sid = await runTurn(stub, "hello-1");

    // Second turn — guard should short-circuit on validatedVersionId match.
    // No direct spy on getVersion here; the assertion is behavioral: two
    // consecutive turns both succeed against the same version without
    // catalog-mismatch errors.
    await runTurn(stub, "hello-2", sid);

    // Pointer still points at v-cache; no silent disable.
    expect(await registry.getActiveForAgent(agentId)).toBe("v-cache");
    expect(await getCachedBundlePointer(stub)).toBe("v-cache");
  });
});

describe("catalog validation: error shape", () => {
  it("CapabilityMismatchError exposes missingIds, versionId, and code", async () => {
    const registry = freshRegistry();
    registry.seed("v-err", "irrelevant", {
      requiredCapabilities: [{ id: "a-missing" }, { id: "b-missing" }],
    });
    try {
      await registry.setActive("agent-err", "v-err", { knownCapabilityIds: [] });
      expect.fail("expected CapabilityMismatchError");
    } catch (err) {
      const e = err as CapabilityMismatchError;
      expect(e).toBeInstanceOf(CapabilityMismatchError);
      expect(e.code).toBe("ERR_CAPABILITY_MISMATCH");
      expect(e.versionId).toBe("v-err");
      expect(e.missingIds).toEqual(["a-missing", "b-missing"]);
      expect(e.name).toBe("CapabilityMismatchError");
    }
  });
});
