import { describe, expect, it, beforeEach } from "vitest";
import type { CapabilityStorage, AgentContext } from "@claw-for-cloudflare/agent-runtime";
import {
  createMockStorage,
  textOf,
  TOOL_CTX as toolCtx,
} from "@claw-for-cloudflare/agent-runtime/test-utils";
import { encrypt, decrypt, generateKey } from "../crypto.js";
import { getEncryptionKey, getSecrets, MAX_SECRET_SIZE } from "../storage.js";
import { createSaveSecretTool, createListSecretsTool, createDeleteSecretTool } from "../tools.js";
import { credentialStore } from "../capability.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(storage?: CapabilityStorage): AgentContext {
  return { storage: storage ?? createMockStorage() } as AgentContext;
}

// ---------------------------------------------------------------------------
// crypto.ts
// ---------------------------------------------------------------------------

describe("crypto", () => {
  describe("generateKey", () => {
    it("returns a base64-encoded 256-bit key", () => {
      const key = generateKey();
      const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(bytes.length).toBe(32);
    });

    it("generates unique keys each call", () => {
      const a = generateKey();
      const b = generateKey();
      expect(a).not.toBe(b);
    });
  });

  describe("encrypt / decrypt round-trip", () => {
    it("round-trips a simple string", async () => {
      const key = generateKey();
      const { ciphertext, iv } = await encrypt(key, "hello world");
      const result = await decrypt(key, ciphertext, iv);
      expect(result).toBe("hello world");
    });

    it("round-trips an empty string", async () => {
      const key = generateKey();
      const { ciphertext, iv } = await encrypt(key, "");
      const result = await decrypt(key, ciphertext, iv);
      expect(result).toBe("");
    });

    it("round-trips unicode content", async () => {
      const key = generateKey();
      const value = "こんにちは 🔑 résumé";
      const { ciphertext, iv } = await encrypt(key, value);
      const result = await decrypt(key, ciphertext, iv);
      expect(result).toBe(value);
    });

    it("round-trips a large string", async () => {
      const key = generateKey();
      const value = "x".repeat(50_000);
      const { ciphertext, iv } = await encrypt(key, value);
      const result = await decrypt(key, ciphertext, iv);
      expect(result).toBe(value);
    });

    it("produces different ciphertexts for the same plaintext (random IV)", async () => {
      const key = generateKey();
      const a = await encrypt(key, "same");
      const b = await encrypt(key, "same");
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(a.iv).not.toBe(b.iv);
    });
  });

  describe("decrypt with wrong key", () => {
    it("throws on key mismatch", async () => {
      const key1 = generateKey();
      const key2 = generateKey();
      const { ciphertext, iv } = await encrypt(key1, "secret");
      await expect(decrypt(key2, ciphertext, iv)).rejects.toThrow();
    });
  });

  describe("decrypt with corrupted data", () => {
    it("throws on tampered ciphertext", async () => {
      const key = generateKey();
      const { ciphertext, iv } = await encrypt(key, "secret");
      // Flip a character in the ciphertext
      const corrupted = ciphertext.slice(0, -2) + "AA";
      await expect(decrypt(key, corrupted, iv)).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// storage.ts
// ---------------------------------------------------------------------------

describe("storage", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  describe("getEncryptionKey", () => {
    it("generates and persists a key on first call", async () => {
      const key = await getEncryptionKey(storage);
      expect(key).toBeTruthy();
      expect(typeof key).toBe("string");
      // Verify it was persisted
      const stored = await storage.get<string>("encryptionKey");
      expect(stored).toBe(key);
    });

    it("returns the same key on subsequent calls", async () => {
      const key1 = await getEncryptionKey(storage);
      const key2 = await getEncryptionKey(storage);
      expect(key1).toBe(key2);
    });
  });

  describe("getSecrets", () => {
    it("returns empty map when no encryption key exists", async () => {
      const secrets = await getSecrets(storage);
      expect(secrets.size).toBe(0);
    });

    it("returns empty map when key exists but no secrets stored", async () => {
      await getEncryptionKey(storage); // creates the key
      const secrets = await getSecrets(storage);
      expect(secrets.size).toBe(0);
    });

    it("returns decrypted secrets", async () => {
      const key = await getEncryptionKey(storage);
      const { ciphertext, iv } = await encrypt(key, "my-api-key");
      await storage.put("secret:API_KEY", {
        name: "API_KEY",
        ciphertext,
        iv,
        savedAt: "2026-01-01T00:00:00.000Z",
      });

      const secrets = await getSecrets(storage);
      expect(secrets.size).toBe(1);
      expect(secrets.get("API_KEY")).toBe("my-api-key");
    });

    it("returns multiple decrypted secrets", async () => {
      const key = await getEncryptionKey(storage);
      for (const [name, value] of [
        ["KEY_A", "val-a"],
        ["KEY_B", "val-b"],
        ["KEY_C", "val-c"],
      ]) {
        const { ciphertext, iv } = await encrypt(key, value);
        await storage.put(`secret:${name}`, {
          name,
          ciphertext,
          iv,
          savedAt: new Date().toISOString(),
        });
      }

      const secrets = await getSecrets(storage);
      expect(secrets.size).toBe(3);
      expect(secrets.get("KEY_A")).toBe("val-a");
      expect(secrets.get("KEY_B")).toBe("val-b");
      expect(secrets.get("KEY_C")).toBe("val-c");
    });

    it("skips secrets that fail to decrypt", async () => {
      const key = await getEncryptionKey(storage);
      // Store one valid secret
      const { ciphertext, iv } = await encrypt(key, "good-value");
      await storage.put("secret:GOOD", {
        name: "GOOD",
        ciphertext,
        iv,
        savedAt: new Date().toISOString(),
      });
      // Store one corrupted secret
      await storage.put("secret:BAD", {
        name: "BAD",
        ciphertext: "corrupted-data",
        iv: "bad-iv",
        savedAt: new Date().toISOString(),
      });

      const secrets = await getSecrets(storage);
      expect(secrets.size).toBe(1);
      expect(secrets.get("GOOD")).toBe("good-value");
      expect(secrets.has("BAD")).toBe(false);
    });
  });

  describe("MAX_SECRET_SIZE", () => {
    it("is 100KB", () => {
      expect(MAX_SECRET_SIZE).toBe(100 * 1024);
    });
  });
});

// ---------------------------------------------------------------------------
// tools.ts — save_secret
// ---------------------------------------------------------------------------

describe("save_secret tool", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("encrypts and stores a secret", async () => {
    const tool = createSaveSecretTool(makeContext(storage));
    const result = await tool.execute({ name: "MY_KEY", value: "super-secret" }, toolCtx);

    expect(textOf(result)).toBe("Secret saved: MY_KEY");
    const details = result.details as { name: string; savedAt: string };
    expect(details.name).toBe("MY_KEY");
    expect(details.savedAt).toBeTruthy();

    // Verify it was actually encrypted and stored
    const secrets = await getSecrets(storage);
    expect(secrets.get("MY_KEY")).toBe("super-secret");
  });

  it("overwrites an existing secret with the same name", async () => {
    const tool = createSaveSecretTool(makeContext(storage));
    await tool.execute({ name: "KEY", value: "original" }, toolCtx);
    await tool.execute({ name: "KEY", value: "updated" }, toolCtx);

    const secrets = await getSecrets(storage);
    expect(secrets.get("KEY")).toBe("updated");
  });

  it("rejects values exceeding MAX_SECRET_SIZE", async () => {
    const tool = createSaveSecretTool(makeContext(storage));
    const bigValue = "x".repeat(MAX_SECRET_SIZE + 1);
    const result = await tool.execute({ name: "BIG", value: bigValue }, toolCtx);

    expect(textOf(result)).toContain("too large");
    expect((result.details as { error: string }).error).toBe("value_too_large");

    // Should not have stored anything
    const secrets = await getSecrets(storage);
    expect(secrets.size).toBe(0);
  });

  it("allows values exactly at MAX_SECRET_SIZE", async () => {
    const tool = createSaveSecretTool(makeContext(storage));
    const exactValue = "x".repeat(MAX_SECRET_SIZE);
    const result = await tool.execute({ name: "EXACT", value: exactValue }, toolCtx);

    expect(textOf(result)).toBe("Secret saved: EXACT");
    const secrets = await getSecrets(storage);
    expect(secrets.get("EXACT")).toBe(exactValue);
  });

  it("throws when storage is not available", async () => {
    const tool = createSaveSecretTool({ storage: undefined } as unknown as AgentContext);
    await expect(tool.execute({ name: "X", value: "Y" }, toolCtx)).rejects.toThrow(
      "Credential store requires capability storage",
    );
  });

  it("uses a consistent encryption key across saves", async () => {
    const tool = createSaveSecretTool(makeContext(storage));
    await tool.execute({ name: "A", value: "val-a" }, toolCtx);
    await tool.execute({ name: "B", value: "val-b" }, toolCtx);

    // Both should be decryptable with the same key
    const secrets = await getSecrets(storage);
    expect(secrets.get("A")).toBe("val-a");
    expect(secrets.get("B")).toBe("val-b");
  });
});

// ---------------------------------------------------------------------------
// tools.ts — list_secrets
// ---------------------------------------------------------------------------

describe("list_secrets tool", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("returns empty message when no secrets exist", async () => {
    const tool = createListSecretsTool(makeContext(storage));
    const result = await tool.execute({}, toolCtx);

    expect(textOf(result)).toBe("No saved secrets.");
    expect((result.details as { secrets: unknown[] }).secrets).toEqual([]);
  });

  it("lists secret names and timestamps without values", async () => {
    const saveTool = createSaveSecretTool(makeContext(storage));
    await saveTool.execute({ name: "TOKEN_A", value: "secret-a" }, toolCtx);
    await saveTool.execute({ name: "TOKEN_B", value: "secret-b" }, toolCtx);

    const listTool = createListSecretsTool(makeContext(storage));
    const result = await listTool.execute({}, toolCtx);

    const details = result.details as { secrets: { name: string; savedAt: string }[] };
    expect(details.secrets).toHaveLength(2);
    const names = details.secrets.map((s) => s.name);
    expect(names).toContain("TOKEN_A");
    expect(names).toContain("TOKEN_B");

    // Content should list names but not values
    expect(textOf(result)).toContain("TOKEN_A");
    expect(textOf(result)).toContain("TOKEN_B");
    expect(textOf(result)).not.toContain("secret-a");
    expect(textOf(result)).not.toContain("secret-b");
  });

  it("throws when storage is not available", async () => {
    const tool = createListSecretsTool({ storage: undefined } as unknown as AgentContext);
    await expect(tool.execute({}, toolCtx)).rejects.toThrow(
      "Credential store requires capability storage",
    );
  });
});

// ---------------------------------------------------------------------------
// tools.ts — delete_secret
// ---------------------------------------------------------------------------

describe("delete_secret tool", () => {
  let storage: CapabilityStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("deletes an existing secret", async () => {
    const saveTool = createSaveSecretTool(makeContext(storage));
    await saveTool.execute({ name: "TO_DELETE", value: "bye" }, toolCtx);

    const deleteTool = createDeleteSecretTool(makeContext(storage));
    const result = await deleteTool.execute({ name: "TO_DELETE" }, toolCtx);

    expect(textOf(result)).toBe("Secret deleted: TO_DELETE");
    expect((result.details as { deleted: boolean }).deleted).toBe(true);

    // Verify it's gone
    const secrets = await getSecrets(storage);
    expect(secrets.has("TO_DELETE")).toBe(false);
  });

  it("reports not found for non-existent secret", async () => {
    const tool = createDeleteSecretTool(makeContext(storage));
    const result = await tool.execute({ name: "NOPE" }, toolCtx);

    expect(textOf(result)).toBe("Secret not found: NOPE");
    expect((result.details as { deleted: boolean }).deleted).toBe(false);
  });

  it("does not affect other secrets", async () => {
    const ctx = makeContext(storage);
    const saveTool = createSaveSecretTool(ctx);
    await saveTool.execute({ name: "KEEP", value: "keep-me" }, toolCtx);
    await saveTool.execute({ name: "REMOVE", value: "remove-me" }, toolCtx);

    const deleteTool = createDeleteSecretTool(ctx);
    await deleteTool.execute({ name: "REMOVE" }, toolCtx);

    const secrets = await getSecrets(storage);
    expect(secrets.size).toBe(1);
    expect(secrets.get("KEEP")).toBe("keep-me");
  });

  it("throws when storage is not available", async () => {
    const tool = createDeleteSecretTool({ storage: undefined } as unknown as AgentContext);
    await expect(tool.execute({ name: "X" }, toolCtx)).rejects.toThrow(
      "Credential store requires capability storage",
    );
  });
});

// ---------------------------------------------------------------------------
// capability.ts
// ---------------------------------------------------------------------------

describe("credentialStore capability", () => {
  it("has correct metadata", () => {
    const cap = credentialStore();
    expect(cap.id).toBe("credential-store");
    expect(cap.name).toBe("Credential Store");
    expect(cap.description).toBeTruthy();
  });

  it("returns 3 tools", () => {
    const cap = credentialStore();
    const tools = cap.tools!(makeContext());
    expect(tools).toHaveLength(3);
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("save_secret");
    expect(names).toContain("list_secrets");
    expect(names).toContain("delete_secret");
  });

  it("returns prompt sections", () => {
    const cap = credentialStore();
    const sections = cap.promptSections!({} as AgentContext);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("save_secret");
    expect(sections[0]).toContain("list_secrets");
    expect(sections[0]).toContain("delete_secret");
  });

  it("does not define schedules, hooks, or httpHandlers", () => {
    const cap = credentialStore();
    expect(cap.schedules).toBeUndefined();
    expect(cap.hooks).toBeUndefined();
    expect(cap.httpHandlers).toBeUndefined();
  });
});
