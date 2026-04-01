import type { CapabilityHttpContext } from "@claw-for-cloudflare/agent-runtime";
import { validateToken } from "./auth.js";
import type { CostEntry } from "./cost.js";
import { getCumulativeCost, persistCost } from "./cost.js";
import type { AiProxyOptions } from "./types.js";

const DEFAULT_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";
const CAPABILITY_ID = "ai-proxy";

/**
 * Create the handler for POST /ai/v1/chat/completions.
 * Returns an OpenAI-compatible chat completions proxy that:
 * 1. Validates the bearer token
 * 2. Checks model allowlist/blocklist
 * 3. Enforces session cost cap
 * 4. Proxies to OpenRouter
 * 5. Persists cost before returning response
 */
export function createChatCompletionsHandler(
  options: AiProxyOptions,
): (request: Request, ctx: CapabilityHttpContext) => Promise<Response> {
  const getApiKey =
    typeof options.apiKey === "function" ? options.apiKey : () => options.apiKey as string;
  const upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL;

  return async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
    // 1. Validate bearer token
    const authorized = await validateToken(ctx.storage, request.headers.get("authorization"));
    if (!authorized) {
      return jsonResponse(
        { error: { message: "Invalid or missing token", type: "auth_error" } },
        401,
      );
    }

    // 2. Parse request body
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse(
        { error: { message: "Invalid JSON body", type: "invalid_request" } },
        400,
      );
    }

    const model = body.model as string | undefined;
    if (!model) {
      return jsonResponse(
        { error: { message: "model is required", type: "invalid_request" } },
        400,
      );
    }

    // 3. Check model allowlist/blocklist
    if (options.allowedModels && options.allowedModels.length > 0) {
      if (!options.allowedModels.includes(model)) {
        return jsonResponse(
          { error: { message: `Model "${model}" is not allowed`, type: "model_error" } },
          403,
        );
      }
    } else if (options.blockedModels?.includes(model)) {
      return jsonResponse(
        { error: { message: `Model "${model}" is blocked`, type: "model_error" } },
        403,
      );
    }

    // 4. Check cost cap
    if (options.sessionCostCap !== undefined) {
      const currentCost = await getCumulativeCost(ctx.storage);
      if (currentCost >= options.sessionCostCap) {
        return jsonResponse(
          {
            error: {
              message: `Cost cap exceeded (${currentCost.toFixed(4)} / ${options.sessionCostCap} USD)`,
              type: "rate_limit_error",
            },
          },
          429,
        );
      }
    }

    // 5. Determine streaming mode
    const isStreaming = body.stream === true;

    // 6. Forward to OpenRouter
    const upstreamUrl = `${upstreamBaseUrl}/chat/completions`;
    const upstreamBody = { ...body };

    // For streaming, ensure usage is included in the final chunk
    if (isStreaming) {
      upstreamBody.stream_options = { include_usage: true };
    }

    const upstreamHeaders: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${getApiKey()}`,
    };

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonResponse(
        { error: { message: `Upstream error: ${message}`, type: "upstream_error" } },
        502,
      );
    }

    // If upstream returned an error, pass it through
    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: {
          "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
        },
      });
    }

    if (isStreaming) {
      return handleStreamingResponse(upstreamResponse, model, ctx);
    }
    return handleNonStreamingResponse(upstreamResponse, model, ctx);
  };
}

/** Handle a non-streaming response: read full body, extract cost, persist, return. */
async function handleNonStreamingResponse(
  upstream: Response,
  model: string,
  ctx: CapabilityHttpContext,
): Promise<Response> {
  const responseBody = await upstream.text();
  const cost = extractCostFromHeaders(upstream, model);

  // Try to extract usage from the response body
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    // not JSON, pass through
  }

  if (parsed?.usage) {
    const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number };
    cost.promptTokens = usage.prompt_tokens ?? 0;
    cost.completionTokens = usage.completion_tokens ?? 0;
  }

  // Persist cost BEFORE returning the response
  await persistCost(ctx.storage, cost);

  // Broadcast cost event to all connected clients
  ctx.broadcastToAll("cost_event", {
    capabilityId: CAPABILITY_ID,
    amount: cost.amount,
    currency: cost.currency,
    detail: `AI: ${model}`,
    metadata: {
      model,
      promptTokens: cost.promptTokens,
      completionTokens: cost.completionTokens,
    },
  });

  return new Response(responseBody, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}

/** Handle a streaming response: pipe SSE through, extract cost from final chunk. */
async function handleStreamingResponse(
  upstream: Response,
  model: string,
  ctx: CapabilityHttpContext,
): Promise<Response> {
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return jsonResponse(
      { error: { message: "No response body from upstream", type: "upstream_error" } },
      502,
    );
  }

  // Extract cost from headers immediately (available before body)
  const cost = extractCostFromHeaders(upstream, model);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const _encoder = new TextEncoder();

  // Process the stream in the background
  const processStream = async () => {
    let buffer = "";
    let lastUsageChunk: { prompt_tokens?: number; completion_tokens?: number } | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Pass through to client
        await writer.write(value);

        // Parse SSE events to find usage data
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data) as Record<string, unknown>;
            if (chunk.usage) {
              lastUsageChunk = chunk.usage as {
                prompt_tokens?: number;
                completion_tokens?: number;
              };
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    } finally {
      await writer.close();
    }

    // Update cost with usage from final chunk
    if (lastUsageChunk) {
      cost.promptTokens = lastUsageChunk.prompt_tokens ?? 0;
      cost.completionTokens = lastUsageChunk.completion_tokens ?? 0;
    }

    // Persist cost after stream completes
    await persistCost(ctx.storage, cost);

    // Broadcast cost event
    ctx.broadcastToAll("cost_event", {
      capabilityId: CAPABILITY_ID,
      amount: cost.amount,
      currency: cost.currency,
      detail: `AI: ${model}`,
      metadata: {
        model,
        promptTokens: cost.promptTokens,
        completionTokens: cost.completionTokens,
      },
    });
  };

  // Start processing without awaiting — the stream pipes independently
  processStream().catch((err) => {
    console.error("[ai-proxy] Stream processing error:", err);
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Extract cost from OpenRouter's response headers.
 * Falls back to zero if the header is not present.
 */
function extractCostFromHeaders(response: Response, model: string): CostEntry {
  const costHeader = response.headers.get("x-openrouter-cost");
  const amount = costHeader ? Number.parseFloat(costHeader) : 0;

  return {
    model,
    amount: Number.isFinite(amount) ? amount : 0,
    currency: "USD",
    promptTokens: 0,
    completionTokens: 0,
    timestamp: new Date().toISOString(),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
