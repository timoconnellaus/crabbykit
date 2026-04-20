/**
 * bundle-config-namespaces — build-time metadata extraction.
 *
 * Covers:
 *  - Three-tier round-trip (capabilityConfigs, agentConfigSchemas,
 *    configNamespaces) when a bundle declares all of them.
 *  - Reserved-token agent-config namespace throws.
 *  - Capability id / namespace id cross-collision throws.
 *  - Bundle with no config emits no new fields.
 *  - `configNamespaces(probeCtx)` that throws raises
 *    BundleMetadataExtractionError.
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleCapability, BundleEnv } from "../types.js";
import { BundleMetadataExtractionError } from "../validate.js";

async function readMetadata(
  bundle: ReturnType<typeof defineBundleAgent>,
): Promise<Record<string, unknown>> {
  const res = await bundle.fetch(
    new Request("https://bundle/metadata", { method: "POST" }),
    {} as BundleEnv,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("defineBundleAgent — config metadata", () => {
  it("round-trips all three config tiers", async () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configSchema: Type.Object({ count: Type.Number() }),
      configDefault: { count: 0 },
      agentConfigPath: "botConfig",
      configNamespaces: () => [
        {
          id: "telegram-accounts",
          description: "accounts",
          schema: Type.Object({ list: Type.Array(Type.String()) }),
          get: async () => null,
          set: async () => undefined,
        },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      config: {
        botConfig: Type.Object({ rateLimit: Type.Number() }),
      },
      capabilities: () => [cap],
    });
    const meta = await readMetadata(bundle);

    expect(Array.isArray(meta.capabilityConfigs)).toBe(true);
    expect((meta.capabilityConfigs as unknown[])[0]).toMatchObject({
      id: "my-cap",
      default: { count: 0 },
    });

    expect(typeof meta.agentConfigSchemas).toBe("object");
    expect((meta.agentConfigSchemas as Record<string, unknown>).botConfig).toBeDefined();

    expect(Array.isArray(meta.configNamespaces)).toBe(true);
    expect((meta.configNamespaces as unknown[])[0]).toMatchObject({
      id: "telegram-accounts",
      description: "accounts",
    });
  });

  it("rejects reserved-token agent-config namespace", () => {
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        config: {
          session: Type.Object({}),
        },
      }),
    ).toThrow(/session.*reserved/);
  });

  it("rejects namespace id colliding with capability id", () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      configNamespaces: () => [
        {
          id: "files",
          description: "",
          schema: Type.Object({}),
          get: async () => null,
          set: async () => undefined,
        },
      ],
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).toThrow(/files.*capability/);
  });

  it("omits new fields when no config declared", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [{ id: "noop", name: "Noop", description: "" }],
    });
    const meta = await readMetadata(bundle);
    expect(meta.capabilityConfigs).toBeUndefined();
    expect(meta.agentConfigSchemas).toBeUndefined();
    expect(meta.configNamespaces).toBeUndefined();
  });

  it("accepts configDefault with type mismatch (default-vs-schema check deferred to host)", () => {
    // v1 intentionally skips runtime default-against-schema validation
    // to avoid pulling @sinclair/typebox/value into the bundle runtime
    // (would leak as an external in scaffolded builds). Host
    // revalidates at promotion time where the live TypeBox Kind
    // symbol is still attached.
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      configSchema: Type.Object({ count: Type.Number() }),
      configDefault: { count: "oops" as unknown as number },
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).not.toThrow();
  });

  it("raises BundleMetadataExtractionError on configNamespaces throw", () => {
    const cap: BundleCapability = {
      id: "broken",
      name: "Broken",
      description: "",
      configNamespaces: () => {
        throw new Error("accessor failed");
      },
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).toThrowError(BundleMetadataExtractionError);
  });

  it("rejects agentConfigPath that doesn't resolve in bundle schema", () => {
    const cap: BundleCapability = {
      id: "my-cap",
      name: "MyCap",
      description: "",
      agentConfigPath: "botConfig.missing",
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        config: {
          botConfig: Type.Object({ rateLimit: Type.Number() }),
        },
        capabilities: () => [cap],
      }),
    ).toThrow(/my-cap.*missing.*botConfig/);
  });
});
