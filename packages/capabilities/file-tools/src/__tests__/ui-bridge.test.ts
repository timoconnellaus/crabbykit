import type { CapabilityHookContext, ToolExecutionEvent } from "@crabbykit/agent-runtime";
import { createNoopStorage } from "@crabbykit/agent-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import type { DirListing, FileConflict, FileContent, FileError, FileSaved } from "../ui-bridge.js";
import { broadcastAgentMutation, dispatchUiAction } from "../ui-bridge.js";
import { createMockR2Bucket, seedBucket } from "./mock-r2.js";

interface BroadcastCall {
  event: string;
  data: unknown;
  scope: "session" | "global" | undefined;
}

function createHookCtx(): { ctx: CapabilityHookContext; broadcasts: BroadcastCall[] } {
  const broadcasts: BroadcastCall[] = [];
  const ctx: CapabilityHookContext = {
    agentId: "agent",
    sessionId: "s1",
    sessionStore: {} as CapabilityHookContext["sessionStore"],
    storage: createNoopStorage(),
    capabilityIds: ["file-tools"],
    broadcastState: (event, data, scope) => {
      broadcasts.push({ event, data, scope });
    },
  };
  return { ctx, broadcasts };
}

const PREFIX = "ns";

function findEvent<T>(broadcasts: BroadcastCall[], event: string): T | undefined {
  const match = broadcasts.find((b) => b.event === event);
  return match?.data as T | undefined;
}

