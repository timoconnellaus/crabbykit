import { describe, expect, it } from "vitest";
import { computeVersionId } from "../hash.js";

describe("computeVersionId", () => {
  it("produces a deterministic SHA-256 hex string", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const id1 = await computeVersionId(bytes.buffer);
    const id2 = await computeVersionId(bytes.buffer);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different IDs for different content", async () => {
    const a = new TextEncoder().encode("version A");
    const b = new TextEncoder().encode("version B");
    const idA = await computeVersionId(a.buffer);
    const idB = await computeVersionId(b.buffer);
    expect(idA).not.toBe(idB);
  });

  it("matches known SHA-256 for empty input", async () => {
    const empty = new ArrayBuffer(0);
    const id = await computeVersionId(empty);
    // SHA-256 of empty input
    expect(id).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
