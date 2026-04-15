import { type ComponentPropsWithoutRef, useCallback, useEffect, useState } from "react";
import { type R2FileContent, useR2Files } from "../hooks/use-r2-files";
import { FileEditor } from "./file-editor";
import { FileTree } from "./file-tree";

export interface FilesPanelProps extends ComponentPropsWithoutRef<"div"> {}

/**
 * Top-level file browser panel. Combines a directory tree with a
 * CodeMirror editor that reads the agent's R2 workspace over the
 * `file-tools` capability's UI bridge.
 */
export function FilesPanel(props: FilesPanelProps) {
  const {
    directories,
    expandedDirs,
    files,
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
  } = useR2Files();

  const [openFile, setOpenFile] = useState<R2FileContent | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [pathToSelect, setPathToSelect] = useState<string | null>(null);

  const handleSelect = useCallback(
    async (path: string) => {
      const cached = files.get(path);
      if (cached) {
        setOpenFile(cached);
        clearConflict();
        return;
      }
      const fetched = await readFile(path);
      if (fetched) {
        setOpenFile(fetched);
        clearConflict();
      }
    },
    [files, readFile, clearConflict],
  );

  // If the open file was invalidated (file_changed cleared the cache),
  // drop the editor state so the next select re-fetches fresh.
  useEffect(() => {
    if (openFile && !files.has(openFile.path)) {
      setOpenFile(null);
    }
  }, [files, openFile]);

  // After tree refreshes, auto-select any pending path from a new-file
  // flow so the user drops straight into the editor.
  useEffect(() => {
    if (!pendingSelect) return;
    const parent = pendingSelect.includes("/")
      ? pendingSelect.slice(0, pendingSelect.lastIndexOf("/"))
      : "";
    const listing = directories.get(parent);
    if (listing?.entries.some((e) => (parent ? `${parent}/${e.name}` : e.name) === pendingSelect)) {
      setPathToSelect(pendingSelect);
      setPendingSelect(null);
    }
  }, [directories, pendingSelect]);

  useEffect(() => {
    if (pathToSelect) {
      handleSelect(pathToSelect);
      setPathToSelect(null);
    }
  }, [pathToSelect, handleSelect]);

  const handleSave = useCallback(
    async (content: string, etag: string) => {
      if (!openFile) return null;
      const result = await writeFile(openFile.path, content, etag);
      if (!result) return null;
      if ("reason" in result) {
        return { conflict: true };
      }
      setOpenFile((prev) => (prev ? { ...prev, etag: result.etag, content } : prev));
      return { etag: result.etag };
    },
    [openFile, writeFile],
  );

  const handleReload = useCallback(async () => {
    if (!openFile) return;
    const fetched = await readFile(openFile.path);
    if (fetched) {
      setOpenFile(fetched);
      clearConflict();
    }
  }, [openFile, readFile, clearConflict]);

  const handleRefresh = useCallback(() => {
    for (const path of expandedDirs) {
      listDir(path);
    }
  }, [expandedDirs, listDir]);

  const handleNewFile = useCallback(
    async (path: string) => {
      const result = await createFile(path);
      if (result) {
        setPendingSelect(path);
      }
    },
    [createFile],
  );

  const handleNewFolder = useCallback(
    (path: string) => {
      createDir(path);
    },
    [createDir],
  );

  const handleRename = useCallback(
    (oldPath: string, newName: string, type: "file" | "directory") => {
      const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parent ? `${parent}/${newName}` : newName;
      if (type === "directory") {
        renameDir(oldPath, newPath);
        // If the open file lived inside the renamed dir, close it — its
        // path is no longer addressable. The file_changed broadcast will
        // clear the cache; file-browser will re-select if the user
        // navigates into the new location.
        if (openFile && (openFile.path === oldPath || openFile.path.startsWith(`${oldPath}/`))) {
          setOpenFile(null);
        }
      } else {
        renameFile(oldPath, newPath);
        if (openFile?.path === oldPath) {
          setOpenFile(null);
          setPendingSelect(newPath);
        }
      }
    },
    [renameFile, renameDir, openFile],
  );

  const handleDelete = useCallback(
    (path: string, type: "file" | "directory") => {
      if (type === "directory") {
        deleteDir(path);
        if (openFile && (openFile.path === path || openFile.path.startsWith(`${path}/`))) {
          setOpenFile(null);
        }
      } else {
        deleteFile(path);
        if (openFile?.path === path) {
          setOpenFile(null);
        }
      }
    },
    [deleteFile, deleteDir, openFile],
  );

  const isConflict = Boolean(conflict && openFile && conflict.path === openFile.path);

  return (
    <div data-agent-ui="files-panel" {...props}>
      {error && (
        <div data-agent-ui="files-panel-error">
          <span>{error.message}</span>
          <button type="button" data-agent-ui="files-panel-error-dismiss" onClick={clearError}>
            ✕
          </button>
        </div>
      )}
      <div data-agent-ui="files-panel-body">
        <div data-agent-ui="files-panel-sidebar">
          <FileTree
            directories={directories}
            expandedDirs={expandedDirs}
            selectedFile={openFile?.path ?? null}
            onToggleDir={toggleExpanded}
            onSelectFile={handleSelect}
            onRefresh={handleRefresh}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        </div>
        <div data-agent-ui="files-panel-main">
          {openFile ? (
            <FileEditor
              key={`${openFile.path}:${openFile.etag}`}
              path={openFile.path}
              content={openFile.content}
              etag={openFile.etag}
              isBinary={openFile.isBinary}
              isLarge={openFile.isLarge}
              largeSize={openFile.largeSize}
              conflict={isConflict}
              onSave={handleSave}
              onReload={handleReload}
            />
          ) : (
            <div data-agent-ui="files-panel-empty">Select a file to view</div>
          )}
        </div>
      </div>
    </div>
  );
}
