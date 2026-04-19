/**
 * Phase 0a — bundle SDK runtime capability/tool resolution tests.
 *
 * Verifies that runBundleTurn invokes `setup.capabilities(env)` and
 * `setup.tools(env)` exactly once per turn, that capability tools and
 * prompt sections are collected against the bundle context, and that
 * capability section content is spliced into the assembled system
 * prompt unless `setup.prompt` is a string (override rule).
 *
 * Phase 0a does NOT advertise the merged tool list to the LLM — the
 * `tools` field on the inferStream request remains absent.
 */

import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapability, BundleEnv } from "../types.js";

function sseChunk(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function openaiDeltaStream(deltas: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of deltas) {
        controller.enqueue(sseChunk({ choices: [{ delta: { content: text } }] }));
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeSpineMock() {
  return {
    broadcast: vi.fn().mockResolvedValue(undefined),
    broadcastGlobal: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    getEntries: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockResolvedValue({ id: "s1" }),
    listSessions: vi.fn().mockResolvedValue([]),
    buildContext: vi.fn().mockResolvedValue([]),
    getCompactionCheckpoint: vi.fn().mockResolvedValue(null),
    kvGet: vi.fn().mockResolvedValue(undefined),
    kvPut: vi.fn().mockResolvedValue(undefined),
    kvDelete: vi.fn().mockResolvedValue(undefined),
    kvList: vi.fn().mockResolvedValue([]),
    scheduleCreate: vi.fn().mockResolvedValue(undefined),
    scheduleUpdate: vi.fn().mockResolvedValue(undefined),
    scheduleDelete: vi.fn().mockResolvedValue(undefined),
    scheduleList: vi.fn().mockResolvedValue([]),
    alarmSet: vi.fn().mockResolvedValue(undefined),
    emitCost: vi.fn().mockResolvedValue(undefined),
    recordToolExecution: vi.fn().mockResolvedValue(undefined),
    processBeforeInference: vi.fn((_t: string, m: unknown[]) => Promise.resolve(m)),
    processBeforeToolExecution: vi.fn().mockResolvedValue(undefined),
  };
}

async function dispatchTurn(opts: {
  bundle: ReturnType<typeof defineBundleAgent>;
  llm: { inferStream: ReturnType<typeof vi.fn> };
  spine: ReturnType<typeof makeSpineMock>;
  prompt?: string;
}): Promise<Record<string, unknown>> {
  const res = await opts.bundle.fetch(
    new Request("https://bundle/turn", {
      method: "POST",
      body: JSON.stringify({
        prompt: opts.prompt ?? "hi",
        agentId: "agent-1",
        sessionId: "session-1",
      }),
    }),
    {
      __BUNDLE_TOKEN: "tok",
      LLM: opts.llm,
      SPINE: opts.spine,
    } as unknown as BundleEnv,
  );
  expect(res.status).toBe(200);
  await res.text();
  const [, request] = opts.llm.inferStream.mock.calls[0] as [string, Record<string, unknown>];
  return request;
}

describe("runBundleTurn — Phase 0a capability + tool resolution", () => {
  it("invokes setup.tools(env) exactly once per turn and advertises the tool to the LLM", async () => {
    const tool = {
      name: "x",
      description: "x tool",
      parameters: { type: "object", properties: {} },
      execute: () => "x",
    };
    const toolsFactory = vi.fn(() => [tool]);
    const llm = { inferStream: vi.fn().mockResolvedValue(openaiDeltaStream(["hi"])) };
    const spine = makeSpineMock();

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      tools: toolsFactory,
    });

    const request = await dispatchTurn({ bundle, llm, spine });
    expect(toolsFactory).toHaveBeenCalledOnce();
    // Phase 0b: tools ARE advertised when present.
    const tools = request.tools as Array<{ type: string; function: { name: string } }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map((t) => t.function.name)).toContain("x");
  });

  it("invokes setup.capabilities(env) exactly once and resolves capability tools/sections/hooks against context", async () => {
    const capTool = {
      name: "cap_tool",
      description: "cap tool",
      parameters: { type: "object", properties: {} },
      execute: () => "",
    };
    const capToolsFn = vi.fn((_ctx: unknown) => [capTool]);
    const capSectionsFn = vi.fn((_ctx: unknown) => ["CAPSECTION"]);
    const cap: BundleCapability = {
      id: "x",
      name: "X",
      description: "x",
      tools: capToolsFn,
      promptSections: capSectionsFn,
      hooks: {
        beforeInference: vi.fn(async (m) => m),
        afterToolExecution: vi.fn(async () => {}),
      },
    };
    const capsFactory = vi.fn(() => [cap]);
    const llm = { inferStream: vi.fn().mockResolvedValue(openaiDeltaStream(["hi"])) };
    const spine = makeSpineMock();

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      prompt: { agentName: "B" },
      capabilities: capsFactory,
    });

    const request = await dispatchTurn({ bundle, llm, spine });
    // Called twice: once at build time by the surfaces metadata
    // extractor, once per turn by `runBundleTurn`.
    expect(capsFactory).toHaveBeenCalledTimes(2);
    expect(capToolsFn).toHaveBeenCalledOnce();
    expect(capSectionsFn).toHaveBeenCalledOnce();
    // BundleContext supplied to capability factories carries the
    // session identifiers — verify shape.
    const ctxArg = capToolsFn.mock.calls[0][0] as Record<string, unknown>;
    expect(ctxArg.agentId).toBe("agent-1");
    expect(ctxArg.sessionId).toBe("session-1");

    // Capability section content spliced into the system prompt
    // (after the default-builder output).
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("CAPSECTION");
    // Default sections still present.
    expect(messages[0].content).toContain("B");

    // Phase 0b: capability tool advertised on the LLM call.
    const tools = request.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toContain("cap_tool");
  });

  it("with neither setup.tools nor setup.capabilities follows the existing text-only path", async () => {
    const llm = { inferStream: vi.fn().mockResolvedValue(openaiDeltaStream(["hi"])) };
    const spine = makeSpineMock();

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      prompt: { agentName: "B" },
    });

    const request = await dispatchTurn({ bundle, llm, spine });
    expect(request).not.toHaveProperty("tools");
    // Single inference call (no tool loop) and exactly one assistant
    // entry persisted.
    expect(llm.inferStream).toHaveBeenCalledOnce();
    expect(spine.appendEntry).toHaveBeenCalledOnce();
  });

  it("setup.prompt: string overrides capability sections (string-override rule)", async () => {
    const cap: BundleCapability = {
      id: "x",
      name: "X",
      description: "x",
      promptSections: () => ["SHOULD_NOT_APPEAR"],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(openaiDeltaStream(["hi"])) };
    const spine = makeSpineMock();

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      prompt: "VERBATIM",
      capabilities: () => [cap],
    });

    const request = await dispatchTurn({ bundle, llm, spine });
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("VERBATIM");
    expect(messages[0].content).not.toContain("SHOULD_NOT_APPEAR");
  });
});
