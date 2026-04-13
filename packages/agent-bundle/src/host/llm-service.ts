/**
 * LlmService — WorkerEntrypoint that proxies LLM inference for bundles.
 *
 * Holds provider credentials. Bundles call `env.LLM_SERVICE.infer(token, request)`
 * via service binding. Token verification ensures identity. Cost emission via spine.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { VerifyOutcome } from "../security/capability-token.js";
import { verifyToken } from "../security/capability-token.js";

// --- Types ---

export interface LlmEnv {
  /** HKDF-derived verify-only subkey for the LLM service. */
  LLM_SUBKEY: CryptoKey;
  /**
   * Spine service binding for cost emission. Typed as Fetcher to avoid
   * requiring a concrete WorkerEntrypoint type — actual calls go through
   * JSRPC at runtime.
   */
  SPINE: Fetcher & { emitCost(token: string, costEvent: unknown): Promise<void> };
  /** Provider API keys (optional — only needed providers). */
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Workers AI binding (optional). */
  AI?: Ai;
}

export interface InferRequest {
  provider: string;
  modelId: string;
  messages: unknown[];
  tools?: unknown[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface InferResponse {
  content: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: unknown[];
  finishReason?: string;
}

// --- Rate limiting ---

const DEFAULT_RATE_LIMIT = 100; // calls per minute per agent
const RATE_WINDOW_MS = 60_000;

class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;

  constructor(limit = DEFAULT_RATE_LIMIT) {
    this.limit = limit;
  }

  check(agentId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(agentId);

    if (!window || window.resetAt <= now) {
      this.windows.set(agentId, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return true;
    }

    if (window.count >= this.limit) {
      return false;
    }

    window.count++;
    return true;
  }
}

// --- LlmService ---

export class LlmService extends WorkerEntrypoint<LlmEnv> {
  private readonly rateLimiter = new RateLimiter();

  async infer(token: string, request: InferRequest): Promise<InferResponse> {
    // 1. Verify token
    const result: VerifyOutcome = await verifyToken(token, this.env.LLM_SUBKEY);
    if (!result.valid) {
      throw new Error(result.code);
    }

    const { aid: agentId } = result.payload;

    // 2. Rate limit
    if (!this.rateLimiter.check(agentId)) {
      throw new Error("ERR_RATE_LIMITED");
    }

    // 3. Route to provider
    let response: InferResponse;
    try {
      switch (request.provider) {
        case "openrouter":
          response = await this.callOpenRouter(request);
          break;
        case "anthropic":
          response = await this.callAnthropic(request);
          break;
        case "openai":
          response = await this.callOpenAI(request);
          break;
        case "workers-ai":
          response = await this.callWorkersAI(request);
          break;
        default:
          throw new Error("ERR_UNSUPPORTED_PROVIDER");
      }
    } catch (err) {
      // Sanitize errors — never leak credentials or upstream response bodies
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("ERR_")) {
        throw new Error(msg);
      }
      throw new Error("ERR_UPSTREAM_OTHER");
    }

    // 4. Emit cost
    try {
      const cost = this.estimateCost(request, response);
      if (cost > 0) {
        await this.env.SPINE.emitCost(token, {
          capabilityId: "llm-service",
          toolName: "infer",
          amount: cost,
          currency: "USD",
          detail: `${request.provider}/${request.modelId}`,
        });
      }
    } catch {
      // Cost emission failure should not block the response
    }

    return response;
  }

  /**
   * Streaming inference. Returns a ReadableStream of SSE-formatted chunks.
   * Bundles consume this across the JSRPC boundary.
   */
  async inferStream(token: string, request: InferRequest): Promise<ReadableStream<Uint8Array>> {
    const result: VerifyOutcome = await verifyToken(token, this.env.LLM_SUBKEY);
    if (!result.valid) {
      throw new Error(result.code);
    }

    const { aid: agentId } = result.payload;

    if (!this.rateLimiter.check(agentId)) {
      throw new Error("ERR_RATE_LIMITED");
    }

    // For streaming, we proxy the upstream SSE stream directly.
    // Provider routing is the same; we just pass stream: true.
    const apiKey = this.getProviderKey(request.provider);
    if (!apiKey && request.provider !== "workers-ai") {
      throw new Error("ERR_UPSTREAM_AUTH");
    }

    const streamRequest = { ...request, stream: true };

    try {
      switch (request.provider) {
        case "openrouter":
        case "openai": {
          const url =
            request.provider === "openrouter"
              ? "https://openrouter.ai/api/v1/chat/completions"
              : "https://api.openai.com/v1/chat/completions";
          const body: Record<string, unknown> = {
            model: streamRequest.modelId,
            messages: streamRequest.messages,
            stream: true,
          };
          if (streamRequest.tools) body.tools = streamRequest.tools;
          if (streamRequest.maxTokens) body.max_tokens = streamRequest.maxTokens;
          if (streamRequest.temperature !== undefined) body.temperature = streamRequest.temperature;

          const res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!res.ok || !res.body) {
            throw new Error("ERR_UPSTREAM_OTHER");
          }

          return res.body;
        }

        case "anthropic": {
          const body: Record<string, unknown> = {
            model: streamRequest.modelId,
            messages: streamRequest.messages,
            max_tokens: streamRequest.maxTokens ?? 4096,
            stream: true,
          };
          if (streamRequest.tools) body.tools = streamRequest.tools;

          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey!,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!res.ok || !res.body) {
            throw new Error("ERR_UPSTREAM_OTHER");
          }

          return res.body;
        }

        default:
          throw new Error("ERR_UNSUPPORTED_PROVIDER");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("ERR_")) throw new Error(msg);
      throw new Error("ERR_UPSTREAM_OTHER");
    }
  }

  private getProviderKey(provider: string): string | undefined {
    switch (provider) {
      case "openrouter":
        return this.env.OPENROUTER_API_KEY;
      case "anthropic":
        return this.env.ANTHROPIC_API_KEY;
      case "openai":
        return this.env.OPENAI_API_KEY;
      default:
        return undefined;
    }
  }

  // --- Provider implementations ---

  private async callOpenRouter(request: InferRequest): Promise<InferResponse> {
    const apiKey = this.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("ERR_UPSTREAM_AUTH");

    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages,
      stream: false, // Streaming handled separately
    };
    if (request.tools) body.tools = request.tools;
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("ERR_UPSTREAM_AUTH");
      if (res.status === 429) throw new Error("ERR_UPSTREAM_RATE");
      throw new Error("ERR_UPSTREAM_OTHER");
    }

    const data = (await res.json()) as Record<string, unknown>;
    return this.parseOpenAIFormat(data);
  }

  private async callAnthropic(request: InferRequest): Promise<InferResponse> {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ERR_UPSTREAM_AUTH");

    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (request.tools) body.tools = request.tools;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("ERR_UPSTREAM_AUTH");
      if (res.status === 429) throw new Error("ERR_UPSTREAM_RATE");
      throw new Error("ERR_UPSTREAM_OTHER");
    }

    const data = (await res.json()) as Record<string, unknown>;
    return this.parseAnthropicFormat(data);
  }

  private async callOpenAI(request: InferRequest): Promise<InferResponse> {
    const apiKey = this.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("ERR_UPSTREAM_AUTH");

    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages,
    };
    if (request.tools) body.tools = request.tools;
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("ERR_UPSTREAM_AUTH");
      if (res.status === 429) throw new Error("ERR_UPSTREAM_RATE");
      throw new Error("ERR_UPSTREAM_OTHER");
    }

    const data = (await res.json()) as Record<string, unknown>;
    return this.parseOpenAIFormat(data);
  }

  private async callWorkersAI(request: InferRequest): Promise<InferResponse> {
    const ai = this.env.AI;
    if (!ai) throw new Error("ERR_UPSTREAM_AUTH");

    const result = await (
      ai as unknown as {
        run: (model: string, inputs: unknown) => Promise<unknown>;
      }
    ).run(request.modelId, {
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    });

    const data = result as Record<string, unknown>;
    return {
      content: data.response ?? data.text ?? "",
      finishReason: "stop",
    };
  }

  // --- Response parsing ---

  private parseOpenAIFormat(data: Record<string, unknown>): InferResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const usage = data.usage as Record<string, unknown> | undefined;

    return {
      content: message?.content ?? "",
      toolCalls: message?.tool_calls as unknown[] | undefined,
      finishReason: (choice?.finish_reason as string) ?? "stop",
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens as number | undefined,
            outputTokens: usage.completion_tokens as number | undefined,
          }
        : undefined,
    };
  }

  private parseAnthropicFormat(data: Record<string, unknown>): InferResponse {
    const content = data.content as unknown[];
    const usage = data.usage as Record<string, unknown> | undefined;

    // Extract text content
    const textBlocks = (content ?? []).filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
    );
    const text = textBlocks.map((b) => b.text).join("");

    // Extract tool use
    const toolUseBlocks = (content ?? []).filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_use",
    );

    return {
      content: text,
      toolCalls: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
      finishReason: (data.stop_reason as string) ?? "stop",
      usage: usage
        ? {
            inputTokens: usage.input_tokens as number | undefined,
            outputTokens: usage.output_tokens as number | undefined,
          }
        : undefined,
    };
  }

  // --- Cost estimation ---

  private estimateCost(_request: InferRequest, response: InferResponse): number {
    const usage = response.usage;
    if (!usage) return 0;

    // Very rough per-token cost estimation. In production, this would be
    // looked up from a cost table per model.
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;

    // Default: $3/M input, $15/M output (Claude Sonnet-ish)
    return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  }
}
