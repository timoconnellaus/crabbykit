import { WorkerEntrypoint } from "cloudflare:workers";
import type { AiServiceEnv, ChatMessage, ChatOptions, ChatResult } from "./types.js";

const DEFAULT_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * WorkerEntrypoint that proxies AI inference to OpenRouter with cost tracking.
 *
 * This follows the same pattern as DbService: dynamic workers loaded via
 * WorkerLoader can't make arbitrary outbound requests or hold API keys.
 * Instead, they call this entrypoint via a service binding.
 *
 * The `start_backend` tool wrapper generates `env.AI` that delegates to
 * this service, so app code just calls `env.AI.chat(model, messages)`.
 *
 * Consumers export this class and register it as a service binding in wrangler:
 * ```jsonc
 * "services": [{
 *   "binding": "AI_SERVICE",
 *   "service": "<worker-name>",
 *   "entrypoint": "AiService"
 * }]
 * ```
 */
export class AiService extends WorkerEntrypoint<AiServiceEnv> {
  /**
   * Send a chat completion request to OpenRouter.
   * Returns the response content, usage, and cost.
   */
  async chat(model: string, messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    const apiKey = this.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY not configured");
    }

    const baseUrl = options?.baseUrl ?? DEFAULT_UPSTREAM_BASE_URL;
    const url = `${baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model,
      messages,
    };
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = result.choices?.[0]?.message?.content ?? "";
    const usage = result.usage ?? {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;

    // Extract cost from OpenRouter's response header
    const costHeader = response.headers.get("x-openrouter-cost");
    const cost = costHeader ? Number.parseFloat(costHeader) : 0;

    return {
      content,
      model: result.model ?? model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost: Number.isFinite(cost) ? cost : 0,
    };
  }
}
