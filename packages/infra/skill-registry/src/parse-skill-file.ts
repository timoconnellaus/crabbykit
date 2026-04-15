import type { SkillSeed } from "./types.js";

/**
 * Parse a SKILL.md file with YAML frontmatter into a SkillSeed.
 *
 * Strict parser — throws on missing required fields (name, description, version).
 * Used for seeding the skill registry from workspace skill files.
 */
export function parseSkillFile(id: string, content: string): SkillSeed {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`Skill "${id}": missing YAML frontmatter`);
  }

  const frontmatter = match[1];
  const fields = parseFrontmatterFields(frontmatter);

  const name = fields.get("name");
  if (!name) {
    throw new Error(`Skill "${id}": missing required frontmatter field "name"`);
  }

  const description = fields.get("description");
  if (!description) {
    throw new Error(`Skill "${id}": missing required frontmatter field "description"`);
  }

  const version = fields.get("version");
  if (!version) {
    throw new Error(`Skill "${id}": missing required frontmatter field "version"`);
  }

  const requiresCapabilities = parseList(fields.get("requiresCapabilities") ?? "");

  return {
    id,
    name,
    description,
    version,
    requiresCapabilities,
    skillMd: content,
  };
}

/** Parse simple YAML key-value pairs from frontmatter text. */
function parseFrontmatterFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      fields.set(key, value);
    }
  }
  return fields;
}

/** Parse a YAML-style list value: either "[a, b]" or comma-separated. */
function parseList(value: string): string[] {
  if (!value) return [];
  // Handle "[a, b]" format
  const bracketMatch = value.match(/^\[(.*)\]$/);
  const inner = bracketMatch ? bracketMatch[1] : value;
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
