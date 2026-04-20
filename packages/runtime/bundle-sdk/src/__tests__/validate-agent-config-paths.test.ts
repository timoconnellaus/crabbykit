import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { evaluateAgentConfigPath, validateAgentConfigPaths } from "../validate.js";

describe("validateAgentConfigPaths", () => {
  it("accepts empty entries", () => {
    expect(() => validateAgentConfigPaths([], {})).not.toThrow();
  });

  it("accepts path matching a local top-level namespace", () => {
    expect(() =>
      validateAgentConfigPaths([{ id: "cap", agentConfigPath: "botConfig" }], {
        botConfig: Type.Object({ x: Type.Number() }),
      } as Record<string, unknown>),
    ).not.toThrow();
  });

  it("walks nested properties", () => {
    expect(() =>
      validateAgentConfigPaths([{ id: "cap", agentConfigPath: "botConfig.rateLimit" }], {
        botConfig: Type.Object({ rateLimit: Type.Number() }),
      } as Record<string, unknown>),
    ).not.toThrow();
  });

  it("rejects missing nested property", () => {
    expect(() =>
      validateAgentConfigPaths([{ id: "cap", agentConfigPath: "botConfig.missing" }], {
        botConfig: Type.Object({ rateLimit: Type.Number() }),
      } as Record<string, unknown>),
    ).toThrow(/cap.*missing.*botConfig/);
  });

  it("tolerates cross-bundle first segment (deferred to dispatch-time)", () => {
    expect(() =>
      validateAgentConfigPaths([{ id: "cap", agentConfigPath: "hostOnlyNs" }], {
        localNs: Type.Object({}),
      } as Record<string, unknown>),
    ).not.toThrow();
  });

  it("rejects empty agentConfigPath", () => {
    expect(() => validateAgentConfigPaths([{ id: "cap", agentConfigPath: "" }], {})).toThrow(
      /cap.*non-empty string/,
    );
  });
});

describe("evaluateAgentConfigPath", () => {
  it("returns snapshot when path is empty", () => {
    expect(evaluateAgentConfigPath({ a: 1 }, "")).toEqual({ a: 1 });
  });

  it("walks a dotted path", () => {
    expect(evaluateAgentConfigPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined on miss", () => {
    expect(evaluateAgentConfigPath({}, "a.b.c")).toBeUndefined();
  });

  it("returns undefined when intermediate is null", () => {
    expect(evaluateAgentConfigPath({ a: null }, "a.b")).toBeUndefined();
  });

  it("returns undefined when intermediate is not object", () => {
    expect(evaluateAgentConfigPath({ a: 5 }, "a.b")).toBeUndefined();
  });
});
