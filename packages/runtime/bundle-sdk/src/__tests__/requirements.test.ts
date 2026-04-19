import { describe, expect, it } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapabilityRequirement, BundleEnv } from "../types.js";
import { validateRequirements } from "../validate.js";

const minimalSetup = {
  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
};

async function readMetadata(
  bundle: ReturnType<typeof defineBundleAgent>,
): Promise<Record<string, unknown>> {
  const res = await bundle.fetch(
    new Request("https://bundle/metadata", { method: "POST" }),
    {} as BundleEnv,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("validateRequirements", () => {
  it("returns [] for undefined", () => {
    expect(validateRequirements(undefined)).toEqual([]);
  });

  it("returns [] for empty array", () => {
    expect(validateRequirements([])).toEqual([]);
  });

  it("accepts a valid declaration", () => {
    const result = validateRequirements([{ id: "tavily-web-search" }, { id: "file-tools" }]);
    expect(result).toEqual([{ id: "tavily-web-search" }, { id: "file-tools" }]);
  });

  it("deduplicates duplicates silently (keep first)", () => {
    const result = validateRequirements([
      { id: "tavily-web-search" },
      { id: "file-tools" },
      { id: "tavily-web-search" },
    ]);
    expect(result).toEqual([{ id: "tavily-web-search" }, { id: "file-tools" }]);
  });

  it("throws TypeError on non-array input", () => {
    expect(() => validateRequirements("tavily-web-search" as unknown)).toThrow(TypeError);
    expect(() => validateRequirements({ id: "tavily-web-search" } as unknown)).toThrow(TypeError);
  });

  it("throws on invalid charset (spaces)", () => {
    expect(() => validateRequirements([{ id: "tavily web search" }])).toThrow(/must match/);
    expect(() => validateRequirements([{ id: "tavily web search" }])).toThrow(/\[0\]/);
  });

  it("throws on uppercase ids", () => {
    expect(() => validateRequirements([{ id: "Tavily" }])).toThrow(/must match/);
  });

  it("throws on trailing hyphen", () => {
    expect(() => validateRequirements([{ id: "tavily-" }])).toThrow(/must match/);
  });

  it("throws on ids shorter than 2 chars", () => {
    expect(() => validateRequirements([{ id: "a" }])).toThrow(RangeError);
  });

  it("throws on ids longer than 64 chars", () => {
    const longId = `${"a".repeat(64)}b`;
    expect(() => validateRequirements([{ id: longId }])).toThrow(RangeError);
  });

  it("throws on more than 64 entries", () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => ({ id: `cap-${i}` }));
    expect(() => validateRequirements(tooMany)).toThrow(RangeError);
  });

  it("throws on null entries", () => {
    expect(() => validateRequirements([null as unknown as BundleCapabilityRequirement])).toThrow(
      /null/,
    );
  });

  it("throws on undefined entries", () => {
    expect(() =>
      validateRequirements([undefined as unknown as BundleCapabilityRequirement]),
    ).toThrow(/undefined/);
  });

  it("throws on non-string id", () => {
    expect(() =>
      validateRequirements([{ id: 42 } as unknown as BundleCapabilityRequirement]),
    ).toThrow(TypeError);
  });

  it("throws on non-object entries (string)", () => {
    expect(() =>
      validateRequirements(["tavily-web-search" as unknown as BundleCapabilityRequirement]),
    ).toThrow(TypeError);
  });

  it("throws on array entries", () => {
    expect(() =>
      validateRequirements([["tavily"] as unknown as BundleCapabilityRequirement]),
    ).toThrow(/must be an object/);
  });

  it("error message names the offending entry index", () => {
    expect(() => validateRequirements([{ id: "valid-id" }, { id: "invalid id" }])).toThrow(/\[1\]/);
  });

  // Reserved-scope rejection (Gap 1)
  it('throws TypeError when id is reserved scope "spine"', () => {
    expect(() => validateRequirements([{ id: "spine" }])).toThrow(TypeError);
    expect(() => validateRequirements([{ id: "spine" }])).toThrow(/reserved scope/);
    expect(() => validateRequirements([{ id: "spine" }])).toThrow(/"spine"/);
  });

  it('throws TypeError when id is reserved scope "llm"', () => {
    expect(() => validateRequirements([{ id: "llm" }])).toThrow(TypeError);
    expect(() => validateRequirements([{ id: "llm" }])).toThrow(/reserved scope/);
    expect(() => validateRequirements([{ id: "llm" }])).toThrow(/"llm"/);
  });

  it("accepts ids that share a prefix with reserved scopes (whole-string match only)", () => {
    // "spine-agent" starts with "spine" but is not equal — must pass
    const r1 = validateRequirements([{ id: "spine-agent" }]);
    expect(r1).toEqual([{ id: "spine-agent" }]);
    // "my-llm" ends with "llm" but is not equal — must pass
    const r2 = validateRequirements([{ id: "my-llm" }]);
    expect(r2).toEqual([{ id: "my-llm" }]);
  });
});

