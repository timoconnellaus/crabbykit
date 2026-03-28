import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { createDeleteSecretTool, createListSecretsTool, createSaveSecretTool } from "./tools.js";

/**
 * Create a credential store capability that provides encrypted secret storage.
 *
 * Tools provided:
 * - `save_secret` — Encrypt and store a named secret
 * - `list_secrets` — List stored secret names (no values)
 * - `delete_secret` — Remove a secret
 *
 * Other capabilities can import `getSecrets()` from this package to
 * retrieve decrypted secrets at runtime (e.g., for injection into a sandbox).
 */
export function credentialStore(): Capability {
  return {
    id: "credential-store",
    name: "Credential Store",
    description: "Encrypted storage for API keys, tokens, and other secrets.",

    tools: (context: AgentContext) => {
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createSaveSecretTool(context),
        createListSecretsTool(context),
        createDeleteSecretTool(context),
      ];
      return tools;
    },

    promptSections: () => [
      "You can securely store and manage secrets (API keys, tokens, passwords) using the credential store tools. Secrets are encrypted at rest and persist across sessions. Use `save_secret` to store a secret by name, `list_secrets` to see what's stored, and `delete_secret` to remove one.",
    ],
  };
}
