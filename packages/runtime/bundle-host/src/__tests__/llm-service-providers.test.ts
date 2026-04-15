/**
 * LlmService provider branch tests (task 4.17).
 *
 * Uses the cloudflare:workers stub from ./__stubs__/ so LlmService can be
 * instantiated directly. Mocks global fetch and the SPINE service binding;
 * verifies routing, error sanitization, and credential redaction for every
 * provider branch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveMintSubkey, mintToken } from "../security/mint.js";
import type { LlmEnv } from "../services/llm-service.js";
import { LLM_SUBKEY_LABEL, LlmService } from "../services/llm-service.js";

const SECRET_OPENROUTER = "sk-or-secret-openrouter-xyz";
const SECRET_ANTHROPIC = "sk-ant-secret-anthropic-xyz";
const SECRET_OPENAI = "sk-openai-secret-xyz";
const MASTER_KEY = "test-master-key-0123456789abcdef";

async function buildEnv(
  overrides: Partial<LlmEnv> = {},
): Promise<LlmEnv & { _emitCostMock: ReturnType<typeof vi.fn> }> {
  const emitCostMock = vi.fn().mockResolvedValue(undefined);
  return {
    AGENT_AUTH_KEY: MASTER_KEY,
    SPINE: {
      emitCost: emitCostMock,
    } as unknown as LlmEnv["SPINE"],
    OPENROUTER_API_KEY: SECRET_OPENROUTER,
    ANTHROPIC_API_KEY: SECRET_ANTHROPIC,
    OPENAI_API_KEY: SECRET_OPENAI,
    ...overrides,
    _emitCostMock: emitCostMock,
  } as LlmEnv & { _emitCostMock: ReturnType<typeof vi.fn> };
}

async function makeToken(agentId = "agent-1", sessionId = "session-1"): Promise<string> {
  const subkey = await deriveMintSubkey(MASTER_KEY, LLM_SUBKEY_LABEL);
  return mintToken({ agentId, sessionId }, subkey);
}

function makeService(env: LlmEnv): LlmService {
  return new LlmService({} as never, env);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlmService token handling", () => {
  it("rejects a malformed token with ERR_MALFORMED", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    await expect(
      svc.infer("not-a-token", {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
        messages: [],
      }),
    ).rejects.toThrow("ERR_MALFORMED");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a token signed with a different key", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    const otherSubkey = await deriveMintSubkey("other-master", LLM_SUBKEY_LABEL);
    const badToken = await mintToken({ agentId: "a", sessionId: "s" }, otherSubkey);
    await expect(
      svc.infer(badToken, {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
        messages: [],
      }),
    ).rejects.toThrow("ERR_BAD_TOKEN");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("LlmService provider routing", () => {
  it("routes openrouter requests to OpenRouter API with bearer auth", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: { content: "hi", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    );

    const token = await makeToken();
    const res = await svc.infer(token, {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.content).toBe("hi");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${SECRET_OPENROUTER}`,
    });
  });

  it("routes anthropic requests with x-api-key header", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockResolvedValue(
      jsonResponse({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const token = await makeToken();
    const res = await svc.infer(token, {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      messages: [],
    });

    expect(res.content).toBe("ok");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init as RequestInit).headers).toMatchObject({
      "x-api-key": SECRET_ANTHROPIC,
    });
  });

  it("routes openai requests with bearer auth", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const token = await makeToken();
    const res = await svc.infer(token, {
      provider: "openai",
      modelId: "gpt-4o",
      messages: [],
    });

    expect(res.content).toBe("pong");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${SECRET_OPENAI}`,
    });
  });

  it("routes workers-ai through env.AI.run without touching fetch", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "llama-says-hi" });
    const env = await buildEnv({
      AI: { run: aiRun } as unknown as Ai,
    });
    const svc = makeService(env);
    const token = await makeToken();
    const res = await svc.infer(token, {
      provider: "workers-ai",
      modelId: "@cf/meta/llama-3-8b-instruct",
      messages: [],
    });

    expect(res.content).toBe("llama-says-hi");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it("rejects unknown providers with ERR_UNSUPPORTED_PROVIDER", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    const token = await makeToken();
    await expect(
      svc.infer(token, {
        provider: "bogus-provider",
        modelId: "x",
        messages: [],
      }),
    ).rejects.toThrow("ERR_UNSUPPORTED_PROVIDER");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("LlmService error sanitization and credential redaction", () => {
  it("never forwards upstream 401 bodies; surfaces ERR_UPSTREAM_AUTH", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockResolvedValue(
      new Response(`{"error":"invalid key ${SECRET_OPENROUTER}"}`, {
        status: 401,
      }),
    );
    const token = await makeToken();
    await expect(
      svc.infer(token, {
        provider: "openrouter",
        modelId: "x",
        messages: [],
      }),
    ).rejects.toThrow(/^ERR_UPSTREAM_AUTH$/);
  });

  it("surfaces ERR_UPSTREAM_RATE on 429", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const token = await makeToken();
    await expect(
      svc.infer(token, {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        messages: [],
      }),
    ).rejects.toThrow("ERR_UPSTREAM_RATE");
  });

  it("surfaces ERR_UPSTREAM_OTHER on generic fetch failure with no leaked message", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockRejectedValue(new Error(`network blew up while using key ${SECRET_OPENAI}`));
    const token = await makeToken();
    try {
      await svc.infer(token, {
        provider: "openai",
        modelId: "gpt-4o",
        messages: [],
      });
      throw new Error("unreachable");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe("ERR_UPSTREAM_OTHER");
      expect(msg).not.toContain(SECRET_OPENAI);
    }
  });

  it("returns ERR_UPSTREAM_AUTH when a provider key is missing", async () => {
    const env = await buildEnv({ OPENROUTER_API_KEY: undefined });
    const svc = makeService(env);
    const token = await makeToken();
    await expect(
      svc.infer(token, {
        provider: "openrouter",
        modelId: "x",
        messages: [],
      }),
    ).rejects.toThrow("ERR_UPSTREAM_AUTH");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("LlmService cost emission", () => {
  it("emits a cost event via SPINE when usage is present", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
    );

    const token = await makeToken();
    await svc.infer(token, {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
      messages: [],
    });

    const emitCost = (env as unknown as { _emitCostMock: ReturnType<typeof vi.fn> })._emitCostMock;
    expect(emitCost).toHaveBeenCalledOnce();
    const [forwardedToken, event] = emitCost.mock.calls[0] as [string, Record<string, unknown>];
    expect(forwardedToken).toBe(token);
    expect(event.capabilityId).toBe("llm-service");
    expect(event.toolName).toBe("infer");
    expect(event.currency).toBe("USD");
    expect(typeof event.amount).toBe("number");
    expect(event.amount).toBeGreaterThan(0);
  });

  it("does not block the response when cost emission throws", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    (env as unknown as { _emitCostMock: ReturnType<typeof vi.fn> })._emitCostMock.mockRejectedValue(
      new Error("spine down"),
    );
    mockFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const token = await makeToken();
    const res = await svc.infer(token, {
      provider: "openrouter",
      modelId: "x",
      messages: [],
    });
    expect(res.content).toBe("hi");
  });
});

describe("LlmService rate limiting", () => {
  it("enforces ERR_RATE_LIMITED after 100 calls in the same window", async () => {
    const env = await buildEnv();
    const svc = makeService(env);
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const token = await makeToken("rate-agent");
    for (let i = 0; i < 100; i++) {
      await svc.infer(token, {
        provider: "openrouter",
        modelId: "x",
        messages: [],
      });
    }
    await expect(
      svc.infer(token, {
        provider: "openrouter",
        modelId: "x",
        messages: [],
      }),
    ).rejects.toThrow("ERR_RATE_LIMITED");
  });
});
