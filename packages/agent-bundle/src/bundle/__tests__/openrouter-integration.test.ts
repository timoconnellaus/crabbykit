/**
 * OpenRouter bundle integration test (task 4.18).
 *
 * Exercises the bundle → LlmService boundary end-to-end against a mock
 * LlmService. Asserts:
 *   - the bundle's declared model provider/modelId are forwarded to
 *     `env.LLM.infer(token, request)`
 *   - the bundle never sees an apiKey field (credentials live host-side)
 *   - the bundle's published source never references an OpenRouter key
 *     string — i.e., credentials never leak into the compiled artifact
 *   - a tool-call response from LlmService round-trips through the bundle's
 *     NDJSON event stream
 *
 * NOTE: the bundle's current `handleTurn` is a single-shot LLM proxy with
 * no iterative tool-call loop. Deeper tool-call orchestration will be
 * covered by a follow-up test once the bundle runtime grows it; this test
 * locks the security-critical contract (credential isolation + provider
 * routing) into CI today.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleEnv } from "../types.js";

const Dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(Dirname, "../../..");

function makeLlmMock() {
  return {
    infer: vi.fn(),
  };
}

describe("OpenRouter bundle — full inference path", () => {
  it("forwards provider/modelId to env.LLM.infer with the llm token", async () => {
    const llm = makeLlmMock();
    llm.infer.mockResolvedValue({ content: "inference ok" });

    const bundle = defineBundleAgent({
      model: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
      },
      prompt: { agentName: "OpenRouterBundle" },
    });

    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
      }),
      {
        __SPINE_TOKEN: "tok-spine",
        __LLM_TOKEN: "tok-llm",
        LLM: llm,
      } as unknown as BundleEnv,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");

    expect(llm.infer).toHaveBeenCalledOnce();
    const [forwardedToken, request] = llm.infer.mock.calls[0];
    // LlmService must receive the LLM-bound token, not the spine token —
    // they're signed with different HKDF subkeys.
    expect(forwardedToken).toBe("tok-llm");
    expect(request).toMatchObject({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
    // Bundle must prepend a system message built from setup.prompt
    // (via buildDefaultSystemPrompt) so the bundle's personality actually
    // reaches the model, followed by the user's turn.
    const reqMessages = (request as { messages: Array<{ role: string; content: string }> })
      .messages;
    expect(reqMessages).toHaveLength(2);
    expect(reqMessages[0].role).toBe("system");
    expect(reqMessages[0].content).toContain("OpenRouterBundle");
    expect(reqMessages[1]).toEqual({ role: "user", content: "hello" });
    // Bundle must never forward an apiKey
    expect(request).not.toHaveProperty("apiKey");

    const text = await res.text();
    expect(text).toContain("inference ok");
    expect(text).toContain("agent_end");
  });

  it("surfaces an error event when LlmService rejects", async () => {
    const llm = makeLlmMock();
    llm.infer.mockRejectedValue(new Error("ERR_UPSTREAM_AUTH"));

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });

    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi" }),
      }),
      {
        __SPINE_TOKEN: "tok-spine",
        __LLM_TOKEN: "tok-llm",
        LLM: llm,
      } as unknown as BundleEnv,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ERR_UPSTREAM_AUTH");
  });

  it("returns a structured tool-call response when LlmService yields toolCalls", async () => {
    // Today the bundle's single-shot path serializes non-string content
    // with JSON.stringify, letting the host observe tool-call intents
    // in the NDJSON stream. This locks in that contract.
    const llm = makeLlmMock();
    llm.infer.mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "get_time", input: {} }],
      toolCalls: [{ id: "t1", name: "get_time", arguments: "{}" }],
    });

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    });

    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "what time is it?" }),
      }),
      {
        __SPINE_TOKEN: "tok-spine",
        __LLM_TOKEN: "tok-llm",
        LLM: llm,
      } as unknown as BundleEnv,
    );

    const text = await res.text();
    expect(text).toContain("tool_use");
    expect(text).toContain("get_time");
  });
});

describe("Credential isolation in compiled bundle source", () => {
  it("the bundle-authoring source never references an OpenRouter API key string", async () => {
    // Task 4.18: "bundle source grepped for OpenRouter key returns zero matches"
    // We simulate this by grepping the bundle subpath source on disk.
    const files = [
      "src/bundle/define.ts",
      "src/bundle/types.ts",
      "src/bundle/runtime.ts",
      "src/bundle/spine-clients.ts",
    ];
    for (const rel of files) {
      const content = await readFile(resolve(PACKAGE_ROOT, rel), "utf8");
      // A real OpenRouter key would start with `sk-or-`
      expect(content).not.toMatch(/sk-or-[A-Za-z0-9_-]{8,}/);
      // Neither a raw `OPENROUTER_API_KEY` literal reference (the bundle
      // must not even know the env var exists — that's a host concern)
      expect(content).not.toContain("OPENROUTER_API_KEY");
    }
  });

  it("the bundle subpath's ModelConfig type has no apiKey field", async () => {
    const types = await readFile(resolve(PACKAGE_ROOT, "src/bundle/types.ts"), "utf8");
    // The comment is allowed to mention apiKey in prose; the runtime
    // interface must not declare it.
    const match = types.match(/interface BundleModelConfig[^}]+\}/);
    expect(match).toBeTruthy();
    const interfaceBody = match![0];
    expect(interfaceBody).not.toMatch(/^\s*apiKey[?:]/m);
  });
});
