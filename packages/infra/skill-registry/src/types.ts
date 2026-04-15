export interface SkillRecord {
  id: string;
  name: string;
  /** Max 250 characters. Used as a routing key for agent skill selection. */
  description: string;
  version: string;
  /** Hex-encoded SHA-256 digest of skillMd content. Computed on upsert. */
  contentHash: string;
  /** Capability IDs this skill requires to function. */
  requiresCapabilities: string[];
  /** Full SKILL.md content including frontmatter. */
  skillMd: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for seed definitions — hash and timestamps are computed automatically. */
export type SkillSeed = Omit<SkillRecord, "contentHash" | "createdAt" | "updatedAt">;

export interface SkillRegistry {
  list(): Promise<SkillRecord[]>;
  get(id: string): Promise<SkillRecord | null>;
  getVersion(id: string): Promise<{ version: string; contentHash: string } | null>;
  upsert(skill: Omit<SkillRecord, "contentHash" | "createdAt" | "updatedAt">): Promise<void>;
  delete(id: string): Promise<boolean>;
}
