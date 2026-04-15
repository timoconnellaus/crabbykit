import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SkillRegistry } from "@claw-for-cloudflare/skill-registry";

export interface SkillDeclaration {
  id: string;
  enabled?: boolean;
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
  enabled: boolean;
  /** Where this skill came from: "registry" if synced from D1, "agent" if created by the agent. */
  origin: "registry" | "agent";
  /** Registry version at last sync. Only present for registry-origin skills. */
  registryVersion?: string;
  /** SHA-256 hash of content as last synced from registry. Only present for registry-origin skills. */
  registryHash?: string;
  /** True when agent has modified content since last registry sync. */
  dirty?: boolean;
  /** Capability IDs required by this skill. */
  requiresCapabilities: string[];
}

/** Conflict stored in DO state when a dirty registry skill has an upstream update. */
export interface SkillConflict {
  skillId: string;
  upstreamContent: string;
  upstreamVersion: string;
  upstreamHash: string;
}
