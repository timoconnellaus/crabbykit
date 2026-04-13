import type { AssistantMessage, AssistantMessageEvent } from "../../types.js";
import {
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
  EventStream,
} from "../event-stream.js";

function makeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("EventStream", () => {
  it("push queues events and they are yielded by async iterator", async () => {
    const stream = new EventStream<number>(
      (e) => e === -1,
      (e) => e,
    );

    stream.push(1);
    stream.push(2);
    stream.push(3);
    stream.push(-1); // complete

    const collected: number[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([1, 2, 3, -1]);
  });

  it("push after end is ignored", async () => {
    const stream = new EventStream<number>(
      () => false,
      (e) => e,
    );

    stream.push(1);
    stream.end();
    stream.push(2); // should be ignored

    const collected: number[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([1]);
  });

  it("end() signals iterator completion", async () => {
    const stream = new EventStream<string>(
      () => false,
      (e) => e,
    );

    stream.push("a");
    stream.end();

    const collected: string[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual(["a"]);
  });

  it("end(result) resolves the result promise", async () => {
    const stream = new EventStream<number, string>(
      () => false,
      () => "unused",
    );

    stream.end("final-value");

    const result = await stream.result();
    expect(result).toBe("final-value");
  });

  it("result() returns the final result from a complete event", async () => {
    const stream = new EventStream<number, string>(
      (e) => e === 99,
      (e) => `result-${e}`,
    );

    stream.push(1);
    stream.push(99);

    const result = await stream.result();
    expect(result).toBe("result-99");
  });

  it("events pushed before iteration starts are queued and delivered", async () => {
    const stream = new EventStream<number>(
      (e) => e === -1,
      (e) => e,
    );

    // Push all events before iterating
    stream.push(10);
    stream.push(20);
    stream.push(30);
    stream.push(-1);

    const collected: number[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([10, 20, 30, -1]);
  });

  it("delivers events pushed after iteration begins", async () => {
    const stream = new EventStream<number>(
      (e) => e === -1,
      (e) => e,
    );

    const collected: number[] = [];
    const iterationDone = (async () => {
      for await (const event of stream) {
        collected.push(event);
      }
    })();

    // Push events asynchronously
    await Promise.resolve();
    stream.push(1);
    await Promise.resolve();
    stream.push(2);
    await Promise.resolve();
    stream.push(-1);

    await iterationDone;
    expect(collected).toEqual([1, 2, -1]);
  });
});

describe("AssistantMessageEventStream", () => {
  it("done event resolves result with message", async () => {
    const stream = new AssistantMessageEventStream();
    const msg = makeAssistantMessage();

    const partial = makeAssistantMessage({ stopReason: "stop" });
    stream.push({ type: "start", partial });
    stream.push({ type: "done", reason: "stop", message: msg });

    const result = await stream.result();
    expect(result).toBe(msg);
    expect(result.role).toBe("assistant");
  });

  it("error event resolves result with error message", async () => {
    const stream = new AssistantMessageEventStream();
    const errorMsg = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "something went wrong",
    });

    const partial = makeAssistantMessage();
    stream.push({ type: "start", partial });
    stream.push({ type: "error", reason: "error", error: errorMsg });

    const result = await stream.result();
    expect(result).toBe(errorMsg);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("something went wrong");
  });

  it("yields all events including done via async iterator", async () => {
    const stream = new AssistantMessageEventStream();
    const msg = makeAssistantMessage();
    const partial = makeAssistantMessage();

    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial });
    stream.push({ type: "done", reason: "stop", message: msg });

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }

    expect(types).toEqual(["start", "text_delta", "done"]);
  });

  it("push after done is ignored", async () => {
    const stream = new AssistantMessageEventStream();
    const msg = makeAssistantMessage();
    const partial = makeAssistantMessage();

    stream.push({ type: "done", reason: "stop", message: msg });
    stream.push({ type: "start", partial }); // should be ignored

    const collected: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe("done");
  });
});

describe("createAssistantMessageEventStream", () => {
  it("returns an AssistantMessageEventStream instance", () => {
    const stream = createAssistantMessageEventStream();
    expect(stream).toBeInstanceOf(AssistantMessageEventStream);
  });
});
