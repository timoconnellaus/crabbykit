/**
 * bundle-http-and-ui-surface — build-time metadata extraction.
 *
 * Verifies:
 *  - Bundle with capabilities declaring HTTP routes round-trips into
 *    `metadata.surfaces.httpRoutes`.
 *  - Bundle with `onAction` capabilities round-trips into
 *    `metadata.surfaces.actionCapabilityIds`.
 *  - Bundle with no routes / no actions omits `surfaces` entirely.
 *  - Intra-bundle duplicate route throws.
 *  - Reserved-id `onAction` throws.
 *  - Bundle with HTTP routes but no lifecycle hooks emits `surfaces`
 *    without emitting `lifecycleHooks`.
 *  - Capability factory accessing missing env throws
 *    `BundleMetadataExtractionError`.
 */

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

describe("defineBundleAgent — surfaces metadata", () => {
  it("populates httpRoutes for capabilities that declare httpHandlers", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      httpHandlers: () => [
        { method: "GET", path: "/files/list", handler: async () => ({ status: 200 }) },
        { method: "POST", path: "/files/:id/move", handler: async () => ({ status: 200 }) },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const meta = await readMetadata(bundle);
    expect(meta.surfaces).toEqual({
      httpRoutes: [
        { method: "GET", path: "/files/list", capabilityId: "files" },
        { method: "POST", path: "/files/:id/move", capabilityId: "files" },
      ],
    });
  });

  it("populates actionCapabilityIds for capabilities that declare onAction", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      onAction: async () => {},
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const meta = await readMetadata(bundle);
    expect(meta.surfaces).toEqual({ actionCapabilityIds: ["files"] });
  });

  it("populates both httpRoutes and actionCapabilityIds when present", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      httpHandlers: () => [
        { method: "GET", path: "/files/list", handler: async () => ({ status: 200 }) },
      ],
      onAction: async () => {},
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const meta = await readMetadata(bundle);
    expect(meta.surfaces).toEqual({
      httpRoutes: [{ method: "GET", path: "/files/list", capabilityId: "files" }],
      actionCapabilityIds: ["files"],
    });
  });

  it("omits surfaces entirely when no routes and no actions are declared", async () => {
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [{ id: "noop", name: "Noop", description: "" }],
    });
    const meta = await readMetadata(bundle);
    expect(meta.surfaces).toBeUndefined();
  });

  it("emits surfaces without lifecycleHooks when only HTTP routes are declared", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      httpHandlers: () => [
        { method: "GET", path: "/files/list", handler: async () => ({ status: 200 }) },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
    });
    const meta = await readMetadata(bundle);
    expect(meta.surfaces).toBeDefined();
    expect(meta.lifecycleHooks).toBeUndefined();
  });

  it("emits both surfaces and lifecycleHooks when both apply", async () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      httpHandlers: () => [
        { method: "GET", path: "/files/list", handler: async () => ({ status: 200 }) },
      ],
    };
    const bundle = defineBundleAgent({
      model: { provider: "openrouter", modelId: "x" },
      capabilities: () => [cap],
      onAlarm: async () => {},
    });
    const meta = await readMetadata(bundle);
    expect(meta.surfaces).toBeDefined();
    expect(meta.lifecycleHooks).toEqual({
      onAlarm: true,
      onSessionCreated: false,
      onClientEvent: false,
    });
  });

  it("throws on intra-bundle duplicate route", () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      httpHandlers: () => [
        { method: "GET", path: "/files/list", handler: async () => ({ status: 200 }) },
        { method: "GET", path: "/files/list", handler: async () => ({ status: 200 }) },
      ],
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).toThrow(/duplicates an earlier declaration/);
  });

  it("throws on reserved action capability id", () => {
    const cap: BundleCapability = {
      id: "schedules",
      name: "Schedules",
      description: "",
      onAction: async () => {},
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).toThrow(/reserved for the host built-in capability_action switch/);
  });

  it("throws on reserved path prefix", () => {
    const cap: BundleCapability = {
      id: "files",
      name: "Files",
      description: "",
      httpHandlers: () => [
        { method: "GET", path: "/bundle/disable", handler: async () => ({ status: 200 }) },
      ],
    };
    expect(() =>
      defineBundleAgent({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).toThrow(/reserved prefix "\/bundle\/"/);
  });

  it("throws BundleMetadataExtractionError when capability factory accesses missing env", () => {
    interface NeedsEnv extends BundleEnv {
      WEBHOOK_PATH: string;
    }
    const cap: BundleCapability = {
      id: "webhook",
      name: "Webhook",
      description: "",
      httpHandlers: (ctx) => {
        const env = ctx.env as NeedsEnv;
        if (typeof env.WEBHOOK_PATH !== "string") {
          throw new TypeError("WEBHOOK_PATH must be set");
        }
        return [{ method: "POST", path: env.WEBHOOK_PATH, handler: async () => ({ status: 200 }) }];
      },
    };
    expect(() =>
      defineBundleAgent<NeedsEnv>({
        model: { provider: "openrouter", modelId: "x" },
        capabilities: () => [cap],
      }),
    ).toThrowError(BundleMetadataExtractionError);
  });
});
