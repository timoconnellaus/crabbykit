import type { CapabilityHttpContext } from "@claw-for-cloudflare/agent-runtime";
import { validateToken } from "./auth.js";
import type { AiProxyOptions } from "./types.js";

/**
 * Create the handler for GET /ai/v1/models.
 * Returns the allowedModels list in OpenAI format.
 * If no allowedModels are configured, returns an empty list.
 */
export function createModelsHandler(
  options: AiProxyOptions,
): (request: Request, ctx: CapabilityHttpContext) => Promise<Response> {
  return async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
    const authorized = await validateToken(ctx.storage, request.headers.get("authorization"));
    if (!authorized) {
      return new Response(
        JSON.stringify({ error: { message: "Invalid or missing token", type: "auth_error" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

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
