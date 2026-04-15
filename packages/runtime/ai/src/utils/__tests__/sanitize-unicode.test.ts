import { sanitizeSurrogates } from "../sanitize-unicode.js";

describe("sanitizeSurrogates", () => {
  it("passes normal text through unchanged", () => {
    expect(sanitizeSurrogates("Hello, world!")).toBe("Hello, world!");
  });

  it("preserves valid emoji", () => {
    const text = "Hello 🙈 World 🎉 Done ✅";
    expect(sanitizeSurrogates(text)).toBe(text);
  });

  it("removes unpaired high surrogate", () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const input = `Text ${highSurrogate} here`;
    expect(sanitizeSurrogates(input)).toBe("Text  here");
  });

  it("removes unpaired low surrogate", () => {
    const lowSurrogate = String.fromCharCode(0xdc00);
    const input = `Text ${lowSurrogate} here`;
    expect(sanitizeSurrogates(input)).toBe("Text  here");
  });

  it("removes multiple unpaired surrogates in sequence", () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    // Two unpaired highs followed by an unpaired low
    const input = `a${high}${high}b${low}c`;
    const result = sanitizeSurrogates(input);
    // The first high is unpaired (followed by another high, not a low)
    // The second high pairs with the low surrogate to form a valid pair
    // So we expect "a" + valid pair + "bc"
    expect(result).not.toContain(high);
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("c")).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeSurrogates("")).toBe("");
  });

  it("preserves valid emoji while removing unpaired surrogates", () => {
    const unpaired = String.fromCharCode(0xd83d);
    const input = `🙈${unpaired}🎉`;
    const result = sanitizeSurrogates(input);
    expect(result).toBe("🙈🎉");
  });
});
