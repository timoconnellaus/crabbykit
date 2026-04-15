const SKILLS_PREFIX = "skills/";

function skillR2Key(namespace: string, skillId: string): string {
  return `${namespace}/${SKILLS_PREFIX}${skillId}/SKILL.md`;
}

export async function writeSkillToR2(
  bucket: R2Bucket,
  namespace: string,
  skillId: string,
  content: string,
): Promise<void> {
  await bucket.put(skillR2Key(namespace, skillId), content);
}

export async function readSkillFromR2(
  bucket: R2Bucket,
  namespace: string,
  skillId: string,
): Promise<string | null> {
  const obj = await bucket.get(skillR2Key(namespace, skillId));
  if (!obj) return null;
  return obj.text();
}

export async function deleteSkillFromR2(
  bucket: R2Bucket,
  namespace: string,
  skillId: string,
): Promise<void> {
  await bucket.delete(skillR2Key(namespace, skillId));
}

export async function hashSkillContent(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Extract the skill ID from an R2 key path, or null if the path isn't a skill file. */
export function skillIdFromR2Path(path: string): string | null {
  // Path format: skills/{skillId}/SKILL.md
  const match = path.match(/^skills\/([^/]+)\/SKILL\.md$/);
  return match ? match[1] : null;
}
