import type { AgentContext } from "@crabbykit/agent-runtime";
import type { SandboxProvider } from "@crabbykit/sandbox";
import { describe, expect, it, vi } from "vitest";
import { vibeCoder } from "../capability.js";
import type { BackendOptions } from "../types.js";

vi.mock("@cloudflare/worker-bundler", () => ({
  createWorker: vi.fn().mockResolvedValue({
    mainModule: "index.js",
    modules: { "index.js": "" },
  }),
}));

function mockProvider(): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setDevPort: vi.fn().mockResolvedValue(undefined),
    clearDevPort: vi.fn().mockResolvedValue(undefined),
  };
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
    requestFromClient: vi.fn().mockResolvedValue({}),
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

function mockBackendOptions(): BackendOptions {
  return {
    loader: { get: vi.fn() } as any,
    dbService: { exec: vi.fn(), batch: vi.fn() } as any,
  };
}

describe("vibeCoder with backend option", () => {
  describe("tool registration", () => {
    it("does not add extra tools when backend is configured (backend runs in Bun, not as a tool)", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const tools = cap.tools!(mockContext());
      const names = tools.map((t) => t.name);
      // Backend doesn't add tools — the Bun app runs in the container
      expect(names).toEqual(["show_preview", "hide_preview", "get_console_logs"]);
    });

    it("does not include deploy_app even with backend configured", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const tools = cap.tools!(mockContext());
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).not.toContain("deploy_app");
    });
  });

  // promptSections were intentionally removed (commit ce3aa1f) — fullstack Bun
  // workflow guidance moved to the vibe-webapp skill so it's loaded on demand
  // rather than baked into every system prompt.
  describe("prompt sections", () => {
    it("does not contribute prompt sections (content moved to vibe-webapp skill)", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      expect(cap.promptSections).toBeUndefined();
    });

    it("frontend-only configuration also contributes no prompt sections", () => {
      const cap = vibeCoder({ provider: mockProvider() });
      expect(cap.promptSections).toBeUndefined();
    });
  });
});
