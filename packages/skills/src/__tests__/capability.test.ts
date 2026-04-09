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
    list: async () =>
      ({ objects: [], delimitedPrefixes: [], truncated: false }) as unknown as R2Objects,
    createMultipartUpload: () => {
      throw new Error("Not implemented");
    },
    resumeMultipartUpload: () => {
      throw new Error("Not implemented");
    },
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
    skills: [{ id: "code-review", enabled: true }],
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
    broadcastState: () => {},
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
  it("returns an excluded section with reason when no skills are cached", () => {
    const cap = skills(createOptions());
    const sections = cap.promptSections!(mockContext());
    expect(sections).toEqual([
      {
        kind: "excluded",
        reason: "Skills not yet loaded (waiting for onConnect sync to populate the cache)",
      },
    ]);
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
      capabilityIds: [],
      broadcast: () => {},
    });

    const sections = cap.promptSections!(ctx);
    expect(sections).toHaveLength(1);
    const first = sections[0];
    const content = typeof first === "string" ? first : "content" in first ? first.content : "";
    expect(content).toContain("code-review");
    expect(content).toContain("Reviews code changes");
    expect(content).toContain("skill_load");
  });

  it("returns an excluded section with reason when no skills are enabled", async () => {
    const cap = skills(
      createOptions({
        skills: [{ id: "code-review", enabled: false }],
      }),
    );

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });

    const sections = cap.promptSections!(mockContext());
    expect(sections).toEqual([{ kind: "excluded", reason: "No skills enabled in the registry" }]);
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
      capabilityIds: [],
      broadcast: () => {},
    });

    const tools = cap.tools!(mockContext());
    const loadTool = tools[0];

    const result = await loadTool.execute({ name: "code-review" }, { toolCallId: "test" });

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
      capabilityIds: [],
      broadcast: () => {},
    });

    const tools = cap.tools!(mockContext());
    const result = await tools[0].execute({ name: "nonexistent" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("not found");
  });

  it("returns error for disabled skill", async () => {
    const cap = skills(
      createOptions({
        skills: [{ id: "code-review", enabled: false }],
      }),
    );

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });

    const tools = cap.tools!(mockContext());
    const result = await tools[0].execute({ name: "code-review" }, { toolCallId: "test" });

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
      capabilityIds: [],
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
      list: async () => {
        throw new Error("D1 is down");
      },
      get: async () => {
        throw new Error("D1 is down");
      },
      getVersion: async () => {
        throw new Error("D1 is down");
      },
      upsert: async () => {
        throw new Error("D1 is down");
      },
      delete: async () => {
        throw new Error("D1 is down");
      },
    };

    const cap = skills(createOptions({ registry: failingRegistry }));

    // Should not throw
    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });
  });

  it("skips skills with missing required capabilities", async () => {
    const recordWithCaps: SkillRecord = {
      ...SAMPLE_RECORD,
      id: "vibe-webapp",
      requiresCapabilities: ["vibe-coder", "sandbox"],
    };

    const cap = skills(
      createOptions({
        registry: createMockRegistry([SAMPLE_RECORD, recordWithCaps]),
        skills: [
          { id: "code-review", enabled: true },
          { id: "vibe-webapp", enabled: true },
        ],
      }),
    );

    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });

    // vibe-webapp should be disabled because capabilityIds is empty
    const vibeSkill = await capStorage.get<any>("installed:vibe-webapp");
    expect(vibeSkill?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// beforeInference conflict injection
// ---------------------------------------------------------------------------

describe("beforeInference", () => {
  it("passes messages through when no conflicts", async () => {
    const cap = skills(createOptions());
    const messages = [{ role: "user", content: "hello", timestamp: Date.now() }];

    const result = await cap.hooks!.beforeInference!(messages as any, {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
    });

    expect(result).toHaveLength(1);
    expect((result[0] as any).content).toBe("hello");
  });

  it("injects merge instructions when pending conflicts exist", async () => {
    const cap = skills(createOptions());

    // Store a conflict using the new prefix
    await capStorage.put("conflict:code-review", {
      skillId: "code-review",
      upstreamContent: "# Updated\nNew instructions",
      upstreamVersion: "1.1.0",
      upstreamHash: "newhash",
    });

    const messages = [{ role: "user", content: "hello", timestamp: Date.now() }];

    const result = await cap.hooks!.beforeInference!(messages as any, {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
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
      enabled: true,
      origin: "registry" as const,
      registryVersion: "1.0.0",
      registryHash: "abc",
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

  it("round-trips skill conflict through storage", async () => {
    const { setSkillConflict, getSkillConflicts, clearSkillConflict } = await import(
      "../storage.js"
    );

    await setSkillConflict(capStorage, {
      skillId: "test",
      upstreamContent: "# New",
      upstreamVersion: "2.0.0",
      upstreamHash: "xyz",
    });

    const conflicts = await getSkillConflicts(capStorage);
    expect(conflicts.size).toBe(1);

    await clearSkillConflict(capStorage, "test");
    const afterClear = await getSkillConflicts(capStorage);
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
      broadcastState: () => {},
      sendPrompt: async () => ({ sessionId: "s1", response: "" }),
    };
  }

  async function syncCap(cap: ReturnType<typeof skills>) {
    await cap.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });
  }

  describe("GET /skills/registry", () => {
    it("lists registry skills not already installed", async () => {
      const cap = skills(
        createOptions({
          registry: createMockRegistry([SAMPLE_RECORD, EXTRA_RECORD]),
          skills: [{ id: "code-review", enabled: true }],
        }),
      );
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const registryHandler = handlers.find((h) => h.path === "/skills/registry");
      expect(registryHandler).toBeDefined();

      const response = await registryHandler!.handler(
        new Request("http://test/skills/registry"),
        mockHttpContext(),
      );
      const body = (await response.json()) as Array<{ id: string }>;
      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("debug-helper");
    });

    it("returns empty array when all registry skills are installed", async () => {
      const cap = skills(
        createOptions({
          registry: createMockRegistry([SAMPLE_RECORD]),
          skills: [{ id: "code-review", enabled: true }],
        }),
      );
      await syncCap(cap);

      const handlers = cap.httpHandlers!(mockContext());
      const registryHandler = handlers.find((h) => h.path === "/skills/registry")!;
      const response = await registryHandler.handler(
        new Request("http://test/skills/registry"),
        mockHttpContext(),
      );
      const body = (await response.json()) as Array<unknown>;
      expect(body).toHaveLength(0);
    });
  });

  describe("POST /skills/install", () => {
    it("installs a skill from the registry with origin registry", async () => {
      const cap = skills(
        createOptions({
          registry: createMockRegistry([SAMPLE_RECORD, EXTRA_RECORD]),
          skills: [{ id: "code-review", enabled: true }],
        }),
      );
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
      const body = (await response.json()) as {
        ok: boolean;
        skill: { id: string; origin: string };
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.skill.origin).toBe("registry");

      // Verify it's in storage
      const installed = await capStorage.get<any>("installed:debug-helper");
      expect(installed).toBeDefined();
      expect(installed.origin).toBe("registry");
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
      const cap = skills(
        createOptions({
          registry: createMockRegistry([SAMPLE_RECORD, EXTRA_RECORD]),
          skills: [{ id: "code-review", enabled: true }],
        }),
      );
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
      const body = (await response.json()) as { ok: boolean };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);

      // Verify removed from storage
      const installed = await capStorage.get("installed:debug-helper");
      expect(installed).toBeUndefined();

      // Verify removed from R2
      expect(bucket._store.has("test-agent/skills/debug-helper/SKILL.md")).toBe(false);
    });

    it("rejects uninstalling built-in skill (checked via declarations)", async () => {
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
      const body = (await response.json()) as { error: string };
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

// ---------------------------------------------------------------------------
// Seed version bump -> sync update flow
// ---------------------------------------------------------------------------

describe("seed version bump updates installed skill", () => {
  const V1_SKILL_MD = `---
name: vibe-webapp
description: Build web apps v1
---

# Vibe Webapp v1

Old instructions here.
`;

  const V2_SKILL_MD = `---
name: vibe-webapp
description: Build web apps v2
---

# Vibe Webapp v2

IMPORTANT: container-db is pre-installed. Do NOT add to package.json.
`;

  /** Compute SHA-256 hex hash matching the real hashSkillContent / computeHash */
  async function sha256(content: string): Promise<string> {
    const encoded = new TextEncoder().encode(content);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    const bytes = new Uint8Array(buffer);
    let hex = "";
    for (const b of bytes) {
      hex += b.toString(16).padStart(2, "0");
    }
    return hex;
  }

  it("updates R2 content when registry version bumps (clean skill)", async () => {
    const v1Hash = await sha256(V1_SKILL_MD);

    const v1Record: SkillRecord = {
      id: "vibe-webapp",
      name: "Vibe Webapp",
      description: "Build web apps v1",
      version: "1.0.0",
      contentHash: v1Hash,
      requiresCapabilities: [],
      skillMd: V1_SKILL_MD,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    // First sync with v1.0.0
    const v1Registry = createMockRegistry([v1Record]);
    const cap1 = skills(
      createOptions({
        registry: v1Registry,
        skills: [{ id: "vibe-webapp", enabled: true }],
      }),
    );

    await cap1.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });

    // Verify v1 content in R2
    const v1Content = bucket._store.get("test-agent/skills/vibe-webapp/SKILL.md");
    expect(v1Content).toContain("Old instructions here");

    // Verify skill_load returns v1 content
    const tools1 = cap1.tools!(mockContext());
    const result1 = await tools1[0].execute({ name: "vibe-webapp" }, { toolCallId: "t1" });
    expect(textOf(result1)).toContain("Old instructions here");

    // Now simulate app restart with updated seed (v1.1.0)
    const v2Hash = await sha256(V2_SKILL_MD);
    const v2Record: SkillRecord = {
      ...v1Record,
      description: "Build web apps v2",
      version: "1.1.0",
      contentHash: v2Hash,
      skillMd: V2_SKILL_MD,
      updatedAt: "2026-02-01T00:00:00Z",
    };

    // New capability instance (simulates app restart) with same storage + bucket
    const v2Registry = createMockRegistry([v2Record]);
    const cap2 = skills(
      createOptions({
        registry: v2Registry,
        skills: [{ id: "vibe-webapp", enabled: true }],
      }),
    );

    // Re-sync (simulates new client connecting after restart)
    await cap2.hooks!.onConnect!({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: capStorage,
      capabilityIds: [],
      broadcast: () => {},
    });

    // Verify R2 now has v2 content
    const v2Content = bucket._store.get("test-agent/skills/vibe-webapp/SKILL.md");
    expect(v2Content).toContain("container-db is pre-installed");
    expect(v2Content).not.toContain("Old instructions here");

    // Verify skill_load returns v2 content
    const tools2 = cap2.tools!(mockContext());
    const result2 = await tools2[0].execute({ name: "vibe-webapp" }, { toolCallId: "t2" });
    expect(textOf(result2)).toContain("container-db is pre-installed");
  });
});
