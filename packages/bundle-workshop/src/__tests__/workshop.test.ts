import { describe, expect, it, vi } from "vitest";
import { bundleWorkshop } from "../index.js";

/** Extract text from a wrapped AgentToolResult. */
function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type: string; text: string }> };
  if (r?.content?.[0]?.type === "text") return r.content[0].text;
  return JSON.stringify(result);
}

function createMockOptions() {
  const files = new Map<string, string>();
  const registry = {
    getActiveForAgent: vi.fn().mockResolvedValue(null),
    setActive: vi.fn().mockResolvedValue(undefined),
    getBytes: vi.fn().mockResolvedValue(null),
  };

  return {
    registry,
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: vi.fn().mockImplementation(async (path: string) => files.get(path) ?? null),
    writeFile: vi.fn().mockImplementation(async (path: string, content: string) => {
      files.set(path, content);
    }),
    exists: vi.fn().mockImplementation(async (path: string) => files.has(path)),
    isElevated: () => true,
    _files: files,
  };
}

function createMockContext(agentId = "test-agent") {
  return {
    agentId,
    sessionId: "test-session",
    stepNumber: 1,
    emitCost: () => {},
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: async () => ({}),
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => false,
      list: async () => new Map(),
    },
    schedules: {} as never,
    rateLimit: { check: () => true } as never,
  };
}

describe("bundleWorkshop", () => {
  it("returns a capability with expected id and tools", () => {
    const opts = createMockOptions();
    const cap = bundleWorkshop(opts);

    expect(cap.id).toBe("bundle-workshop");
    expect(cap.name).toBe("Bundle Workshop");

    const ctx = createMockContext();
    const tools = cap.tools!(ctx as never);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("bundle_init");
    expect(toolNames).toContain("bundle_build");
    expect(toolNames).toContain("bundle_test");
    expect(toolNames).toContain("bundle_deploy");
    expect(toolNames).toContain("bundle_disable");
    expect(toolNames).toContain("bundle_rollback");
    expect(toolNames).toContain("bundle_versions");
    expect(tools.length).toBe(7);
  });

  describe("bundle_init", () => {
    it("scaffolds workspace files and runs bun install", async () => {
      const opts = createMockOptions();
      const cap = bundleWorkshop(opts);
      const ctx = createMockContext();
      const tools = cap.tools!(ctx as never);
      const initTool = tools.find((t) => t.name === "bundle_init")!;

      const result = await initTool.execute(
        { name: "my-brain" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("my-brain");
      expect(textOf(result)).toContain("success");
      expect(opts.writeFile).toHaveBeenCalled();
      expect(opts.exec).toHaveBeenCalledWith("bun install --ignore-scripts", expect.any(Object));
    });

    it("rejects existing workspace", async () => {
      const opts = createMockOptions();
      opts._files.set("/workspace/bundles/existing", "");
      opts.exists.mockImplementation(async (p: string) => opts._files.has(p));

      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext() as never);
      const initTool = tools.find((t) => t.name === "bundle_init")!;

      const result = await initTool.execute(
        { name: "existing" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("already exists");
    });
  });

  describe("bundle_build", () => {
    it("returns error when src/index.ts missing", async () => {
      const opts = createMockOptions();
      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext() as never);
      const buildTool = tools.find((t) => t.name === "bundle_build")!;

      const result = await buildTool.execute(
        { name: "missing" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("No src/index.ts");
    });

    it("runs bun build when source exists", async () => {
      const opts = createMockOptions();
      opts._files.set("/workspace/bundles/my-brain/src/index.ts", "export default {}");
      opts.exists.mockImplementation(async (p: string) => opts._files.has(p));
      opts.exec.mockResolvedValue({ stdout: "Bundled 3 modules", stderr: "", exitCode: 0 });

      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext() as never);
      const buildTool = tools.find((t) => t.name === "bundle_build")!;

      const result = await buildTool.execute(
        { name: "my-brain" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("successful");
      expect(opts.exec).toHaveBeenCalledWith(
        expect.stringContaining("bun build"),
        expect.any(Object),
      );
    });
  });

  describe("bundle_deploy", () => {
    it("returns error when no built bundle", async () => {
      const opts = createMockOptions();
      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext() as never);
      const deployTool = tools.find((t) => t.name === "bundle_deploy")!;

      const result = await deployTool.execute(
        { name: "missing" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("No built bundle");
    });

    it("deploys to self by default", async () => {
      const opts = createMockOptions();
      opts._files.set("/workspace/bundles/my-brain/dist/bundle.js", "export default {}");
      opts.readFile.mockImplementation(async (p: string) => opts._files.get(p) ?? null);

      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext("agent-42") as never);
      const deployTool = tools.find((t) => t.name === "bundle_deploy")!;

      const result = await deployTool.execute(
        { name: "my-brain", rationale: "test deploy" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("deployed successfully");
      expect(textOf(result)).toContain("self");
      expect(opts.registry.setActive).toHaveBeenCalledWith(
        "agent-42",
        expect.any(String),
        expect.objectContaining({ rationale: "test deploy" }),
      );
    });

    it("enforces deploy rate limit", async () => {
      const opts = createMockOptions();
      opts._files.set("/workspace/bundles/my-brain/dist/bundle.js", "export default {}");
      opts.readFile.mockImplementation(async (p: string) => opts._files.get(p) ?? null);

      const cap = bundleWorkshop({ ...opts, deployRateLimitPerMinute: 2 });
      const tools = cap.tools!(createMockContext() as never);
      const deployTool = tools.find((t) => t.name === "bundle_deploy")!;
      const execCtx = { toolCallId: "tc1", signal: AbortSignal.timeout(5000) };

      await deployTool.execute({ name: "my-brain" }, execCtx);
      await deployTool.execute({ name: "my-brain" }, execCtx);
      const result = await deployTool.execute({ name: "my-brain" }, execCtx);

      expect(textOf(result)).toContain("rate limit");
    });
  });

  describe("bundle_disable", () => {
    it("clears active pointer via registry", async () => {
      const opts = createMockOptions();
      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext("agent-1") as never);
      const disableTool = tools.find((t) => t.name === "bundle_disable")!;

      const result = await disableTool.execute(
        { rationale: "bug found" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("disabled");
      expect(opts.registry.setActive).toHaveBeenCalledWith("agent-1", null, expect.any(Object));
    });
  });

  describe("bundle_versions", () => {
    it("shows active version status", async () => {
      const opts = createMockOptions();
      opts.registry.getActiveForAgent.mockResolvedValue("abc123");

      const cap = bundleWorkshop(opts);
      const tools = cap.tools!(createMockContext() as never);
      const versionsTool = tools.find((t) => t.name === "bundle_versions")!;

      const result = await versionsTool.execute(
        {},
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("abc123");
    });
  });

  it("includes prompt section about workshop workflow", () => {
    const opts = createMockOptions();
    const cap = bundleWorkshop(opts);
    const sections = cap.promptSections!({} as never);

    expect(sections.length).toBe(1);
    const section = sections[0] as { kind: string; content: string };
    expect(section.kind).toBe("included");
    expect(section.content).toContain("bundle_init");
    expect(section.content).toContain("self-editing");
  });
});
