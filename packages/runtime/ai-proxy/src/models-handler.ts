import type { CapabilityHttpContext } from "@crabbykit/agent-runtime";
import type { AiProxyOptions } from "./types.js";

/**
 * Create the handler for GET /ai/v1/models.
 * Returns the allowedModels list in OpenAI format.
 * If no allowedModels are configured, returns an empty list.
 *
 * No authentication required — interception is trusted.
 */
export function createModelsHandler(
  options: AiProxyOptions,
): (request: Request, ctx: CapabilityHttpContext) => Promise<Response> {
  return async (_request: Request, _ctx: CapabilityHttpContext): Promise<Response> => {
    const models = (options.allowedModels ?? []).map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: id.split("/")[0] ?? "unknown",
    }));

    return new Response(JSON.stringify({ object: "list", data: models }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
