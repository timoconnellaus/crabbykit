import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { validateCapabilityConfigs } from "../validate.js";

const checkValue = (schema: unknown, value: unknown) =>
  Value.Check(schema as Parameters<typeof Value.Check>[0], value);

describe("validateCapabilityConfigs", () => {
  it("accepts empty list", () => {
    expect(() => validateCapabilityConfigs([])).not.toThrow();
  });

  it("accepts schema with no default", () => {
    expect(() =>
      validateCapabilityConfigs([
        {
          id: "my-cap",
          schema: Type.Object({ count: Type.Number() }) as unknown,
        },
      ]),
    ).not.toThrow();
  });

  it("accepts default that matches schema when checkValue is provided", () => {
    expect(() =>
      validateCapabilityConfigs(
        [
          {
            id: "my-cap",
            schema: Type.Object({ count: Type.Number() }) as unknown,
            default: { count: 42 },
          },
        ],
        checkValue,
      ),
    ).not.toThrow();
  });

  it("rejects default that fails schema when checkValue is provided", () => {
    expect(() =>
      validateCapabilityConfigs(
        [
          {
            id: "my-cap",
            schema: Type.Object({ count: Type.Number() }) as unknown,
            default: { count: "nope" } as Record<string, unknown>,
          },
        ],
        checkValue,
      ),
    ).toThrow(/my-cap.*configDefault/);
  });

  it("skips default validation when checkValue is undefined (bundle runtime default)", () => {
    expect(() =>
      validateCapabilityConfigs([
        {
          id: "my-cap",
          schema: Type.Object({ count: Type.Number() }) as unknown,
          default: { count: "nope" } as Record<string, unknown>,
        },
      ]),
    ).not.toThrow();
  });

  it("rejects Transform kind", () => {
    expect(() =>
      validateCapabilityConfigs([
        {
          id: "transform-cap",
          schema: { Kind: "Transform", type: "string" },
        },
      ]),
    ).toThrow(/transform-cap.*Transform/);
  });

  it("rejects Constructor kind nested in properties", () => {
    expect(() =>
      validateCapabilityConfigs([
        {
          id: "nested-cap",
          schema: {
            Kind: "Object",
            type: "object",
            properties: {
              bad: { Kind: "Constructor" },
            },
          },
        },
      ]),
    ).toThrow(/nested-cap.*Constructor.*bad/);
  });

  it("rejects Function kind nested in anyOf", () => {
    expect(() =>
      validateCapabilityConfigs([
        {
          id: "union-cap",
          schema: {
            anyOf: [{ type: "string" }, { Kind: "Function" }],
          },
        },
      ]),
    ).toThrow(/union-cap.*Function/);
  });
});
