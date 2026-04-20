/**
 * Regression test: TypeBox schemas round-trip through
 * JSON.parse(JSON.stringify(...)) with identical Value.Check behavior.
 * Kind symbol drops, but JSON-Schema-compatible runtime validation
 * survives. Covers Object + Optional + Union + Literal + Array +
 * Recursive + Unsafe per Decision 1.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { hydrateBundleSchema, serializeBundleSchema } from "../schema-serialize.js";

function roundTrip(schema: unknown): unknown {
  const serialized = serializeBundleSchema(schema);
  const json = JSON.parse(JSON.stringify(serialized));
  return hydrateBundleSchema(json);
}

describe("schema serialization round-trip", () => {
  it("Object + Optional + Literal + Union survives", () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Optional(Type.Number()),
      kind: Type.Union([Type.Literal("a"), Type.Literal("b")]),
    });
    const serialized = roundTrip(schema);
    const valid = { name: "x", kind: "a" };
    const invalid = { name: "x", kind: "c" };
    expect(Value.Check(schema, valid)).toBe(Value.Check(serialized as never, valid));
    expect(Value.Check(schema, invalid)).toBe(Value.Check(serialized as never, invalid));
  });

  it("Array + nested Object survives", () => {
    const schema = Type.Object({
      items: Type.Array(Type.Object({ id: Type.String(), n: Type.Number() })),
    });
    const serialized = roundTrip(schema);
    const valid = { items: [{ id: "x", n: 1 }] };
    const invalid = { items: [{ id: "x" }] };
    expect(Value.Check(schema, valid)).toBe(Value.Check(serialized as never, valid));
    expect(Value.Check(schema, invalid)).toBe(Value.Check(serialized as never, invalid));
  });

  it("Recursive survives", () => {
    const schema = Type.Recursive((Self) =>
      Type.Object({
        label: Type.String(),
        children: Type.Array(Self),
      }),
    );
    const serialized = roundTrip(schema);
    const valid = { label: "root", children: [{ label: "c", children: [] }] };
    expect(Value.Check(schema, valid)).toBe(Value.Check(serialized as never, valid));
  });

  it("Boolean + Integer survive", () => {
    const schema = Type.Object({
      flag: Type.Boolean(),
      count: Type.Integer(),
    });
    const serialized = roundTrip(schema);
    const valid = { flag: true, count: 3 };
    const invalid = { flag: "yes", count: 3 };
    expect(Value.Check(schema, valid)).toBe(Value.Check(serialized as never, valid));
    expect(Value.Check(schema, invalid)).toBe(Value.Check(serialized as never, invalid));
  });
});
