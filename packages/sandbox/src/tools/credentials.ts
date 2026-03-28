import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { decrypt, encrypt, generateKey } from "@claw-for-cloudflare/credential-store";
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

/**
 * Save a file from the container as an encrypted credential.
 * The file is read from the running container and stored encrypted in DO storage.
 * On next elevation, it will be injected back into the container.
 */
export function createSaveFileCredentialTool(
  provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "save_file_credential",
    description:
      "Save a config file from the sandbox as a persistent credential. The file will be read from the container and encrypted. On next elevation, it will be restored automatically. Only files in ~/.config/, ~/.local/, or home dotfiles are allowed.",
    parameters: Type.Object({
      path: Type.String({
        description: "The file path in the container (e.g., ~/.npmrc, ~/.config/gh/hosts.yml)",
      }),
    }),
    execute: async (args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const normalizedPath = normalizePath(args.path);
      if (!isAllowedPath(normalizedPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Path not allowed. Credentials can only be saved in ~/.config/, ~/.local/, or home dotfiles.",
            },
          ],
          details: { error: "path_not_allowed" },
        };
      }

      // Read file from container
      const escapedPath = normalizedPath.replace(/'/g, "'\\''");
      const result = await provider.exec(`cat '${escapedPath}'`, { timeout: 5000 });
      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to read file: ${result.stderr || "not found"}`,
            },
          ],
          details: { error: "file_read_failed" },
        };
      }

      if (result.stdout.length > MAX_CREDENTIAL_SIZE) {
        return {
          content: [
            {
              type: "text" as const,
              text: `File too large (max ${MAX_CREDENTIAL_SIZE / 1024}KB).`,
            },
          ],
          details: { error: "file_too_large" },
        };
      }

      const encryptionKey = await getEncryptionKey(storage);
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
        content: [{ type: "text" as const, text: `File credential saved: ${normalizedPath}` }],
        details: { type: "file", key: normalizedPath },
      };
    },
  });
}

/**
 * List all stored sandbox credentials (file-type only).
 */
export function createListFileCredentialsTool(
  _provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "list_file_credentials",
    description: "List saved file credentials that will be restored on sandbox elevation.",
    parameters: Type.Object({}),
    execute: async () => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const all = await storage.list<StoredCredential>("credential:file:");
      if (all.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No saved file credentials." }],
          details: { credentials: [] },
        };
      }

      const credentials = Array.from(all.values()).map((c) => ({
        path: c.key,
        savedAt: c.savedAt,
      }));
      const lines = credentials.map((c) => `${c.path} (saved ${c.savedAt})`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { credentials },
      };
    },
  });
}

/**
 * Delete a stored file credential.
 */
export function createDeleteFileCredentialTool(
  _provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "delete_file_credential",
    description: "Delete a saved file credential so it is no longer restored on elevation.",
    parameters: Type.Object({
      path: Type.String({ description: "The file path to delete (e.g., ~/.npmrc)" }),
    }),
    execute: async (args) => {
      const storage = context.storage;
      if (!storage) throw new Error("Sandbox capability requires storage");

      const normalizedPath = normalizePath(args.path);
      const deleted = await storage.delete(`credential:file:${normalizedPath}`);
      if (!deleted) {
        return {
          content: [
            { type: "text" as const, text: `File credential not found: ${normalizedPath}` },
          ],
          details: { deleted: false },
        };
      }

      return {
        content: [{ type: "text" as const, text: `File credential deleted: ${normalizedPath}` }],
        details: { deleted: true },
      };
    },
  });
}

/**
 * Inject all stored file credentials into the container.
 * Called from the elevate tool after container start.
 * Returns env vars from the credential-store capability that should be passed to the container.
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
        // Escape single quotes in paths and values to prevent shell injection
        const dir = cred.key.substring(0, cred.key.lastIndexOf("/"));
        const escapedDir = dir.replace(/'/g, "'\\''");
        await provider.exec(`mkdir -p '${escapedDir}'`, { timeout: 5000 });
        // Base64-encode the value to safely transport it through the shell
        const b64Value = btoa(value);
        const escapedKey = cred.key.replace(/'/g, "'\\''");
        await provider.exec(`printf '%s' '${b64Value}' | base64 -d > '${escapedKey}'`, {
          timeout: 5000,
        });
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
