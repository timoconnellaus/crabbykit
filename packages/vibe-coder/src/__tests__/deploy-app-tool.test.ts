import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/worker-bundler", () => ({
  createWorker: vi.fn().mockResolvedValue({
    mainModule: "index.js",
    modules: { "index.js": "export default { fetch() {} }" },
  }),
}));

import { createWorker } from "@cloudflare/worker-bundler";
import { createDeployAppTool } from "../tools/deploy-app.js";
import { vibeCoder } from "../capability.js";

// --- Helpers ---

function mockProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setDevPort: vi.fn().mockResolvedValue(undefined),
    clearDevPort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockExecRouter(
  handlers: Record<string, { stdout: string; stderr?: string; exitCode?: number }>,
) {
  return vi.fn().mockImplementation((cmd: string) => {
    for (const [prefix, result] of Object.entries(handlers)) {
      if (cmd.includes(prefix)) {
        return Promise.resolve({
          stdout: result.stdout,
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
        });
      }
    }
    return Promise.resolve({ stdout: "", stderr: "unhandled command", exitCode: 1 });
  });
}

function mockContext(sessionId = "test-session"): AgentContext {
  return {
    agentId: "test-agent",
    sessionId,
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    broadcastState: vi.fn(),
    requestFromClient: vi.fn(),
    schedules: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      setTimer: vi.fn().mockResolvedValue(undefined),
      cancelTimer: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue(new Map()),
    },
  };
}

function mockAgentStorage(namespace = "ns-abc123"): AgentStorage {
  return {
    bucket: vi.fn(),
    namespace: vi.fn().mockReturnValue(namespace),
  };
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text;
}

// --- Tests ---

