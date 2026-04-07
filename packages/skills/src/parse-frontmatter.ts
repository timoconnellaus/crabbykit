/**
 * Lenient frontmatter parser for the afterToolExecution hook.
 *
 * Never throws — returns a partial object with whatever fields were found.
 * Used when the agent writes a SKILL.md and we need to extract metadata.
 */
export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  requiresCapabilities?: string[];
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return result;

  const frontmatter = match[1];
  for (const line of frontmatter.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    switch (key) {
      case "name":
        result.name = value;
        break;
      case "description":
        result.description = value;
        break;
      case "version":
        result.version = value;
        break;
      case "requiresCapabilities": {
        const bracketMatch = value.match(/^\[(.*)\]$/);
        const inner = bracketMatch ? bracketMatch[1] : value;
        result.requiresCapabilities = inner
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
    }
  }

  return result;
}
