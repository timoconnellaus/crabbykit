/**
 * ServiceLlmProvider — bundle-side adapter that RPCs to LlmService via service binding.
 *
 * Used automatically when a bundle's model() returns { provider, modelId } without apiKey.
 * Reads the capability token from env.__LLM_TOKEN — a per-service token signed
 * with the LLM HKDF subkey. Do NOT use __SPINE_TOKEN here: SpineService and
 * LlmService verify with different subkeys, so mixing tokens fails with
 * ERR_BAD_TOKEN.
 */

import type { BundleEnv } from "../types.js";

export interface LlmServiceBinding {
  infer(
    token: string,
    request: {
      provider: string;
      modelId: string;
      messages: unknown[];
      tools?: unknown[];
      stream?: boolean;
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<{
    content: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
    toolCalls?: unknown[];
    finishReason?: string;
  }>;
}

/**
 * Create an LLM provider that proxies through LlmService.
 */
export function createServiceLlmProvider(env: BundleEnv, llmService: LlmServiceBinding) {
  return {
    async infer(request: {
      provider: string;
      modelId: string;
      messages: unknown[];
      tools?: unknown[];
      maxTokens?: number;
      temperature?: number;
    }) {
      const token = env.__LLM_TOKEN;
      if (!token) {
        throw new Error("Missing __LLM_TOKEN — cannot call LlmService without a token");
      }

      return llmService.infer(token, request);
    },
  };
}
