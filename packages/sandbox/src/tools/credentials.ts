import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { decrypt, encrypt, generateKey } from "../crypto.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

/** Allowed credential file paths (home dotfiles, .config, .local). */
const ALLOWED_PATH_PATTERNS = [
  /^\/home\/gia\/\.[^/]+$/, // dotfiles in home: ~/.npmrc, ~/.gitconfig
  /^\/home\/gia\/\.config\//, // ~/.config/**
  /^\/home\/gia\/\.local\//, // ~/.local/**
];

const MAX_CREDENTIAL_SIZE = 100 * 1024; // 100KB

interface StoredCredential {
  type: "file" | "env";
  key: string; // normalized path or env var name
  ciphertext: string;
  iv: string;
  savedAt: string;
}

function normalizePath(p: string): string {
  return p.replace(/^~\//, "/home/gia/").replace(/\/+/g, "/");
}

function isAllowedPath(p: string): boolean {
  const normalized = normalizePath(p);
  return ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function getEncryptionKey(storage: NonNullable<AgentContext["storage"]>): Promise<string> {
  let key = await storage.get<string>("encryptionKey");
  if (!key) {
    key = generateKey();
    await storage.put("encryptionKey", key);
  }
  return key;
}

export function createSaveCredentialTool(
  provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "save_credential",
    description:
      "Save a credential (file or environment variable) that will be injected into the sandbox on elevation. File credentials are read from the container; env var credentials are provided as values.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("file"), Type.Literal("env")], {
        description: '"file" to save a config file, "env" to save an environment variable',
      }),
      key: Type.String({
        description:
          "For file: the path (e.g., ~/.npmrc). For env: the variable name (e.g., NPM_TOKEN).",
      }),
      value: Type.Optional(
        Type.String({
          description: "For env type: the value to store. For file type: omit (read from container).",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const encryptionKey = await getEncryptionKey(storage);

      if (args.type === "file") {
        const normalizedPath = normalizePath(args.key);
        if (!isAllowedPath(normalizedPath)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Path not allowed. Credentials can only be saved in ~/.config/, ~/.local/, or home dotfiles.`,
              },
            ],
            details: { error: "path_not_allowed" },
          };
        }

        // Read file from container
        const result = await provider.exec(`cat '${normalizedPath}'`, { timeout: 5000 });
        if (result.exitCode !== 0) {
          return {
            content: [
              { type: "text" as const, text: `Failed to read file: ${result.stderr || "not found"}` },
            ],
            details: { error: "file_read_failed" },
          };
        }

        if (result.stdout.length > MAX_CREDENTIAL_SIZE) {
          return {
            content: [
              { type: "text" as const, text: `File too large (max ${MAX_CREDENTIAL_SIZE / 1024}KB).` },
            ],
            details: { error: "file_too_large" },
          };
        }

        const { ciphertext, iv } = await encrypt(encryptionKey, result.stdout);
        const stored: StoredCredential = {
          type: "file",
          key: normalizedPath,
          ciphertext,
          iv,
          savedAt: new Date().toISOString(),
        };
        await storage.put(`credential:file:${normalizedPath}`, stored);

        return {
          content: [{ type: "text" as const, text: `Credential saved: ${normalizedPath}` }],
          details: { type: "file", key: normalizedPath },
        };
      }

      // Env var
      const value = args.value;
      if (!value) {
        return {
          content: [
            { type: "text" as const, text: "Missing value for env credential." },
          ],
          details: { error: "missing_value" },
        };
      }

      if (value.length > MAX_CREDENTIAL_SIZE) {
        return {
          content: [
            { type: "text" as const, text: `Value too large (max ${MAX_CREDENTIAL_SIZE / 1024}KB).` },
          ],
          details: { error: "value_too_large" },
        };
      }

      const { ciphertext, iv } = await encrypt(encryptionKey, value);
      const stored: StoredCredential = {
        type: "env",
        key: args.key,
        ciphertext,
        iv,
        savedAt: new Date().toISOString(),
      };
      await storage.put(`credential:env:${args.key}`, stored);

      return {
        content: [{ type: "text" as const, text: `Credential saved: ${args.key} (env var)` }],
        details: { type: "env", key: args.key },
      };
    },
  });
}

export function createListCredentialsTool(
  _provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "list_credentials",
    description: "List saved credentials (names only, no values).",
    parameters: Type.Object({}),
    execute: async () => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const all = await storage.list<StoredCredential>("credential:");
      if (all.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No saved credentials." }],
          details: { credentials: [] },
        };
      }

      const lines = Array.from(all.values()).map(
        (c) => `${c.type === "file" ? "file" : "env "}: ${c.key} (saved ${c.savedAt})`,
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          credentials: Array.from(all.values()).map((c) => ({
            type: c.type,
            key: c.key,
            savedAt: c.savedAt,
          })),
        },
      };
    },
  });
}

export function createDeleteCredentialTool(
  _provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "delete_credential",
    description: "Delete a saved credential.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("file"), Type.Literal("env")], {
        description: '"file" or "env"',
      }),
      key: Type.String({ description: "The path or env var name to delete." }),
    }),
    execute: async (_toolCallId, args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const storageKey =
        args.type === "file"
          ? `credential:file:${normalizePath(args.key)}`
          : `credential:env:${args.key}`;

      const deleted = await storage.delete(storageKey);
      if (!deleted) {
        return {
          content: [{ type: "text" as const, text: `Credential not found: ${args.key}` }],
          details: { deleted: false },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Credential deleted: ${args.key}` }],
        details: { deleted: true },
      };
    },
  });
}

/**
 * Inject all stored credentials into the container.
 * Called from the elevate tool after container start.
 * Returns env vars that should be passed to the container.
 */
export async function injectCredentials(
  storage: NonNullable<AgentContext["storage"]>,
  provider: SandboxProvider,
): Promise<{ files: number; envVars: Record<string, string>; errors: string[] }> {
  const encryptionKey = await storage.get<string>("encryptionKey");
  if (!encryptionKey) return { files: 0, envVars: {}, errors: [] };

  const all = await storage.list<StoredCredential>("credential:");
  if (all.size === 0) return { files: 0, envVars: {}, errors: [] };

  let files = 0;
  const envVars: Record<string, string> = {};
  const errors: string[] = [];

  for (const [, cred] of all) {
    try {
      const value = await decrypt(encryptionKey, cred.ciphertext, cred.iv);

      if (cred.type === "file") {
        // Create parent directory and write file
        const dir = cred.key.substring(0, cred.key.lastIndexOf("/"));
        await provider.exec(`mkdir -p '${dir}'`, { timeout: 5000 });
        // Use printf to avoid shell interpretation of file content
        const escaped = value.replace(/'/g, "'\\''");
        await provider.exec(`printf '%s' '${escaped}' > '${cred.key}'`, { timeout: 5000 });
        files++;
      } else {
        envVars[cred.key] = value;
      }
    } catch (err) {
      const msg = `Failed to inject ${cred.type} credential "${cred.key}": ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[sandbox] ${msg}`);
      errors.push(msg);
    }
  }

  return { files, envVars, errors };
}
