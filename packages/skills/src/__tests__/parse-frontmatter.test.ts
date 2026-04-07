import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../parse-frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses all fields from valid frontmatter", () => {
    const content = `---
name: my-skill
description: A test skill
version: 1.0.0
requiresCapabilities: [sandbox, r2-storage]
---

# Content here
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      name: "my-skill",
      description: "A test skill",
      version: "1.0.0",
      requiresCapabilities: ["sandbox", "r2-storage"],
    });
  });

  it("returns empty object when no frontmatter", () => {
    const content = "# Just markdown\n\nNo frontmatter here.";
    expect(parseFrontmatter(content)).toEqual({});
  });

  it("returns partial object when some fields missing", () => {
    const content = `---
name: partial-skill
---

# Content
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("partial-skill");
    expect(result.description).toBeUndefined();
    expect(result.version).toBeUndefined();
  });

  it("handles empty requiresCapabilities list", () => {
    const content = `---
name: test
description: test desc
requiresCapabilities: []
---
`;
    const result = parseFrontmatter(content);
    expect(result.requiresCapabilities).toEqual([]);
  });

  it("handles empty content", () => {
    expect(parseFrontmatter("")).toEqual({});
  });

  it("handles malformed frontmatter (no closing ---)", () => {
    const content = `---
name: broken
`;
    expect(parseFrontmatter(content)).toEqual({});
  });

  it("handles Windows-style line endings", () => {
    const content = "---\r\nname: win-skill\r\ndescription: Windows desc\r\n---\r\n# Content\r\n";
    const result = parseFrontmatter(content);
    expect(result.name).toBe("win-skill");
    expect(result.description).toBe("Windows desc");
  });

  it("ignores unknown fields", () => {
    const content = `---
name: test
unknown_field: some value
description: desc
---
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("test");
    expect(result.description).toBe("desc");
    expect(result).not.toHaveProperty("unknown_field");
  });
});
