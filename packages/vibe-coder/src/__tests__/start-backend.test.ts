import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createStartBackendTool } from "../tools/start-backend.js";

vi.mock("@cloudflare/worker-bundler", () => ({
  createWorker: vi.fn().mockResolvedValue({
    mainModule: "index.js",
    modules: { "index.js": "export default { fetch() {} }" },
  }),
}));

import { createWorker } from "@cloudflare/worker-bundler";

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

/** Create a mock provider.exec that routes based on command prefix. */
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
    rateLimit: { consume: async () => ({ allowed: true }) },
    notifyBundlePointerChanged: async () => {},
  };
}

function mockBackendOptions() {
  return {
    loader: {
      get: vi.fn().mockReturnValue({
        getEntrypoint: vi.fn().mockResolvedValue({ fetch: vi.fn() }),
      }),
    } as any,
    dbService: { exec: vi.fn(), batch: vi.fn() } as any,
  };
}

function getText(result: any): string {
  return result.content[0].text;
}

describe("start_backend tool", () => {
  it("has the correct name and description", () => {
    const tool = createStartBackendTool(mockProvider(), mockContext(), mockBackendOptions());
    expect(tool.name).toBe("start_backend");
    expect(tool.description).toContain("Bundle and start");
  });

  it("returns error when entry point does not exist", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({ "test -f": { stdout: "", exitCode: 1 } }),
    });
    const tool = createStartBackendTool(provider, mockContext(), mockBackendOptions());

    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("does not exist");
  });

  it("returns error when file listing fails", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "", stderr: "permission denied", exitCode: 1 },
      }),
    });
    const tool = createStartBackendTool(provider, mockContext(), mockBackendOptions());

    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("Error collecting backend source files");
  });

  it("returns error when entry point not found in collected files", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/utils.ts\n" },
        cat: { stdout: "export const x = 1;" },
      }),
    });
    const tool = createStartBackendTool(provider, mockContext(), mockBackendOptions());

    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("not found in collected files");
    expect(getText(result)).toContain("utils.ts");
  });

  it("bundles successfully, loads worker, persists state, and broadcasts", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/index.ts\n/workspace/app/server/package.json\n" },
        cat: { stdout: "export default { fetch() {} }" },
      }),
    });

    const ctx = mockContext();
    const backend = mockBackendOptions();
    const tool = createStartBackendTool(provider, ctx, backend);

    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    // createWorker was called with collected files
    expect(createWorker).toHaveBeenCalledWith({
      files: {
        "index.ts": expect.any(String),
        "package.json": expect.any(String),
      },
      entryPoint: "index.ts",
    });

    // WorkerLoader was called with wrapper as mainModule
    expect(backend.loader.get).toHaveBeenCalledWith(
      expect.stringContaining("backend/"),
      expect.any(Function),
    );

    // Verify the loader factory includes the wrapper and __DB_SERVICE
    const factory = backend.loader.get.mock.calls[0][1] as () => Promise<any>;
    const workerDef = await factory();
    expect(workerDef.mainModule).toBe("__claw_wrapper.js");
    expect(workerDef.modules["__claw_wrapper.js"]).toContain("wrapDb");
    expect(workerDef.env.__DB_SERVICE).toBe(backend.dbService);

    // State was persisted
    expect(ctx.storage!.put).toHaveBeenCalledWith("backend:version", 1);
    expect(ctx.storage!.put).toHaveBeenCalledWith(
      "backend:loaderKey",
      expect.stringContaining("backend/"),
    );
    expect(ctx.storage!.put).toHaveBeenCalledWith("backend:backendId", expect.any(String));
    expect(ctx.storage!.put).toHaveBeenCalledWith(
      "backend:bundle",
      expect.objectContaining({ mainModule: "__claw_wrapper.js" }),
    );

    // Broadcast
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "backend_started",
      expect.objectContaining({ version: 1, backendId: expect.any(String) }),
    );

    // Success response
    expect(getText(result)).toContain("Backend started (v1");
    expect(getText(result)).toContain("2 source files");
  });

  it("uses explicit backendId when provided", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/index.ts\n" },
        cat: { stdout: "code" },
      }),
    });

    const ctx = mockContext();
    const backend = mockBackendOptions();
    const tool = createStartBackendTool(provider, ctx, backend);

    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts", backendId: "my-custom-app" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("my-custom-app");
    expect(ctx.storage!.put).toHaveBeenCalledWith("backend:backendId", "my-custom-app");

    // Loader key includes the custom backend ID
    const loaderKey = backend.loader.get.mock.calls[0][0] as string;
    expect(loaderKey).toContain("my-custom-app");
  });

  it("increments version on subsequent calls", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/index.ts\n" },
        cat: { stdout: "code" },
      }),
    });

    const ctx = mockContext();
    // Simulate existing version
    (ctx.storage!.get as ReturnType<typeof vi.fn>).mockResolvedValue(3);

    const backend = mockBackendOptions();
    const tool = createStartBackendTool(provider, ctx, backend);

    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("v4");
  });

  it("returns error when bundling fails", async () => {
    (createWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("esbuild compilation failed"),
    );

    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/index.ts\n" },
        cat: { stdout: "bad code" },
      }),
    });

    const tool = createStartBackendTool(provider, mockContext(), mockBackendOptions());
    const result = await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts" },
      { toolCallId: "tc1" },
    );

    expect(getText(result)).toContain("Error bundling backend");
    expect(getText(result)).toContain("esbuild compilation failed");
  });

  it("derives sourceDir from entryPoint when not specified", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/main.ts\n" },
        cat: { stdout: "code" },
      }),
    });

    const tool = createStartBackendTool(provider, mockContext(), mockBackendOptions());
    await tool.execute({ entryPoint: "/workspace/app/server/main.ts" }, { toolCallId: "tc1" });

    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ entryPoint: "main.ts" }));
  });

  it("uses explicit sourceDir when provided", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/src/server/index.ts\n" },
        cat: { stdout: "code" },
      }),
    });

    const tool = createStartBackendTool(provider, mockContext(), mockBackendOptions());
    await tool.execute(
      { entryPoint: "/workspace/app/src/server/index.ts", sourceDir: "/workspace/app/src" },
      { toolCallId: "tc1" },
    );

    expect(createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ entryPoint: "server/index.ts" }),
    );
  });

  it("wrapper module injects backendId into DB calls", async () => {
    const provider = mockProvider({
      exec: mockExecRouter({
        "test -f": { stdout: "OK" },
        find: { stdout: "/workspace/app/server/index.ts\n" },
        cat: { stdout: "export default { fetch() {} }" },
      }),
    });

    const backend = mockBackendOptions();
    const tool = createStartBackendTool(provider, mockContext(), backend);
    await tool.execute(
      { entryPoint: "/workspace/app/server/index.ts", backendId: "test-app" },
      { toolCallId: "tc1" },
    );

    const factory = backend.loader.get.mock.calls[0][1] as () => Promise<any>;
    const workerDef = await factory();
    const wrapper = workerDef.modules["__claw_wrapper.js"] as string;

    // Wrapper should contain the backend ID
    expect(wrapper).toContain("test-app");
    // Wrapper should import the user's main module
    expect(wrapper).toContain("index.js");
    // Wrapper should create a DB wrapper with exec/batch
    expect(wrapper).toContain("exec");
    expect(wrapper).toContain("batch");
  });
});
