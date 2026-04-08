import type { SkillListEntry } from "../../transport/types.js";
import { useAgentConnection } from "../agent-connection-provider.js";

export interface UseSkillsReturn {
  skills: SkillListEntry[];
}

/**
 * Subscribes to the "skills" capability state.
 */
export function useSkills(): UseSkillsReturn {
  const { state } = useAgentConnection();

  const data = state.capabilityState.skills as { skills?: SkillListEntry[] } | undefined;
  const skills = data?.skills ?? [];

  return { skills };
}
