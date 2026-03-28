import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { encrypt } from "./crypto.js";
import { getEncryptionKey, MAX_SECRET_SIZE, type StoredSecret } from "./storage.js";

export function createSaveSecretTool(context: AgentContext) {
  return defineTool({
    name: "save_secret",
    description:
      "Encrypt and store a named secret (API key, token, password). The secret is persisted across sessions and can be retrieved by other capabilities.",
    parameters: Type.Object({
      name: Type.String({
        description: "Name for the secret (e.g., OPENAI_API_KEY, GITHUB_TOKEN)",
      }),
      value: Type.String({ description: "The secret value to encrypt and store" }),
    }),
    execute: async (args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Credential store requires capability storage");

      if (args.value.length > MAX_SECRET_SIZE) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Value too large (max ${MAX_SECRET_SIZE / 1024}KB).`,
            },
          ],
          details: { error: "value_too_large" },
        };
      }

      const encryptionKey = await getEncryptionKey(storage);
      const { ciphertext, iv } = await encrypt(encryptionKey, args.value);
      const stored: StoredSecret = {
        name: args.name,
        ciphertext,
        iv,
        savedAt: new Date().toISOString(),
      };
      await storage.put(`secret:${args.name}`, stored);

      return {
        content: [{ type: "text" as const, text: `Secret saved: ${args.name}` }],
        details: { name: args.name, savedAt: stored.savedAt },
      };
    },
  });
}

export function createListSecretsTool(context: AgentContext) {
  return defineTool({
    name: "list_secrets",
    description: "List saved secrets (names only, no values).",
    parameters: Type.Object({}),
    execute: async () => {
      const storage = context.storage;
      if (!storage) throw new Error("Credential store requires capability storage");

      const all = await storage.list<StoredSecret>("secret:");
      if (all.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No saved secrets." }],
          details: { secrets: [] },
        };
      }

      const secrets = Array.from(all.values()).map((s) => ({
        name: s.name,
        savedAt: s.savedAt,
      }));
      const lines = secrets.map((s) => `${s.name} (saved ${s.savedAt})`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { secrets },
      };
    },
  });
}

export function createDeleteSecretTool(context: AgentContext) {
  return defineTool({
    name: "delete_secret",
    description: "Delete a saved secret.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the secret to delete" }),
    }),
    execute: async (args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Credential store requires capability storage");

      const deleted = await storage.delete(`secret:${args.name}`);
      if (!deleted) {
        return {
          content: [{ type: "text" as const, text: `Secret not found: ${args.name}` }],
          details: { deleted: false },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Secret deleted: ${args.name}` }],
        details: { deleted: true },
      };
    },
  });
}
