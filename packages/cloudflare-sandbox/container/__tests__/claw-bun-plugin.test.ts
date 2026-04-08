/**
 * Tests that the container-db copy stays in sync with the source package.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("claw-container-db source copy", () => {
  it("container copy matches source package", async () => {
    // Note: vitest runs under Node here (not Bun), so use fs/promises rather
    // than Bun.file() — the file contents are what matters, not the API.
    const containerCopy = await readFile(
      path.resolve(__dirname, "..", "claw-container-db", "index.ts"),
      "utf8",
    );
    const sourceFile = await readFile(
      path.resolve(__dirname, "..", "..", "..", "container-db", "src", "index.ts"),
      "utf8",
    );
    expect(containerCopy).toBe(sourceFile);
  });
});
