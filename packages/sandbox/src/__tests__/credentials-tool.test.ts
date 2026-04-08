import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { decrypt, encrypt, generateKey } from "@claw-for-cloudflare/credential-store";
import { describe, expect, it, vi } from "vitest";
import {
  createDeleteFileCredentialTool,
  createListFileCredentialsTool,
  createSaveFileCredentialTool,
  injectCredentials,
} from "../tools/credentials.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

function createMapStorage(): CapabilityStorage {
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

const DEFAULT_CONFIG: Required<SandboxConfig> = {
  idleTimeout: 180,
  activeTimeout: 900,
  defaultCwd: "/workspace",
  defaultExecTimeout: 60_000,
};

function mockProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

function mockContext(sessionId = "test-session", storage?: CapabilityStorage): AgentContext {
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
    storage: storage ?? createMapStorage(),
  };
}

describe("save_file_credential", () => {
  it("rejects disallowed paths", async () => {
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const provider = mockProvider();
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "/etc/passwd" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not allowed");
    expect(result.details).toEqual({ error: "path_not_allowed" });
  });

  it("rejects paths outside allowed directories", async () => {
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const provider = mockProvider();
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute(
      { path: "/home/sandbox/projects/secret" },
      { toolCallId: "tc1" },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not allowed");
  });

  it("allows ~/.npmrc (home dotfile)", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({
        stdout: "registry=https://npm.example.com",
        stderr: "",
        exitCode: 0,
      }),
    });
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "~/.npmrc" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("saved");
    expect(text).toContain("/home/sandbox/.npmrc");
  });

  it("allows ~/.config/ paths", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({
        stdout: "config-data",
        stderr: "",
        exitCode: 0,
      }),
    });
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "~/.config/gh/hosts.yml" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("saved");
  });

  it("returns error when file read fails", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "No such file",
        exitCode: 1,
      }),
    });
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "~/.npmrc" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Failed to read");
    expect(result.details).toEqual({ error: "file_read_failed" });
  });

  it("rejects files exceeding size limit", async () => {
    const bigContent = "x".repeat(101 * 1024); // > 100KB
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({
        stdout: bigContent,
        stderr: "",
        exitCode: 0,
      }),
    });
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "~/.npmrc" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("too large");
    expect(result.details).toEqual({ error: "file_too_large" });
  });

  it("encrypts and stores the credential", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({
        stdout: "secret-token",
        stderr: "",
        exitCode: 0,
      }),
    });
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const tool = createSaveFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    await tool.execute({ path: "~/.npmrc" }, { toolCallId: "tc1" });

    // Should have stored an encryption key
    const encKey = await storage.get<string>("encryptionKey");
    expect(encKey).toBeTruthy();

    // Should have stored the credential
    const stored = await storage.get<{
      type: string;
      key: string;
      ciphertext: string;
      iv: string;
    }>("credential:file:/home/sandbox/.npmrc");
    expect(stored).toBeTruthy();
    expect(stored!.type).toBe("file");
    expect(stored!.key).toBe("/home/sandbox/.npmrc");

    // Decrypt and verify
    const plaintext = await decrypt(encKey!, stored!.ciphertext, stored!.iv);
    expect(plaintext).toBe("secret-token");
  });
});

