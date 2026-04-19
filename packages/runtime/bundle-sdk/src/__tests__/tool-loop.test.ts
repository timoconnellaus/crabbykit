/**
 * Phase 0b — bundle tool-execution loop tests (tasks 2.12, 2.14).
 *
 * Verifies:
 *  - single tool-call round-trips and re-inferences
 *  - two tool calls in one assistant message both execute before
 *    re-inference
 *  - blocked tool-call path appends the deny reason without executing
 *  - bundle-side `afterToolExecution` fires BEFORE host hook bridge
 *    `recordToolExecution`
 *  - iteration cap throws the expected error
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

function toolCallEvent(opts: {
  index: number;
  id: string;
  name: string;
  arguments: string;
}): Uint8Array {
  return sseEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: opts.index,
              id: opts.id,
              type: "function",
              function: { name: opts.name, arguments: opts.arguments },
            },
          ],
        },
      },
    ],
  });
}

function toolCallsFinish(): Uint8Array {
  return sseEvent({ choices: [{ finish_reason: "tool_calls" }] });
}

function textThenStop(text: string): Uint8Array[] {
  return [
    sseEvent({ choices: [{ delta: { content: text } }] }),
    sseEvent({ choices: [{ finish_reason: "stop" }] }),
    bytes("data: [DONE]\n\n"),
  ];
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

async function runTurn(opts: {
  setup: Parameters<typeof defineBundleAgent>[0];
  llm: { inferStream: ReturnType<typeof vi.fn> };
  spine: ReturnType<typeof makeSpineMock>;
}): Promise<{ status: number }> {
  const bundle = defineBundleAgent(opts.setup);
  const res = await bundle.fetch(
    new Request("https://bundle/turn", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", agentId: "a", sessionId: "s" }),
    }),
    {
      __BUNDLE_TOKEN: "tok",
      LLM: opts.llm,
      SPINE: opts.spine,
    } as unknown as BundleEnv,
  );
  // Drain so work() finishes
  try {
    await res.text();
  } catch {
    /* ignored */
  }
  return { status: res.status };
}

