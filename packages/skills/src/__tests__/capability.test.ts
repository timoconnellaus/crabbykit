import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStorage, textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { SkillRecord, SkillRegistry } from "@claw-for-cloudflare/skill-registry";
import { skills } from "../capability.js";
import type { SkillsOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Mock R2 bucket
// ---------------------------------------------------------------------------

function createMockR2Bucket(): R2Bucket & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return { text: async () => value } as unknown as R2ObjectBody;
    },
    put: async (key: string, value: string | ReadableStream | ArrayBuffer | null) => {
      if (typeof value === "string") store.set(key, value);
      return {} as R2Object;
    },
    delete: async (keys: string | string[]) => {
      if (Array.isArray(keys)) {
        for (const k of keys) store.delete(k);
      } else {
        store.delete(keys);
      }
    },
    head: async () => null,
    list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }) as unknown as R2Objects,
    createMultipartUpload: () => { throw new Error("Not implemented"); },
    resumeMultipartUpload: () => { throw new Error("Not implemented"); },
  } as unknown as R2Bucket & { _store: Map<string, string> };
}

// ---------------------------------------------------------------------------
// Mock registry
// ---------------------------------------------------------------------------

function createMockRegistry(records: SkillRecord[]): SkillRegistry {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    list: async () => [...map.values()],
    get: async (id) => map.get(id) ?? null,
    getVersion: async (id) => {
      const r = map.get(id);
      return r ? { version: r.version, contentHash: r.contentHash } : null;
    },
    upsert: async () => {},
    delete: async () => false,
  };
}

const SAMPLE_SKILL_MD = `---
name: code-review
description: Reviews code changes
---

# Code Review

Review code changes for bugs and style issues.
`;

