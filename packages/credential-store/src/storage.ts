import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { decrypt, generateKey } from "./crypto.js";

/** Shape of an encrypted secret in storage. */
export interface StoredSecret {
  name: string;
  ciphertext: string;
  iv: string;
  savedAt: string;
}

const MAX_SECRET_SIZE = 100 * 1024; // 100KB

/**
 * Get or create the AES-256-GCM encryption key for this capability's storage.
 * The key is generated once and persisted — all secrets share the same key.
 */
export async function getEncryptionKey(storage: CapabilityStorage): Promise<string> {
  let key = await storage.get<string>("encryptionKey");
  if (!key) {
    key = generateKey();
    await storage.put("encryptionKey", key);
  }
  return key;
}

/**
 * Retrieve all stored secrets as a Map of name → decrypted value.
 * Useful for other capabilities (e.g., sandbox) that need to inject secrets.
 *
 * Errors on individual secrets are logged and skipped — partial results are returned.
 */
export async function getSecrets(storage: CapabilityStorage): Promise<Map<string, string>> {
  const encryptionKey = await storage.get<string>("encryptionKey");
  if (!encryptionKey) return new Map();

  const all = await storage.list<StoredSecret>("secret:");
  if (all.size === 0) return new Map();

  const result = new Map<string, string>();
  for (const [, secret] of all) {
    try {
      const value = await decrypt(encryptionKey, secret.ciphertext, secret.iv);
      result.set(secret.name, value);
    } catch (err) {
      console.error(
        `[credential-store] Failed to decrypt secret "${secret.name}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

export { MAX_SECRET_SIZE };
