/**
 * Tests that the container-db copy stays in sync with the source package.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("claw-container-db source copy", () => {
  it("container copy matches source package", async () => {
    const containerCopy = await Bun.file(
      path.resolve(__dirname, "..", "claw-container-db", "index.ts"),
    ).text();
    const sourceFile = await Bun.file(
      path.resolve(__dirname, "..", "..", "..", "container-db", "src", "index.ts"),
    ).text();
    expect(containerCopy).toBe(sourceFile);
  });
});
