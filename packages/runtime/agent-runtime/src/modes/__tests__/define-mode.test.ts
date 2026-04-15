import { describe, expect, it } from "vitest";
import { defineMode } from "../define-mode.js";

describe("defineMode", () => {
  it("returns the input unchanged when no filter conflicts are present", () => {
    const mode = defineMode({
      id: "plan",
      name: "Planning",
      description: "Read-only",
    });
    expect(mode.id).toBe("plan");
    expect(mode.name).toBe("Planning");
  });

  it("throws when tools.allow and tools.deny are both populated", () => {
    expect(() =>
      defineMode({
        id: "x",
        name: "X",
        description: "x",
        tools: { allow: ["file_read"], deny: ["file_write"] },
      }),
    ).toThrow(/`tools` filter cannot specify both/);
  });

  it("throws when capabilities.allow and capabilities.deny are both populated", () => {
    expect(() =>
      defineMode({
        id: "x",
        name: "X",
        description: "x",
        capabilities: { allow: ["file-tools"], deny: ["vibe-coder"] },
      }),
    ).toThrow(/`capabilities` filter cannot specify both/);
  });

  it("identifies which filter is invalid in the error message", () => {
    expect(() =>
      defineMode({
        id: "x",
        name: "X",
        description: "x",
        tools: { allow: ["a"], deny: ["b"] },
      }),
    ).toThrow(/`tools`/);
    expect(() =>
      defineMode({
        id: "x",
        name: "X",
        description: "x",
        capabilities: { allow: ["a"], deny: ["b"] },
      }),
    ).toThrow(/`capabilities`/);
  });

  it("accepts allow-only filters", () => {
    const mode = defineMode({
      id: "x",
      name: "X",
      description: "x",
      tools: { allow: ["file_read"] },
      capabilities: { allow: ["file-tools"] },
    });
    expect(mode.tools).toEqual({ allow: ["file_read"] });
    expect(mode.capabilities).toEqual({ allow: ["file-tools"] });
  });

  it("accepts deny-only filters", () => {
    const mode = defineMode({
      id: "x",
      name: "X",
      description: "x",
      tools: { deny: ["file_write"] },
      capabilities: { deny: ["vibe-coder"] },
    });
    expect(mode.tools).toEqual({ deny: ["file_write"] });
  });

  it("permits different filters to independently pick allow or deny", () => {
    const mode = defineMode({
      id: "x",
      name: "X",
      description: "x",
      capabilities: { allow: ["file-tools"] },
      tools: { deny: ["file_write"] },
    });
    expect(mode.capabilities).toEqual({ allow: ["file-tools"] });
    expect(mode.tools).toEqual({ deny: ["file_write"] });
  });

  it("treats an empty allow array as no filter (does not throw)", () => {
    expect(() =>
      defineMode({
        id: "x",
        name: "X",
        description: "x",
        tools: { allow: [], deny: ["file_write"] },
      }),
    ).not.toThrow();
  });
});
