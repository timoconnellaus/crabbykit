import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useState } from "react";
import type { R2DirEntry, R2DirListing } from "../hooks/use-r2-files";
import { FileIcon } from "./file-icon";

export interface FileTreeProps {
  directories: Map<string, R2DirListing>;
  expandedDirs: Set<string>;
  selectedFile: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
  onNewFile: (path: string) => void;
  onNewFolder: (path: string) => void;
  onRename: (oldPath: string, newName: string, type: "file" | "directory") => void;
  onDelete: (path: string, type: "file" | "directory") => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  type: "file" | "directory";
}

interface DeleteConfirmState {
  path: string;
  type: "file" | "directory";
}

interface NewEntryState {
  dir: string;
  type: "file" | "directory";
}

export function FileTree({
  directories,
  expandedDirs,
  selectedFile,
  onToggleDir,
  onSelectFile,
  onRefresh,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<{
    path: string;
    type: "file" | "directory";
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [newEntry, setNewEntry] = useState<NewEntryState | null>(null);
  const [newEntryName, setNewEntryName] = useState("");

  const root = directories.get("");

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const openContextMenu = useCallback((e: MouseEvent, path: string, type: "file" | "directory") => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, path, type });
  }, []);

  const startRename = useCallback((path: string, type: "file" | "directory") => {
    const name = path.split("/").pop() ?? path;
    setRenameValue(name);
    setRenamingPath({ path, type });
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingPath && renameValue.trim()) {
      onRename(renamingPath.path, renameValue.trim(), renamingPath.type);
    }
    setRenamingPath(null);
  }, [renamingPath, renameValue, onRename]);

  const handleRenameKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") commitRename();
      if (e.key === "Escape") setRenamingPath(null);
    },
    [commitRename],
  );

  const startDelete = useCallback((path: string, type: "file" | "directory") => {
    setDeleteConfirm({ path, type });
    setContextMenu(null);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deleteConfirm) onDelete(deleteConfirm.path, deleteConfirm.type);
    setDeleteConfirm(null);
  }, [deleteConfirm, onDelete]);

  const startNewEntry = useCallback((dir: string, type: "file" | "directory") => {
    setNewEntryName("");
    setNewEntry({ dir, type });
  }, []);

  const commitNewEntry = useCallback(() => {
    if (newEntry && newEntryName.trim()) {
      const full = newEntry.dir ? `${newEntry.dir}/${newEntryName.trim()}` : newEntryName.trim();
      if (newEntry.type === "file") {
        onNewFile(full);
      } else {
        onNewFolder(full);
      }
    }
    setNewEntry(null);
  }, [newEntry, newEntryName, onNewFile, onNewFolder]);

  const handleNewEntryKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") commitNewEntry();
      if (e.key === "Escape") setNewEntry(null);
    },
    [commitNewEntry],
  );

  const renderEntries = (parentPath: string, entries: R2DirEntry[], depth: number) => {
    return entries.map((entry) => {
      const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const isRenaming = renamingPath?.path === fullPath && renamingPath.type === entry.type;

      if (entry.type === "directory") {
        const isExpanded = expandedDirs.has(fullPath);
        const dirListing = directories.get(fullPath);

        return (
          <div key={fullPath} data-agent-ui="file-tree-dir">
            <div
              data-agent-ui="file-tree-row"
              data-type="directory"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {isRenaming ? (
                <>
                  <span data-agent-ui="file-tree-chevron">{isExpanded ? "▾" : "▸"}</span>
                  <FileIcon name={entry.name} type="directory" expanded={isExpanded} />
                  <input
                    data-agent-ui="file-tree-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKey}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    // biome-ignore lint/a11y/noAutofocus: user-initiated rename needs focus
                    autoFocus
                  />
                </>
              ) : (
                <button
                  type="button"
                  data-agent-ui="file-tree-dir-button"
                  data-expanded={isExpanded || undefined}
                  onClick={() => onToggleDir(fullPath)}
                  onContextMenu={(e) => openContextMenu(e, fullPath, "directory")}
                >
                  <span data-agent-ui="file-tree-chevron">{isExpanded ? "▾" : "▸"}</span>
                  <FileIcon name={entry.name} type="directory" expanded={isExpanded} />
                  <span data-agent-ui="file-tree-name">{entry.name}</span>
                </button>
              )}
              {!isRenaming && (
                <div data-agent-ui="file-tree-row-actions">
                  <button
                    type="button"
                    data-agent-ui="file-tree-row-action"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(fullPath, "directory");
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    data-agent-ui="file-tree-row-action"
                    data-danger
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      startDelete(fullPath, "directory");
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
            {isExpanded && dirListing && (
              <>
                {newEntry?.dir === fullPath && (
                  <div
                    data-agent-ui="file-tree-new-entry-row"
                    style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
                  >
                    <input
                      data-agent-ui="file-tree-new-file-input"
                      value={newEntryName}
                      onChange={(e) => setNewEntryName(e.target.value)}
                      onKeyDown={handleNewEntryKey}
                      onBlur={() => setNewEntry(null)}
                      placeholder={newEntry.type === "file" ? "filename.ext" : "folder-name"}
                      // biome-ignore lint/a11y/noAutofocus: user-initiated creation needs focus
                      autoFocus
                    />
                  </div>
                )}
                {renderEntries(fullPath, dirListing.entries, depth + 1)}
                {dirListing.entries.length === 0 && newEntry?.dir !== fullPath && (
                  <div
                    data-agent-ui="file-tree-empty-dir"
                    style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
                  >
                    Empty
                  </div>
                )}
              </>
            )}
            {isExpanded && !dirListing && (
              <div
                data-agent-ui="file-tree-loading"
                style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
              >
                Loading…
              </div>
            )}
          </div>
        );
      }

      const isSelected = selectedFile === fullPath;

      return (
        <div
          key={fullPath}
          data-agent-ui="file-tree-row"
          data-type="file"
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
        >
          {isRenaming ? (
            <>
              <FileIcon name={entry.name} type="file" />
              <input
                data-agent-ui="file-tree-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKey}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                // biome-ignore lint/a11y/noAutofocus: user-initiated rename needs focus
                autoFocus
              />
            </>
          ) : (
            <button
              type="button"
              data-agent-ui="file-tree-file-button"
              data-selected={isSelected || undefined}
              onClick={() => onSelectFile(fullPath)}
              onContextMenu={(e) => openContextMenu(e, fullPath, "file")}
            >
              <FileIcon name={entry.name} type="file" />
              <span data-agent-ui="file-tree-name">{entry.name}</span>
            </button>
          )}
          {!isRenaming && (
            <div data-agent-ui="file-tree-row-actions">
              <button
                type="button"
                data-agent-ui="file-tree-row-action"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(fullPath, "file");
                }}
              >
                ✎
              </button>
              <button
                type="button"
                data-agent-ui="file-tree-row-action"
                data-danger
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  startDelete(fullPath, "file");
                }}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div data-agent-ui="file-tree">
      <div data-agent-ui="file-tree-header">
        <span data-agent-ui="file-tree-title">Files</span>
        <div data-agent-ui="file-tree-header-actions">
          <button
            type="button"
            data-agent-ui="file-tree-new-file"
            title="New file"
            onClick={() => startNewEntry("", "file")}
          >
            + File
          </button>
          <button
            type="button"
            data-agent-ui="file-tree-new-folder"
            title="New folder"
            onClick={() => startNewEntry("", "directory")}
          >
            + Folder
          </button>
          <button
            type="button"
            data-agent-ui="file-tree-refresh"
            title="Refresh"
            onClick={onRefresh}
          >
            ↻
          </button>
        </div>
      </div>

      <div data-agent-ui="file-tree-body">
        {newEntry?.dir === "" && (
          <div data-agent-ui="file-tree-new-entry-row" style={{ paddingLeft: "20px" }}>
            <input
              data-agent-ui="file-tree-new-file-input"
              value={newEntryName}
              onChange={(e) => setNewEntryName(e.target.value)}
              onKeyDown={handleNewEntryKey}
              onBlur={() => setNewEntry(null)}
              placeholder={newEntry.type === "file" ? "filename.ext" : "folder-name"}
              // biome-ignore lint/a11y/noAutofocus: user-initiated creation needs focus
              autoFocus
            />
          </div>
        )}
        {!root && <div data-agent-ui="file-tree-loading">Loading files…</div>}
        {root && root.entries.length === 0 && newEntry?.dir !== "" && (
          <div data-agent-ui="file-tree-empty">
            <span>No files yet</span>
            <button
              type="button"
              data-agent-ui="file-tree-empty-create"
              onClick={() => startNewEntry("", "file")}
            >
              Create a file
            </button>
          </div>
        )}
        {root && root.entries.length > 0 && renderEntries("", root.entries, 0)}
      </div>

      {contextMenu && (
        <div
          data-agent-ui="file-tree-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.type === "directory" && (
            <>
              <button
                type="button"
                data-agent-ui="file-tree-context-item"
                onClick={() => startNewEntry(contextMenu.path, "file")}
              >
                New file here
              </button>
              <button
                type="button"
                data-agent-ui="file-tree-context-item"
                onClick={() => startNewEntry(contextMenu.path, "directory")}
              >
                New folder here
              </button>
            </>
          )}
          <button
            type="button"
            data-agent-ui="file-tree-context-item"
            onClick={() => startRename(contextMenu.path, contextMenu.type)}
          >
            Rename
          </button>
          <button
            type="button"
            data-agent-ui="file-tree-context-item"
            data-danger
            onClick={() => startDelete(contextMenu.path, contextMenu.type)}
          >
            Delete
          </button>
        </div>
      )}

      {deleteConfirm && (
        <div data-agent-ui="file-tree-delete-confirm">
          <div data-agent-ui="file-tree-delete-dialog">
            <h3>Delete {deleteConfirm.type === "directory" ? "folder" : "file"}?</h3>
            <p>
              {deleteConfirm.type === "directory" ? (
                <>
                  Delete <strong>{deleteConfirm.path.split("/").pop()}</strong> and all of its
                  contents? This cannot be undone.
                </>
              ) : (
                <>
                  Delete <strong>{deleteConfirm.path.split("/").pop()}</strong>? This cannot be
                  undone.
                </>
              )}
            </p>
            <div data-agent-ui="file-tree-delete-actions">
              <button
                type="button"
                data-agent-ui="file-tree-delete-cancel"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-agent-ui="file-tree-delete-confirm-button"
                onClick={confirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
