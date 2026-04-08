import { describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { AgentContext, CapabilityHookContext } from "@claw-for-cloudflare/agent-runtime";
import { AppStore } from "../app-store.js";
import { appRegistry } from "../capability.js";
import { createMockSqlStore } from "./mock-sql-store.js";

function createTestOptions() {
  const provider: SandboxProvider = {
    start: vi.fn(),
    stop: vi.fn(),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  };

  const storage = {
    namespace: () => "test-ns",
    bucket: () => "test-bucket",
  } as unknown as AgentStorage;

  return { provider, sql: createMockSqlStore(), storage };
}

describe("appRegistry capability", () => {
  it("has correct id and metadata", () => {
    const cap = appRegistry(createTestOptions());

    expect(cap.id).toBe("app-registry");
    expect(cap.name).toBe("App Registry");
    expect(cap.description).toBeDefined();
  });

  it("returns five tools", () => {
    const cap = appRegistry(createTestOptions());
    const context = {
      agentId: "agent-1",
      sessionId: "session-1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: vi.fn(),
      broadcastToAll: vi.fn(),
      broadcastState: vi.fn(),
      requestFromClient: vi.fn(),
      schedules: {} as any,
    } as unknown as AgentContext;

    const tools = cap.tools!(context);

    expect(tools).toHaveLength(5);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("deploy_app");
    expect(names).toContain("list_apps");
    expect(names).toContain("get_app_history");
    expect(names).toContain("rollback_app");
    expect(names).toContain("delete_app");
  });

  it("returns prompt sections", () => {
    const cap = appRegistry(createTestOptions());
    const context = {
      agentId: "agent-1",
      sessionId: "session-1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: vi.fn(),
      broadcastToAll: vi.fn(),
      broadcastState: vi.fn(),
      requestFromClient: vi.fn(),
      schedules: {} as any,
    } as unknown as AgentContext;
    const sections = cap.promptSections!(context);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("deploy_app");
    expect(sections[0]).toContain("/apps/");
  });

  it("onConnect hook broadcasts app_list with empty apps", async () => {
    const cap = appRegistry(createTestOptions());
    const broadcastFn = vi.fn();

    const ctx: CapabilityHookContext = {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionStore: {} as any,
      storage: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      },
      broadcast: broadcastFn,
      capabilityIds: [],
    };

    await cap.hooks!.onConnect!(ctx);

    expect(broadcastFn).toHaveBeenCalledWith("app_list", {
      apps: [],
    });
  });

  it("onConnect broadcasts app_list with registered apps including version info", async () => {
    const options = createTestOptions();
    // Directly create apps in the same SQL store the capability will use
    const store = new AppStore(options.sql);
    const app = store.create("Test App", "test-app");
    store.addVersion(app.id, {
      deployId: "d1",
      commitHash: "abc1234567890",
      message: "Initial deploy",
      files: ["index.html"],
      hasBackend: false,
    });

    const cap = appRegistry(options);
    const broadcastFn = vi.fn();

    const ctx: CapabilityHookContext = {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionStore: {} as any,
      storage: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      },
      broadcast: broadcastFn,
      capabilityIds: [],
    };

    await cap.hooks!.onConnect!(ctx);
    expect(broadcastFn).toHaveBeenCalledWith("app_list", {
      apps: [
        expect.objectContaining({
          name: "Test App",
          slug: "test-app",
          currentVersion: 1,
          commitHash: "abc1234567890",
          commitMessage: "Initial deploy",
        }),
      ],
    });
  });

  it("onConnect broadcasts app with no version (null coalescing)", async () => {
    const options = createTestOptions();
    const store = new AppStore(options.sql);
    store.create("No Version App", "no-version");

    const cap = appRegistry(options);
    const broadcastFn = vi.fn();

    const ctx: CapabilityHookContext = {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionStore: {} as any,
      storage: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      },
      broadcast: broadcastFn,
      capabilityIds: [],
    };

    await cap.hooks!.onConnect!(ctx);
    expect(broadcastFn).toHaveBeenCalledWith("app_list", {
      apps: [
        expect.objectContaining({
          name: "No Version App",
          slug: "no-version",
          currentVersion: 0,
          commitHash: "",
          commitMessage: null,
        }),
      ],
    });
  });

  it("broadcastList is called by tools via broadcastToAll on delete", async () => {
    const options = createTestOptions();
    // Pre-populate an app
    const store = new AppStore(options.sql);
    const app = store.create("Delete Me", "delete-me");

    const cap = appRegistry(options);
    const broadcastToAll = vi.fn();

    const context = {
      agentId: "agent-1",
      sessionId: "session-1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: vi.fn(),
      broadcastToAll,
      broadcastState: vi.fn(),
      requestFromClient: vi.fn(),
      schedules: {} as any,
    } as unknown as AgentContext;

    const tools = cap.tools!(context);
    const deleteTool = tools.find((t: any) => t.name === "delete_app");

    // Execute delete — this triggers broadcastList which calls broadcastToAll
    await deleteTool.execute({ slug: "delete-me" }, { toolCallId: "test" });

    expect(broadcastToAll).toHaveBeenCalledWith("app_list", expect.objectContaining({ apps: [] }));
  });
});
