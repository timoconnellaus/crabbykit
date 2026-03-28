import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

const NOT_ELEVATED_RESULT = {
  content: [
    {
      type: "text" as const,
      text: "Not elevated. Call the elevate tool first to activate the sandbox.",
    },
  ],
  details: { error: "not_elevated" },
};

/**
 * Check if the sandbox is elevated. Returns a tool error result if not elevated, or null if elevated.
 */
export async function checkElevation(
  storage: CapabilityStorage | undefined,
): Promise<typeof NOT_ELEVATED_RESULT | null> {
  if (!storage) throw new Error("Sandbox capability requires storage");
  const elevated = await storage.get<boolean>("elevated");
  if (!elevated) return NOT_ELEVATED_RESULT;
  return null;
}
