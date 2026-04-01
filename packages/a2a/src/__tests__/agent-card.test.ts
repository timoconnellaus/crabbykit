import { describe, expect, it } from "vitest";
import { buildAgentCard, capabilitiesToSkills } from "../server/agent-card.js";
import type { AgentCardConfig } from "../server/claw-executor.js";
import { A2A_PROTOCOL_VERSION } from "../version.js";

describe("buildAgentCard", () => {
  it("builds a card with required fields", () => {
    const config: AgentCardConfig = {
      name: "Test Agent",
      url: "https://agent.example.com",
    };

    const card = buildAgentCard(config);

    expect(card.name).toBe("Test Agent");
    expect(card.url).toBe("https://agent.example.com");
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });

  it("uses name as description fallback", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.description).toBe("Agent");
  });

  it("uses provided description over name", () => {
    const card = buildAgentCard({
      name: "Agent",
      description: "A helpful agent",
      url: "https://agent.example.com",
    });
    expect(card.description).toBe("A helpful agent");
  });

  it("defaults version to 1.0.0", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.version).toBe("1.0.0");
  });

  it("uses provided version", () => {
    const card = buildAgentCard({
      name: "Agent",
      url: "https://agent.example.com",
      version: "2.0.0",
    });
    expect(card.version).toBe("2.0.0");
  });

  it("sets capabilities flags", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.capabilities.stateTransitionHistory).toBe(true);
  });

  it("includes provider when specified", () => {
    const card = buildAgentCard({
      name: "Agent",
      url: "https://agent.example.com",
      provider: { organization: "Acme Corp", url: "https://acme.com" },
    });
    expect(card.provider).toEqual({ organization: "Acme Corp", url: "https://acme.com" });
  });

  it("omits provider when not specified", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.provider).toBeUndefined();
  });

  it("includes securitySchemes when specified", () => {
    const card = buildAgentCard({
      name: "Agent",
      url: "https://agent.example.com",
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    });
    expect(card.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } });
  });

  it("omits securitySchemes when not specified", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.securitySchemes).toBeUndefined();
  });

  it("includes security when specified", () => {
    const card = buildAgentCard({
      name: "Agent",
      url: "https://agent.example.com",
      security: [{ bearer: [] }],
    });
    expect(card.security).toEqual([{ bearer: [] }]);
  });

  it("defaults skills to empty array", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.skills).toEqual([]);
  });

  it("includes skills when specified", () => {
    const card = buildAgentCard({
      name: "Agent",
      url: "https://agent.example.com",
      skills: [{ id: "s1", name: "Skill 1", description: "First skill" }],
    });
    expect(card.skills).toHaveLength(1);
    expect(card.skills![0].id).toBe("s1");
  });

  it("defaults input/output modes to text/plain", () => {
    const card = buildAgentCard({ name: "Agent", url: "https://agent.example.com" });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("uses provided input/output modes", () => {
    const card = buildAgentCard({
      name: "Agent",
      url: "https://agent.example.com",
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "text/html"],
    });
    expect(card.defaultInputModes).toEqual(["text/plain", "application/json"]);
    expect(card.defaultOutputModes).toEqual(["text/plain", "text/html"]);
  });
});

describe("capabilitiesToSkills", () => {
  it("converts capabilities to skills", () => {
    const capabilities = [
      { id: "cap-1", name: "Capability 1", description: "First capability" },
      { id: "cap-2", name: "Capability 2", description: "Second capability" },
    ];

    const skills = capabilitiesToSkills(capabilities);

    expect(skills).toHaveLength(2);
    expect(skills[0]).toEqual({ id: "cap-1", name: "Capability 1", description: "First capability" });
    expect(skills[1]).toEqual({ id: "cap-2", name: "Capability 2", description: "Second capability" });
  });

  it("returns empty array for empty input", () => {
    expect(capabilitiesToSkills([])).toEqual([]);
  });
});
