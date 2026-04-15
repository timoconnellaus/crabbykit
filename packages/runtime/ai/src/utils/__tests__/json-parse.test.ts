import { parseStreamingJson } from "../json-parse.js";

describe("parseStreamingJson", () => {
  it("returns empty object for undefined", () => {
    expect(parseStreamingJson(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseStreamingJson("")).toEqual({});
  });

  it("returns empty object for whitespace-only string", () => {
    expect(parseStreamingJson("   ")).toEqual({});
  });

  it("parses valid complete JSON", () => {
    const result = parseStreamingJson('{"name": "test", "value": 42}');
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("parses partial JSON via partial-json fallback", () => {
    const result = parseStreamingJson('{"key": "val');
    expect(result).toHaveProperty("key");
    // partial-json should recover what it can
    expect(typeof result.key).toBe("string");
  });

  it("returns empty object for completely invalid JSON", () => {
    expect(parseStreamingJson("not json at all }{}{")).toEqual({});
  });

  it("parses array JSON", () => {
    const result = parseStreamingJson("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses nested objects", () => {
    const input = '{"outer": {"inner": "value"}, "list": [1, 2]}';
    const result = parseStreamingJson(input);
    expect(result).toEqual({ outer: { inner: "value" }, list: [1, 2] });
  });

  it("handles partial nested JSON", () => {
    const result = parseStreamingJson('{"outer": {"inner": "va');
    expect(result).toHaveProperty("outer");
  });
});
