import { describe, expect, it } from "vitest";
import {
  MAX_BUNDLE_SIZE_BYTES,
  METADATA_CAPABILITY_IDS_MAX,
  METADATA_DESCRIPTION_MAX,
  METADATA_KEYS,
  METADATA_STRING_MAX,
  READBACK_DELAYS,
} from "../types.js";

describe("registry constants", () => {
  it("MAX_BUNDLE_SIZE_BYTES is 25 MiB", () => {
    expect(MAX_BUNDLE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });

  it("READBACK_DELAYS sum to ~5s", () => {
    const total = READBACK_DELAYS.reduce((a, b) => a + b, 0);
    expect(total).toBe(5150);
  });

  it("METADATA_KEYS includes expected fields", () => {
    expect(METADATA_KEYS.has("name")).toBe(true);
    expect(METADATA_KEYS.has("description")).toBe(true);
    expect(METADATA_KEYS.has("capabilityIds")).toBe(true);
    expect(METADATA_KEYS.has("buildTimestamp")).toBe(true);
    expect(METADATA_KEYS.has("attackerField")).toBe(false);
  });

  it("string limits are reasonable", () => {
    expect(METADATA_STRING_MAX).toBe(256);
    expect(METADATA_DESCRIPTION_MAX).toBe(1024);
    expect(METADATA_CAPABILITY_IDS_MAX).toBe(32);
  });
});
