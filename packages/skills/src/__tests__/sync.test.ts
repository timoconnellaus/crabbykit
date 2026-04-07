import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMockStorage } from "@claw-for-cloudflare/agent-runtime/test-utils";
import type { SkillRecord, SkillRegistry } from "@claw-for-cloudflare/skill-registry";
import { syncSkills } from "../sync.js";
import { getInstalledSkill, getSkillConflicts, listInstalledSkills, putInstalledSkill } from "../storage.js";
import type { InstalledSkill } from "../types.js";

function createMockRegistry(records: SkillRecord[]): SkillRegistry {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    list: async () => records,
    get: async (id: string) => map.get(id) ?? null,
    getVersion: async (id: string) => {
      const r = map.get(id);
      return r ? { version: r.version, contentHash: r.contentHash } : null;
    },
    upsert: async () => {},
    delete: async () => false,
  };
}

function createMockBucket(): R2Bucket {
  const store = new Map<string, string>();
  return {
    put: async (key: string, value: unknown) => {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    get: async (key: string) => {
      const val = store.get(key);
      if (val === undefined) return null;
      return { text: async () => val } as R2ObjectBody;
    },
    delete: async (key: string | string[]) => {
      if (Array.isArray(key)) key.forEach((k) => store.delete(k));
      else store.delete(key);
    },
    head: async () => null,
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }) as unknown as R2Objects,
    createMultipartUpload: async () => ({}) as R2MultipartUpload,
    resumeMultipartUpload: () => ({}) as R2MultipartUpload,
  } as R2Bucket;
}

const SKILL_RECORD: SkillRecord = {
  id: "test-skill",
  name: "Test Skill",
  description: "A test skill",
  version: "1.0.0",
  contentHash: "abc123",
  requiresCapabilities: [],
  skillMd: "---\nname: Test Skill\ndescription: A test skill\nversion: 1.0.0\n---\n# Test",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

describe("syncSkills", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let bucket: R2Bucket;

  beforeEach(() => {
    storage = createMockStorage();
    bucket = createMockBucket();
  });

  it("installs a new skill from registry (scenario 1)", async () => {
    const registry = createMockRegistry([SKILL_RECORD]);

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill", enabled: true }],
      capabilityIds: [],
    });

    const installed = await getInstalledSkill(storage, "test-skill");
    expect(installed).toBeDefined();
    expect(installed!.name).toBe("Test Skill");
    expect(installed!.origin).toBe("registry");
    expect(installed!.registryVersion).toBe("1.0.0");
    expect(installed!.registryHash).toBe("abc123");
    expect(installed!.enabled).toBe(true);
  });

  it("updates a clean skill when new version available (scenario 2)", async () => {
    const v2Record = { ...SKILL_RECORD, version: "2.0.0", contentHash: "def456" };
    const registry = createMockRegistry([v2Record]);

    // Pre-install v1
    await putInstalledSkill(storage, "test-skill", {
      name: "Test Skill",
      description: "A test skill",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: "abc123",
      dirty: false,
      requiresCapabilities: [],
    });

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill", enabled: true }],
      capabilityIds: [],
    });

    const updated = await getInstalledSkill(storage, "test-skill");
    expect(updated!.registryVersion).toBe("2.0.0");
    expect(updated!.registryHash).toBe("def456");
  });

  it("creates a conflict for dirty skill with new version (scenario 3)", async () => {
    const v2Record = { ...SKILL_RECORD, version: "2.0.0", contentHash: "def456", skillMd: "updated content" };
    const registry = createMockRegistry([v2Record]);

    // Pre-install v1, marked dirty
    await putInstalledSkill(storage, "test-skill", {
      name: "Test Skill",
      description: "A test skill",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: "abc123",
      dirty: true,
      requiresCapabilities: [],
    });

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill", enabled: true }],
      capabilityIds: [],
    });

    const conflicts = await getSkillConflicts(storage);
    expect(conflicts.size).toBe(1);
    const conflict = conflicts.get("conflict:test-skill");
    expect(conflict).toBeDefined();
    expect(conflict!.upstreamVersion).toBe("2.0.0");
    expect(conflict!.upstreamContent).toBe("updated content");
  });

  it("disables skill with missing capability dependencies", async () => {
    const record = { ...SKILL_RECORD, requiresCapabilities: ["sandbox", "vibe-coder"] };
    const registry = createMockRegistry([record]);

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill", enabled: true }],
      capabilityIds: ["sandbox"],
    });

    const installed = await getInstalledSkill(storage, "test-skill");
    expect(installed!.enabled).toBe(false);
  });

  it("skips skill not found in registry", async () => {
    const registry = createMockRegistry([]);

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "missing-skill" }],
      capabilityIds: [],
    });

    const installed = await getInstalledSkill(storage, "missing-skill");
    expect(installed).toBeUndefined();
  });

  it("does not update when version is the same", async () => {
    const registry = createMockRegistry([SKILL_RECORD]);

    await putInstalledSkill(storage, "test-skill", {
      name: "Test Skill",
      description: "A test skill",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: "abc123",
      requiresCapabilities: [],
    });

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill", enabled: true }],
      capabilityIds: [],
    });

    const installed = await getInstalledSkill(storage, "test-skill");
    expect(installed!.registryVersion).toBe("1.0.0");
  });

  it("syncs enabled state from declaration when version unchanged", async () => {
    const registry = createMockRegistry([SKILL_RECORD]);

    await putInstalledSkill(storage, "test-skill", {
      name: "Test Skill",
      description: "A test skill",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: "abc123",
      requiresCapabilities: [],
    });

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill", enabled: false }],
      capabilityIds: [],
    });

    const installed = await getInstalledSkill(storage, "test-skill");
    expect(installed!.enabled).toBe(false);
  });

  it("does not update agent-origin skills from registry", async () => {
    const v2Record = { ...SKILL_RECORD, version: "2.0.0", contentHash: "def456" };
    const registry = createMockRegistry([v2Record]);

    await putInstalledSkill(storage, "test-skill", {
      name: "Agent Skill",
      description: "Created by agent",
      enabled: true,
      origin: "agent",
      requiresCapabilities: [],
    });

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill" }],
      capabilityIds: [],
    });

    const installed = await getInstalledSkill(storage, "test-skill");
    expect(installed!.origin).toBe("agent");
    expect(installed!.name).toBe("Agent Skill");
  });

  it("continues syncing other skills when one fails", async () => {
    const failingRegistry: SkillRegistry = {
      list: async () => [],
      get: async (id: string) => {
        if (id === "fail-skill") throw new Error("Registry error");
        return SKILL_RECORD;
      },
      getVersion: async () => null,
      upsert: async () => {},
      delete: async () => false,
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncSkills({
      storage,
      registry: failingRegistry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "fail-skill" }, { id: "test-skill" }],
      capabilityIds: [],
    });

    const failed = await getInstalledSkill(storage, "fail-skill");
    expect(failed).toBeUndefined();

    const succeeded = await getInstalledSkill(storage, "test-skill");
    expect(succeeded).toBeDefined();

    warnSpy.mockRestore();
  });

  it("defaults enabled to true when not specified", async () => {
    const registry = createMockRegistry([SKILL_RECORD]);

    await syncSkills({
      storage,
      registry,
      bucket,
      namespace: "ns",
      declarations: [{ id: "test-skill" }],
      capabilityIds: [],
    });

    const installed = await getInstalledSkill(storage, "test-skill");
    expect(installed!.enabled).toBe(true);
  });
});