describe("dispatchUiAction", () => {
  let bucket: R2Bucket;
  const getBucket = () => bucket;
  const getPrefix = () => PREFIX;

  beforeEach(async () => {
    bucket = createMockR2Bucket();
    await seedBucket(bucket, PREFIX, {
      "README.md": "# Hello\n",
      "src/app.ts": "export const x = 1;\n",
      "src/util/helpers.ts": "export const y = 2;\n",
    });
  });

  it("list returns a sorted directory listing", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("list", {}, ctx, getBucket, getPrefix);

    const listing = findEvent<DirListing>(broadcasts, "dir_listing");
    expect(listing).toBeDefined();
    expect(listing?.path).toBe("");
    const names = listing?.entries.map((e) => e.name);
    // directories first, then files, both alphabetical
    expect(names).toEqual(["src", "README.md"]);
    expect(listing?.entries[0].type).toBe("directory");
  });

  it("list accepts a subdirectory path", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("list", { path: "src" }, ctx, getBucket, getPrefix);

    const listing = findEvent<DirListing>(broadcasts, "dir_listing");
    expect(listing?.path).toBe("src");
    const names = listing?.entries.map((e) => e.name);
    expect(names).toEqual(["util", "app.ts"]);
  });

  it("read returns file content + etag", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("read", { path: "README.md" }, ctx, getBucket, getPrefix);

    const file = findEvent<FileContent>(broadcasts, "file_content");
    expect(file?.path).toBe("README.md");
    expect(file?.content).toBe("# Hello\n");
    expect(file?.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(file?.isBinary).toBe(false);
    expect(file?.isLarge).toBe(false);
  });

  it("read flags binary files", async () => {
    await bucket.put(`${PREFIX}/binary.bin`, "\x00\x01\x02\x03");
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("read", { path: "binary.bin" }, ctx, getBucket, getPrefix);

    const file = findEvent<FileContent>(broadcasts, "file_content");
    expect(file?.isBinary).toBe(true);
    expect(file?.content).toBe("");
  });

  it("read emits file_error when the file is missing", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("read", { path: "nope.txt" }, ctx, getBucket, getPrefix);

    const err = findEvent<FileError>(broadcasts, "file_error");
    expect(err?.action).toBe("read");
    expect(err?.message).toContain("not found");
  });

  it("write persists content and broadcasts file_saved + file_changed", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "write",
      { path: "new.md", content: "new body" },
      ctx,
      getBucket,
      getPrefix,
    );

    const saved = findEvent<FileSaved>(broadcasts, "file_saved");
    expect(saved?.path).toBe("new.md");
    expect(saved?.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "new.md" });

    const stored = await bucket.get(`${PREFIX}/new.md`);
    expect(await stored?.text()).toBe("new body");
  });

  it("write detects a stale etag and returns file_conflict", async () => {
    const { ctx: readCtx, broadcasts: readBroadcasts } = createHookCtx();
    await dispatchUiAction("read", { path: "README.md" }, readCtx, getBucket, getPrefix);
    const file = findEvent<FileContent>(readBroadcasts, "file_content");

    // Mutate externally
    await bucket.put(`${PREFIX}/README.md`, "# externally rewritten\n");

    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "write",
      { path: "README.md", content: "# user edit\n", etag: file?.etag },
      ctx,
      getBucket,
      getPrefix,
    );

    const conflict = findEvent<FileConflict>(broadcasts, "file_conflict");
    expect(conflict?.path).toBe("README.md");
    expect(findEvent(broadcasts, "file_saved")).toBeUndefined();
  });

  it("create rejects existing files", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("create", { path: "README.md" }, ctx, getBucket, getPrefix);

    const err = findEvent<FileError>(broadcasts, "file_error");
    expect(err?.action).toBe("create");
    expect(err?.message).toContain("already exists");
  });

  it("create adds a zero-byte file and broadcasts file_changed", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("create", { path: "fresh.txt" }, ctx, getBucket, getPrefix);

    expect(findEvent<FileSaved>(broadcasts, "file_saved")?.path).toBe("fresh.txt");
    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "fresh.txt" });
    const object = await bucket.get(`${PREFIX}/fresh.txt`);
    expect(object).not.toBeNull();
  });

  it("delete removes the file and broadcasts file_changed", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("delete", { path: "README.md" }, ctx, getBucket, getPrefix);

    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "README.md" });
    expect(await bucket.get(`${PREFIX}/README.md`)).toBeNull();
  });

  it("rename moves the file and broadcasts both paths", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "rename",
      { oldPath: "README.md", newPath: "docs/intro.md" },
      ctx,
      getBucket,
      getPrefix,
    );

    const changedPaths = broadcasts
      .filter((b) => b.event === "file_changed")
      .map((b) => (b.data as { path: string }).path);
    expect(changedPaths).toContain("README.md");
    expect(changedPaths).toContain("docs/intro.md");

    expect(await bucket.get(`${PREFIX}/README.md`)).toBeNull();
    const moved = await bucket.get(`${PREFIX}/docs/intro.md`);
    expect(await moved?.text()).toBe("# Hello\n");
  });

  it("rename refuses to clobber an existing destination", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "rename",
      { oldPath: "src/app.ts", newPath: "README.md" },
      ctx,
      getBucket,
      getPrefix,
    );
    expect(findEvent<FileError>(broadcasts, "file_error")?.action).toBe("rename");
  });

  it("rejects directory traversal on read", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("read", { path: "../escape" }, ctx, getBucket, getPrefix);
    expect(findEvent<FileError>(broadcasts, "file_error")?.message).toContain("..");
  });

  it("returns file_error for unknown actions", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("bogus", {}, ctx, getBucket, getPrefix);
    expect(findEvent<FileError>(broadcasts, "file_error")?.message).toContain("Unknown");
  });

  it("mkdir creates nested directory markers", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("mkdir", { path: "docs/guides" }, ctx, getBucket, getPrefix);

    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "docs/guides" });
    expect(await bucket.head(`${PREFIX}/docs/`)).not.toBeNull();
    expect(await bucket.head(`${PREFIX}/docs/guides/`)).not.toBeNull();
  });

  it("mkdir is idempotent when the directory already exists", async () => {
    await bucket.put(`${PREFIX}/docs/`, "");
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("mkdir", { path: "docs" }, ctx, getBucket, getPrefix);
    expect(findEvent<FileError>(broadcasts, "file_error")).toBeUndefined();
    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "docs" });
  });

  it("rmdir deletes every key under the prefix", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("rmdir", { path: "src" }, ctx, getBucket, getPrefix);

    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "src" });
    expect(await bucket.get(`${PREFIX}/src/app.ts`)).toBeNull();
    expect(await bucket.get(`${PREFIX}/src/util/helpers.ts`)).toBeNull();
  });

  it("rmdir emits file_error when the directory is missing", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction("rmdir", { path: "nope" }, ctx, getBucket, getPrefix);
    expect(findEvent<FileError>(broadcasts, "file_error")?.action).toBe("rmdir");
  });

  it("rename_dir moves an entire subtree to a new prefix", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "rename_dir",
      { oldPath: "src", newPath: "source" },
      ctx,
      getBucket,
      getPrefix,
    );

    const changedPaths = broadcasts
      .filter((b) => b.event === "file_changed")
      .map((b) => (b.data as { path: string }).path);
    expect(changedPaths).toContain("src");
    expect(changedPaths).toContain("source");
    expect(await bucket.get(`${PREFIX}/src/app.ts`)).toBeNull();
    const moved = await bucket.get(`${PREFIX}/source/app.ts`);
    expect(await moved?.text()).toBe("export const x = 1;\n");
  });

  it("rename_dir refuses to move a directory into itself", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "rename_dir",
      { oldPath: "src", newPath: "src/nested" },
      ctx,
      getBucket,
      getPrefix,
    );
    expect(findEvent<FileError>(broadcasts, "file_error")?.message).toContain("into itself");
  });

  it("rename_dir refuses to clobber an existing destination", async () => {
    await bucket.put(`${PREFIX}/docs/index.md`, "");
    const { ctx, broadcasts } = createHookCtx();
    await dispatchUiAction(
      "rename_dir",
      { oldPath: "src", newPath: "docs" },
      ctx,
      getBucket,
      getPrefix,
    );
    expect(findEvent<FileError>(broadcasts, "file_error")?.message).toContain("already exists");
  });
});

