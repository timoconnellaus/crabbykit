import type { AgentContext, Capability } from "@crabbykit/agent-runtime";
import { resetCost } from "./cost.js";
import { createModelsHandler } from "./models-handler.js";
import { createChatCompletionsHandler } from "./proxy-handler.js";
import type { AiProxyOptions } from "./types.js";

/**
 * Create an AI proxy capability that provides OpenAI-compatible inference
 * to vibe-coded apps with mandatory cost tracking.
 *
 * ## How it works
 *
 * **Development (Container/Sandbox):**
 * Container apps reach the AI proxy via `http://ai.internal/v1` which is
 * intercepted by the SandboxContainer DO and routed to OpenRouter. No
 * tokens or env vars are needed — interception is trusted.
 *
 * For legacy compatibility, the HTTP handlers also accept bearer token
 * authentication on the Agent DO's `/ai/v1/*` endpoints.
 *
 * **Deployed Apps (Worker Loader):**
 * Deployed backend workers receive `env.AI` via the AiService
 * WorkerEntrypoint (configured as a service binding). The entrypoint
 * proxies to OpenRouter and returns cost metadata.
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     aiProxy({
 *       apiKey: () => this.env.OPENROUTER_API_KEY,
 *       allowedModels: ["anthropic/claude-sonnet-4", "openai/gpt-4o-mini"],
 *       sessionCostCap: 1.0,
 *     }),
 *   ];
 * }
 * ```
 */
export function aiProxy(options: AiProxyOptions): Capability {
  return {
    id: "ai-proxy",
    name: "AI Proxy",
    description: "OpenAI-compatible AI inference proxy with mandatory cost tracking.",

    httpHandlers: (_context: AgentContext) => [
      {
        method: "POST" as const,
        path: "/ai/v1/chat/completions",
        handler: createChatCompletionsHandler(options),
      },
      {
        method: "GET" as const,
        path: "/ai/v1/models",
        handler: createModelsHandler(options),
      },
    ],

    hooks: {
      afterToolExecution: async (event, ctx) => {
        // On elevate: reset cost tracking for the new session
        if (event.toolName === "elevate" && !event.isError) {
          await resetCost(ctx.storage);
        }
      },
    },
  };
}