describe("defineBundleAgent requiredCapabilities", () => {
  it("writes declaration into metadata", async () => {
    const bundle = defineBundleAgent({
      ...minimalSetup,
      requiredCapabilities: [{ id: "tavily-web-search" }, { id: "file-tools" }],
    });

    const meta = await readMetadata(bundle);
    expect(meta.requiredCapabilities).toEqual([{ id: "tavily-web-search" }, { id: "file-tools" }]);
  });

  it("omits field when declaration is undefined", async () => {
    const bundle = defineBundleAgent(minimalSetup);
    const meta = await readMetadata(bundle);
    expect(meta.requiredCapabilities).toBeUndefined();
  });

  it("omits field when declaration is empty", async () => {
    const bundle = defineBundleAgent({ ...minimalSetup, requiredCapabilities: [] });
    const meta = await readMetadata(bundle);
    expect(meta.requiredCapabilities).toBeUndefined();
  });

  it("preserves declaration order in metadata", async () => {
    const bundle = defineBundleAgent({
      ...minimalSetup,
      requiredCapabilities: [{ id: "file-tools" }, { id: "tavily-web-search" }],
    });

    const meta = await readMetadata(bundle);
    expect(meta.requiredCapabilities).toEqual([{ id: "file-tools" }, { id: "tavily-web-search" }]);
  });

  it("deduplicates silently at build time", async () => {
    const bundle = defineBundleAgent({
      ...minimalSetup,
      requiredCapabilities: [{ id: "tavily-web-search" }, { id: "tavily-web-search" }],
    });

    const meta = await readMetadata(bundle);
    expect(meta.requiredCapabilities).toEqual([{ id: "tavily-web-search" }]);
  });

  it("throws at build time on invalid charset", () => {
    expect(() =>
      defineBundleAgent({
        ...minimalSetup,
        requiredCapabilities: [{ id: "invalid id" }],
      }),
    ).toThrow(/must match/);
  });

  it("throws at build time on over-long id", () => {
    expect(() =>
      defineBundleAgent({
        ...minimalSetup,
        requiredCapabilities: [{ id: "a".repeat(65) }],
      }),
    ).toThrow(RangeError);
  });

  it("throws at build time on over-count list", () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => ({ id: `cap-${i}` }));
    expect(() => defineBundleAgent({ ...minimalSetup, requiredCapabilities: tooMany })).toThrow(
      RangeError,
    );
  });

  it("preserves other metadata fields alongside requiredCapabilities", async () => {
    const bundle = defineBundleAgent({
      ...minimalSetup,
      metadata: { name: "Helper", description: "research" },
      requiredCapabilities: [{ id: "tavily-web-search" }],
    });

    const meta = await readMetadata(bundle);
    expect(meta.name).toBe("Helper");
    expect(meta.description).toBe("research");
    expect(meta.requiredCapabilities).toEqual([{ id: "tavily-web-search" }]);
  });
});
