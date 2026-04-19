/**
 * Phase 1 — bundle inspection cache integration test (tasks 3.13-3.16).
 *
 * Drives `runBundleTurn` end-to-end against a spine mock that captures
 * `recordPromptSections` calls. Verifies:
 *   - per-turn cache write fires once with version-keyed args
 *   - capability returning `string`/`BundlePromptSection` renders prompt
 *     identically to pre-Phase-1 (backwards-compat)
 *   - string-override path still surfaces suppressed sections to the
 *     inspection cache with `excludedReason` populated
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

async function runTurn(opts: {
  setup: Parameters<typeof defineBundleAgent>[0];
  llm: { inferStream: ReturnType<typeof vi.fn> };
  spine: ReturnType<typeof makeSpineMock>;
  bundleVersion?: string;
  prompt?: string;
}) {
  const bundle = defineBundleAgent(opts.setup);
  const res = await bundle.fetch(
    new Request("https://bundle/turn", {
      method: "POST",
      body: JSON.stringify({
        prompt: opts.prompt ?? "hi",
        agentId: "a",
        sessionId: "s",
      }),
    }),
    {
      __BUNDLE_TOKEN: "tok",
      __BUNDLE_VERSION_ID: opts.bundleVersion ?? "v1",
      LLM: opts.llm,
      SPINE: opts.spine,
    } as unknown as BundleEnv,
  );
  await res.text();
}

describe("bundle inspection cache (Phase 1)", () => {
  it("writes the normalized PromptSection[] snapshot once per turn, keyed by sessionId + bundle version", async () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "My Cap",
      description: "",
      promptSections: () => [
        "string content",
        { kind: "included", content: "Bundle entry", name: "Greet" },
      ],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    await runTurn({
      setup: {
        model: { provider: "openrouter", modelId: "x" },
        prompt: { agentName: "B" },
        capabilities: () => [cap],
      },
      llm,
      spine,
      bundleVersion: "v42",
    });

    expect(spine.recordPromptSections).toHaveBeenCalledOnce();
    const [token, sessionId, sections, versionId] = spine.recordPromptSections.mock.calls[0] as [
      string,
      string,
      unknown[],
      string,
    ];
    expect(token).toBe("tok");
    expect(sessionId).toBe("s");
    expect(versionId).toBe("v42");

    // Two normalized entries (string → custom-source, BundlePromptSection
    // → capability source).
    const arr = sections as Array<{ source: { type: string }; included: boolean }>;
    expect(arr).toHaveLength(2);
    expect(arr[0].source.type).toBe("custom");
    expect(arr[1].source.type).toBe("capability");
    expect(arr.every((s) => s.included)).toBe(true);
  });

  it("string-override suppresses sections in prompt AND surfaces them as excluded in the inspection cache", async () => {
    const cap: BundleCapability = {
      id: "x",
      name: "X",
      description: "",
      promptSections: () => ["should not appear"],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    await runTurn({
      setup: {
        model: { provider: "openrouter", modelId: "x" },
        prompt: "VERBATIM",
        capabilities: () => [cap],
      },
      llm,
      spine,
      bundleVersion: "v1",
    });

    // Prompt does not contain the section.
    const reqMessages = (
      llm.inferStream.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> }
    ).messages;
    expect(reqMessages[0].content).toBe("VERBATIM");

    // Inspection cache contains the suppressed section, marked excluded.
    const [, , sections] = spine.recordPromptSections.mock.calls[0] as [
      string,
      string,
      Array<{ included: boolean; excludedReason?: string }>,
    ];
    expect(sections).toHaveLength(1);
    expect(sections[0].included).toBe(false);
    expect(sections[0].excludedReason).toBe("Suppressed by setup.prompt: string override");
  });

  it("backwards-compat: a bundle whose capability returns only strings renders identically to pre-Phase-1", async () => {
    const cap: BundleCapability = {
      id: "x",
      name: "X",
      description: "",
      promptSections: () => ["pre-existing string section"],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    await runTurn({
      setup: {
        model: { provider: "openrouter", modelId: "x" },
        prompt: { agentName: "B" },
        capabilities: () => [cap],
      },
      llm,
      spine,
      bundleVersion: "v1",
    });
    const reqMessages = (
      llm.inferStream.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> }
    ).messages;
    expect(reqMessages[0].content).toContain("pre-existing string section");
  });

  it("when no __BUNDLE_VERSION_ID is set, no inspection write fires (best-effort)", async () => {
    const cap: BundleCapability = {
      id: "x",
      name: "X",
      description: "",
      promptSections: () => ["s"],
    };
    const llm = { inferStream: vi.fn().mockResolvedValue(textStop("ok")) };
    const spine = makeSpineMock();
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", agentId: "a", sessionId: "s" }),
      }),
      {
        __BUNDLE_TOKEN: "tok",
        // __BUNDLE_VERSION_ID intentionally omitted.
        LLM: llm,
        SPINE: spine,
      } as unknown as BundleEnv,
    );
    await res.text();
    expect(spine.recordPromptSections).not.toHaveBeenCalled();
  });
});
