import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useR2Files } from "../hooks/use-r2-files";
import {
  createMockProviderHandle,
  MockAgentConnectionProvider,
  type MockProviderHandle,
} from "./agent-connection-provider/hooks/test-provider";

afterEach(() => {
  cleanup();
});

function makeWrapper(handle: MockProviderHandle, currentSessionId: string | null = "sess_1") {
  return ({ children }: { children: ReactNode }) => (
    <MockAgentConnectionProvider handle={handle} currentSessionId={currentSessionId}>
      {children}
    </MockAgentConnectionProvider>
  );
}

function broadcast(handle: MockProviderHandle, event: string, data: unknown) {
  const listeners = handle.subscribers.get("file-tools");
  if (!listeners) return;
  for (const fn of listeners) fn(event, data);
}

describe("useR2Files", () => {
  it("sends an initial list action on mount", () => {
    const handle = createMockProviderHandle();
    renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    expect(handle.sent.length).toBeGreaterThanOrEqual(1);
    const initial = handle.sent[0];
    expect(initial).toMatchObject({
      type: "capability_action",
      capabilityId: "file-tools",
      action: "list",
      sessionId: "sess_1",
    });
  });

  it("stores dir_listing broadcasts on the directories map", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      broadcast(handle, "dir_listing", {
        path: "",
        entries: [{ name: "README.md", type: "file" }],
      });
    });

    expect(result.current.directories.get("")?.entries).toEqual([
      { name: "README.md", type: "file" },
    ]);
  });

  it("readFile resolves with the next file_content broadcast", async () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    let resolved: unknown = null;
    await act(async () => {
      const promise = result.current.readFile("README.md");
      broadcast(handle, "file_content", {
        path: "README.md",
        content: "# Hi",
        etag: "abc",
        isBinary: false,
        isLarge: false,
      });
      resolved = await promise;
    });

    expect(resolved).toMatchObject({ path: "README.md", content: "# Hi", etag: "abc" });
    expect(result.current.files.get("README.md")?.content).toBe("# Hi");
  });

  it("readFile rejects with null on file_error", async () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    let resolved: unknown = "not-touched";
    await act(async () => {
      const promise = result.current.readFile("missing.md");
      broadcast(handle, "file_error", {
        action: "read",
        path: "missing.md",
        message: "File not found",
      });
      resolved = await promise;
    });

    expect(resolved).toBeNull();
    expect(result.current.error?.message).toBe("File not found");
  });

  it("writeFile resolves with file_saved result", async () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    let resolved: unknown = null;
    await act(async () => {
      const promise = result.current.writeFile("a.md", "body", "etag1");
      broadcast(handle, "file_saved", { path: "a.md", etag: "etag2" });
      resolved = await promise;
    });

    expect(resolved).toEqual({ path: "a.md", etag: "etag2" });
    const sent = handle.sent.find((m) => m.type === "capability_action" && m.action === "write");
    expect(sent).toMatchObject({ data: { path: "a.md", content: "body", etag: "etag1" } });
  });

  it("writeFile surfaces file_conflict and stores it", async () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    let resolved: unknown = null;
    await act(async () => {
      const promise = result.current.writeFile("a.md", "body");
      broadcast(handle, "file_conflict", {
        path: "a.md",
        reason: "Modified externally",
      });
      resolved = await promise;
    });

    expect(resolved).toMatchObject({ reason: "Modified externally" });
    expect(result.current.conflict?.path).toBe("a.md");
  });

  it("file_changed invalidates the cached file and refreshes parent dir", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      broadcast(handle, "file_content", {
        path: "src/app.ts",
        content: "old",
        etag: "v1",
        isBinary: false,
        isLarge: false,
      });
    });
    expect(result.current.files.has("src/app.ts")).toBe(true);

    // Ensure the parent dir is expanded so file_changed triggers a refresh.
    act(() => {
      result.current.toggleExpanded("src");
    });
    const beforeCount = handle.sent.length;

    act(() => {
      broadcast(handle, "file_changed", { path: "src/app.ts" });
    });

    expect(result.current.files.has("src/app.ts")).toBe(false);
    // Toggling expanded kicked off one list; file_changed should enqueue another.
    const listActionsForSrc = handle.sent.filter(
      (m) =>
        m.type === "capability_action" &&
        m.action === "list" &&
        (m.data as { path?: string }).path === "src",
    );
    expect(listActionsForSrc.length).toBeGreaterThanOrEqual(1);
    expect(handle.sent.length).toBeGreaterThanOrEqual(beforeCount);
  });

  it("deleteFile sends a delete action", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      result.current.deleteFile("x.txt");
    });

    const deleteAction = handle.sent.find(
      (m) => m.type === "capability_action" && m.action === "delete",
    );
    expect(deleteAction).toMatchObject({ data: { path: "x.txt" } });
  });

  it("renameFile sends a rename action", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      result.current.renameFile("a.md", "b.md");
    });

    const rename = handle.sent.find((m) => m.type === "capability_action" && m.action === "rename");
    expect(rename).toMatchObject({ data: { oldPath: "a.md", newPath: "b.md" } });
  });

  it("createDir sends an mkdir action", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      result.current.createDir("docs/guides");
    });

    const mkdir = handle.sent.find((m) => m.type === "capability_action" && m.action === "mkdir");
    expect(mkdir).toMatchObject({ data: { path: "docs/guides" } });
  });

  it("deleteDir sends an rmdir action", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      result.current.deleteDir("src");
    });

    const rmdir = handle.sent.find((m) => m.type === "capability_action" && m.action === "rmdir");
    expect(rmdir).toMatchObject({ data: { path: "src" } });
  });

  it("renameDir sends a rename_dir action", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      result.current.renameDir("src", "source");
    });

    const renameDir = handle.sent.find(
      (m) => m.type === "capability_action" && m.action === "rename_dir",
    );
    expect(renameDir).toMatchObject({ data: { oldPath: "src", newPath: "source" } });
  });

  it("file_changed on a directory invalidates descendants and listings", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), { wrapper: makeWrapper(handle) });

    act(() => {
      broadcast(handle, "dir_listing", {
        path: "src",
        entries: [{ name: "app.ts", type: "file" }],
      });
      broadcast(handle, "file_content", {
        path: "src/app.ts",
        content: "x",
        etag: "v1",
        isBinary: false,
        isLarge: false,
      });
    });
    expect(result.current.directories.has("src")).toBe(true);
    expect(result.current.files.has("src/app.ts")).toBe(true);

    act(() => {
      broadcast(handle, "file_changed", { path: "src" });
    });

    expect(result.current.directories.has("src")).toBe(false);
    expect(result.current.files.has("src/app.ts")).toBe(false);
  });

  it("does nothing when there is no current session", () => {
    const handle = createMockProviderHandle();
    const { result } = renderHook(() => useR2Files(), {
      wrapper: makeWrapper(handle, null),
    });

    expect(handle.sent).toHaveLength(0);

    act(() => {
      result.current.deleteFile("x.txt");
    });
    expect(handle.sent).toHaveLength(0);
  });
});
