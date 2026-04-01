import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

/** Configuration options for the AI proxy capability. */
export interface AiProxyOptions {
  /** OpenRouter API key — string or getter function. */
  apiKey: string | (() => string);

  /**
   * Worker's public URL so the container can call back to the AI proxy.
   * Dev: "http://host.docker.internal:5173"
   * Prod: "https://your-worker.workers.dev"
   */
  workerUrl: string;

  /** Sandbox provider for injecting env vars at elevate time. */
  provider: SandboxProvider;

  /** Base URL for the upstream AI provider. Default: "https://openrouter.ai/api/v1" */
  upstreamBaseUrl?: string;

  /**
   * Allowed model IDs. If set, requests for other models are rejected with 403.
   * Example: ["anthropic/claude-sonnet-4", "openai/gpt-4o"]
   */
  allowedModels?: string[];

  /**
   * Blocked model IDs. Checked after allowedModels.
   * If allowedModels is set, blockedModels is ignored.
   */
  blockedModels?: string[];

  /** Maximum cumulative cost in USD before requests are refused with 429. */
  sessionCostCap?: number;
}

/** Environment the AiService WorkerEntrypoint needs. */
export interface AiServiceEnv {
  OPENROUTER_API_KEY: string;
  [key: string]: unknown;
}

/** A single chat message in OpenAI format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for the AiService.chat() call. */
export interface ChatOptions {
  /** Override the upstream base URL for this call. */
  baseUrl?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Temperature (0-2). */
  temperature?: number;
}

/** Result from an AiService.chat() call. */
export interface ChatResult {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cost: number;
}
