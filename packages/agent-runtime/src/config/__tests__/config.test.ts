import { describe, it, expect, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { textOf, TOOL_CTX } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { ConfigStore } from "../config-store.js";
import { createConfigSchema } from "../config-schema.js";
import { createConfigGet } from "../config-get.js";
import { createConfigSet } from "../config-set.js";
import type { ConfigContext } from "../types.js";
import type { ConfigNamespace } from "../config-namespace.js";
import type { KvStore } from "../../storage/types.js";
import type { Capability } from "../../capabilities/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory KvStore for testing ConfigStore. */
function createMockKvStore(): KvStore {
  const data = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
    async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of data) {
        if (!options?.prefix || k.startsWith(options.prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}

const MODEL_SCHEMA = Type.Object({ model: Type.String() });

function makeCap(overrides: Partial<Capability> & { id: string }): Capability {
  return {
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? `${overrides.id} capability`,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ConfigContext> = {}): ConfigContext {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    sessionStore: { get: vi.fn(), rename: vi.fn() } as unknown as ConfigContext["sessionStore"],
    configStore: new ConfigStore(createMockKvStore()),
    capabilities: [],
    namespaces: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

describe("ConfigStore", () => {
  it("returns undefined for unset capability config", async () => {
    const store = new ConfigStore(createMockKvStore());
    expect(await store.getCapabilityConfig("missing")).toBeUndefined();
  });

  it("round-trips capability config", async () => {
    const store = new ConfigStore(createMockKvStore());
    await store.setCapabilityConfig("my-cap", { model: "gpt-4" });
    expect(await store.getCapabilityConfig("my-cap")).toEqual({ model: "gpt-4" });
  });

  it("returns undefined for unset namespace", async () => {
    const store = new ConfigStore(createMockKvStore());
    expect(await store.getNamespace("ns")).toBeUndefined();
  });

  it("round-trips namespace config", async () => {
    const store = new ConfigStore(createMockKvStore());
    await store.setNamespace("theme", { dark: true });
    expect(await store.getNamespace("theme")).toEqual({ dark: true });
  });

  it("isolates different capabilities", async () => {
    const store = new ConfigStore(createMockKvStore());
    await store.setCapabilityConfig("cap-a", { a: 1 });
    await store.setCapabilityConfig("cap-b", { b: 2 });
    expect(await store.getCapabilityConfig("cap-a")).toEqual({ a: 1 });
    expect(await store.getCapabilityConfig("cap-b")).toEqual({ b: 2 });
  });

  it("isolates different namespaces", async () => {
    const store = new ConfigStore(createMockKvStore());
    await store.setNamespace("ns-x", { x: 1 });
    await store.setNamespace("ns-y", { y: 2 });
    expect(await store.getNamespace("ns-x")).toEqual({ x: 1 });
    expect(await store.getNamespace("ns-y")).toEqual({ y: 2 });
  });
});

// ---------------------------------------------------------------------------
// config_schema tool
// ---------------------------------------------------------------------------

describe("config_schema", () => {
  it("full listing includes session schema", async () => {
    const tool = createConfigSchema(makeCtx());
    const result = await tool.execute({}, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.session).toBeDefined();
    expect(parsed.session.properties.name).toBeDefined();
  });

  it("full listing includes capabilities", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const tool = createConfigSchema(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute({}, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.capabilities["my-cap"]).toBeDefined();
    expect(parsed.capabilities["my-cap"].configSchema).toBeTruthy();
  });

  it("full listing shows null configSchema when capability has none", async () => {
    const cap = makeCap({ id: "no-schema" });
    const tool = createConfigSchema(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute({}, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.capabilities["no-schema"].configSchema).toBeNull();
  });

  it("full listing includes namespaces", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn(),
      set: vi.fn(),
    };
    const tool = createConfigSchema(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute({}, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.theme).toBeDefined();
    expect(parsed.theme.description).toBe("Theme settings");
  });

  it("single namespace 'session' returns session schema", async () => {
    const tool = createConfigSchema(makeCtx());
    const result = await tool.execute({ namespace: "session" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.properties.name.type).toBe("string");
  });

  it("single namespace 'capability:x' returns configSchema", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const tool = createConfigSchema(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute({ namespace: "capability:my-cap" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.properties.model).toBeDefined();
  });

  it("single namespace 'capability:x' with no configSchema returns fallback", async () => {
    const cap = makeCap({ id: "no-schema" });
    const tool = createConfigSchema(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute({ namespace: "capability:no-schema" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.type).toBe("object");
    expect(parsed.description).toContain("does not accept configuration");
  });

  it("single namespace unknown capability returns error", async () => {
    const tool = createConfigSchema(makeCtx());
    const result = await tool.execute({ namespace: "capability:nope" }, TOOL_CTX);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown namespace");
  });

  it("single namespace custom returns its schema", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn(),
      set: vi.fn(),
    };
    const tool = createConfigSchema(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute({ namespace: "theme" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.properties.dark).toBeDefined();
  });

  it("single namespace unknown returns error", async () => {
    const tool = createConfigSchema(makeCtx());
    const result = await tool.execute({ namespace: "nope" }, TOOL_CTX);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown namespace");
  });
});

// ---------------------------------------------------------------------------
// config_get tool
// ---------------------------------------------------------------------------

describe("config_get", () => {
  it("reads capability config from store", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const ctx = makeCtx({ capabilities: [cap] });
    await ctx.configStore.setCapabilityConfig("my-cap", { model: "gpt-4" });
    const tool = createConfigGet(ctx);
    const result = await tool.execute({ namespace: "capability:my-cap" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.model).toBe("gpt-4");
  });

  it("falls back to configDefault when not stored", async () => {
    const cap = makeCap({
      id: "my-cap",
      configSchema: MODEL_SCHEMA,
      configDefault: { model: "default-model" },
    });
    const ctx = makeCtx({ capabilities: [cap] });
    const tool = createConfigGet(ctx);
    const result = await tool.execute({ namespace: "capability:my-cap" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.model).toBe("default-model");
  });

  it("falls back to empty object when no configDefault", async () => {
    const cap = makeCap({ id: "my-cap" });
    const ctx = makeCtx({ capabilities: [cap] });
    const tool = createConfigGet(ctx);
    const result = await tool.execute({ namespace: "capability:my-cap" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({});
  });

  it("unknown capability returns error", async () => {
    const tool = createConfigGet(makeCtx());
    const result = await tool.execute({ namespace: "capability:nope" }, TOOL_CTX);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown capability");
  });

  it("reads session name from sessionStore", async () => {
    const ctx = makeCtx();
    (ctx.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({ name: "My Session" });
    const tool = createConfigGet(ctx);
    const result = await tool.execute({ namespace: "session" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.name).toBe("My Session");
  });

  it("session with no name returns empty string", async () => {
    const ctx = makeCtx();
    (ctx.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({});
    const tool = createConfigGet(ctx);
    const result = await tool.execute({ namespace: "session" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.name).toBe("");
  });

  it("session returns empty string when session is null", async () => {
    const ctx = makeCtx();
    (ctx.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const tool = createConfigGet(ctx);
    const result = await tool.execute({ namespace: "session" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.name).toBe("");
  });

  it("reads from custom namespace via get()", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn().mockResolvedValue({ dark: true }),
      set: vi.fn(),
    };
    const tool = createConfigGet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute({ namespace: "theme" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.dark).toBe(true);
    expect(ns.get).toHaveBeenCalledWith("theme");
  });

  it("reads from pattern-matched namespace", async () => {
    const ns: ConfigNamespace = {
      id: "schedule",
      description: "Schedules",
      schema: Type.Object({ cron: Type.String() }),
      pattern: /^schedule:(.+)$/,
      get: vi.fn().mockResolvedValue({ cron: "0 9 * * *" }),
      set: vi.fn(),
    };
    const tool = createConfigGet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute({ namespace: "schedule:abc123" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.cron).toBe("0 9 * * *");
    expect(ns.get).toHaveBeenCalledWith("schedule:abc123");
  });

  it("custom namespace returning undefined gives empty object", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
    };
    const tool = createConfigGet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute({ namespace: "theme" }, TOOL_CTX);
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({});
  });

  it("unknown namespace returns error", async () => {
    const tool = createConfigGet(makeCtx());
    const result = await tool.execute({ namespace: "nope" }, TOOL_CTX);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown namespace");
  });
});

// ---------------------------------------------------------------------------
// config_set tool
// ---------------------------------------------------------------------------

describe("config_set", () => {
  it("sets capability config after validation", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const ctx = makeCtx({ capabilities: [cap] });
    const tool = createConfigSet(ctx);
    const result = await tool.execute(
      { namespace: "capability:my-cap", value: { model: "gpt-4" } },
      TOOL_CTX,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Configuration updated");
    expect(await ctx.configStore.getCapabilityConfig("my-cap")).toEqual({ model: "gpt-4" });
  });

  it("capability with no configSchema returns error", async () => {
    const cap = makeCap({ id: "my-cap" });
    const tool = createConfigSet(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute(
      { namespace: "capability:my-cap", value: { model: "gpt-4" } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not accept configuration");
  });

  it("unknown capability returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "capability:nope", value: {} },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown capability");
  });

  it("validation failure returns error with hint", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const tool = createConfigSet(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute(
      { namespace: "capability:my-cap", value: { model: 42 } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
  });

  it("fires onConfigChange hook with old and new config", async () => {
    const onConfigChange = vi.fn().mockResolvedValue(undefined);
    const cap = makeCap({
      id: "my-cap",
      configSchema: MODEL_SCHEMA,
      configDefault: { model: "old-model" },
      hooks: { onConfigChange },
    });
    const ctx = makeCtx({ capabilities: [cap] });
    const tool = createConfigSet(ctx);
    await tool.execute(
      { namespace: "capability:my-cap", value: { model: "new-model" } },
      TOOL_CTX,
    );
    expect(onConfigChange).toHaveBeenCalledOnce();
    expect(onConfigChange.mock.calls[0][0]).toEqual({ model: "old-model" });
    expect(onConfigChange.mock.calls[0][1]).toEqual({ model: "new-model" });
  });

  it("fires onConfigChange with stored config when available", async () => {
    const onConfigChange = vi.fn().mockResolvedValue(undefined);
    const cap = makeCap({
      id: "my-cap",
      configSchema: MODEL_SCHEMA,
      configDefault: { model: "default" },
      hooks: { onConfigChange },
    });
    const ctx = makeCtx({ capabilities: [cap] });
    await ctx.configStore.setCapabilityConfig("my-cap", { model: "stored" });
    const tool = createConfigSet(ctx);
    await tool.execute(
      { namespace: "capability:my-cap", value: { model: "updated" } },
      TOOL_CTX,
    );
    expect(onConfigChange.mock.calls[0][0]).toEqual({ model: "stored" });
  });

  it("onConfigChange hook error returns error", async () => {
    const cap = makeCap({
      id: "my-cap",
      configSchema: MODEL_SCHEMA,
      hooks: {
        onConfigChange: vi.fn().mockRejectedValue(new Error("hook boom")),
      },
    });
    const tool = createConfigSet(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute(
      { namespace: "capability:my-cap", value: { model: "gpt-4" } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hook boom");
  });

  it("sets session name", async () => {
    const ctx = makeCtx();
    const tool = createConfigSet(ctx);
    const result = await tool.execute(
      { namespace: "session", value: { name: "New Name" } },
      TOOL_CTX,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Session renamed to: New Name");
    expect(ctx.sessionStore.rename).toHaveBeenCalledWith("session-1", "New Name");
  });

  it("session with empty name returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "session", value: { name: "" } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("1-200 characters");
  });

  it("session with too-long name returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "session", value: { name: "x".repeat(201) } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("1-200 characters");
  });

  it("session with non-object value returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "session", value: "just a string that wont parse to obj" },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Expected { name: "..." }');
  });

  it("session with null value returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "session", value: null },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Expected { name: "..." }');
  });

  it("session with missing name property returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "session", value: { foo: "bar" } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Expected { name: "..." }');
  });

  it("sets custom namespace value", async () => {
    const setFn = vi.fn().mockResolvedValue(undefined);
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn(),
      set: setFn,
    };
    const tool = createConfigSet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute(
      { namespace: "theme", value: { dark: true } },
      TOOL_CTX,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Configuration updated: theme");
    expect(setFn).toHaveBeenCalledWith("theme", { dark: true });
  });

  it("validates custom namespace value against schema", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn(),
      set: vi.fn(),
    };
    const tool = createConfigSet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute(
      { namespace: "theme", value: { dark: "not-a-bool" } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
  });

  it("pattern-matched namespace skips validation", async () => {
    const setFn = vi.fn().mockResolvedValue(undefined);
    const ns: ConfigNamespace = {
      id: "schedule",
      description: "Schedules",
      schema: Type.Object({ cron: Type.String() }),
      pattern: /^schedule:(.+)$/,
      get: vi.fn(),
      set: setFn,
    };
    const tool = createConfigSet(makeCtx({ namespaces: [ns] }));
    // Pass value that doesn't match schema — should still succeed
    const result = await tool.execute(
      { namespace: "schedule:abc", value: { anything: 42 } },
      TOOL_CTX,
    );
    expect(result.isError).toBeUndefined();
    expect(setFn).toHaveBeenCalledWith("schedule:abc", { anything: 42 });
  });

  it("custom namespace set error returns error", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn(),
      set: vi.fn().mockRejectedValue(new Error("set failed")),
    };
    const tool = createConfigSet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute(
      { namespace: "theme", value: { dark: true } },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("set failed");
  });

  it("custom namespace set returns custom string", async () => {
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      get: vi.fn(),
      set: vi.fn().mockResolvedValue("Theme applied!"),
    };
    const tool = createConfigSet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute(
      { namespace: "theme", value: { dark: true } },
      TOOL_CTX,
    );
    expect(textOf(result)).toBe("Theme applied!");
  });

  it("unknown namespace returns error", async () => {
    const tool = createConfigSet(makeCtx());
    const result = await tool.execute(
      { namespace: "nope", value: {} },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown namespace");
  });

  it("LLM string-to-JSON parsing works", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const ctx = makeCtx({ capabilities: [cap] });
    const tool = createConfigSet(ctx);
    const result = await tool.execute(
      { namespace: "capability:my-cap", value: '{"model":"gpt-4"}' },
      TOOL_CTX,
    );
    expect(result.isError).toBeUndefined();
    expect(await ctx.configStore.getCapabilityConfig("my-cap")).toEqual({ model: "gpt-4" });
  });

  it("unparseable string stays as string (and fails validation)", async () => {
    const cap = makeCap({ id: "my-cap", configSchema: MODEL_SCHEMA });
    const tool = createConfigSet(makeCtx({ capabilities: [cap] }));
    const result = await tool.execute(
      { namespace: "capability:my-cap", value: "not json at all" },
      TOOL_CTX,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Validation error");
  });

  it("null value passes through for delete operations", async () => {
    const setFn = vi.fn().mockResolvedValue(undefined);
    const ns: ConfigNamespace = {
      id: "theme",
      description: "Theme settings",
      schema: Type.Object({ dark: Type.Boolean() }),
      pattern: /^theme$/,
      get: vi.fn(),
      set: setFn,
    };
    const tool = createConfigSet(makeCtx({ namespaces: [ns] }));
    const result = await tool.execute(
      { namespace: "theme", value: null },
      TOOL_CTX,
    );
    expect(result.isError).toBeUndefined();
    expect(setFn).toHaveBeenCalledWith("theme", null);
  });
});
