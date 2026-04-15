import type { AgentCard, AgentSkill } from "../types.js";
import { A2A_PROTOCOL_VERSION } from "../version.js";
import type { AgentCardConfig } from "./claw-executor.js";

/**
 * Build an A2A Agent Card from CLAW configuration.
 */
export function buildAgentCard(config: AgentCardConfig): AgentCard {
  return {
    name: config.name,
    description: config.description ?? config.name,
    url: config.url,
    version: config.version ?? "1.0.0",
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.securitySchemes ? { securitySchemes: config.securitySchemes } : {}),
    ...(config.security ? { security: config.security } : {}),
    skills: config.skills ?? [],
    defaultInputModes: config.defaultInputModes ?? ["text/plain"],
    defaultOutputModes: config.defaultOutputModes ?? ["text/plain"],
  };
}

/**
 * Convert CLAW capabilities into A2A skills for the Agent Card.
 * Each capability's id, name, and description map to AgentSkill fields.
 */
export function capabilitiesToSkills(
  capabilities: Array<{ id: string; name: string; description: string }>,
): AgentSkill[] {
  return capabilities.map((cap) => ({
    id: cap.id,
    name: cap.name,
    description: cap.description,
  }));
}
