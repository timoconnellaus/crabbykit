import { beforeEach, describe, expect, it } from "vitest";
import { createFileDeleteTool } from "../file-delete.js";
import { createFileEditTool } from "../file-edit.js";
import { createFileFindTool } from "../file-find.js";
import { createFileListTool } from "../file-list.js";
import { createFileReadTool } from "../file-read.js";
import { createFileTreeTool } from "../file-tree.js";
import { createFileWriteTool } from "../file-write.js";
import { createMockR2Bucket, seedBucket } from "./mock-r2.js";

const PREFIX = "test-agent";

/** Extract text from the first content block of a tool result */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: "text"; text: string }).text;
}

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
});
