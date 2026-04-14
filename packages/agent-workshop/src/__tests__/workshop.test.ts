import { describe, expect, it, vi } from "vitest";
import { agentWorkshop, type WorkshopExecResult } from "../index.js";

/** Extract text from a wrapped AgentToolResult. */
function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type: string; text: string }> };
  if (r?.content?.[0]?.type === "text") return r.content[0].text;
  return JSON.stringify(result);
}

/** Remove surrounding double quotes and unescape shell-quoted content. */
function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

/**
 * A minimal shell interpreter that backs a fake sandbox. Recognizes:
 *  - `test -e <path>` — checks the fake filesystem
 *  - `cat <path>` — reads from the fake filesystem
 *  - `mkdir -p <dir> && echo <b64> | base64 -d > <path>` — writes a file
 *  - `cd <dir> && bun install ...`
 *  - `cd <dir> && bun build ... --outfile=<relative-out>`
 *
 * Anything else returns exit 0 with no output.
 */
function createShellMock() {
  const files = new Map<string, string>();
  const execLog: string[] = [];

  function dirExists(path: string): boolean {
    if (files.has(path)) return true;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  const sandboxExec = vi
    .fn<
      (
        sessionId: string,
        command: string,
        opts?: { signal?: AbortSignal },
      ) => Promise<WorkshopExecResult>
    >()
    .mockImplementation(async (_sessionId, cmd) => {
      execLog.push(cmd);

      const testE = cmd.match(/^test -e (.+)$/);
      if (testE) {
        const path = unquote(testE[1]);
        return {
          stdout: "",
          stderr: "",
          exitCode: dirExists(path) ? 0 : 1,
        };
      }

      const cat = cmd.match(/^cat (.+)$/);
      if (cat) {
        const path = unquote(cat[1]);
        const content = files.get(path);
        if (content == null) {
          return {
            stdout: "",
            stderr: `cat: ${path}: No such file or directory`,
            exitCode: 1,
          };
        }
        return { stdout: content, stderr: "", exitCode: 0 };
      }

      const write = cmd.match(/^mkdir -p (.+?) && echo (.+?) \| base64 -d > (.+)$/);
      if (write) {
        const path = unquote(write[3]);
        const b64 = unquote(write[2]);
        try {
          files.set(path, atob(b64));
          return { stdout: "", stderr: "", exitCode: 0 };
        } catch (err) {
          return {
            stdout: "",
            stderr: `base64: ${err instanceof Error ? err.message : String(err)}`,
            exitCode: 1,
          };
        }
      }

      if (cmd.includes("bun install")) {
        return { stdout: "installed 0 packages", stderr: "", exitCode: 0 };
      }

      if (cmd.includes("bun build")) {
        const cdMatch = cmd.match(/^cd (.+?) && /);
        const cwd = cdMatch ? unquote(cdMatch[1]) : "/workspace";
        const outfileMatch = cmd.match(/--outfile=(\S+)/);
        const outfile = outfileMatch
          ? `${cwd}/${outfileMatch[1]}`.replace(/\/+/g, "/")
          : `${cwd}/dist/bundle.js`;
        files.set(
          outfile,
          "export default { async fetch() { return new Response('bundle-live'); } };",
        );
        return { stdout: "Bundle: 45 modules", stderr: "", exitCode: 0 };
      }

      return { stdout: "", stderr: "", exitCode: 0 };
    });

  return { files, execLog, sandboxExec };
}

function createMockRegistry() {
  return {
    getActiveForAgent: vi.fn().mockResolvedValue(null),
    setActive: vi.fn().mockResolvedValue(undefined),
    getBytes: vi.fn().mockResolvedValue(null),
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

describe("agentWorkshop", () => {
  it("returns a capability with expected id and tools", () => {
    const shell = createShellMock();
    const registry = createMockRegistry();
    const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });

    expect(cap.id).toBe("agent-workshop");
    expect(cap.name).toBe("Agent Workshop");

    const ctx = createMockContext();
    const tools = cap.tools!(ctx as never);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("workshop_init");
    expect(toolNames).toContain("workshop_build");
    expect(toolNames).toContain("workshop_test");
    expect(toolNames).toContain("workshop_deploy");
    expect(toolNames).toContain("workshop_disable");
    expect(toolNames).toContain("workshop_rollback");
    expect(toolNames).toContain("workshop_versions");
    expect(tools.length).toBe(7);
  });

  describe("workshop_init", () => {
    it("scaffolds workspace files and runs bun install", async () => {
      const shell = createShellMock();
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const ctx = createMockContext();
      const tools = cap.tools!(ctx as never);
      const initTool = tools.find((t) => t.name === "workshop_init")!;

      const result = await initTool.execute(
        { name: "my-brain" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("my-brain");
      expect(textOf(result)).toContain("success");
      expect(shell.files.has("/workspace/bundles/my-brain/package.json")).toBe(true);
      expect(shell.files.has("/workspace/bundles/my-brain/tsconfig.json")).toBe(true);
      expect(shell.files.has("/workspace/bundles/my-brain/src/index.ts")).toBe(true);
      expect(shell.execLog.some((c) => c.includes("bun install"))).toBe(true);
    });

    it("rejects existing workspace", async () => {
      const shell = createShellMock();
      shell.files.set("/workspace/bundles/existing/package.json", "{}");
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext() as never);
      const initTool = tools.find((t) => t.name === "workshop_init")!;

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

  describe("workshop_build", () => {
    it("returns error when src/index.ts missing", async () => {
      const shell = createShellMock();
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext() as never);
      const buildTool = tools.find((t) => t.name === "workshop_build")!;

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
      const shell = createShellMock();
      shell.files.set("/workspace/bundles/my-brain/src/index.ts", "export default {}");
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext() as never);
      const buildTool = tools.find((t) => t.name === "workshop_build")!;

      const result = await buildTool.execute(
        { name: "my-brain" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("successful");
      expect(shell.execLog.some((c) => c.includes("bun build"))).toBe(true);
    });
  });

  describe("workshop_deploy", () => {
    it("returns error when no built bundle", async () => {
      const shell = createShellMock();
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext() as never);
      const deployTool = tools.find((t) => t.name === "workshop_deploy")!;

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
      const shell = createShellMock();
      shell.files.set("/workspace/bundles/my-brain/dist/bundle.js", "export default {}");
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext("agent-42") as never);
      const deployTool = tools.find((t) => t.name === "workshop_deploy")!;

      const result = await deployTool.execute(
        { name: "my-brain", rationale: "test deploy" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("deployed successfully");
      expect(textOf(result)).toContain("self");
      expect(registry.setActive).toHaveBeenCalledWith(
        "agent-42",
        expect.any(String),
        expect.objectContaining({ rationale: "test deploy" }),
      );
    });

    it("enforces deploy rate limit", async () => {
      const shell = createShellMock();
      shell.files.set("/workspace/bundles/my-brain/dist/bundle.js", "export default {}");
      const registry = createMockRegistry();
      const cap = agentWorkshop({
        registry,
        sandboxExec: shell.sandboxExec,
        deployRateLimitPerMinute: 2,
      });
      const tools = cap.tools!(createMockContext() as never);
      const deployTool = tools.find((t) => t.name === "workshop_deploy")!;
      const execCtx = { toolCallId: "tc1", signal: AbortSignal.timeout(5000) };

      await deployTool.execute({ name: "my-brain" }, execCtx);
      await deployTool.execute({ name: "my-brain" }, execCtx);
      const result = await deployTool.execute({ name: "my-brain" }, execCtx);

      expect(textOf(result)).toContain("rate limit");
    });
  });

  describe("workshop_disable", () => {
    it("clears active pointer via registry", async () => {
      const shell = createShellMock();
      const registry = createMockRegistry();
      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext("agent-1") as never);
      const disableTool = tools.find((t) => t.name === "workshop_disable")!;

      const result = await disableTool.execute(
        { rationale: "bug found" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result)).toContain("disabled");
      expect(registry.setActive).toHaveBeenCalledWith("agent-1", null, expect.any(Object));
    });
  });

  describe("workshop_versions", () => {
    it("shows active version status", async () => {
      const shell = createShellMock();
      const registry = createMockRegistry();
      registry.getActiveForAgent.mockResolvedValue("abc123");

      const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
      const tools = cap.tools!(createMockContext() as never);
      const versionsTool = tools.find((t) => t.name === "workshop_versions")!;

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

  describe("sandbox elevation gate", () => {
    it("bubbles the not-elevated error from sandboxExec", async () => {
      const registry = createMockRegistry();
      const sandboxExec = vi.fn().mockResolvedValue({
        stdout: "",
        stderr:
          "Sandbox is not elevated for this session. Call the `elevate` tool first before using workshop tools.",
        exitCode: 126,
      });

      const cap = agentWorkshop({ registry, sandboxExec });
      const tools = cap.tools!(createMockContext() as never);
      const initTool = tools.find((t) => t.name === "workshop_init")!;

      const result = await initTool.execute(
        { name: "anything" },
        {
          toolCallId: "tc1",
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(textOf(result).toLowerCase()).toContain("elevate");
    });
  });

  it("includes prompt section about workshop workflow", () => {
    const shell = createShellMock();
    const registry = createMockRegistry();
    const cap = agentWorkshop({ registry, sandboxExec: shell.sandboxExec });
    const sections = cap.promptSections!({} as never);

    expect(sections.length).toBe(1);
    const section = sections[0] as { kind: string; content: string };
    expect(section.kind).toBe("included");
    expect(section.content).toContain("workshop_init");
    expect(section.content).toContain("elevate");
  });
});
