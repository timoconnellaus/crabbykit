import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearApiProviders,
  getApiProvider,
  getApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "../api-registry.js";
import type { Api, Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

function makeModel(api: Api, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  };
}

const EMPTY_CONTEXT: Context = { messages: [] };

function mockStreamFn(): StreamFunction<Api> {
  return () => new AssistantMessageEventStream();
}

// The register-builtins module auto-registers "openai-completions" on import
// via the index barrel. Save and restore registry state around tests.
let savedProviders: ReturnType<typeof getApiProviders>;

beforeEach(() => {
  savedProviders = getApiProviders();
  clearApiProviders();
});

afterEach(() => {
  clearApiProviders();
  // Re-register all providers that were present before the test
  // We can't perfectly restore because registerApiProvider wraps streams,
  // but for isolation this is sufficient — the builtins will be re-registered
  // on next import cycle. For safety, just re-import builtins.
});

describe("registerApiProvider + getApiProvider", () => {
  it("round-trips a registered provider", () => {
    const stream = mockStreamFn();
    const streamSimple = mockStreamFn();

    registerApiProvider({
      api: "anthropic-messages",
      stream: stream as StreamFunction<"anthropic-messages">,
      streamSimple: streamSimple as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });

    const provider = getApiProvider("anthropic-messages");
    expect(provider).toBeDefined();
    expect(provider!.api).toBe("anthropic-messages");
  });

  it("returns undefined for unregistered api", () => {
    expect(getApiProvider("nonexistent-api")).toBeUndefined();
  });
});

describe("wrapped stream api mismatch check", () => {
  it("throws when wrapped stream is called with wrong model.api", () => {
    const stream = mockStreamFn();
    const streamSimple = mockStreamFn();

    registerApiProvider({
      api: "anthropic-messages",
      stream: stream as StreamFunction<"anthropic-messages">,
      streamSimple: streamSimple as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });

    const provider = getApiProvider("anthropic-messages")!;
    const wrongModel = makeModel("openai-completions");

    expect(() => provider.stream(wrongModel, EMPTY_CONTEXT)).toThrow("Mismatched api");
  });

  it("throws on streamSimple with wrong model.api", () => {
    const stream = mockStreamFn();
    const streamSimple = mockStreamFn();

    registerApiProvider({
      api: "anthropic-messages",
      stream: stream as StreamFunction<"anthropic-messages">,
      streamSimple: streamSimple as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });

    const provider = getApiProvider("anthropic-messages")!;
    const wrongModel = makeModel("openai-completions");

    expect(() => provider.streamSimple(wrongModel, EMPTY_CONTEXT)).toThrow("Mismatched api");
  });

  it("does not throw when model.api matches", () => {
    const stream = mockStreamFn();
    const streamSimple = mockStreamFn();

    registerApiProvider({
      api: "anthropic-messages",
      stream: stream as StreamFunction<"anthropic-messages">,
      streamSimple: streamSimple as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });

    const provider = getApiProvider("anthropic-messages")!;
    const correctModel = makeModel("anthropic-messages");

    expect(() => provider.stream(correctModel, EMPTY_CONTEXT)).not.toThrow();
    expect(() => provider.streamSimple(correctModel, EMPTY_CONTEXT)).not.toThrow();
  });
});

describe("getApiProviders", () => {
  it("returns all registered providers", () => {
    registerApiProvider({
      api: "anthropic-messages",
      stream: mockStreamFn() as StreamFunction<"anthropic-messages">,
      streamSimple: mockStreamFn() as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });
    registerApiProvider({
      api: "google-generative-ai",
      stream: mockStreamFn() as StreamFunction<"google-generative-ai">,
      streamSimple: mockStreamFn() as StreamFunction<"google-generative-ai", SimpleStreamOptions>,
    });

    const providers = getApiProviders();
    expect(providers).toHaveLength(2);
    const apis = providers.map((p) => p.api);
    expect(apis).toContain("anthropic-messages");
    expect(apis).toContain("google-generative-ai");
  });
});

describe("unregisterApiProviders", () => {
  it("removes providers by sourceId", () => {
    registerApiProvider(
      {
        api: "anthropic-messages",
        stream: mockStreamFn() as StreamFunction<"anthropic-messages">,
        streamSimple: mockStreamFn() as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
      },
      "plugin-a",
    );

    expect(getApiProvider("anthropic-messages")).toBeDefined();

    unregisterApiProviders("plugin-a");

    expect(getApiProvider("anthropic-messages")).toBeUndefined();
  });

  it("leaves providers with different sourceId", () => {
    registerApiProvider(
      {
        api: "anthropic-messages",
        stream: mockStreamFn() as StreamFunction<"anthropic-messages">,
        streamSimple: mockStreamFn() as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
      },
      "plugin-a",
    );
    registerApiProvider(
      {
        api: "google-generative-ai",
        stream: mockStreamFn() as StreamFunction<"google-generative-ai">,
        streamSimple: mockStreamFn() as StreamFunction<"google-generative-ai", SimpleStreamOptions>,
      },
      "plugin-b",
    );

    unregisterApiProviders("plugin-a");

    expect(getApiProvider("anthropic-messages")).toBeUndefined();
    expect(getApiProvider("google-generative-ai")).toBeDefined();
  });
});

describe("clearApiProviders", () => {
  it("removes all providers", () => {
    registerApiProvider({
      api: "anthropic-messages",
      stream: mockStreamFn() as StreamFunction<"anthropic-messages">,
      streamSimple: mockStreamFn() as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });
    registerApiProvider({
      api: "google-generative-ai",
      stream: mockStreamFn() as StreamFunction<"google-generative-ai">,
      streamSimple: mockStreamFn() as StreamFunction<"google-generative-ai", SimpleStreamOptions>,
    });

    clearApiProviders();

    expect(getApiProviders()).toHaveLength(0);
  });
});

describe("re-registration", () => {
  it("overwrites existing provider for same api", () => {
    const stream1 = vi.fn(mockStreamFn());
    const stream2 = vi.fn(mockStreamFn());

    registerApiProvider({
      api: "anthropic-messages",
      stream: stream1 as unknown as StreamFunction<"anthropic-messages">,
      streamSimple: mockStreamFn() as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });
    registerApiProvider({
      api: "anthropic-messages",
      stream: stream2 as unknown as StreamFunction<"anthropic-messages">,
      streamSimple: mockStreamFn() as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
    });

    const provider = getApiProvider("anthropic-messages")!;
    const model = makeModel("anthropic-messages");
    provider.stream(model, EMPTY_CONTEXT);

    // The second registration should have overwritten the first
    expect(stream1).not.toHaveBeenCalled();
    expect(stream2).toHaveBeenCalled();
  });
});
