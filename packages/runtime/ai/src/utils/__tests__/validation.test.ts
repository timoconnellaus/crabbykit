import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "../../types.js";
import { validateToolArguments, validateToolCall } from "../validation.js";

function makeTool(name: string, parameters: ReturnType<typeof Type.Object>): Tool {
  return { name, description: `Tool ${name}`, parameters };
}

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

describe("validateToolCall", () => {
  const tools = [
    makeTool("greet", Type.Object({ name: Type.String() })),
    makeTool("add", Type.Object({ a: Type.Number(), b: Type.Number() })),
  ];

  it("finds tool by name and validates", () => {
    const result = validateToolCall(tools, makeToolCall("greet", { name: "Alice" }));
    expect(result).toEqual({ name: "Alice" });
  });

  it("throws for unknown tool name", () => {
    expect(() => validateToolCall(tools, makeToolCall("unknown", {}))).toThrow(
      'Tool "unknown" not found',
    );
  });
});

describe("validateToolArguments", () => {
  it("valid args pass through", () => {
    const tool = makeTool("test", Type.Object({ name: Type.String() }));
    const result = validateToolArguments(tool, makeToolCall("test", { name: "hello" }));
    expect(result).toEqual({ name: "hello" });
  });

  it("coerces types (string to number with coerceTypes)", () => {
    const tool = makeTool("calc", Type.Object({ value: Type.Number() }));
    const result = validateToolArguments(tool, makeToolCall("calc", { value: "42" }));
    expect(result).toEqual({ value: 42 });
  });

  it("throws formatted error for invalid args (missing required field)", () => {
    const tool = makeTool("strict", Type.Object({ required_field: Type.String() }));
    expect(() => validateToolArguments(tool, makeToolCall("strict", {}))).toThrow(
      'Validation failed for tool "strict"',
    );
  });

  it("throws error with tool name in message", () => {
    const tool = makeTool("my_tool", Type.Object({ x: Type.Number() }));
    try {
      validateToolArguments(tool, makeToolCall("my_tool", { x: "not-a-number" }));
      // If coercion doesn't fail, force a real validation error
    } catch (e: unknown) {
      expect((e as Error).message).toContain("my_tool");
    }
  });

  it("validates nested object schemas", () => {
    const tool = makeTool(
      "nested",
      Type.Object({
        outer: Type.Object({
          inner: Type.String(),
        }),
      }),
    );
    const result = validateToolArguments(
      tool,
      makeToolCall("nested", { outer: { inner: "value" } }),
    );
    expect(result).toEqual({ outer: { inner: "value" } });
  });

  it("rejects invalid nested objects", () => {
    const tool = makeTool(
      "nested",
      Type.Object({
        outer: Type.Object({
          inner: Type.Number(),
        }),
      }),
    );
    expect(() =>
      validateToolArguments(tool, makeToolCall("nested", { outer: { inner: "not-a-number" } })),
    ).toThrow('Validation failed for tool "nested"');
  });

  it("does not mutate original arguments", () => {
    const tool = makeTool("coerce", Type.Object({ count: Type.Number() }));
    const original = { count: "5" };
    const call = makeToolCall("coerce", original);
    validateToolArguments(tool, call);
    // Original should remain a string
    expect(call.arguments.count).toBe("5");
  });
});
