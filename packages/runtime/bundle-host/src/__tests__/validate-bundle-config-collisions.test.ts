import { describe, expect, it } from "vitest";
import {
  AgentConfigCollisionError,
  CapabilityConfigCollisionError,
  ConfigNamespaceCollisionError,
  validateBundleAgentConfigsAgainstKnownIds,
  validateBundleCapabilityConfigsAgainstKnownIds,
  validateBundleConfigNamespacesAgainstKnownIds,
} from "../validate-config.js";

describe("validateBundleAgentConfigsAgainstKnownIds", () => {
  it("accepts when declared empty", () => {
    expect(validateBundleAgentConfigsAgainstKnownIds(undefined, ["foo"])).toEqual({ valid: true });
    expect(validateBundleAgentConfigsAgainstKnownIds([], ["foo"])).toEqual({ valid: true });
  });

  it("accepts when known undefined (cross-deployment)", () => {
    expect(validateBundleAgentConfigsAgainstKnownIds(["botConfig"], undefined)).toEqual({
      valid: true,
    });
  });

  it("accepts when no collision", () => {
    expect(validateBundleAgentConfigsAgainstKnownIds(["botConfig"], ["tavily"])).toEqual({
      valid: true,
    });
  });

  it("flags collision", () => {
    const result = validateBundleAgentConfigsAgainstKnownIds(
      ["botConfig", "tavily"],
      ["tavily", "other"],
    );
    expect(result).toEqual({ valid: false, collidingNamespaces: ["tavily"] });
  });
});

describe("validateBundleConfigNamespacesAgainstKnownIds", () => {
  it("accepts undefined declared", () => {
    expect(validateBundleConfigNamespacesAgainstKnownIds(undefined, ["x"])).toEqual({
      valid: true,
    });
  });

  it("flags collision", () => {
    const result = validateBundleConfigNamespacesAgainstKnownIds(
      ["accounts", "schedules"],
      ["schedules"],
    );
    expect(result).toEqual({ valid: false, collidingIds: ["schedules"] });
  });
});

describe("validateBundleCapabilityConfigsAgainstKnownIds", () => {
  it("accepts undefined declared", () => {
    expect(validateBundleCapabilityConfigsAgainstKnownIds(undefined, ["x"])).toEqual({
      valid: true,
    });
  });

  it("flags collision", () => {
    const result = validateBundleCapabilityConfigsAgainstKnownIds(
      ["my-counter", "new-cap"],
      ["my-counter", "other"],
    );
    expect(result).toEqual({ valid: false, collidingIds: ["my-counter"] });
  });
});

describe("error classes", () => {
  it("AgentConfigCollisionError carries code", () => {
    const err = new AgentConfigCollisionError({
      collidingNamespaces: ["x"],
      versionId: "v1",
    });
    expect(err.code).toBe("ERR_AGENT_CONFIG_COLLISION");
    expect(err.collidingNamespaces).toEqual(["x"]);
    expect(err.versionId).toBe("v1");
  });

  it("ConfigNamespaceCollisionError carries code", () => {
    const err = new ConfigNamespaceCollisionError({
      collidingIds: ["y"],
      versionId: "v2",
    });
    expect(err.code).toBe("ERR_CONFIG_NAMESPACE_COLLISION");
  });

  it("CapabilityConfigCollisionError carries code", () => {
    const err = new CapabilityConfigCollisionError({
      collidingIds: ["z"],
      versionId: "v3",
    });
    expect(err.code).toBe("ERR_CAPABILITY_CONFIG_COLLISION");
  });
});
