/**
 * Catalog validation on `InMemoryBundleRegistry.setActive`.
 *
 * Parallel to the D1 version's validation test suite — same contract,
 * different implementation. Both registries share the
 * `validateCatalogAgainstKnownIds` helper from bundle-registry.
 */

import { describe, expect, it } from "vitest";
import { CapabilityMismatchError } from "../bundle-config.js";
import { InMemoryBundleRegistry } from "../in-memory-registry.js";

function setup(meta?: { requiredCapabilities?: Array<{ id: string }> }): InMemoryBundleRegistry {
  const registry = new InMemoryBundleRegistry();
  registry.seed("v-ok", "bytes", meta);
  return registry;
}

describe("InMemoryBundleRegistry.setActive catalog validation", () => {
  it("flips the pointer when declared capabilities are present", async () => {
    const r = setup({ requiredCapabilities: [{ id: "tavily-web-search" }] });
    await r.setActive("agent-ok", "v-ok", {
      knownCapabilityIds: ["tavily-web-search", "file-tools"],
    });
    expect(await r.getActiveForAgent("agent-ok")).toBe("v-ok");
  });

  it("throws CapabilityMismatchError when a declared capability is missing", async () => {
    const r = setup({ requiredCapabilities: [{ id: "tavily-web-search" }] });
    await expect(
      r.setActive("agent-miss", "v-ok", { knownCapabilityIds: ["file-tools"] }),
    ).rejects.toBeInstanceOf(CapabilityMismatchError);
    expect(await r.getActiveForAgent("agent-miss")).toBeNull();
  });

  it("error payload names missing ids and the versionId", async () => {
    const r = setup({
      requiredCapabilities: [{ id: "tavily-web-search" }, { id: "vector-memory" }],
    });
    try {
      await r.setActive("agent-miss", "v-ok", { knownCapabilityIds: [] });
      expect.fail("expected CapabilityMismatchError");
    } catch (err) {
      const e = err as CapabilityMismatchError;
      expect(e.missingIds).toEqual(["tavily-web-search", "vector-memory"]);
      expect(e.versionId).toBe("v-ok");
      expect(e.code).toBe("ERR_CAPABILITY_MISMATCH");
    }
  });

  it("skipCatalogCheck: true bypasses validation", async () => {
    const r = setup({ requiredCapabilities: [{ id: "tavily-web-search" }] });
    await r.setActive("agent-skip", "v-ok", { skipCatalogCheck: true });
    expect(await r.getActiveForAgent("agent-skip")).toBe("v-ok");
  });

  it("clearing (versionId: null) without options always works", async () => {
    const r = setup({ requiredCapabilities: [{ id: "tavily-web-search" }] });
    await r.setActive("agent-clear", null);
    expect(await r.getActiveForAgent("agent-clear")).toBeNull();
  });

  it("throws TypeError when knownCapabilityIds is omitted and skipCatalogCheck is not true", async () => {
    const r = setup({ requiredCapabilities: [{ id: "tavily-web-search" }] });
    await expect(r.setActive("agent-req", "v-ok", {})).rejects.toThrow(TypeError);
  });

  it("legacy metadata without requiredCapabilities passes", async () => {
    const r = setup();
    await r.setActive("agent-legacy", "v-ok", { knownCapabilityIds: [] });
    expect(await r.getActiveForAgent("agent-legacy")).toBe("v-ok");
  });

  it("duplicate required ids do not produce duplicate missing ids", async () => {
    const r = setup({
      requiredCapabilities: [{ id: "tavily-web-search" }, { id: "tavily-web-search" }],
    });
    try {
      await r.setActive("agent-dup", "v-ok", { knownCapabilityIds: [] });
      expect.fail("expected CapabilityMismatchError");
    } catch (err) {
      const e = err as CapabilityMismatchError;
      expect(e.missingIds).toEqual(["tavily-web-search"]);
    }
  });

  it("skipCatalogCheck: true wins over missing knownCapabilityIds", async () => {
    const r = setup({ requiredCapabilities: [{ id: "tavily-web-search" }] });
    await r.setActive("agent-skip-wins", "v-ok", { skipCatalogCheck: true });
    expect(await r.getActiveForAgent("agent-skip-wins")).toBe("v-ok");
  });

  // Reserved-scope rejection (Gap 3)
  it('throws TypeError when requiredCapabilities contains reserved id "spine"', async () => {
    const r = setup({ requiredCapabilities: [{ id: "spine" }] });
    await expect(
      r.setActive("agent-reserved-spine", "v-ok", { knownCapabilityIds: ["spine"] }),
    ).rejects.toThrow(TypeError);
    await expect(
      r.setActive("agent-reserved-spine", "v-ok", { knownCapabilityIds: ["spine"] }),
    ).rejects.toThrow(/reserved scope/);
    // Pointer must NOT have been flipped
    expect(await r.getActiveForAgent("agent-reserved-spine")).toBeNull();
  });

  it('throws TypeError when requiredCapabilities contains reserved id "llm"', async () => {
    const r = setup({ requiredCapabilities: [{ id: "llm" }] });
    await expect(
      r.setActive("agent-reserved-llm", "v-ok", { knownCapabilityIds: ["llm"] }),
    ).rejects.toThrow(TypeError);
    await expect(
      r.setActive("agent-reserved-llm", "v-ok", { knownCapabilityIds: ["llm"] }),
    ).rejects.toThrow(/reserved scope/);
    expect(await r.getActiveForAgent("agent-reserved-llm")).toBeNull();
  });

  // Gap 4: reserved-id check is NOT bypassable by skipCatalogCheck: true
  it("reserved-id rejection fires even with skipCatalogCheck: true", async () => {
    const r = setup({ requiredCapabilities: [{ id: "spine" }] });
    await expect(
      r.setActive("agent-reserved-skip", "v-ok", { skipCatalogCheck: true }),
    ).rejects.toThrow(TypeError);
    // The reserved-id check runs before the skipCatalogCheck branch
    expect(await r.getActiveForAgent("agent-reserved-skip")).toBeNull();
  });

  it("reserved-id rejection for llm fires even with skipCatalogCheck: true", async () => {
    const r = setup({ requiredCapabilities: [{ id: "llm" }] });
    await expect(
      r.setActive("agent-reserved-skip-llm", "v-ok", { skipCatalogCheck: true }),
    ).rejects.toThrow(TypeError);
    expect(await r.getActiveForAgent("agent-reserved-skip-llm")).toBeNull();
  });
});
