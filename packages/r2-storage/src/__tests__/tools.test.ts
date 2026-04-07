import { beforeEach, describe, expect, it } from "vitest";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { createFileCopyTool } from "../file-copy.js";
import { createFileDeleteTool } from "../file-delete.js";
import { createFileEditTool } from "../file-edit.js";
import { createFileFindTool } from "../file-find.js";
import { createFileListTool } from "../file-list.js";
import { createFileMoveTool } from "../file-move.js";
import { createFileReadTool } from "../file-read.js";
import { createFileTreeTool } from "../file-tree.js";
import { createFileWriteTool } from "../file-write.js";
import { createFailingR2Bucket, createMockR2Bucket, seedBucket } from "./mock-r2.js";

const PREFIX = "test-agent";

describe("file_read", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileReadTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileReadTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, {
      "hello.txt": "line 0\nline 1\nline 2\nline 3\nline 4",
    });
  });

  it("reads a file", async () => {
    const result = await tool.execute({ path: "hello.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("line 0");
    expect(textOf(result)).toContain("line 4");
  });

  it("returns error for missing file", async () => {
    const result = await tool.execute({ path: "nope.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error: File not found");
  });

  it("supports offset", async () => {
    const result = await tool.execute({ path: "hello.txt", offset: 2 }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).not.toContain("line 0");
    expect(text).not.toContain("line 1");
    expect(text).toContain("line 2");
  });

  it("supports limit", async () => {
    const result = await tool.execute({ path: "hello.txt", limit: 2 }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("line 0");
    expect(text).toContain("line 1");
    expect(text).not.toContain("line 2");
  });

  it("rejects invalid paths", async () => {
    const result = await tool.execute({ path: "../etc/passwd" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error:");
  });

  it("truncates large files", async () => {
    const bigContent = "x".repeat(1000) + "\n".repeat(100);
    await bucket.put(`${PREFIX}/big.txt`, bigContent);
    const smallLimit = 500;
    const smallTool = createFileReadTool(
      () => bucket,
      () => PREFIX,
      smallLimit,
    );
    const result = await smallTool.execute({ path: "big.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("[File truncated");
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileReadTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute({ path: "hello.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error reading file:");
    expect(result.details).toHaveProperty("error", "read_error");
  });
});

describe("file_write", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileWriteTool>;

  beforeEach(() => {
    bucket = createMockR2Bucket();
    tool = createFileWriteTool(
      () => bucket,
      () => PREFIX,
    );
  });

  it("writes a file", async () => {
    const result = await tool.execute(
      { path: "new.txt", content: "hello world" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Successfully wrote");
    expect(textOf(result)).toContain("11 bytes");

    // Verify via read
    const obj = await bucket.get(`${PREFIX}/new.txt`);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe("hello world");
  });

  it("creates directory markers for nested paths", async () => {
    await tool.execute({ path: "src/lib/utils.ts", content: "export {}" }, { toolCallId: "test" });
    const dirMarker = await bucket.head(`${PREFIX}/src/`);
    expect(dirMarker).not.toBeNull();
    const subDirMarker = await bucket.head(`${PREFIX}/src/lib/`);
    expect(subDirMarker).not.toBeNull();
  });

  it("rejects content exceeding 1MB", async () => {
    const bigContent = "x".repeat(1_048_577);
    const result = await tool.execute(
      { path: "big.txt", content: bigContent },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: Content size");
    expect(textOf(result)).toContain("1MB limit");
  });

  it("rejects invalid paths", async () => {
    const result = await tool.execute({ path: "../evil", content: "bad" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error:");
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileWriteTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute(
      { path: "test.txt", content: "hello" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error writing file:");
    expect(result.details).toHaveProperty("error", "write_error");
  });
});

describe("file_edit", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileEditTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileEditTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, {
      "code.ts": 'const x = "hello";\nconst y = "world";\n',
    });
  });

  it("replaces a unique string", async () => {
    const result = await tool.execute(
      {
        path: "code.ts",
        old_string: '"hello"',
        new_string: '"hi"',
      },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Successfully replaced 1 occurrence");

    const obj = await bucket.get(`${PREFIX}/code.ts`);
    expect(await obj!.text()).toContain('"hi"');
    expect(await obj!.text()).toContain('"world"');
  });

  it("errors on ambiguous match without replace_all", async () => {
    await bucket.put(`${PREFIX}/dup.ts`, "foo foo foo");
    const result = await tool.execute(
      {
        path: "dup.ts",
        old_string: "foo",
        new_string: "bar",
      },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Found 3 occurrences");
  });

  it("replaces all occurrences with replace_all", async () => {
    await bucket.put(`${PREFIX}/dup.ts`, "foo foo foo");
    const result = await tool.execute(
      {
        path: "dup.ts",
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Successfully replaced 3 occurrences");
    const obj = await bucket.get(`${PREFIX}/dup.ts`);
    expect(await obj!.text()).toBe("bar bar bar");
  });

  it("returns no-op for identical strings", async () => {
    const result = await tool.execute(
      {
        path: "code.ts",
        old_string: "same",
        new_string: "same",
      },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("No changes made");
  });

  it("errors when string not found", async () => {
    const result = await tool.execute(
      {
        path: "code.ts",
        old_string: "nonexistent",
        new_string: "replacement",
      },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("String not found");
  });

  it("errors for missing file", async () => {
    const result = await tool.execute(
      {
        path: "nope.ts",
        old_string: "a",
        new_string: "b",
      },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("File not found");
  });

  it("rejects invalid paths", async () => {
    const result = await tool.execute(
      { path: "../evil", old_string: "a", new_string: "b" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileEditTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute(
      { path: "code.ts", old_string: "a", new_string: "b" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error editing file:");
    expect(result.details).toHaveProperty("error", "edit_error");
  });
});

describe("file_delete", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileDeleteTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileDeleteTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, { "deleteme.txt": "gone" });
  });

  it("deletes a file", async () => {
    const result = await tool.execute({ path: "deleteme.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Successfully deleted");
    const obj = await bucket.get(`${PREFIX}/deleteme.txt`);
    expect(obj).toBeNull();
  });

  it("succeeds even if file does not exist (idempotent)", async () => {
    const result = await tool.execute({ path: "nonexistent.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Successfully deleted");
  });

  it("rejects invalid paths", async () => {
    const result = await tool.execute({ path: "../etc/passwd" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileDeleteTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute({ path: "deleteme.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error deleting file:");
    expect(result.details).toHaveProperty("error", "delete_error");
  });
});

describe("file_list", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileListTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileListTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, {
      "readme.md": "# Hello",
      "src/main.ts": "console.log('hi')",
      "src/lib/utils.ts": "export {}",
    });
    // Directory markers
    await bucket.put(`${PREFIX}/src/`, "");
    await bucket.put(`${PREFIX}/src/lib/`, "");
  });

  it("lists root directory", async () => {
    const result = await tool.execute({}, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("readme.md");
    expect(text).toContain("src");
  });

  it("lists subdirectory", async () => {
    const result = await tool.execute({ path: "src" }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("main.ts");
    expect(text).toContain("lib");
  });

  it("shows empty for nonexistent directory", async () => {
    const result = await tool.execute({ path: "nope" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("empty");
  });

  it("rejects invalid paths", async () => {
    const result = await tool.execute({ path: "../evil" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileListTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error listing directory:");
    expect(result.details).toHaveProperty("error", "list_error");
  });
});

describe("file_tree", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileTreeTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileTreeTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, {
      "readme.md": "# Hello",
      "src/main.ts": "code",
      "src/lib/utils.ts": "utils",
    });
    await bucket.put(`${PREFIX}/src/`, "");
    await bucket.put(`${PREFIX}/src/lib/`, "");
  });

  it("shows tree structure", async () => {
    const result = await tool.execute({}, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("readme.md");
    expect(text).toContain("src/");
    expect(text).toContain("main.ts");
  });

  it("limits depth", async () => {
    const result = await tool.execute({ depth: 1 }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("readme.md");
    expect(text).toContain("src/");
    // Depth 1 should not recurse into src/
    expect(text).not.toContain("main.ts");
  });

  it("scopes to subdirectory", async () => {
    const result = await tool.execute({ path: "src" }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("src");
    expect(text).toContain("main.ts");
    expect(text).not.toContain("readme.md");
  });

  it("rejects invalid paths", async () => {
    const result = await tool.execute({ path: "../evil" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileTreeTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error building tree:");
    expect(result.details).toHaveProperty("error", "tree_error");
  });

  it("shows empty for empty directory", async () => {
    const emptyBucket = createMockR2Bucket();
    const emptyTool = createFileTreeTool(
      () => emptyBucket,
      () => PREFIX,
    );
    const result = await emptyTool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toContain("empty");
  });

  it("truncates when exceeding MAX_ENTRIES_PER_LEVEL (100)", async () => {
    const bigBucket = createMockR2Bucket();
    // Create 110 files at root level to exceed the 100-entry cap
    const files: Record<string, string> = {};
    for (let i = 0; i < 110; i++) {
      files[`file-${String(i).padStart(3, "0")}.txt`] = "content";
    }
    await seedBucket(bigBucket, PREFIX, files);
    const bigTool = createFileTreeTool(
      () => bigBucket,
      () => PREFIX,
    );
    const result = await bigTool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toContain("... and");
    expect(textOf(result)).toContain("more items");
  });
});

describe("file_find", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileFindTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileFindTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, {
      "readme.md": "# Hello",
      "src/main.ts": "code",
      "src/lib/utils.ts": "utils",
      "src/lib/helpers.js": "helpers",
    });
  });

  it("finds files by glob pattern", async () => {
    const result = await tool.execute({ pattern: "**/*.ts" }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("src/main.ts");
    expect(text).toContain("src/lib/utils.ts");
    expect(text).not.toContain("helpers.js");
    expect(text).not.toContain("readme.md");
  });

  it("scopes search to a directory", async () => {
    const result = await tool.execute({ pattern: "*.ts", path: "src" }, { toolCallId: "test" });
    const text = textOf(result);
    expect(text).toContain("main.ts");
    // *.ts should not match across directories
    expect(text).not.toContain("utils.ts");
  });

  it("returns no-match message", async () => {
    const result = await tool.execute({ pattern: "**/*.py" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("No files matched");
  });

  it("finds by exact filename", async () => {
    const result = await tool.execute({ pattern: "**/readme.md" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("readme.md");
  });

  it("rejects invalid scoped path", async () => {
    const result = await tool.execute({ pattern: "*.ts", path: "../evil" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileFindTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute({ pattern: "*.ts" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Error searching files:");
    expect(result.details).toHaveProperty("error", "find_error");
  });

  it("caps results at MAX_RESULTS (200)", async () => {
    const bucket = createMockR2Bucket();
    const files: Record<string, string> = {};
    for (let i = 0; i < 210; i++) {
      files[`file-${String(i).padStart(3, "0")}.txt`] = "content";
    }
    await seedBucket(bucket, PREFIX, files);
    const findTool = createFileFindTool(
      () => bucket,
      () => PREFIX,
    );
    const result = await findTool.execute({ pattern: "**/*.txt" }, { toolCallId: "test" });
    expect(textOf(result)).toContain("Results capped at 200");
    expect(result.details).toEqual({ pattern: "**/*.txt", matchCount: 200 });
  });
});

describe("file_copy", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileCopyTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileCopyTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, { "original.txt": "hello world" });
  });

  it("copies a file to a new path", async () => {
    const result = await tool.execute(
      { source: "original.txt", destination: "copy.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Copied original.txt → copy.txt");
    expect(result.details).toEqual({ source: "original.txt", destination: "copy.txt" });

    // Verify both files exist
    const orig = await bucket.get(`${PREFIX}/original.txt`);
    expect(orig).not.toBeNull();
    const copy = await bucket.get(`${PREFIX}/copy.txt`);
    expect(copy).not.toBeNull();
    expect(await copy!.text()).toBe("hello world");
  });

  it("rejects invalid source path", async () => {
    const result = await tool.execute(
      { source: "../etc/passwd", destination: "copy.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: source path:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("rejects invalid destination path", async () => {
    const result = await tool.execute(
      { source: "original.txt", destination: "../evil" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: destination path:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("returns error when source file not found", async () => {
    const result = await tool.execute(
      { source: "missing.txt", destination: "copy.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: source file not found: missing.txt");
    expect(result.details).toEqual({ error: "not_found" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileCopyTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute(
      { source: "a.txt", destination: "b.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error copying file:");
    expect(result.details).toHaveProperty("error", "copy_error");
  });
});

describe("file_move", () => {
  let bucket: R2Bucket;
  let tool: ReturnType<typeof createFileMoveTool>;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    tool = createFileMoveTool(
      () => bucket,
      () => PREFIX,
    );
    await seedBucket(bucket, PREFIX, { "source.txt": "move me" });
  });

  it("moves a file (copy + delete source)", async () => {
    const result = await tool.execute(
      { source: "source.txt", destination: "dest.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Moved source.txt → dest.txt");
    expect(result.details).toEqual({ source: "source.txt", destination: "dest.txt" });

    // Source should be deleted
    const src = await bucket.get(`${PREFIX}/source.txt`);
    expect(src).toBeNull();
    // Destination should exist
    const dst = await bucket.get(`${PREFIX}/dest.txt`);
    expect(dst).not.toBeNull();
    expect(await dst!.text()).toBe("move me");
  });

  it("rejects invalid source path", async () => {
    const result = await tool.execute(
      { source: "../etc/passwd", destination: "dest.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: source path:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("rejects invalid destination path", async () => {
    const result = await tool.execute(
      { source: "source.txt", destination: "../evil" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: destination path:");
    expect(result.details).toEqual({ error: "invalid_path" });
  });

  it("returns error when source file not found", async () => {
    const result = await tool.execute(
      { source: "missing.txt", destination: "dest.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error: source file not found: missing.txt");
    expect(result.details).toEqual({ error: "not_found" });
  });

  it("handles R2 errors gracefully", async () => {
    const failTool = createFileMoveTool(
      () => createFailingR2Bucket(),
      () => PREFIX,
    );
    const result = await failTool.execute(
      { source: "a.txt", destination: "b.txt" },
      { toolCallId: "test" },
    );
    expect(textOf(result)).toContain("Error moving file:");
    expect(result.details).toHaveProperty("error", "move_error");
  });
});
