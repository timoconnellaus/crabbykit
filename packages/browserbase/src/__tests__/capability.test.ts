import { describe, it, expect, vi } from "vitest";
import { browserbase } from "../capability.js";
import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

function createMockStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async list<T>(prefix?: string): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}

function mockContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    stepNumber: 1,
    emitCost: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    requestFromClient: vi.fn(),
    schedules: {} as AgentContext["schedules"],
    storage: createMockStorage(),
    ...overrides,
  };
}

describe("browserbase capability", () => {
  const options = {
    apiKey: "test-key",
    projectId: "test-proj",
  };

  it("has correct id, name, and description", () => {
    const cap = browserbase(options);
    expect(cap.id).toBe("browserbase");
    expect(cap.name).toBe("Browserbase");
    expect(cap.description).toBeTruthy();
  });

  it("provides 8 tools", () => {
    const cap = browserbase(options);
    const ctx = mockContext();
    const tools = cap.tools!(ctx);

    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_open");
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_type");
    expect(names).toContain("browser_close");
    expect(names).toContain("browser_clear_state");
  });

  it("provides close_browser command", () => {
    const cap = browserbase(options);
    const ctx = mockContext();
    const commands = cap.commands!(ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("close_browser");
  });

  it("has onConnect hook", () => {
    const cap = browserbase(options);
    expect(cap.hooks?.onConnect).toBeDefined();
  });

  it("has dispose function", () => {
    const cap = browserbase(options);
    expect(cap.dispose).toBeDefined();
  });

  it("throws if no storage available", () => {
    const cap = browserbase(options);
    const ctx = mockContext({ storage: undefined });

    expect(() => cap.tools!(ctx)).toThrow("requires capability storage");
  });
});