describe("bundle tool-execution loop", () => {
  it("single tool call: executes, broadcasts tool_event, re-runs inference, finishes on stop", async () => {
    const tool = {
      name: "search",
      description: "search the web",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      execute: vi.fn().mockResolvedValue("found 3 results"),
    };
    const inferStream = vi
      .fn()
      // First call: model emits one tool call
      .mockResolvedValueOnce(
        streamFrom([
          toolCallEvent({ index: 0, id: "c1", name: "search", arguments: '{"q":"hi"}' }),
          toolCallsFinish(),
        ]),
      )
      // Second call: model finishes with text
      .mockResolvedValueOnce(streamFrom(textThenStop("done.")));
    const spine = makeSpineMock();

    await runTurn({
      setup: { model: { provider: "openrouter", modelId: "x" }, tools: () => [tool] },
      llm: { inferStream },
      spine,
    });

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(tool.execute.mock.calls[0][0]).toEqual({ q: "hi" });
    expect(inferStream).toHaveBeenCalledTimes(2);

    // Second inferStream call must include the tool result back as a `role: tool` message.
    const secondCallReq = inferStream.mock.calls[1][1] as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMsg = secondCallReq.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("c1");
    expect(toolMsg?.content).toBe("found 3 results");

    // tool_event broadcasts fired
    const broadcastTypes = spine.broadcast.mock.calls.map(
      ([, payload]) => (payload as { type: string }).type,
    );
    expect(broadcastTypes).toContain("tool_event");

    const toolEvents = spine.broadcast.mock.calls
      .map(([, payload]) => payload as { type: string; event: { type: string } })
      .filter((p) => p.type === "tool_event")
      .map((p) => p.event.type);
    expect(toolEvents).toEqual(["tool_execution_start", "tool_execution_end"]);

    // recordToolExecution fired bundle-side via the host bridge.
    expect(spine.recordToolExecution).toHaveBeenCalledOnce();
  });

  it("two parallel tool calls: both execute (sequentially) before re-inference", async () => {
    const t1 = {
      name: "f1",
      description: "",
      parameters: {},
      execute: vi.fn().mockResolvedValue("r1"),
    };
    const t2 = {
      name: "f2",
      description: "",
      parameters: {},
      execute: vi.fn().mockResolvedValue("r2"),
    };
    const inferStream = vi
      .fn()
      .mockResolvedValueOnce(
        streamFrom([
          sseEvent({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "a", function: { name: "f1", arguments: "{}" } },
                    { index: 1, id: "b", function: { name: "f2", arguments: "{}" } },
                  ],
                },
              },
            ],
          }),
          toolCallsFinish(),
        ]),
      )
      .mockResolvedValueOnce(streamFrom(textThenStop("done")));
    const spine = makeSpineMock();
    await runTurn({
      setup: { model: { provider: "openrouter", modelId: "x" }, tools: () => [t1, t2] },
      llm: { inferStream },
      spine,
    });
    expect(t1.execute).toHaveBeenCalledOnce();
    expect(t2.execute).toHaveBeenCalledOnce();

    const secondReq = inferStream.mock.calls[1][1] as { messages: Array<Record<string, unknown>> };
    const toolMsgs = secondReq.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(["a", "b"]);
  });

  it("blocked tool-call: deny reason appended to model, execute NOT called", async () => {
    const tool = {
      name: "search",
      description: "",
      parameters: {},
      execute: vi.fn().mockResolvedValue("never-runs"),
    };
    const inferStream = vi
      .fn()
      .mockResolvedValueOnce(
        streamFrom([
          toolCallEvent({ index: 0, id: "blk", name: "search", arguments: "{}" }),
          toolCallsFinish(),
        ]),
      )
      .mockResolvedValueOnce(streamFrom(textThenStop("ack")));
    const spine = makeSpineMock();
    spine.processBeforeToolExecution.mockResolvedValue({ block: true, reason: "denied by policy" });

    await runTurn({
      setup: { model: { provider: "openrouter", modelId: "x" }, tools: () => [tool] },
      llm: { inferStream },
      spine,
    });

    expect(tool.execute).not.toHaveBeenCalled();
    const secondReq = inferStream.mock.calls[1][1] as { messages: Array<Record<string, unknown>> };
    const toolMsg = secondReq.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("denied by policy");

    // tool_execution_end event for the blocked call still broadcast,
    // marked isError so the UI can render the denial.
    const endEvent = spine.broadcast.mock.calls
      .map(([, p]) => p as { type: string; event: Record<string, unknown> })
      .find((p) => p.type === "tool_event" && p.event.type === "tool_execution_end");
    expect(endEvent?.event.isError).toBe(true);
  });

  it("bundle-side afterToolExecution fires BEFORE host hook bridge recordToolExecution", async () => {
    const order: string[] = [];
    const tool = {
      name: "x",
      description: "",
      parameters: {},
      execute: vi.fn().mockResolvedValue("r"),
    };
    const cap: BundleCapability = {
      id: "ord",
      name: "Order",
      description: "",
      tools: () => [tool],
      hooks: {
        afterToolExecution: vi.fn(async () => {
          order.push("bundle-side-hook");
        }),
      },
    };
    const inferStream = vi
      .fn()
      .mockResolvedValueOnce(
        streamFrom([
          toolCallEvent({ index: 0, id: "z", name: "x", arguments: "{}" }),
          toolCallsFinish(),
        ]),
      )
      .mockResolvedValueOnce(streamFrom(textThenStop("done")));
    const spine = makeSpineMock();
    spine.recordToolExecution.mockImplementation(async () => {
      order.push("host-bridge-record");
    });

    await runTurn({
      setup: { model: { provider: "openrouter", modelId: "x" }, capabilities: () => [cap] },
      llm: { inferStream },
      spine,
    });

    expect(order).toEqual(["bundle-side-hook", "host-bridge-record"]);
  });

  it("iteration cap surfaces an explicit error after the configured limit", async () => {
    // Model emits tool_calls in EVERY iteration — the loop should
    // hit the cap and surface the explicit error in the message_end
    // broadcast, then close the response stream.
    const tool = {
      name: "loop",
      description: "",
      parameters: {},
      execute: vi.fn().mockResolvedValue("r"),
    };
    const inferStream = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          streamFrom([
            toolCallEvent({ index: 0, id: "c", name: "loop", arguments: "{}" }),
            toolCallsFinish(),
          ]),
        ),
      );
    const spine = makeSpineMock();
    await runTurn({
      setup: { model: { provider: "openrouter", modelId: "x" }, tools: () => [tool] },
      llm: { inferStream },
      spine,
    });

    // Cap enforced — calls capped at the iteration cap (the test
    // doesn't assert the exact constant; just that the error is
    // surfaced before unlimited execution).
    expect(inferStream.mock.calls.length).toBeLessThanOrEqual(30);

    const errorEnd = spine.broadcast.mock.calls
      .map(
        ([, p]) =>
          p as { type: string; event?: { type?: string; message?: { errorMessage?: string } } },
      )
      .find(
        (p) =>
          p.type === "agent_event" &&
          p.event?.type === "message_end" &&
          typeof p.event?.message?.errorMessage === "string",
      );
    expect(errorEnd?.event?.message?.errorMessage).toContain("max inference iterations");
  });
});
