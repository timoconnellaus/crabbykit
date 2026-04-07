import { describe, expect, it, vi } from "vitest";
import { createWorkersAiEmbedder, estimateTokenCount } from "../embeddings.js";

describe("estimateTokenCount", () => {
  it("estimates tokens at ~4 chars per token", () => {
    expect(estimateTokenCount(["hello"])).toBe(2); // 5 chars -> ceil(5/4) = 2
  });

  it("sums across multiple texts", () => {
    // 12 + 12 = 24 chars -> ceil(24/4) = 6
    expect(estimateTokenCount(["hello world!", "another text"])).toBe(6);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTokenCount([])).toBe(0);
  });
});

describe("createWorkersAiEmbedder", () => {
  it("returns empty array for empty input", async () => {
    const ai = { run: vi.fn() } as unknown as Ai;
    const embed = createWorkersAiEmbedder(() => ai);
    const result = await embed([]);
    expect(result).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("embeds a single batch of texts", async () => {
    const mockVectors = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    const ai = {
      run: vi.fn().mockResolvedValue({ data: mockVectors }),
    } as unknown as Ai;
    const embed = createWorkersAiEmbedder(() => ai);

    const result = await embed(["text1", "text2"]);
    expect(result).toEqual(mockVectors);
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("batches texts when exceeding MAX_BATCH_SIZE (100)", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const batch1Vectors = Array.from({ length: 100 }, () => [0.1]);
    const batch2Vectors = Array.from({ length: 50 }, () => [0.2]);

    const ai = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ data: batch1Vectors })
        .mockResolvedValueOnce({ data: batch2Vectors }),
    } as unknown as Ai;
    const embed = createWorkersAiEmbedder(() => ai);

    const result = await embed(texts);
    expect(result).toHaveLength(150);
    expect(ai.run).toHaveBeenCalledTimes(2);
    // First batch: 100 texts, second batch: 50 texts
    expect((ai.run as ReturnType<typeof vi.fn>).mock.calls[0][1].text).toHaveLength(100);
    expect((ai.run as ReturnType<typeof vi.fn>).mock.calls[1][1].text).toHaveLength(50);
  });
});
