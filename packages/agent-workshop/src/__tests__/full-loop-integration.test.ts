/**
 * Agent workshop full-loop integration (task 6.28).
 *
 * Drives init → build → test → deploy → disable end-to-end against:
 *  - a minimal shell interpreter that backs a fake sandbox container
 *  - a real InMemoryBundleRegistry from agent-bundle
 *
 * The fake sandbox only understands the commands workshop actually
 * emits (test -e, cat, mkdir -p + base64 -d, bun install, bun build).
 * That's enough to exercise every seam in the workshop capability that
 * would fire against a real container.
 */

import { InMemoryBundleRegistry } from "@claw-for-cloudflare/agent-bundle/host";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * A minimal shell interpreter over a Map-backed fake filesystem. Same
 * dispatch rules as workshop.test.ts — duplicated locally to keep each
 * test suite self-contained.
 */
function createFakeSandbox() {
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
        return {
          stdout: "",
          stderr: "",
          exitCode: dirExists(unquote(testE[1])) ? 0 : 1,
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
        files.set(path, atob(b64));
        return { stdout: "", stderr: "", exitCode: 0 };
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

function createMockContext(agentId = "agent-int") {
  return {
    agentId,
    sessionId: "session-1",
    stepNumber: 1,
    emitCost: () => {},
    broadcast: vi.fn(),
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
    notifyBundlePointerChanged: vi.fn().mockResolvedValue(undefined),
  };
}

async function runTool(
  cap: ReturnType<typeof agentWorkshop>,
  name: string,
  args: Record<string, unknown>,
  ctx = createMockContext(),
): Promise<string> {
  const tool = cap.tools!(ctx as never).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  const result = await tool.execute(args, {
    toolCallId: `tc-${Date.now()}`,
    signal: AbortSignal.timeout(10_000),
  });
  return textOf(result);
}

describe("Agent workshop full-loop integration", () => {
  let sandbox: ReturnType<typeof createFakeSandbox>;
  let registry: InMemoryBundleRegistry;
  let cap: ReturnType<typeof agentWorkshop>;

  beforeEach(() => {
    sandbox = createFakeSandbox();
    registry = new InMemoryBundleRegistry();
    cap = agentWorkshop({ registry, sandboxExec: sandbox.sandboxExec });
  });

  it("executes init → build → deploy → disable end-to-end", async () => {
    const ctx = createMockContext("agent-42");

    // 1. Init
    const initOut = await runTool(cap, "workshop_init", { name: "demo" }, ctx);
    expect(initOut).toContain("success");
    expect(sandbox.files.has("/workspace/bundles/demo/package.json")).toBe(true);
    expect(sandbox.files.has("/workspace/bundles/demo/src/index.ts")).toBe(true);
    expect(sandbox.execLog.some((c) => c.includes("bun install"))).toBe(true);

    // 2. Build
    const buildOut = await runTool(cap, "workshop_build", { name: "demo" }, ctx);
    expect(buildOut).toContain("successful");
    expect(sandbox.files.has("/workspace/bundles/demo/dist/bundle.js")).toBe(true);
    expect(sandbox.execLog.some((c) => c.includes("bun build"))).toBe(true);

    // 3. Deploy — should land in registry with self-pointing active
    const deployOut = await runTool(
      cap,
      "workshop_deploy",
      { name: "demo", rationale: "first deploy" },
      ctx,
    );
    expect(deployOut).toContain("deployed successfully");
    const activeV1 = await registry.getActiveForAgent("agent-42");
    expect(activeV1).not.toBeNull();
    // Version ID is the content-addressed SHA-256 of the artifact bytes
    expect(activeV1).toMatch(/^[0-9a-f]{64}$/);
    // The deployment log captures the rationale
    const deployments = registry.getDeployments("agent-42");
    expect(deployments.at(-1)?.rationale).toBe("first deploy");

    // 4. Audit logs fired for the write-path tools (init + deploy)
    const broadcastCalls = (ctx.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const auditEvents = broadcastCalls.filter((c) => c[0] === "workshop_audit");
    expect(auditEvents.length).toBeGreaterThanOrEqual(2);
    const loggedTools = auditEvents.map((c) => (c[1] as { tool: string }).tool);
    expect(loggedTools).toContain("workshop_init");
    expect(loggedTools).toContain("workshop_deploy");

    // 5. Disable — reverts active pointer
    const disableOut = await runTool(cap, "workshop_disable", { rationale: "end of demo" }, ctx);
    expect(disableOut).toContain("disabled");
    expect(await registry.getActiveForAgent("agent-42")).toBeNull();
  });

  it("two sequential deploys produce distinct content-addressed versions", async () => {
    const ctx = createMockContext("agent-two");

    await runTool(cap, "workshop_init", { name: "rb" }, ctx);
    await runTool(cap, "workshop_build", { name: "rb" }, ctx);
    await runTool(cap, "workshop_deploy", { name: "rb" }, ctx);
    const v1 = await registry.getActiveForAgent("agent-two");
    expect(v1).not.toBeNull();

    // Mutate the built artifact so the next deploy is a new content hash
    sandbox.files.set(
      "/workspace/bundles/rb/dist/bundle.js",
      "export default { async fetch() { return new Response('bundle-live-v2'); } };",
    );

    await runTool(cap, "workshop_deploy", { name: "rb" }, ctx);
    const v2 = await registry.getActiveForAgent("agent-two");
    expect(v2).not.toBeNull();
    expect(v2).not.toBe(v1);

    // previous pointer now reflects v1
    expect(registry.getPointer("agent-two")?.previousVersionId).toBe(v1);

    // Note: workshop_rollback requires the D1BundleRegistry implementation
    // (in-memory registry only exposes the minimal 3-method surface).
    // Rollback is covered by packages/bundle-registry's integration tests.
  });

  it("enforces the deploy rate limit", async () => {
    const ctx = createMockContext("agent-ratelimit");
    cap = agentWorkshop({
      registry,
      sandboxExec: sandbox.sandboxExec,
      deployRateLimitPerMinute: 2,
    });

    await runTool(cap, "workshop_init", { name: "rl" }, ctx);
    await runTool(cap, "workshop_build", { name: "rl" }, ctx);

    const first = await runTool(cap, "workshop_deploy", { name: "rl" }, ctx);
    expect(first).toContain("deployed successfully");
    // Mutate bytes so the second deploy is a distinct content hash
    sandbox.files.set(
      "/workspace/bundles/rl/dist/bundle.js",
      "export default { async fetch() { return new Response('round-2'); } };",
    );
    const second = await runTool(cap, "workshop_deploy", { name: "rl" }, ctx);
    expect(second).toContain("deployed successfully");

    sandbox.files.set(
      "/workspace/bundles/rl/dist/bundle.js",
      "export default { async fetch() { return new Response('round-3'); } };",
    );
    const third = await runTool(cap, "workshop_deploy", { name: "rl" }, ctx);
    expect(third.toLowerCase()).toMatch(/rate limit|too many/);
  });

  it("workshop_versions surfaces the active version after a deploy", async () => {
    const ctx = createMockContext("agent-hist");
    await runTool(cap, "workshop_init", { name: "hist" }, ctx);
    await runTool(cap, "workshop_build", { name: "hist" }, ctx);
    await runTool(cap, "workshop_deploy", { name: "hist", rationale: "release-a" }, ctx);

    const versionsOut = await runTool(cap, "workshop_versions", {}, ctx);
    const active = await registry.getActiveForAgent("agent-hist");
    expect(active).not.toBeNull();
    expect(versionsOut).toContain(active!);
    // Full deployment history text requires D1BundleRegistry.listDeployments
  });

  it("surfaces elevation-required errors from sandboxExec", async () => {
    const notElevatedExec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr:
        "Sandbox is not elevated for this session. Call the `elevate` tool first before using workshop tools.",
      exitCode: 126,
    });
    const gated = agentWorkshop({ registry, sandboxExec: notElevatedExec });
    const ctx = createMockContext();
    const initOut = await runTool(gated, "workshop_init", { name: "x" }, ctx);
    expect(initOut.toLowerCase()).toMatch(/elevat/);
  });
});