describe("broadcastAgentMutation", () => {
  function makeEvent(
    toolName: string,
    args: Record<string, unknown>,
    isError = false,
  ): ToolExecutionEvent {
    return { toolName, args, isError };
  }

  it("emits file_changed when a file_write tool succeeds", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await broadcastAgentMutation(makeEvent("file_write", { path: "docs/a.md" }), ctx);
    expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "docs/a.md" });
  });

  it("emits for every mutation tool", async () => {
    const tools = ["file_edit", "file_delete"];
    for (const toolName of tools) {
      const { ctx, broadcasts } = createHookCtx();
      await broadcastAgentMutation(makeEvent(toolName, { path: "x.txt" }), ctx);
      expect(findEvent(broadcasts, "file_changed")).toEqual({ path: "x.txt" });
    }
  });

  it("emits destination + source for file_move", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await broadcastAgentMutation(
      makeEvent("file_move", { source: "a.txt", destination: "b.txt" }),
      ctx,
    );
    const paths = broadcasts
      .filter((b) => b.event === "file_changed")
      .map((b) => (b.data as { path: string }).path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("b.txt");
  });

  it("emits destination only for file_copy", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await broadcastAgentMutation(
      makeEvent("file_copy", { source: "a.txt", destination: "b.txt" }),
      ctx,
    );
    const paths = broadcasts
      .filter((b) => b.event === "file_changed")
      .map((b) => (b.data as { path: string }).path);
    expect(paths).toEqual(["b.txt"]);
  });

  it("skips read-only tools", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await broadcastAgentMutation(makeEvent("file_read", { path: "x.txt" }), ctx);
    expect(broadcasts).toHaveLength(0);
  });

  it("skips errored tool invocations", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await broadcastAgentMutation(makeEvent("file_write", { path: "x.txt" }, true), ctx);
    expect(broadcasts).toHaveLength(0);
  });

  it("skips invalid paths without crashing", async () => {
    const { ctx, broadcasts } = createHookCtx();
    await broadcastAgentMutation(makeEvent("file_write", { path: "../etc" }), ctx);
    expect(broadcasts).toHaveLength(0);
  });
});