describe("deploy_app tool", () => {
  it("has correct name and description", () => {
    const tool = createDeployAppTool(mockProvider(), mockContext(), mockAgentStorage());
    expect(tool.name).toBe("deploy_app");
    expect(tool.description).toContain("Deploy");
  });

  it("returns error when build directory does not exist", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "", exitCode: 1 },
      }),
    });
    const tool = createDeployAppTool(provider, mockContext(), mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("does not exist");
    expect(getText(result)).toContain("Build the app first");
  });

  it("returns error when file listing fails", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "", stderr: "permission denied", exitCode: 1 },
      }),
    });
    const tool = createDeployAppTool(provider, mockContext(), mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("Error listing files");
    expect(getText(result)).toContain("permission denied");
  });

  it("returns error when build directory is empty", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "\n", exitCode: 0 },
      }),
    });
    const tool = createDeployAppTool(provider, mockContext(), mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("contains no files");
  });

  it("returns error when copy to deploy path fails", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "index.html\napp.js\n", exitCode: 0 },
        "cp -r": { stdout: "", stderr: "no space left on device", exitCode: 1 },
      }),
    });
    const tool = createDeployAppTool(provider, mockContext(), mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("Error copying build");
    expect(getText(result)).toContain("no space left on device");
  });

  it("deploys frontend-only successfully", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "index.html\nassets/app.js\nassets/style.css\n", exitCode: 0 },
        "mkdir -p": { stdout: "", exitCode: 0 },
      }),
    });
    const ctx = mockContext();
    const storage = mockAgentStorage("agent-ns-123");
    const tool = createDeployAppTool(provider, ctx, storage);

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    const text = getText(result);
    expect(text).toContain("deployed successfully");
    expect(text).toContain("3 assets");
    expect(text).not.toContain("Backend");
  });

  it("deploy URL includes namespace from AgentStorage", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "index.html\n", exitCode: 0 },
        "mkdir -p": { stdout: "", exitCode: 0 },
      }),
    });
    const ctx = mockContext();
    const storage = mockAgentStorage("my-namespace");
    const tool = createDeployAppTool(provider, ctx, storage);

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    const text = getText(result);
    expect(text).toContain("/deploy/my-namespace/");
  });

  it("persists metadata in capability storage", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "index.html\napp.js\n", exitCode: 0 },
        "mkdir -p": { stdout: "", exitCode: 0 },
      }),
    });
    const ctx = mockContext();
    const tool = createDeployAppTool(provider, ctx, mockAgentStorage());

    await tool.execute({ buildDir: "/workspace/my-app/dist" }, { toolCallId: "tc1" });

    const putFn = ctx.storage!.put as ReturnType<typeof vi.fn>;
    expect(putFn).toHaveBeenCalledWith(
      expect.stringMatching(/^deploy:/),
      expect.objectContaining({
        deployId: expect.any(String),
        files: ["index.html", "app.js"],
        deployedAt: expect.any(String),
        buildDir: "/workspace/my-app/dist",
        hasBackend: false,
      }),
    );
  });

  it("broadcasts deploy_complete event", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "index.html\n", exitCode: 0 },
        "mkdir -p": { stdout: "", exitCode: 0 },
      }),
    });
    const ctx = mockContext();
    const tool = createDeployAppTool(provider, ctx, mockAgentStorage());

    await tool.execute({ buildDir: "/workspace/my-app/dist" }, { toolCallId: "tc1" });

    expect(ctx.broadcast).toHaveBeenCalledWith(
      "deploy_complete",
      expect.objectContaining({
        deployId: expect.any(String),
        url: expect.stringContaining("/deploy/"),
        files: ["index.html"],
        hasBackend: false,
      }),
    );
  });

  it("deploys with backend successfully", async () => {
    // The deploy_app tool calls find twice: once for the build dir, once for the backend source dir.
    // We need the exec mock to distinguish between these two find calls.
    let findCallCount = 0;
    const execFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("test -d")) {
        return Promise.resolve({ stdout: "OK", stderr: "", exitCode: 0 });
      }
      if (cmd.includes("find")) {
        findCallCount++;
        if (findCallCount === 1) {
          // Frontend file listing
          return Promise.resolve({ stdout: "index.html\n", stderr: "", exitCode: 0 });
        }
        // Backend file listing — must return absolute paths matching the sourceDir
        return Promise.resolve({
          stdout: "/workspace/my-app/server/index.ts\n",
          stderr: "",
          exitCode: 0,
        });
      }
      if (cmd.includes("cat")) {
        return Promise.resolve({
          stdout: "export default { fetch() {} }",
          stderr: "",
          exitCode: 0,
        });
      }
      // mkdir -p, cp -r, etc.
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    const provider = mockProvider({ exec: execFn });
    const ctx = mockContext();
    const tool = createDeployAppTool(provider, ctx, mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist", backendEntry: "/workspace/my-app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    const text = getText(result);
    expect(text).toContain("deployed successfully");
    expect(text).toContain("Backend: deployed");
    expect(text).toContain("API available at /api/*");
  });

  it("returns partial error when backend bundling fails", async () => {
    (createWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("esbuild compilation failed"),
    );

    let findCallCount = 0;
    const execFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("test -d")) {
        return Promise.resolve({ stdout: "OK", stderr: "", exitCode: 0 });
      }
      if (cmd.includes("find")) {
        findCallCount++;
        if (findCallCount === 1) {
          return Promise.resolve({ stdout: "index.html\n", stderr: "", exitCode: 0 });
        }
        return Promise.resolve({
          stdout: "/workspace/my-app/server/index.ts\n",
          stderr: "",
          exitCode: 0,
        });
      }
      if (cmd.includes("cat")) {
        return Promise.resolve({ stdout: "bad code", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    const provider = mockProvider({ exec: execFn });
    const ctx = mockContext();
    const tool = createDeployAppTool(provider, ctx, mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist", backendEntry: "/workspace/my-app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    const text = getText(result);
    expect(text).toContain("Frontend deployed but backend failed");
    expect(text).toContain("esbuild compilation failed");
  });

  it("returns details in the result on success", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -d": { stdout: "OK" },
        find: { stdout: "index.html\nstyle.css\n", exitCode: 0 },
        "mkdir -p": { stdout: "", exitCode: 0 },
      }),
    });
    const tool = createDeployAppTool(provider, mockContext(), mockAgentStorage());

    const result = await tool.execute(
      { buildDir: "/workspace/my-app/dist" },
      { toolCallId: "tc1" },
    );

    expect(result.details).toEqual(
      expect.objectContaining({
        deployId: expect.any(String),
        url: expect.stringContaining("/deploy/"),
        files: ["index.html", "style.css"],
        deployedAt: expect.any(String),
        hasBackend: false,
      }),
    );
  });
});

describe("vibeCoder tools (deploy removed)", () => {
  it("does not include deploy_app tool", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    const tools = cap.tools!(mockContext());
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("deploy_app");
    expect(tools).toHaveLength(3);
  });

  it("does not include deploy instructions in prompt sections", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    const sections = cap.promptSections!(mockContext());
    expect(sections).toHaveLength(1);
    for (const section of sections) {
      expect(section).not.toContain("deploy_app");
    }
  });
});
