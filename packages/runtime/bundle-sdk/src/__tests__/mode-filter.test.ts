/**
 * Phase 3 — bundle SDK mode-aware dispatch tests.
 *
 * Covers the filter logic that runs inside the bundle isolate when
 * `__BUNDLE_ACTIVE_MODE` is injected by the dispatcher:
 *  - tool allow/deny filters the LLM advertisement and execute lookup
 *  - capability deny drops the cap's tools, sections, and hooks
 *  - inspection cache marks dropped sections with
 *    `excludedReason: "Filtered by mode: <id>"`
 *  - no active mode → bundle sees full inventory
 *  - string-override applies BEFORE mode filter (Decision 14)
 *  - BundleContext.activeMode = { id, name } (no allow/deny lists)
 */

import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapability, BundleEnv } from "../types.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function sseEvent(payload: unknown): Uint8Array {
  return bytes(`data: ${JSON.stringify(payload)}\n\n`);
}
function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}
function textStop(text: string): ReadableStream<Uint8Array> {
  return streamFrom([
    sseEvent({ choices: [{ delta: { content: text } }] }),
    sseEvent({ choices: [{ finish_reason: "stop" }] }),
    bytes("data: [DONE]\n\n"),
  ]);
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
    recordPromptSections: vi.fn().mockResolvedValue(undefined),
    getBundlePromptSections: vi.fn().mockResolvedValue([]),
  };
}

async function dispatch(opts: {
  setup: Parameters<typeof defineBundleAgent>[0];
  llm: { inferStream: ReturnType<typeof vi.fn> };
  spine: ReturnType<typeof makeSpineMock>;
  activeMode?: {
    id: string;
    name: string;
    tools?: { allow?: string[]; deny?: string[] };
    capabilities?: { allow?: string[]; deny?: string[] };
  };
}): Promise<Record<string, unknown>> {
  const bundle = defineBundleAgent(opts.setup);
  const env: Record<string, unknown> = {
    __BUNDLE_TOKEN: "tok",
    __BUNDLE_VERSION_ID: "v1",
    LLM: opts.llm,
    SPINE: opts.spine,
  };
  if (opts.activeMode) env.__BUNDLE_ACTIVE_MODE = opts.activeMode;
  const res = await bundle.fetch(
    new Request("https://bundle/turn", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", agentId: "a", sessionId: "s" }),
    }),
    env as unknown as BundleEnv,
  );
  await res.text();
  return opts.llm.inferStream.mock.calls[0][1] as Record<string, unknown>;
}

describe("bundle Phase 3 — mode-aware dispatch", () => {
  it("active mode tools.allow filters the LLM tool advertisement", async () => {
    const tA = { name: "task_create", description: "", parameters: {}, execute: () => "" };
    const tB = { name: "task_complete", description: "", parameters: {}, execute: () => "" };
    const tC = { name: "web_search", description: "", parameters: {}, execute: () => "" };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    const request = await dispatch({
      setup: { model: { provider: "openrouter", modelId: "x" }, tools: () => [tA, tB, tC] },
      llm,
      spine,
      activeMode: { id: "planning", name: "Planning", tools: { allow: ["task_create"] } },
    });
    const advertised = request.tools as Array<{ function: { name: string } }>;
    expect(advertised.map((t) => t.function.name)).toEqual(["task_create"]);
  });

  it("active mode capabilities.deny drops the cap's tools, sections, and hooks", async () => {
    const beforeInferenceHook = vi.fn(async (m) => m);
    const denied: BundleCapability = {
      id: "denied",
      name: "Denied",
      description: "",
      tools: () => [{ name: "denied_tool", description: "", parameters: {}, execute: () => "" }],
      promptSections: () => ["denied section content"],
      hooks: { beforeInference: beforeInferenceHook },
    };
    const allowed: BundleCapability = {
      id: "allowed",
      name: "Allowed",
      description: "",
      tools: () => [{ name: "allowed_tool", description: "", parameters: {}, execute: () => "" }],
      promptSections: () => ["allowed section content"],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    const request = await dispatch({
      setup: {
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [denied, allowed],
      },
      llm,
      spine,
      activeMode: { id: "narrow", name: "Narrow", capabilities: { deny: ["denied"] } },
    });
    const advertised = request.tools as Array<{ function: { name: string } }>;
    expect(advertised.map((t) => t.function.name)).toEqual(["allowed_tool"]);
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("allowed section content");
    expect(messages[0].content).not.toContain("denied section content");
    // beforeInference hook from denied cap MUST NOT fire for the model call.
    expect(beforeInferenceHook).not.toHaveBeenCalled();

    // Inspection cache marks the dropped section with
    // "Filtered by mode: <id>".
    const [, , sections] = spine.recordPromptSections.mock.calls[0] as [
      string,
      string,
      Array<{ key: string; included: boolean; excludedReason?: string }>,
    ];
    const denialEntry = sections.find((s) => s.key.startsWith("cap-denied-"));
    expect(denialEntry?.included).toBe(false);
    expect(denialEntry?.excludedReason).toBe("Filtered by mode: narrow");
  });

  it("no active mode → bundle sees full tool inventory", async () => {
    const tA = { name: "x", description: "", parameters: {}, execute: () => "" };
    const tB = { name: "y", description: "", parameters: {}, execute: () => "" };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    const request = await dispatch({
      setup: { model: { provider: "openrouter", modelId: "x" }, tools: () => [tA, tB] },
      llm,
      spine,
    });
    const advertised = request.tools as Array<{ function: { name: string } }>;
    expect(advertised.map((t) => t.function.name).sort()).toEqual(["x", "y"]);
  });

  it("Decision 14: setup.prompt: string + active mode → sections suppressed by string-override (mode reason ignored), tool filter still applies", async () => {
    const tA = { name: "kept", description: "", parameters: {}, execute: () => "" };
    const tB = { name: "dropped", description: "", parameters: {}, execute: () => "" };
    const cap: BundleCapability = {
      id: "x",
      name: "X",
      description: "",
      tools: () => [tA, tB],
      promptSections: () => ["X section"],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    const request = await dispatch({
      setup: {
        model: { provider: "openrouter", modelId: "x" },
        prompt: "VERBATIM",
        capabilities: () => [cap],
      },
      llm,
      spine,
      activeMode: { id: "m", name: "M", tools: { allow: ["kept"] } },
    });
    const advertised = request.tools as Array<{ function: { name: string } }>;
    expect(advertised.map((t) => t.function.name)).toEqual(["kept"]);
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toBe("VERBATIM");

    // Inspection: section is excluded with the string-override reason
    // (string-override wins over mode-filter in the inspection cache too).
    const [, , sections] = spine.recordPromptSections.mock.calls[0] as [
      string,
      string,
      Array<{ included: boolean; excludedReason?: string }>,
    ];
    expect(sections[0].included).toBe(false);
    expect(sections[0].excludedReason).toBe("Suppressed by setup.prompt: string override");
  });
});
