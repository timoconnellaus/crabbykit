import { createMockStorage } from "@crabbykit/agent-runtime/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createAfterToolExecutionHook } from "../dirty-tracking.js";
import { hashSkillContent, writeSkillToR2 } from "../r2.js";
import {
  getInstalledSkill,
  getSkillConflicts,
  putInstalledSkill,
  setSkillConflict,
} from "../storage.js";
import type { InstalledSkill } from "../types.js";

function createMockBucket(): R2Bucket & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
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
      if (Array.isArray(key)) for (const k of key) store.delete(k);
      else store.delete(key);
    },
    head: async () => null,
    list: async () =>
      ({ objects: [], truncated: false, delimitedPrefixes: [] }) as unknown as R2Objects,
    createMultipartUpload: async () => ({}) as R2MultipartUpload,
    resumeMultipartUpload: () => ({}) as R2MultipartUpload,
  } as R2Bucket & { _store: Map<string, string> };
}

describe("createAfterToolExecutionHook", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let bucket: ReturnType<typeof createMockBucket>;
  let cachedSkills: Map<string, InstalledSkill> | null;
  let hook: (
    event: { toolName: string; args: unknown; isError: boolean },
    ctx: { agentId: string; sessionId: string; storage: ReturnType<typeof createMockStorage> },
  ) => Promise<void>;

  const hookCtx = { agentId: "agent-1", sessionId: "session-1", storage: null as any };

  beforeEach(() => {
    storage = createMockStorage();
    bucket = createMockBucket();
    cachedSkills = null;
    hookCtx.storage = storage;

    hook = createAfterToolExecutionHook(
      { bucket: () => bucket, namespace: () => "ns" } as any,
      [{ id: "builtin-skill" }],
      () => cachedSkills,
      (cache) => {
        cachedSkills = cache;
      },
    );
  });

  it("ignores non-mutation tools", async () => {
    await hook(
      { toolName: "some_other_tool", args: { path: "skills/test/SKILL.md" }, isError: false },
      hookCtx,
    );
    // No error, nothing stored
    const installed = await getInstalledSkill(storage, "test");
    expect(installed).toBeUndefined();
  });

  it("ignores file_write on non-skill paths", async () => {
    await hook(
      { toolName: "file_write", args: { path: "some/other/path.md" }, isError: false },
      hookCtx,
    );
    const installed = await getInstalledSkill(storage, "test");
    expect(installed).toBeUndefined();
  });

  it("creates new agent-origin skill on file_write for unknown skill", async () => {
    const content = "---\nname: New Skill\ndescription: A new one\n---\n# Content";
    await writeSkillToR2(bucket, "ns", "new-skill", content);

    await hook(
      { toolName: "file_write", args: { path: "skills/new-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    const installed = await getInstalledSkill(storage, "new-skill");
    expect(installed).toBeDefined();
    expect(installed!.origin).toBe("agent");
    expect(installed!.name).toBe("New Skill");
    expect(installed!.description).toBe("A new one");
    expect(installed!.enabled).toBe(true);
  });

  it("marks registry-origin skill dirty when content differs from registryHash", async () => {
    const originalContent = "---\nname: Test\ndescription: Desc\n---\n# Original";
    const originalHash = await hashSkillContent(originalContent);

    await putInstalledSkill(storage, "reg-skill", {
      name: "Test",
      description: "Desc",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: originalHash,
      dirty: false,
      requiresCapabilities: [],
    });

    // Write modified content
    const modifiedContent = "---\nname: Test\ndescription: Desc\n---\n# Modified";
    await writeSkillToR2(bucket, "ns", "reg-skill", modifiedContent);

    await hook(
      { toolName: "file_write", args: { path: "skills/reg-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    const updated = await getInstalledSkill(storage, "reg-skill");
    expect(updated!.dirty).toBe(true);
  });

  it("keeps registry-origin skill clean when content matches registryHash", async () => {
    const content = "---\nname: Test\ndescription: Desc\n---\n# Original";
    const hash = await hashSkillContent(content);

    await putInstalledSkill(storage, "reg-skill", {
      name: "Test",
      description: "Desc",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: hash,
      dirty: false,
      requiresCapabilities: [],
    });

    // Write same content back
    await writeSkillToR2(bucket, "ns", "reg-skill", content);

    await hook(
      { toolName: "file_write", args: { path: "skills/reg-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    const updated = await getInstalledSkill(storage, "reg-skill");
    expect(updated!.dirty).toBe(false);
  });

  it("resolves conflict on file_write when conflict exists", async () => {
    await putInstalledSkill(storage, "conflict-skill", {
      name: "Conflict",
      description: "Desc",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: "old-hash",
      dirty: true,
      requiresCapabilities: [],
    });

    await setSkillConflict(storage, {
      skillId: "conflict-skill",
      upstreamContent: "new upstream content",
      upstreamVersion: "2.0.0",
      upstreamHash: "new-hash",
    });

    const mergedContent = "---\nname: Merged\ndescription: Merged desc\n---\n# Merged";
    await writeSkillToR2(bucket, "ns", "conflict-skill", mergedContent);

    await hook(
      { toolName: "file_write", args: { path: "skills/conflict-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    // Conflict should be cleared
    const conflicts = await getSkillConflicts(storage);
    expect(conflicts.size).toBe(0);

    // Version/hash should be updated
    const updated = await getInstalledSkill(storage, "conflict-skill");
    expect(updated!.registryVersion).toBe("2.0.0");
    expect(updated!.registryHash).toBe("new-hash");
    expect(updated!.dirty).toBe(false);
  });

  it("disables registry-origin skill on file_delete", async () => {
    await putInstalledSkill(storage, "del-skill", {
      name: "Delete Me",
      description: "Desc",
      enabled: true,
      origin: "registry",
      registryVersion: "1.0.0",
      registryHash: "hash",
      requiresCapabilities: [],
    });

    await hook(
      { toolName: "file_delete", args: { path: "skills/del-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    const updated = await getInstalledSkill(storage, "del-skill");
    expect(updated).toBeDefined();
    expect(updated!.enabled).toBe(false);
  });

  it("removes agent-origin skill on file_delete", async () => {
    await putInstalledSkill(storage, "agent-del", {
      name: "Agent Skill",
      description: "Desc",
      enabled: true,
      origin: "agent",
      requiresCapabilities: [],
    });

    await hook(
      { toolName: "file_delete", args: { path: "skills/agent-del/SKILL.md" }, isError: false },
      hookCtx,
    );

    const deleted = await getInstalledSkill(storage, "agent-del");
    expect(deleted).toBeUndefined();
  });

  it("handles file_edit same as file_write", async () => {
    const content = "---\nname: Edited\ndescription: Edited desc\n---\n# Edited";
    await writeSkillToR2(bucket, "ns", "edit-skill", content);

    await hook(
      { toolName: "file_edit", args: { path: "skills/edit-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    const installed = await getInstalledSkill(storage, "edit-skill");
    expect(installed).toBeDefined();
    expect(installed!.origin).toBe("agent");
    expect(installed!.name).toBe("Edited");
  });

  it("updates cache after processing", async () => {
    const content = "---\nname: Cache Test\ndescription: Test\n---\n# Test";
    await writeSkillToR2(bucket, "ns", "cache-test", content);

    expect(cachedSkills).toBeNull();

    await hook(
      { toolName: "file_write", args: { path: "skills/cache-test/SKILL.md" }, isError: false },
      hookCtx,
    );

    expect(cachedSkills).not.toBeNull();
    expect(cachedSkills!.size).toBe(1);
  });

  it("ignores events with no path arg", async () => {
    await hook({ toolName: "file_write", args: {}, isError: false }, hookCtx);
    // Should not throw, nothing to process
  });

  it("ignores events with non-string path", async () => {
    await hook({ toolName: "file_write", args: { path: 42 }, isError: false }, hookCtx);
    // Should not throw
  });

  it("updates agent-origin skill metadata on write", async () => {
    await putInstalledSkill(storage, "agent-skill", {
      name: "Old Name",
      description: "Old desc",
      enabled: true,
      origin: "agent",
      requiresCapabilities: [],
    });

    const content =
      "---\nname: New Name\ndescription: New desc\nrequiresCapabilities: [sandbox]\n---\n# Updated";
    await writeSkillToR2(bucket, "ns", "agent-skill", content);

    await hook(
      { toolName: "file_write", args: { path: "skills/agent-skill/SKILL.md" }, isError: false },
      hookCtx,
    );

    const updated = await getInstalledSkill(storage, "agent-skill");
    expect(updated!.name).toBe("New Name");
    expect(updated!.description).toBe("New desc");
    expect(updated!.requiresCapabilities).toEqual(["sandbox"]);
  });
});
