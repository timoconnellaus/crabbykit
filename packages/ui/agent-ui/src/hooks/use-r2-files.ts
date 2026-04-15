import { useAgentConnection } from "@claw-for-cloudflare/agent-runtime/client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * UI-facing types for the r2-storage capability's UI bridge. These
 * mirror the events emitted by `packages/r2-storage/src/ui-bridge.ts`
 * and are duplicated here so `agent-ui` does not take a hard dependency
 * on the capability package.
 */
export interface R2DirEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface R2DirListing {
  path: string;
  entries: R2DirEntry[];
}

export interface R2FileContent {
  path: string;
  content: string;
  etag: string;
  isBinary: boolean;
  isLarge: boolean;
  largeSize?: number;
}

export interface R2FileSaved {
  path: string;
  etag: string;
}

export interface R2FileConflict {
  path: string;
  reason: string;
}

export interface R2FileError {
  action: string;
  path?: string;
  message: string;
}

export interface R2FileBrowserState {
  /** Tree of directory listings, keyed by path (root = ""). */
  directories: Map<string, R2DirListing>;
  /** Cache of file contents, keyed by path. */
  files: Map<string, R2FileContent>;
  /** Paths whose directories are currently expanded in the UI tree. */
  expandedDirs: Set<string>;
  /** Last error message from the capability, if any. */
  error: R2FileError | null;
  /** Last conflict, if any. */
  conflict: R2FileConflict | null;
}

export interface UseR2FilesReturn extends R2FileBrowserState {
  listDir: (path?: string) => void;
  readFile: (path: string) => Promise<R2FileContent | null>;
  writeFile: (
    path: string,
    content: string,
    etag?: string,
  ) => Promise<R2FileSaved | R2FileConflict | null>;
  createFile: (path: string) => Promise<R2FileSaved | null>;
  deleteFile: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => void;
  createDir: (path: string) => void;
  deleteDir: (path: string) => void;
  renameDir: (oldPath: string, newPath: string) => void;
  toggleExpanded: (path: string) => void;
  clearError: () => void;
  clearConflict: () => void;
}

const CAPABILITY_ID = "r2-storage";

/**
 * Hook wrapping the r2-storage capability's UI bridge. Subscribes to
 * `dir_listing` / `file_content` / `file_saved` / `file_conflict` /
 * `file_changed` / `file_error` broadcasts, and exposes helpers that
 * send `capability_action` messages.
 *
 * The hook maintains its own cache of directory listings and file
 * contents. Incoming `file_changed` events invalidate both so the next
 * render refetches. Action helpers (read, write, create) return a
 * promise that resolves with the next matching broadcast — callers
 * awaiting them see the result inline without wiring their own
 * subscribers.
 */
