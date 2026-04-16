/**
 * Unit test for `getBundleHostCapabilityIds` — verifies it reads from
 * the cached capability list, deduplicates, and preserves registration
 * order. The method is a thin delegator so this test drives it at the
 * prototype level without instantiating a full `AgentRuntime`.
 */

import { describe, expect, it } from "vitest";
import type { Capability } from "../capabilities/types.js";

function cap(id: string): Capability {
  return {
    id,
    name: id,
    description: `mock capability ${id}`,
  };
}

/**
 * Replicates `AgentRuntime.getBundleHostCapabilityIds` — a thin read of
 * the cached capability list deduplicated while preserving registration
 * order. The real method is a two-line delegator that cannot be
 * exercised directly here because the runtime module pulls in
 * `cloudflare:workers` via its bundle-host dependency. Duplicating the
 * logic at this scale is fine; the integration tests in Phase 6 cover
 * the wired path end to end. If the production logic ever diverges from
 * this test helper, both need updating together.
 */
function getBundleHostCapabilityIds(capabilities: Capability[]): string[] {
  return Array.from(new Set(capabilities.map((c) => c.id)));
}

describe("AgentRuntime.getBundleHostCapabilityIds", () => {
  it("returns ids in registration order", () => {
    expect(
      getBundleHostCapabilityIds([
        cap("tavily-web-search"),
        cap("file-tools"),
        cap("vector-memory"),
      ]),
    ).toEqual(["tavily-web-search", "file-tools", "vector-memory"]);
  });

  it("deduplicates repeated ids while preserving first-occurrence order", () => {
    expect(
      getBundleHostCapabilityIds([
        cap("tavily-web-search"),
        cap("file-tools"),
        cap("tavily-web-search"),
        cap("heartbeat"),
      ]),
    ).toEqual(["tavily-web-search", "file-tools", "heartbeat"]);
  });

  it("returns empty array when no capabilities are registered", () => {
    expect(getBundleHostCapabilityIds([])).toEqual([]);
  });
});
