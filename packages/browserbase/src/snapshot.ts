import type { AXNode, RefMap } from "./types.js";

/** Roles that are interactive and should get refs. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

/** Roles that provide structure/context — get refs for text extraction. */
const CONTENT_ROLES = new Set([
  "heading",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "article",
  "region",
  "main",
  "navigation",
]);

/** Roles that are purely structural (can be filtered in compact mode). */
const STRUCTURAL_ROLES = new Set([
  "generic",
  "group",
  "list",
  "table",
  "row",
  "rowgroup",
  "grid",
  "treegrid",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "tree",
  "directory",
  "document",
  "application",
  "presentation",
  "none",
]);

export interface SnapshotOptions {
  /** Only include interactive elements (buttons, links, inputs, etc.). */
  interactive?: boolean;
  /** Maximum depth of tree to include. */
  maxDepth?: number;
}

/**
 * Format a CDP Accessibility.getFullAXTree response into an indented,
 * ref-annotated text representation suitable for LLM consumption.
 *
 * Ported from agent-browser's snapshot engine, adapted for raw CDP AX nodes
 * instead of Playwright's ariaSnapshot format.
 */
export function formatAXTree(nodes: AXNode[], options: SnapshotOptions = {}): {
  tree: string;
  refs: RefMap;
} {
  if (!nodes.length) {
    return { tree: "(empty)", refs: {} };
  }

  const refs: RefMap = {};
  let refCounter = 0;

  // Build parent→children index
  const childrenOf = new Map<string, AXNode[]>();
  const nodeById = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeById.set(node.nodeId, node);
    if (node.childIds) {
      const children: AXNode[] = [];
      for (const childId of node.childIds) {
        const child = nodes.find((n) => n.nodeId === childId);
        if (child) children.push(child);
      }
      childrenOf.set(node.nodeId, children);
    }
  }

  const lines: string[] = [];

  function walk(node: AXNode, depth: number): void {
    if (node.ignored) return;
    if (options.maxDepth !== undefined && depth > options.maxDepth) return;

    const role = node.role?.value ?? "unknown";
    const name = node.name?.value ?? "";
    const roleLower = role.toLowerCase();

    // Skip the root "RootWebArea" — just walk children
    if (roleLower === "rootwebarea" || roleLower === "webarea") {
      const children = childrenOf.get(node.nodeId) ?? [];
      for (const child of children) {
        walk(child, depth);
      }
      return;
    }

    const isInteractive = INTERACTIVE_ROLES.has(roleLower);
    const isContent = CONTENT_ROLES.has(roleLower);
    const isStructural = STRUCTURAL_ROLES.has(roleLower);

    // In interactive mode, skip non-interactive nodes (but recurse into children)
    if (options.interactive && !isInteractive) {
      const children = childrenOf.get(node.nodeId) ?? [];
      for (const child of children) {
        walk(child, depth);
      }
      return;
    }

    // Build line
    const indent = "  ".repeat(depth);
    let line = `${indent}- ${role}`;
    if (name) {
      line += ` "${name}"`;
    }

    // Assign ref to interactive and content elements
    if (isInteractive || isContent) {
      const ref = `e${++refCounter}`;
      line += ` [ref=${ref}]`;
      refs[ref] = {
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId,
        role: roleLower,
        name: name,
      };
    }

    // Add properties (e.g., level for headings, checked for checkboxes)
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "level" || prop.name === "checked" || prop.name === "expanded" || prop.name === "selected" || prop.name === "disabled" || prop.name === "required") {
          line += ` [${prop.name}=${prop.value.value}]`;
        }
      }
    }

    lines.push(line);

    // Recurse into children
    const children = childrenOf.get(node.nodeId) ?? [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  }

  // Start from the root node (first in the array)
  walk(nodes[0], 0);

  const tree = lines.join("\n") || (options.interactive ? "(no interactive elements)" : "(empty)");
  return { tree, refs };
}

/**
 * Resolve a ref ID to its AX node metadata.
 * Returns the backendDOMNodeId needed for click/type operations.
 */
export function resolveRef(refs: RefMap, ref: string): RefMap[string] | null {
  // Normalize: accept "e3", "@e3", "ref=e3"
  const normalized = ref.replace(/^@/, "").replace(/^ref=/, "");
  return refs[normalized] ?? null;
}