export function useR2Files(): UseR2FilesReturn {
  const { send, subscribe, currentSessionIdRef, state } = useAgentConnection();

  const [directories, setDirectories] = useState<Map<string, R2DirListing>>(() => new Map());
  const [files, setFiles] = useState<Map<string, R2FileContent>>(() => new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<R2FileError | null>(null);
  const [conflict, setConflict] = useState<R2FileConflict | null>(null);

  /**
   * Pending request queues, keyed by action + path. When an action
   * helper returns a promise, we stash a resolver here that the event
   * handler drains on the first matching broadcast.
   */
  const pendingReadsRef = useRef(new Map<string, ((value: R2FileContent | null) => void)[]>());
  const pendingWritesRef = useRef(
    new Map<string, ((value: R2FileSaved | R2FileConflict | null) => void)[]>(),
  );
  const pendingCreatesRef = useRef(new Map<string, ((value: R2FileSaved | null) => void)[]>());

  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;

  const listDir = useCallback(
    (path?: string) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId: CAPABILITY_ID,
        action: "list",
        data: { path: path ?? "" },
        sessionId,
      });
    },
    [send, currentSessionIdRef],
  );

  const readFile = useCallback(
    (path: string): Promise<R2FileContent | null> => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return Promise.resolve(null);
      return new Promise((resolve) => {
        const queue = pendingReadsRef.current.get(path) ?? [];
        queue.push(resolve);
        pendingReadsRef.current.set(path, queue);
        send({
          type: "capability_action",
          capabilityId: CAPABILITY_ID,
          action: "read",
          data: { path },
          sessionId,
        });
      });
    },
    [send, currentSessionIdRef],
  );

  const writeFile = useCallback(
    (
      path: string,
      content: string,
      etag?: string,
    ): Promise<R2FileSaved | R2FileConflict | null> => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return Promise.resolve(null);
      return new Promise((resolve) => {
        const queue = pendingWritesRef.current.get(path) ?? [];
        queue.push(resolve);
        pendingWritesRef.current.set(path, queue);
        send({
          type: "capability_action",
          capabilityId: CAPABILITY_ID,
          action: "write",
          data: { path, content, etag },
          sessionId,
        });
      });
    },
    [send, currentSessionIdRef],
  );

  const createFile = useCallback(
    (path: string): Promise<R2FileSaved | null> => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return Promise.resolve(null);
      return new Promise((resolve) => {
        const queue = pendingCreatesRef.current.get(path) ?? [];
        queue.push(resolve);
        pendingCreatesRef.current.set(path, queue);
        send({
          type: "capability_action",
          capabilityId: CAPABILITY_ID,
          action: "create",
          data: { path },
          sessionId,
        });
      });
    },
    [send, currentSessionIdRef],
  );

  const deleteFile = useCallback(
    (path: string) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId: CAPABILITY_ID,
        action: "delete",
        data: { path },
        sessionId,
      });
    },
    [send, currentSessionIdRef],
  );

  const renameFile = useCallback(
    (oldPath: string, newPath: string) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId: CAPABILITY_ID,
        action: "rename",
        data: { oldPath, newPath },
        sessionId,
      });
    },
    [send, currentSessionIdRef],
  );

  const createDir = useCallback(
    (path: string) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId: CAPABILITY_ID,
        action: "mkdir",
        data: { path },
        sessionId,
      });
    },
    [send, currentSessionIdRef],
  );

  const deleteDir = useCallback(
    (path: string) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId: CAPABILITY_ID,
        action: "rmdir",
        data: { path },
        sessionId,
      });
    },
    [send, currentSessionIdRef],
  );

  const renameDir = useCallback(
    (oldPath: string, newPath: string) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      send({
        type: "capability_action",
        capabilityId: CAPABILITY_ID,
        action: "rename_dir",
        data: { oldPath, newPath },
        sessionId,
      });
    },
    [send, currentSessionIdRef],
  );

  const toggleExpanded = useCallback(
    (path: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          listDir(path);
        }
        return next;
      });
    },
    [listDir],
  );

  const clearError = useCallback(() => setError(null), []);
  const clearConflict = useCallback(() => setConflict(null), []);

  // Subscribe to capability_state events for r2-storage.
  useEffect(() => {
    const unsubscribe = subscribe(CAPABILITY_ID, (event, data) => {
      switch (event) {
        case "dir_listing": {
          const listing = data as R2DirListing;
          setDirectories((prev) => {
            const next = new Map(prev);
            next.set(listing.path, listing);
            return next;
          });
          return;
        }
        case "file_content": {
          const file = data as R2FileContent;
          setFiles((prev) => {
            const next = new Map(prev);
            next.set(file.path, file);
            return next;
          });
          const queue = pendingReadsRef.current.get(file.path);
          if (queue && queue.length > 0) {
            for (const resolve of queue) resolve(file);
            pendingReadsRef.current.delete(file.path);
          }
          return;
        }
        case "file_saved": {
          const saved = data as R2FileSaved;
          const writeQueue = pendingWritesRef.current.get(saved.path);
          if (writeQueue && writeQueue.length > 0) {
            for (const resolve of writeQueue) resolve(saved);
            pendingWritesRef.current.delete(saved.path);
          }
          const createQueue = pendingCreatesRef.current.get(saved.path);
          if (createQueue && createQueue.length > 0) {
            for (const resolve of createQueue) resolve(saved);
            pendingCreatesRef.current.delete(saved.path);
          }
          return;
        }
        case "file_conflict": {
          const conflictData = data as R2FileConflict;
          setConflict(conflictData);
          const queue = pendingWritesRef.current.get(conflictData.path);
          if (queue && queue.length > 0) {
            for (const resolve of queue) resolve(conflictData);
            pendingWritesRef.current.delete(conflictData.path);
          }
          return;
        }
        case "file_changed": {
          const { path } = data as { path: string };
          const dirPrefix = `${path}/`;
          setFiles((prev) => {
            const next = new Map(prev);
            let mutated = false;
            for (const key of next.keys()) {
              if (key === path || key.startsWith(dirPrefix)) {
                next.delete(key);
                mutated = true;
              }
            }
            return mutated ? next : prev;
          });
          // Drop any cached directory listings rooted at or inside `path`
          // (dir renames / deletes invalidate every descendant listing).
          setDirectories((prev) => {
            const next = new Map(prev);
            let mutated = false;
            for (const key of next.keys()) {
              if (key === path || key.startsWith(dirPrefix)) {
                next.delete(key);
                mutated = true;
              }
            }
            return mutated ? next : prev;
          });
          // Refresh the parent directory if it's currently expanded.
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          if (expandedDirsRef.current.has(parent)) {
            listDir(parent);
          }
          return;
        }
        case "file_error": {
          const errData = data as R2FileError;
          setError(errData);
          const readQueue = pendingReadsRef.current.get(errData.path ?? "");
          if (readQueue && readQueue.length > 0 && errData.action === "read") {
            for (const resolve of readQueue) resolve(null);
            pendingReadsRef.current.delete(errData.path ?? "");
          }
          const writeQueue = pendingWritesRef.current.get(errData.path ?? "");
          if (writeQueue && writeQueue.length > 0 && errData.action === "write") {
            for (const resolve of writeQueue) resolve(null);
            pendingWritesRef.current.delete(errData.path ?? "");
          }
          const createQueue = pendingCreatesRef.current.get(errData.path ?? "");
          if (createQueue && createQueue.length > 0 && errData.action === "create") {
            for (const resolve of createQueue) resolve(null);
            pendingCreatesRef.current.delete(errData.path ?? "");
          }
          return;
        }
        default:
          return;
      }
    });
    return unsubscribe;
  }, [subscribe, listDir]);

  // Load root directory once a session is available. Re-fires when the
  // session id changes (initial join after WebSocket open, or switch).
  useEffect(() => {
    if (!state.currentSessionId) return;
    listDir("");
    for (const path of expandedDirsRef.current) {
      if (path !== "") listDir(path);
    }
  }, [state.currentSessionId, listDir]);

  return {
    directories,
    files,
    expandedDirs,
    error,
    conflict,
    listDir,
    readFile,
    writeFile,
    createFile,
    deleteFile,
    renameFile,
    createDir,
    deleteDir,
    renameDir,
    toggleExpanded,
    clearError,
    clearConflict,
  };
}
