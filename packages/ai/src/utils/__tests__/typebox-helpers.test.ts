import { StringEnum } from "../typebox-helpers.js";

describe("StringEnum", () => {
  it("creates schema with type string and enum array", () => {
    const schema = StringEnum(["a", "b", "c"]);
    expect(schema.type).toBe("string");
    expect(schema.enum).toEqual(["a", "b", "c"]);
  });

  it("includes description when provided", () => {
    const schema = StringEnum(["x", "y"], { description: "Pick one" });
    expect(schema.description).toBe("Pick one");
  });

  it("includes default when provided", () => {
    const schema = StringEnum(["low", "high"], { default: "low" });
    expect(schema.default).toBe("low");
  });

  it("omits description and default when not provided", () => {
    const schema = StringEnum(["a", "b"]);
    expect(schema).not.toHaveProperty("description");
    expect(schema).not.toHaveProperty("default");
  });

  it("includes both description and default when both provided", () => {
    const schema = StringEnum(["on", "off"], {
      description: "Toggle state",
      default: "off",
    });
    expect(schema.type).toBe("string");
    expect(schema.enum).toEqual(["on", "off"]);
    expect(schema.description).toBe("Toggle state");
    expect(schema.default).toBe("off");
  });
});
