import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../parse-skill-file.js";

describe("parseSkillFile", () => {
  it("parses a complete SKILL.md into a SkillSeed", () => {
    const content = `---
name: My Skill
description: A useful skill for testing
version: 2.1.0
requiresCapabilities: [sandbox, vibe-coder]
---

# My Skill

Instructions go here.
`;
    const seed = parseSkillFile("my-skill", content);
    expect(seed).toEqual({
      id: "my-skill",
      name: "My Skill",
      description: "A useful skill for testing",
      version: "2.1.0",
      requiresCapabilities: ["sandbox", "vibe-coder"],
      skillMd: content,
    });
  });

  it("defaults requiresCapabilities to empty array when missing", () => {
    const content = `---
name: Simple Skill
description: No deps
version: 1.0.0
---

# Simple
`;
    const seed = parseSkillFile("simple", content);
    expect(seed.requiresCapabilities).toEqual([]);
  });

  it("throws when frontmatter is missing", () => {
    const content = "# No frontmatter\n\nJust content.";
    expect(() => parseSkillFile("bad", content)).toThrow('Skill "bad": missing YAML frontmatter');
  });

  it("throws when name is missing", () => {
    const content = `---
description: has desc
version: 1.0.0
---
`;
    expect(() => parseSkillFile("no-name", content)).toThrow(
      'Skill "no-name": missing required frontmatter field "name"',
    );
  });

  it("throws when description is missing", () => {
    const content = `---
name: Has Name
version: 1.0.0
---
`;
    expect(() => parseSkillFile("no-desc", content)).toThrow(
      'Skill "no-desc": missing required frontmatter field "description"',
    );
  });

  it("throws when version is missing", () => {
    const content = `---
name: Has Name
description: Has desc
---
`;
    expect(() => parseSkillFile("no-ver", content)).toThrow(
      'Skill "no-ver": missing required frontmatter field "version"',
    );
  });

  it("preserves full content including frontmatter in skillMd", () => {
    const content = `---
name: Test
description: Test desc
version: 1.0.0
---

# Content`;
    const seed = parseSkillFile("test", content);
    expect(seed.skillMd).toBe(content);
  });
});
