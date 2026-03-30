import { describe, expect, it } from "vitest";
import { vectorMemory } from "../capability.js";
import { createMockVectorize } from "./mock-vectorize.js";

function mockAi(): Ai {
  return {
    run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
  } as unknown as Ai;
}

function mockBucket(): R2Bucket {
  return {} as R2Bucket;
}

function mockStorage(bucket?: R2Bucket) {
  return {
    bucket: () => bucket ?? mockBucket(),
    namespace: () => "agent-1",
  };
}

describe("vectorMemory", () => {
  it("returns correct capability structure", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
    });

    expect(cap.id).toBe("vector-memory");
    expect(cap.name).toBe("Vector Memory");
    expect(cap.description).toBeDefined();
  });

  it("provides memory_search and memory_get tools", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
    });

    const context = {
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      schedules: {} as any,
    };

    const tools = cap.tools!(context);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["memory_search", "memory_get"]);
  });

  it("provides prompt sections", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
    });

    const context = {
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      schedules: {} as any,
    };

    const sections = cap.promptSections!(context);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("memory_search");
    expect(sections[0]).toContain("MEMORY.md");
  });

  it("has afterToolExecution hook", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
    });

    expect(cap.hooks?.afterToolExecution).toBeDefined();
  });

  it("throws if neither embed nor ai is provided", () => {
    expect(() =>
      vectorMemory({
        storage: mockStorage(),
        vectorizeIndex: createMockVectorize(),
      }),
    ).toThrow("vectorMemory: provide either 'embed' or 'ai' option");
  });

  it("accepts custom embed function", () => {
    const customEmbed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      embed: customEmbed,
    });

    // Should not throw
    expect(cap.id).toBe("vector-memory");
  });

  it("accepts getter function for vectorize index", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: () => createMockVectorize(),
      ai: () => mockAi(),
    });

    expect(cap.id).toBe("vector-memory");
  });
});
