import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SkillRegistry } from "@claw-for-cloudflare/skill-registry";

export interface SkillDeclaration {
  id: string;
  enabled?: boolean;
  autoUpdate?: boolean;
}

export interface SkillsOptions {
  storage: AgentStorage;
  registry: SkillRegistry;
  skills: SkillDeclaration[];
}

/** Skill metadata persisted in DO state via CapabilityStorage. */
export interface InstalledSkill {
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  autoUpdate: boolean;
  stale: boolean;
  /** SHA-256 hash of SKILL.md as installed/last updated from registry. */
  originalHash: string;
  /** R2 key when enabled, undefined when disabled. */
  r2Key?: string;
  /** Capability IDs required by this skill. */
  requiresCapabilities: string[];
  /** True for skills declared in getCapabilities() — cannot be uninstalled. */
  builtIn?: boolean;
}

/** Pending merge stored in DO state when a user-modified skill has an update. */
export interface PendingMerge {
  skillId: string;
  newContent: string;
  newVersion: string;
  newHash: string;
}