const SAMPLE_RECORD: SkillRecord = {
  id: "code-review",
  name: "Code Review",
  description: "Reviews code changes for bugs, security, and style",
  version: "1.0.0",
  contentHash: "abc123",
  requiresCapabilities: [],
  skillMd: SAMPLE_SKILL_MD,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bucket: R2Bucket & { _store: Map<string, string> };
let registry: SkillRegistry;
let capStorage: CapabilityStorage;

function createOptions(overrides?: Partial<SkillsOptions>): SkillsOptions {
  return {
    storage: {
      bucket: () => bucket,
      namespace: () => "test-agent",
    },
    registry,
    skills: [{ id: "code-review", enabled: true, autoUpdate: true }],
    ...overrides,
  };
}

function mockContext(storage?: CapabilityStorage) {
  return {
    agentId: "test-agent",
    sessionId: "s1",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    schedules: {} as any,
    storage: storage ?? capStorage,
  };
}

beforeEach(() => {
  bucket = createMockR2Bucket();
  registry = createMockRegistry([SAMPLE_RECORD]);
  capStorage = createMockStorage();
});

// ---------------------------------------------------------------------------
// Capability shape
// ---------------------------------------------------------------------------

describe("skills capability", () => {
  it("returns a valid Capability with correct shape", () => {
    const cap = skills(createOptions());
    expect(cap.id).toBe("skills");
    expect(cap.name).toBe("Skills");
    expect(cap.tools).toBeInstanceOf(Function);
    expect(cap.promptSections).toBeInstanceOf(Function);
    expect(cap.hooks).toBeDefined();
    expect(cap.hooks!.onConnect).toBeInstanceOf(Function);
    expect(cap.hooks!.beforeInference).toBeInstanceOf(Function);
    expect(cap.hooks!.afterToolExecution).toBeInstanceOf(Function);
    expect(cap.hooks!.onConfigChange).toBeInstanceOf(Function);
    expect(cap.configNamespaces).toBeInstanceOf(Function);
  });

  it("provides one tool: skill_load", () => {
    const cap = skills(createOptions());
    const tools = cap.tools!(mockContext());
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("skill_load");
  });
});

// ---------------------------------------------------------------------------
// promptSections
// ---------------------------------------------------------------------------

describe("promptSections", () => {
  it("returns empty array when no skills are cached", () => {
    const cap = skills(createOptions());
    const sections = cap.promptSections!(mockContext());
    expect(sections).toEqual([]);
  });

  it("lists enabled skills after onConnect sync", async () => {
    const cap = skills(createOptions());
    const ctx = mockContext();

    // Run onConnect to populate cache
    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    const sections = cap.promptSections!(ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("code-review");
    expect(sections[0]).toContain("Reviews code changes");
    expect(sections[0]).toContain("skill_load");
  });

  it("excludes disabled skills", async () => {
    const cap = skills(createOptions({
      skills: [{ id: "code-review", enabled: false }],
    }));

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    const sections = cap.promptSections!(mockContext());
    expect(sections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// skill_load tool
// ---------------------------------------------------------------------------

describe("skill_load tool", () => {
  it("loads an enabled skill from R2 and strips frontmatter", async () => {
    const cap = skills(createOptions());

    // Sync to populate cache and write to R2
    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    const tools = cap.tools!(mockContext());
    const loadTool = tools[0];

    const result = await loadTool.execute(
      { name: "code-review" },
      { toolCallId: "test" },
    );

    const text = textOf(result);
    expect(text).toContain("# Code Review");
    expect(text).not.toContain("---");
    expect(text).not.toContain("name: code-review");
  });

  it("returns error for non-existent skill", async () => {
    const cap = skills(createOptions());

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    const tools = cap.tools!(mockContext());
    const result = await tools[0].execute(
      { name: "nonexistent" },
      { toolCallId: "test" },
    );

    expect(textOf(result)).toContain("not found");
  });

  it("returns error for disabled skill", async () => {
    const cap = skills(createOptions({
      skills: [{ id: "code-review", enabled: false }],
    }));

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    const tools = cap.tools!(mockContext());
    const result = await tools[0].execute(
      { name: "code-review" },
      { toolCallId: "test" },
    );

    expect(textOf(result)).toContain("not enabled");
  });
});

// ---------------------------------------------------------------------------
// onConnect sync
// ---------------------------------------------------------------------------

describe("onConnect sync", () => {
  it("fetches skills from registry and writes to R2", async () => {
    const cap = skills(createOptions());

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    // Check R2 has the skill
    expect(bucket._store.has("test-agent/skills/code-review/SKILL.md")).toBe(true);

    // Check DO state
    const installed = await capStorage.get("installed:code-review");
    expect(installed).toBeDefined();
  });

  it("handles registry failure gracefully", async () => {
    const failingRegistry: SkillRegistry = {
      list: async () => { throw new Error("D1 is down"); },
      get: async () => { throw new Error("D1 is down"); },
      getVersion: async () => { throw new Error("D1 is down"); },
      upsert: async () => { throw new Error("D1 is down"); },
      delete: async () => { throw new Error("D1 is down"); },
    };

    const cap = skills(createOptions({ registry: failingRegistry }));

    // Should not throw
    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });
  });

  it("skips skills with missing required capabilities", async () => {
    const recordWithCaps: SkillRecord = {
      ...SAMPLE_RECORD,
      id: "vibe-webapp",
      requiresCapabilities: ["vibe-coder", "sandbox"],
    };

    const cap = skills(createOptions({
      registry: createMockRegistry([SAMPLE_RECORD, recordWithCaps]),
      skills: [
        { id: "code-review", enabled: true },
        { id: "vibe-webapp", enabled: true },
      ],
    }));

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });

    // vibe-webapp should be disabled because capabilityIds is empty
    const vibeSkill = await capStorage.get<any>("installed:vibe-webapp");
    expect(vibeSkill?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// beforeInference merge injection
// ---------------------------------------------------------------------------

describe("beforeInference", () => {
  it("passes messages through when no pending merges", async () => {
    const cap = skills(createOptions());
    const messages = [{ role: "user", content: "hello", timestamp: Date.now() }];

    const result = await cap.hooks!.beforeInference!(messages as any, {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
    });

    expect(result).toHaveLength(1);
    expect((result[0] as any).content).toBe("hello");
  });

  it("injects merge instructions when pending merges exist", async () => {
    const cap = skills(createOptions());

    // Manually set a pending merge
    await capStorage.put("merge:code-review", {
      skillId: "code-review",
      newContent: "# Updated\nNew instructions",
      newVersion: "1.1.0",
      newHash: "newhash",
    });

    const messages = [{ role: "user", content: "hello", timestamp: Date.now() }];

    const result = await cap.hooks!.beforeInference!(messages as any, {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
    });

    // Should have the merge instruction prepended + the original message
    expect(result.length).toBeGreaterThan(1);
    const injected = result[0] as any;
    expect(injected.content).toContain("SKILL UPDATE");
    expect(injected.content).toContain("code-review");
    expect(injected.metadata?.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

describe("storage helpers", () => {
  it("round-trips installed skill through storage", async () => {
    const { putInstalledSkill, getInstalledSkill, listInstalledSkills, deleteInstalledSkill } =
      await import("../storage.js");

    const skill = {
      name: "Test",
      description: "Test skill",
      version: "1.0.0",
      enabled: true,
      autoUpdate: true,
      stale: false,
      originalHash: "abc",
      requiresCapabilities: [],
    };

    await putInstalledSkill(capStorage, "test-skill", skill);
    const retrieved = await getInstalledSkill(capStorage, "test-skill");
    expect(retrieved).toMatchObject(skill);

    const all = await listInstalledSkills(capStorage);
    expect(all.size).toBe(1);

    await deleteInstalledSkill(capStorage, "test-skill");
    const afterDelete = await getInstalledSkill(capStorage, "test-skill");
    expect(afterDelete).toBeUndefined();
  });

  it("round-trips pending merge through storage", async () => {
    const { setPendingMerge, getPendingMerges, clearPendingMerge } =
      await import("../storage.js");

    await setPendingMerge(capStorage, {
      skillId: "test",
      newContent: "# New",
      newVersion: "2.0.0",
      newHash: "xyz",
    });

    const merges = await getPendingMerges(capStorage);
    expect(merges.size).toBe(1);

    await clearPendingMerge(capStorage, "test");
    const afterClear = await getPendingMerges(capStorage);
    expect(afterClear.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R2 helpers
// ---------------------------------------------------------------------------

describe("R2 helpers", () => {
  it("writes and reads skill content", async () => {
    const { writeSkillToR2, readSkillFromR2, deleteSkillFromR2 } = await import("../r2.js");

    await writeSkillToR2(bucket, "ns", "my-skill", "# Skill Content");
    const content = await readSkillFromR2(bucket, "ns", "my-skill");
    expect(content).toBe("# Skill Content");

    await deleteSkillFromR2(bucket, "ns", "my-skill");
    const afterDelete = await readSkillFromR2(bucket, "ns", "my-skill");
    expect(afterDelete).toBeNull();
  });

  it("computes consistent hashes", async () => {
    const { hashSkillContent } = await import("../r2.js");

    const hash1 = await hashSkillContent("hello");
    const hash2 = await hashSkillContent("hello");
    const hash3 = await hashSkillContent("world");

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts skill ID from R2 path", async () => {
    const { skillIdFromR2Path } = await import("../r2.js");

    expect(skillIdFromR2Path("skills/code-review/SKILL.md")).toBe("code-review");
    expect(skillIdFromR2Path("skills/my-tool/SKILL.md")).toBe("my-tool");
    expect(skillIdFromR2Path("other/path/file.md")).toBeNull();
    expect(skillIdFromR2Path("skills/nested/deep/SKILL.md")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP handlers — install / uninstall / registry browse
// ---------------------------------------------------------------------------

describe("httpHandlers", () => {
  const EXTRA_RECORD: SkillRecord = {
    ...SAMPLE_RECORD,
    id: "debug-helper",
    name: "Debug Helper",
    description: "Helps debug issues systematically",
  };

  function mockHttpContext(storage?: CapabilityStorage) {
    return {
      sessionStore: {} as any,
      storage: storage ?? capStorage,
      broadcastToAll: () => {},
      sendPrompt: async () => ({ sessionId: "s1", response: "" }),
    };
  }

  async function syncCap(cap: ReturnType<typeof skills>) {
    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      broadcast: () => {},
    });
  }

  describe("GET /skills/registry", () => {
    it("lists registry skills not already installed", async () => {
      const cap = skills(createOptions({
        registry: createMockRegistry([SAMPLE_RECORD, EXTRA_RECORD]),
        skills: [{ id: "code-review", enabled: true }],
      }));
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const registryHandler = handlers.find((h) => h.path === "/skills/registry");
      expect(registryHandler).toBeDefined();

      const response = await registryHandler!.handler(
        new Request("http://test/skills/registry"),
        mockHttpContext(),
      );
      const body = await response.json() as Array<{ id: string }>;
      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("debug-helper");
    });

    it("returns empty array when all registry skills are installed", async () => {
      const cap = skills(createOptions({
        registry: createMockRegistry([SAMPLE_RECORD]),
        skills: [{ id: "code-review", enabled: true }],
      }));
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const registryHandler = handlers.find((h) => h.path === "/skills/registry")!;
      const response = await registryHandler.handler(
        new Request("http://test/skills/registry"),
        mockHttpContext(),
      );
      const body = await response.json() as Array<unknown>;
      expect(body).toHaveLength(0);
    });
  });

  describe("POST /skills/install", () => {
    it("installs a skill from the registry", async () => {
      const cap = skills(createOptions({
        registry: createMockRegistry([SAMPLE_RECORD, EXTRA_RECORD]),
        skills: [{ id: "code-review", enabled: true }],
      }));
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const installHandler = handlers.find((h) => h.path === "/skills/install")!;

      const response = await installHandler.handler(
        new Request("http://test/skills/install", {
          method: "POST",
          body: JSON.stringify({ id: "debug-helper" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      const body = await response.json() as { ok: boolean; skill: { id: string } };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);

      // Verify it's in storage
      const installed = await capStorage.get<any>("installed:debug-helper");
      expect(installed).toBeDefined();
      expect(installed.builtIn).toBe(false);
      expect(installed.enabled).toBe(true);

      // Verify R2 has content
      expect(bucket._store.has("test-agent/skills/debug-helper/SKILL.md")).toBe(true);
    });

    it("rejects installing already-installed skill", async () => {
      const cap = skills(createOptions());
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const installHandler = handlers.find((h) => h.path === "/skills/install")!;

      const response = await installHandler.handler(
        new Request("http://test/skills/install", {
          method: "POST",
          body: JSON.stringify({ id: "code-review" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      expect(response.status).toBe(409);
    });

    it("rejects installing skill not in registry", async () => {
      const cap = skills(createOptions());
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const installHandler = handlers.find((h) => h.path === "/skills/install")!;

      const response = await installHandler.handler(
        new Request("http://test/skills/install", {
          method: "POST",
          body: JSON.stringify({ id: "nonexistent" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      expect(response.status).toBe(404);
    });

    it("rejects missing skill id", async () => {
      const cap = skills(createOptions());
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const installHandler = handlers.find((h) => h.path === "/skills/install")!;

      const response = await installHandler.handler(
        new Request("http://test/skills/install", {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("POST /skills/uninstall", () => {
    it("uninstalls a runtime-added skill", async () => {
      const cap = skills(createOptions({
        registry: createMockRegistry([SAMPLE_RECORD, EXTRA_RECORD]),
        skills: [{ id: "code-review", enabled: true }],
      }));
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const installHandler = handlers.find((h) => h.path === "/skills/install")!;
      const uninstallHandler = handlers.find((h) => h.path === "/skills/uninstall")!;

      // First install
      await installHandler.handler(
        new Request("http://test/skills/install", {
          method: "POST",
          body: JSON.stringify({ id: "debug-helper" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );

      // Then uninstall
      const response = await uninstallHandler.handler(
        new Request("http://test/skills/uninstall", {
          method: "POST",
          body: JSON.stringify({ id: "debug-helper" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      const body = await response.json() as { ok: boolean };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);

      // Verify removed from storage
      const installed = await capStorage.get("installed:debug-helper");
      expect(installed).toBeUndefined();

      // Verify removed from R2
      expect(bucket._store.has("test-agent/skills/debug-helper/SKILL.md")).toBe(false);
    });

    it("rejects uninstalling built-in skill", async () => {
      const cap = skills(createOptions());
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const uninstallHandler = handlers.find((h) => h.path === "/skills/uninstall")!;

      const response = await uninstallHandler.handler(
        new Request("http://test/skills/uninstall", {
          method: "POST",
          body: JSON.stringify({ id: "code-review" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      expect(response.status).toBe(403);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("built-in");
    });

    it("rejects uninstalling non-installed skill", async () => {
      const cap = skills(createOptions());
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const uninstallHandler = handlers.find((h) => h.path === "/skills/uninstall")!;

      const response = await uninstallHandler.handler(
        new Request("http://test/skills/uninstall", {
          method: "POST",
          body: JSON.stringify({ id: "nonexistent" }),
          headers: { "content-type": "application/json" },
        }),
        mockHttpContext(),
      );
      expect(response.status).toBe(404);
    });
  });
});
