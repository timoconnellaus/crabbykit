import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { validateAgentConfigSchemas } from "../validate.js";

describe("validateAgentConfigSchemas", () => {
  it("accepts well-formed schemas", () => {
    expect(() =>
      validateAgentConfigSchemas(
        {
          botConfig: Type.Object({ rateLimit: Type.Number() }) as unknown,
          otherConfig: Type.Object({}) as unknown,
        } as Record<string, unknown>,
        [],
        [],
      ),
    ).not.toThrow();
  });

  for (const reserved of ["session", "agent-config", "schedules", "queue"]) {
    it(`rejects reserved token "${reserved}"`, () => {
      expect(() =>
        validateAgentConfigSchemas({ [reserved]: Type.Object({}) } as Record<string, unknown>, [], []),
      ).toThrow(new RegExp(reserved));
    });
  }

  it("rejects capability: prefix", () => {
    expect(() =>
      validateAgentConfigSchemas(
        { "capability:foo": Type.Object({}) } as Record<string, unknown>,
        [],
        [],
      ),
    ).toThrow(/capability:/);
  });

  it("rejects collision with bundle capability id", () => {
    expect(() =>
      validateAgentConfigSchemas(
        { myCap: Type.Object({}) } as Record<string, unknown>,
        ["myCap"],
        [],
      ),
    ).toThrow(/myCap.*capability/);
  });

  it("rejects collision with action capability id", () => {
    expect(() =>
      validateAgentConfigSchemas(
        { actCap: Type.Object({}) } as Record<string, unknown>,
        [],
        ["actCap"],
      ),
    ).toThrow(/actCap.*onAction/);
  });

  it("rejects Transform schema", () => {
    expect(() =>
      validateAgentConfigSchemas(
        { nsA: { Kind: "Transform" } } as Record<string, unknown>,
        [],
        [],
      ),
    ).toThrow(/Transform/);
  });
});
