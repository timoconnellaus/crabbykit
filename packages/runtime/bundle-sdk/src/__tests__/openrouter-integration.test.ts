/**
 * OpenRouter bundle integration test (task 4.18).
 *
 * Exercises the bundle → LlmService streaming boundary end-to-end
 * against a mock LlmService. Asserts:
 *   - the bundle's declared model provider/modelId are forwarded to
 *     `env.LLM.inferStream(token, request)`
 *   - the bundle never sees an apiKey field (credentials live host-side)
 *   - the LLM-bound token is used, not the spine token — they're
 *     signed with different HKDF subkeys
 *   - streaming token deltas flow out via `spine.broadcast` as
 *     message_start → message_update → message_end → agent_end
 *   - the final assistant message is persisted via `spine.appendEntry`
 *   - the bundle's published source never references an OpenRouter key
 *     string — credentials never leak into the compiled artifact
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleEnv } from "../types.js";

const Dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(Dirname, "../..");

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

interface SpineMock {
  broadcast: ReturnType<typeof vi.fn>;
  broadcastGlobal: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  getEntries: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  buildContext: ReturnType<typeof vi.fn>;
  getCompactionCheckpoint: ReturnType<typeof vi.fn>;
  kvGet: ReturnType<typeof vi.fn>;
  kvPut: ReturnType<typeof vi.fn>;
  kvDelete: ReturnType<typeof vi.fn>;
  kvList: ReturnType<typeof vi.fn>;
  scheduleCreate: ReturnType<typeof vi.fn>;
  scheduleUpdate: ReturnType<typeof vi.fn>;
  scheduleDelete: ReturnType<typeof vi.fn>;
  scheduleList: ReturnType<typeof vi.fn>;
  alarmSet: ReturnType<typeof vi.fn>;
  emitCost: ReturnType<typeof vi.fn>;
}

function makeSpineMock(): SpineMock {
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
  };
}

describe("OpenRouter bundle — streaming inference path", () => {
  it("forwards provider/modelId to env.LLM.inferStream with the llm token and streams deltas", async () => {
    const llm = {
      inferStream: vi.fn().mockResolvedValue(openaiDeltaStream(["hello", " ", "world"])),
    };
    const spine = makeSpineMock();

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
      prompt: { agentName: "OpenRouterBundle" },
    });

    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", agentId: "agent-1", sessionId: "session-1" }),
      }),
      {
        __SPINE_TOKEN: "tok-spine",
        __LLM_TOKEN: "tok-llm",
        LLM: llm,
        SPINE: spine,
      } as unknown as BundleEnv,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    // Drain the body so the readable stream completes and work() finishes.
    await res.text();

    // LlmService must receive the LLM-bound token, not the spine token —
    // they're signed with different HKDF subkeys.
    expect(llm.inferStream).toHaveBeenCalledOnce();
    const [forwardedToken, request] = llm.inferStream.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(forwardedToken).toBe("tok-llm");
    expect(request).toMatchObject({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
    expect(request).not.toHaveProperty("apiKey");

    // Bundle must prepend a system message built from setup.prompt so
    // the bundle's personality reaches the model, followed by the
    // user turn.
    const reqMessages = request.messages as Array<{ role: string; content: string }>;
    expect(reqMessages).toHaveLength(2);
    expect(reqMessages[0].role).toBe("system");
    expect(reqMessages[0].content).toContain("OpenRouterBundle");
    expect(reqMessages[1]).toEqual({ role: "user", content: "hi" });

    // Streaming lifecycle should have been broadcast via spine.broadcast
    // with the spine token. Inspect the event types emitted.
    const broadcastEvents = spine.broadcast.mock.calls.map(([token, payload]) => {
      expect(token).toBe("tok-spine");
      return (payload as { event: { type: string } }).event.type;
    });
    expect(broadcastEvents[0]).toBe("message_start");
    expect(broadcastEvents.filter((t) => t === "message_update").length).toBeGreaterThanOrEqual(3);
    expect(broadcastEvents).toContain("message_end");
    expect(broadcastEvents[broadcastEvents.length - 1]).toBe("agent_end");

    // The final assistant message must be persisted via spine.appendEntry.
    expect(spine.appendEntry).toHaveBeenCalledOnce();
    const [persistToken, persistEntry] = spine.appendEntry.mock.calls[0] as [string, unknown];
    expect(persistToken).toBe("tok-spine");
    const entry = persistEntry as {
      type: string;
      data: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(entry.type).toBe("message");
    expect(entry.data.role).toBe("assistant");
    expect(entry.data.content[0]).toEqual({ type: "text", text: "hello world" });
  });

  it("surfaces an error event when LlmService rejects", async () => {
    const llm = {
      inferStream: vi.fn().mockRejectedValue(new Error("ERR_UPSTREAM_AUTH")),
    };
    const spine = makeSpineMock();

    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
    });

    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", agentId: "agent-1", sessionId: "session-1" }),
      }),
      {
        __SPINE_TOKEN: "tok-spine",
        __LLM_TOKEN: "tok-llm",
        LLM: llm,
        SPINE: spine,
      } as unknown as BundleEnv,
    );

    // The HTTP response errors out (host dispatcher increments its
    // auto-revert failure counter) but the client still gets a
    // synthetic message_end + agent_end via broadcast so the UI
    // doesn't hang.
    try {
      await res.text();
    } catch {
      // controller.error propagates as a body read failure; ignored.
    }

    const errorBroadcasts = spine.broadcast.mock.calls.filter(([, payload]) => {
      const ev = (payload as { event: { type: string; message?: { errorMessage?: string } } })
        .event;
      return ev.type === "message_end" && ev.message?.errorMessage === "ERR_UPSTREAM_AUTH";
    });
    expect(errorBroadcasts.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a /turn call that omits agentId or sessionId", async () => {
    const llm = { inferStream: vi.fn() };
    const spine = makeSpineMock();
    const bundle = defineBundleAgent({ model: { provider: "openrouter", modelId: "x" } });

    const res = await bundle.fetch(
      new Request("https://bundle/turn", {
        method: "POST",
        body: JSON.stringify({ prompt: "hi" }),
      }),
      {
        __SPINE_TOKEN: "tok-spine",
        __LLM_TOKEN: "tok-llm",
        LLM: llm,
        SPINE: spine,
      } as unknown as BundleEnv,
    );

    expect(res.status).toBe(400);
    expect(llm.inferStream).not.toHaveBeenCalled();
  });
});

describe("Credential isolation in compiled bundle source", () => {
  it("the bundle-authoring source never references an OpenRouter API key string", async () => {
    // Task 4.18: "bundle source grepped for OpenRouter key returns zero matches"
    const files = ["src/define.ts", "src/types.ts", "src/runtime.ts", "src/spine-clients.ts"];
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
    const types = await readFile(resolve(PACKAGE_ROOT, "src/types.ts"), "utf8");
    const match = types.match(/interface BundleModelConfig[^}]+\}/);
    expect(match).toBeTruthy();
    const interfaceBody = match![0];
    expect(interfaceBody).not.toMatch(/^\s*apiKey[?:]/m);
  });
});
