import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxExecResult, SandboxProvider } from "@claw-for-cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";
import { AppStore } from "../app-store.js";
import { createDeleteAppTool } from "../tools/delete-app.js";
import { createGetAppHistoryTool } from "../tools/get-app-history.js";
import { createListAppsTool } from "../tools/list-apps.js";
import { createRollbackAppTool } from "../tools/rollback-app.js";
import { createMockSqlStore } from "./mock-sql-store.js";

function textOf(result: any): string {
  return result.content[0].text;
}

function createTestContext(): {
  appStore: AppStore;
  provider: SandboxProvider;
  context: AgentContext;
  broadcastAppList: ReturnType<typeof vi.fn>;
} {
  const appStore = new AppStore(createMockSqlStore());
  const execResults: Map<string, SandboxExecResult> = new Map();

  const provider: SandboxProvider = {
    start: vi.fn(),
    stop: vi.fn(),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn(async (cmd: string) => {
      // Check for registered results
      for (const [pattern, result] of execResults) {
        if (cmd.includes(pattern)) return result;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
  };

  const broadcastFn = vi.fn();
  const context = {
    agentId: "test-agent",
    sessionId: "test-session",
    storage: null,
    broadcast: broadcastFn,
    rateLimit: { consume: async () => ({ allowed: true }) },
  } as unknown as AgentContext;

  const broadcastAppList = vi.fn();

  return { appStore, provider, context, broadcastAppList };
}

describe("list_apps tool", () => {
  it("returns message when no apps exist", async () => {
    const { appStore } = createTestContext();
    const tool = createListAppsTool(appStore);
    const result = await tool.execute({}, { toolCallId: "test" });

    expect(textOf(result)).toBe("No apps deployed yet.");
  });

  it("lists app with no versions", async () => {
    const { appStore } = createTestContext();
    appStore.create("Empty App", "empty-app");

    const tool = createListAppsTool(appStore);
    const result = await tool.execute({}, { toolCallId: "test" });

    expect(textOf(result)).toContain("Empty App");
    expect(textOf(result)).toContain("v0");
  });

  it("shows full-stack indicator for backend apps", async () => {
    const { appStore } = createTestContext();
    const app = appStore.create("Backend App", "backend-app");
    appStore.addVersion(app.id, {
      deployId: "d1",
      commitHash: "abc1234567890",
      message: "With backend",
      files: ["index.html"],
      hasBackend: true,
    });

    const tool = createListAppsTool(appStore);
    const result = await tool.execute({}, { toolCallId: "test" });

    expect(textOf(result)).toContain("full-stack");
  });

  it("lists all apps with version info", async () => {
    const { appStore } = createTestContext();
    const app = appStore.create("Todo App", "todo-app");
    appStore.addVersion(app.id, {
      deployId: "d1",
      commitHash: "abc1234567890",
      message: "Initial",
      files: ["index.html"],
      hasBackend: false,
    });

    const tool = createListAppsTool(appStore);
    const result = await tool.execute({}, { toolCallId: "test" });
    const text = textOf(result);

    expect(text).toContain("Todo App");
    expect(text).toContain("todo-app");
    expect(text).toContain("v1");
    expect(text).toContain("abc1234");
    expect(text).toContain("Initial");
  });
});

describe("get_app_history tool", () => {
  it("returns error for nonexistent app", async () => {
    const { appStore } = createTestContext();
    const tool = createGetAppHistoryTool(appStore);
    const result = await tool.execute({ slug: "nope" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("not found");
  });

  it("returns message for app with no versions", async () => {
    const { appStore } = createTestContext();
    appStore.create("Empty App", "empty-app");

    const tool = createGetAppHistoryTool(appStore);
    const result = await tool.execute({ slug: "empty-app" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("no versions deployed");
  });

  it("shows no-message indicator when commit message is null", async () => {
    const { appStore } = createTestContext();
    const app = appStore.create("App", "app");
    appStore.addVersion(app.id, {
      deployId: "d1",
      commitHash: "aaa1234567890",
      files: ["a.html"],
      hasBackend: false,
    });

    const tool = createGetAppHistoryTool(appStore);
    const result = await tool.execute({ slug: "app" }, { toolCallId: "test" });
    const text = textOf(result);

    expect(text).toContain("(no message)");
  });

  it("lists version history with LIVE marker", async () => {
    const { appStore } = createTestContext();
    const app = appStore.create("App", "app");
    appStore.addVersion(app.id, {
      deployId: "d1",
      commitHash: "aaa1234567890",
      message: "First",
      files: ["a.html"],
      hasBackend: false,
    });
    appStore.addVersion(app.id, {
      deployId: "d2",
      commitHash: "bbb1234567890",
      message: "Second",
      files: ["a.html", "b.html"],
      hasBackend: false,
    });

    const tool = createGetAppHistoryTool(appStore);
    const result = await tool.execute({ slug: "app" }, { toolCallId: "test" });
    const text = textOf(result);

    expect(text).toContain("2 versions");
    expect(text).toContain("LIVE");
    expect(text).toContain("bbb1234");
    expect(text).toContain("aaa1234");
  });
});

describe("rollback_app tool", () => {
  it("returns error for nonexistent app", async () => {
    const { appStore, provider, context, broadcastAppList } = createTestContext();
    const tool = createRollbackAppTool(provider, context, appStore, broadcastAppList);
    const result = await tool.execute({ slug: "nope", version: 1 }, { toolCallId: "test" });

    expect(textOf(result)).toContain("not found");
  });

  it("returns error for nonexistent version", async () => {
    const { appStore, provider, context, broadcastAppList } = createTestContext();
    appStore.create("App", "app");
    const tool = createRollbackAppTool(provider, context, appStore, broadcastAppList);
    const result = await tool.execute({ slug: "app", version: 99 }, { toolCallId: "test" });

    expect(textOf(result)).toContain("does not exist");
  });

  it("rolls back to specified version", async () => {
    const { appStore, provider, context, broadcastAppList } = createTestContext();
    const app = appStore.create("App", "app");
    appStore.addVersion(app.id, {
      deployId: "d1",
      commitHash: "aaa123",
      message: "v1",
      files: [],
      hasBackend: false,
    });
    appStore.addVersion(app.id, {
      deployId: "d2",
      commitHash: "bbb456",
      message: "v2",
      files: [],
      hasBackend: false,
    });

    const tool = createRollbackAppTool(provider, context, appStore, broadcastAppList);
    const result = await tool.execute({ slug: "app", version: 1 }, { toolCallId: "test" });

    expect(textOf(result)).toContain("Rolled back");
    expect(textOf(result)).toContain("v1");

    // Verify SQL was updated
    const updated = appStore.getBySlug("app");
    expect(updated?.currentVersion).toBe(1);

    // Verify broadcast was called
    expect(broadcastAppList).toHaveBeenCalled();

    // Verify CURRENT file was written
    expect(provider.exec).toHaveBeenCalledWith(
      expect.stringContaining("CURRENT"),
      expect.anything(),
    );
  });
});

describe("delete_app tool", () => {
  it("returns error for nonexistent app", async () => {
    const { appStore, provider, context, broadcastAppList } = createTestContext();
    const tool = createDeleteAppTool(provider, context, appStore, broadcastAppList);
    const result = await tool.execute({ slug: "nope" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("not found");
  });

  it("deletes app and broadcasts", async () => {
    const { appStore, provider, context, broadcastAppList } = createTestContext();
    const app = appStore.create("Doomed", "doomed");
    appStore.addVersion(app.id, {
      deployId: "d1",
      commitHash: "abc",
      files: [],
      hasBackend: false,
    });

    const tool = createDeleteAppTool(provider, context, appStore, broadcastAppList);
    const result = await tool.execute({ slug: "doomed" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("Deleted");
    expect(appStore.getBySlug("doomed")).toBeNull();
    expect(broadcastAppList).toHaveBeenCalled();

    // Verify R2 cleanup
    expect(provider.exec).toHaveBeenCalledWith(
      expect.stringContaining("rm -rf"),
      expect.anything(),
    );
  });
});
