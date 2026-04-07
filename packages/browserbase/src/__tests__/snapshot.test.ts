import { describe, it, expect } from "vitest";
import { formatAXTree, resolveRef } from "../snapshot.js";
import type { AXNode } from "../types.js";

function node(overrides: Partial<AXNode> & { nodeId: string }): AXNode {
  return {
    ignored: false,
    ...overrides,
  };
}

const sampleTree: AXNode[] = [
  node({
    nodeId: "1",
    role: { type: "role", value: "RootWebArea" },
    name: { type: "computedString", value: "Example Page" },
    childIds: ["2", "3", "4", "5"],
  }),
  node({
    nodeId: "2",
    role: { type: "role", value: "heading" },
    name: { type: "computedString", value: "Welcome" },
    properties: [{ name: "level", value: { type: "integer", value: 1 } }],
    backendDOMNodeId: 10,
  }),
  node({
    nodeId: "3",
    role: { type: "role", value: "paragraph" },
    name: { type: "computedString", value: "Some text content" },
  }),
  node({
    nodeId: "4",
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Submit" },
    backendDOMNodeId: 20,
  }),
  node({
    nodeId: "5",
    role: { type: "role", value: "textbox" },
    name: { type: "computedString", value: "Email" },
    backendDOMNodeId: 30,
  }),
];

describe("formatAXTree", () => {
  it("formats a basic tree with refs on interactive elements", () => {
    const { tree, refs } = formatAXTree(sampleTree);

    expect(tree).toContain('heading "Welcome" [ref=e1]');
    expect(tree).toContain("[level=1]");
    expect(tree).toContain('button "Submit" [ref=e2]');
    expect(tree).toContain('textbox "Email" [ref=e3]');

    expect(refs.e1.role).toBe("heading");
    expect(refs.e1.name).toBe("Welcome");
    expect(refs.e2.role).toBe("button");
    expect(refs.e2.backendDOMNodeId).toBe(20);
    expect(refs.e3.role).toBe("textbox");
  });

  it("skips root RootWebArea node", () => {
    const { tree } = formatAXTree(sampleTree);
    expect(tree).not.toContain("RootWebArea");
  });

  it("assigns refs only to interactive and content roles", () => {
    const { refs } = formatAXTree(sampleTree);
    // heading (content) + button (interactive) + textbox (interactive) = 3 refs
    // paragraph is neither interactive nor content
    expect(Object.keys(refs)).toHaveLength(3);
  });

  it("does not assign refs to structural/paragraph roles", () => {
    const { refs } = formatAXTree(sampleTree);
    const roles = Object.values(refs).map((r) => r.role);
    expect(roles).not.toContain("paragraph");
  });

  it("handles interactive-only mode", () => {
    const { tree, refs } = formatAXTree(sampleTree, { interactive: true });

    // Should contain interactive elements only
    expect(tree).toContain("button");
    expect(tree).toContain("textbox");
    // Should NOT contain heading or paragraph
    expect(tree).not.toContain("heading");
    expect(tree).not.toContain("paragraph");

    expect(Object.keys(refs)).toHaveLength(2);
  });

  it("respects maxDepth", () => {
    const nestedTree: AXNode[] = [
      node({
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        childIds: ["2"],
      }),
      node({
        nodeId: "2",
        role: { type: "role", value: "navigation" },
        name: { type: "computedString", value: "Main" },
        childIds: ["3"],
        backendDOMNodeId: 10,
      }),
      node({
        nodeId: "3",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Menu" },
        backendDOMNodeId: 20,
      }),
    ];

    const { tree, refs } = formatAXTree(nestedTree, { maxDepth: 0 });

    expect(tree).toContain("navigation");
    expect(tree).not.toContain("button");
    // Only the navigation ref (depth 0), not button (depth 1)
    expect(Object.keys(refs)).toHaveLength(1);
  });

  it("returns (empty) for empty node list", () => {
    const { tree, refs } = formatAXTree([]);
    expect(tree).toBe("(empty)");
    expect(Object.keys(refs)).toHaveLength(0);
  });

  it("returns (no interactive elements) in interactive mode when none found", () => {
    const nonInteractive: AXNode[] = [
      node({
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        childIds: ["2"],
      }),
      node({
        nodeId: "2",
        role: { type: "role", value: "paragraph" },
        name: { type: "computedString", value: "Just text" },
      }),
    ];

    const { tree } = formatAXTree(nonInteractive, { interactive: true });
    expect(tree).toBe("(no interactive elements)");
  });

  it("skips ignored nodes", () => {
    const withIgnored: AXNode[] = [
      node({
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        childIds: ["2", "3"],
      }),
      node({
        nodeId: "2",
        ignored: true,
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Hidden" },
      }),
      node({
        nodeId: "3",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Visible" },
        backendDOMNodeId: 10,
      }),
    ];

    const { tree, refs } = formatAXTree(withIgnored);
    expect(tree).not.toContain("Hidden");
    expect(tree).toContain("Visible");
    expect(Object.keys(refs)).toHaveLength(1);
  });

  it("includes checkbox checked property", () => {
    const checkbox: AXNode[] = [
      node({
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        childIds: ["2"],
      }),
      node({
        nodeId: "2",
        role: { type: "role", value: "checkbox" },
        name: { type: "computedString", value: "Accept terms" },
        properties: [{ name: "checked", value: { type: "tristate", value: "true" } }],
        backendDOMNodeId: 10,
      }),
    ];

    const { tree } = formatAXTree(checkbox);
    expect(tree).toContain("[checked=true]");
  });
});

describe("resolveRef", () => {
  it("resolves a direct ref", () => {
    const refs = { e1: { nodeId: "1", backendDOMNodeId: 10, role: "button", name: "Submit" } };
    expect(resolveRef(refs, "e1")).toEqual(refs.e1);
  });

  it("resolves @-prefixed ref", () => {
    const refs = { e2: { nodeId: "2", backendDOMNodeId: 20, role: "link", name: "Home" } };
    expect(resolveRef(refs, "@e2")).toEqual(refs.e2);
  });

  it("resolves ref= prefixed ref", () => {
    const refs = { e3: { nodeId: "3", backendDOMNodeId: 30, role: "textbox", name: "Name" } };
    expect(resolveRef(refs, "ref=e3")).toEqual(refs.e3);
  });

  it("returns null for unknown ref", () => {
    expect(resolveRef({}, "e99")).toBeNull();
  });
});