describe("list_file_credentials", () => {
  it("returns empty message when no credentials", async () => {
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const provider = mockProvider();
    const tool = createListFileCredentialsTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({}, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No saved file credentials.");
    expect(result.details).toEqual({ credentials: [] });
  });

  it("lists multiple credentials", async () => {
    const storage = createMapStorage();

    // Pre-populate with two credentials
    await storage.put("credential:file:/home/sandbox/.npmrc", {
      type: "file",
      key: "/home/sandbox/.npmrc",
      ciphertext: "abc",
      iv: "def",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    await storage.put("credential:file:/home/sandbox/.config/gh/hosts.yml", {
      type: "file",
      key: "/home/sandbox/.config/gh/hosts.yml",
      ciphertext: "ghi",
      iv: "jkl",
      savedAt: "2026-01-02T00:00:00.000Z",
    });

    const ctx = mockContext("s1", storage);
    const provider = mockProvider();
    const tool = createListFileCredentialsTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({}, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("/home/sandbox/.npmrc");
    expect(text).toContain("/home/sandbox/.config/gh/hosts.yml");
    expect((result.details as { credentials: unknown[] }).credentials).toHaveLength(2);
  });
});

describe("delete_file_credential", () => {
  it("deletes an existing credential", async () => {
    const storage = createMapStorage();
    await storage.put("credential:file:/home/sandbox/.npmrc", {
      type: "file",
      key: "/home/sandbox/.npmrc",
      ciphertext: "abc",
      iv: "def",
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    const ctx = mockContext("s1", storage);
    const provider = mockProvider();
    const tool = createDeleteFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "~/.npmrc" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("deleted");
    expect(result.details).toEqual({ deleted: true });

    // Verify it's gone
    const stored = await storage.get("credential:file:/home/sandbox/.npmrc");
    expect(stored).toBeUndefined();
  });

  it("returns not found for missing credential", async () => {
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const provider = mockProvider();
    const tool = createDeleteFileCredentialTool(provider, DEFAULT_CONFIG, ctx);

    const result = await tool.execute({ path: "~/.npmrc" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
    expect(result.details).toEqual({ deleted: false });
  });
});

describe("injectCredentials", () => {
  it("returns zeros when no encryption key", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();

    const result = await injectCredentials(storage, provider);
    expect(result).toEqual({ files: 0, envVars: {}, errors: [] });
  });

  it("returns zeros when no credentials stored", async () => {
    const storage = createMapStorage();
    await storage.put("encryptionKey", generateKey());
    const provider = mockProvider();

    const result = await injectCredentials(storage, provider);
    expect(result).toEqual({ files: 0, envVars: {}, errors: [] });
  });

  it("injects file credentials into container", async () => {
    const storage = createMapStorage();
    const key = generateKey();
    await storage.put("encryptionKey", key);

    const { ciphertext, iv } = await encrypt(key, "my-secret-token");
    await storage.put("credential:file:/home/sandbox/.npmrc", {
      type: "file",
      key: "/home/sandbox/.npmrc",
      ciphertext,
      iv,
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    const execCalls: string[] = [];
    const provider = mockProvider({
      exec: vi.fn().mockImplementation(async (cmd: string) => {
        execCalls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });

    const result = await injectCredentials(storage, provider);

    expect(result.files).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Should have called mkdir -p and then written the file
    expect(execCalls.length).toBe(2);
    expect(execCalls[0]).toContain("mkdir -p");
    expect(execCalls[0]).toContain("/home/sandbox");
    expect(execCalls[1]).toContain("base64 -d");
    expect(execCalls[1]).toContain("/home/sandbox/.npmrc");
  });

  it("returns env var credentials in envVars map", async () => {
    const storage = createMapStorage();
    const key = generateKey();
    await storage.put("encryptionKey", key);

    const { ciphertext, iv } = await encrypt(key, "env-secret-value");
    await storage.put("credential:env:MY_TOKEN", {
      type: "env",
      key: "MY_TOKEN",
      ciphertext,
      iv,
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    const provider = mockProvider();
    const result = await injectCredentials(storage, provider);

    expect(result.files).toBe(0);
    expect(result.envVars).toEqual({ MY_TOKEN: "env-secret-value" });
    expect(result.errors).toHaveLength(0);
  });

  it("collects errors for failed injections without throwing", async () => {
    const storage = createMapStorage();
    const key = generateKey();
    await storage.put("encryptionKey", key);

    // Store a credential with invalid ciphertext to cause decrypt to fail
    await storage.put("credential:file:/home/sandbox/.bad", {
      type: "file",
      key: "/home/sandbox/.bad",
      ciphertext: "not-valid-ciphertext",
      iv: "not-valid-iv",
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    const provider = mockProvider();
    const result = await injectCredentials(storage, provider);

    expect(result.files).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("/home/sandbox/.bad");
  });
});
