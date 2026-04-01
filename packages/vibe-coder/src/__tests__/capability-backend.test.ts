import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
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
  };
}

function mockBackendOptions(): BackendOptions {
  return {
    loader: { get: vi.fn() } as any,
    dbService: { exec: vi.fn(), batch: vi.fn() } as any,
  };
}

function mockDeployOptions() {
  return {
    storage: {
      bucket: () => ({}) as any,
      namespace: () => "test-ns",
    },
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

    it("includes deploy_app when deploy is configured alongside backend", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
        deploy: mockDeployOptions(),
      });
      const tools = cap.tools!(mockContext());
      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.name)).toContain("deploy_app");
    });
  });

  describe("prompt sections", () => {
    it("includes fullstack Bun workflow when backend is configured", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections).toHaveLength(1);
      expect(sections[0]).toContain("Bun");
      expect(sections[0]).toContain("Bun.serve");
      expect(sections[0]).toContain("bun:sqlite");
    });

    it("includes frontend-only Bun workflow without backend", () => {
      const cap = vibeCoder({ provider: mockProvider() });
      const sections = cap.promptSections!(mockContext());
      expect(sections).toHaveLength(1);
      expect(sections[0]).toContain("Bun");
      expect(sections[0]).toContain("Bun.serve");
      expect(sections[0]).not.toContain("bun:sqlite");
    });

    it("includes deploy section when deploy is configured", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
        deploy: mockDeployOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections).toHaveLength(2);
      expect(sections[1]).toContain("Deploying");
      expect(sections[1]).toContain("deploy_app");
    });

    it("fullstack prompt includes database example with bun:sqlite", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections[0]).toContain("Database");
      expect(sections[0]).toContain("bun:sqlite");
      expect(sections[0]).toContain("/api/items");
    });

    it("fullstack prompt includes HTML import pattern", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections[0]).toContain('import homepage from "./index.html"');
      expect(sections[0]).toContain("routes");
    });

    it("fullstack prompt mentions HMR and development mode", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections[0]).toContain("HMR");
      expect(sections[0]).toContain("development: true");
    });

    it("prompts mention show_preview", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections[0]).toContain("show_preview");
    });

    it("prompts include hostname binding for container networking", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections[0]).toContain("0.0.0.0");
    });

    it("does not mention Vite or clawForCloudflare plugin", () => {
      const cap = vibeCoder({
        provider: mockProvider(),
        backend: mockBackendOptions(),
      });
      const sections = cap.promptSections!(mockContext());
      expect(sections[0]).not.toContain("Vite");
      expect(sections[0]).not.toContain("clawForCloudflare");
      expect(sections[0]).not.toContain("vite");
    });
  });
});
