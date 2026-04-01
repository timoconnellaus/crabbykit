import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { clearToken, generateProxyToken, storeToken } from "./auth.js";
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
 * When the sandbox elevates, this capability generates a bearer token and
 * injects `CLAW_AI_BASE_URL` + `CLAW_AI_TOKEN` into the container. Apps
 * use the standard OpenAI SDK with these env vars. All requests route
 * through the Agent DO's HTTP handler, which proxies to OpenRouter and
 * tracks costs. The API key never enters the container.
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
 *       workerUrl: this.env.WORKER_URL ?? "http://host.docker.internal:5173",
 *       provider: this.sandboxProvider,
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
        // On elevate: generate token, inject env vars into container
        if (event.toolName === "elevate" && !event.isError) {
          const token = generateProxyToken();
          await storeToken(ctx.storage, token);
          await resetCost(ctx.storage);

          const url = `${options.workerUrl}/agent/${ctx.agentId}/ai/v1`;
          try {
            await options.provider.start({
              envVars: {
                CLAW_AI_BASE_URL: url,
                CLAW_AI_TOKEN: token,
              },
            });
          } catch (err) {
            console.warn("[ai-proxy] Failed to inject env vars into container:", err);
          }
        }

        // On de-elevate: clear token
        if (event.toolName === "de_elevate") {
          await clearToken(ctx.storage);
        }
      },
    },

    promptSections: () => [
      "AI Access for Vibe-Coded Apps:\n" +
        "Apps can call AI models via the OpenAI SDK using injected environment variables.\n" +
        "These are set automatically when the sandbox is elevated.\n\n" +
        "Example (server-side, in your Bun server):\n" +
        "```\n" +
        'import OpenAI from "openai";\n' +
        "const ai = new OpenAI({\n" +
        "  baseURL: process.env.CLAW_AI_BASE_URL,\n" +
        "  apiKey: process.env.CLAW_AI_TOKEN,\n" +
        "});\n" +
        "const response = await ai.chat.completions.create({\n" +
        '  model: "anthropic/claude-sonnet-4",\n' +
        '  messages: [{ role: "user", content: "Hello" }],\n' +
        "});\n" +
        "console.log(response.choices[0].message.content);\n" +
        "```\n\n" +
        "Key rules:\n" +
        "- Always use `process.env.CLAW_AI_BASE_URL` and `process.env.CLAW_AI_TOKEN` — never hardcode API keys\n" +
        "- Costs are tracked automatically through the proxy\n" +
        "- Both streaming and non-streaming are supported\n" +
        (options.allowedModels?.length
          ? `- Available models: ${options.allowedModels.join(", ")}\n`
          : "") +
        (options.sessionCostCap !== undefined
          ? `- Cost cap: $${options.sessionCostCap} USD per session\n`
          : ""),
    ],
  };
}
