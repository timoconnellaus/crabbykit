/**
 * Promotion-time route + action-id collision validation in
 * `InMemoryBundleRegistry.setActive` (`bundle-http-and-ui-surface`).
 */

import { describe, expect, it } from "vitest";
import { InMemoryBundleRegistry } from "../in-memory-registry.js";
import { ActionIdCollisionError, RouteCollisionError } from "../validate-routes.js";

const seed = (registry: InMemoryBundleRegistry, versionId: string, metadata: unknown): void => {
  registry.seed(versionId, "module.exports = {};", metadata as Record<string, unknown>);
};

describe("InMemoryBundleRegistry.setActive — route collision", () => {
  it("throws RouteCollisionError when bundle declares route colliding with knownHttpRoutes", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", {
      surfaces: {
        httpRoutes: [{ method: "POST", path: "/skills/install", capabilityId: "skills" }],
      },
    });
    await expect(
      registry.setActive("a1", "v1", {
        knownCapabilityIds: [],
        knownHttpRoutes: [{ method: "POST", path: "/skills/install" }],
      }),
    ).rejects.toBeInstanceOf(RouteCollisionError);
    // Pointer NOT flipped on collision
    expect(await registry.getActiveForAgent("a1")).toBeNull();
  });

  it("passes when knownHttpRoutes is undefined (cross-deployment promotion path)", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", {
      surfaces: {
        httpRoutes: [{ method: "POST", path: "/skills/install", capabilityId: "skills" }],
      },
    });
    // No knownHttpRoutes provided — opt-out path. Note: knownCapabilityIds is
    // still required because skipCatalogCheck is false by default.
    await registry.setActive("a1", "v1", { knownCapabilityIds: [] });
    expect(await registry.getActiveForAgent("a1")).toBe("v1");
  });

  it("passes when no surfaces.httpRoutes declared", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", { surfaces: { actionCapabilityIds: ["files"] } });
    await registry.setActive("a1", "v1", {
      knownCapabilityIds: [],
      knownHttpRoutes: [{ method: "POST", path: "/anything" }],
    });
    expect(await registry.getActiveForAgent("a1")).toBe("v1");
  });
});

describe("InMemoryBundleRegistry.setActive — action-id collision", () => {
  it("throws ActionIdCollisionError when bundle declares onAction id colliding with knownCapabilityIds", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", {
      surfaces: { actionCapabilityIds: ["tavily-web-search"] },
    });
    await expect(
      registry.setActive("a1", "v1", {
        knownCapabilityIds: ["tavily-web-search"],
      }),
    ).rejects.toBeInstanceOf(ActionIdCollisionError);
    expect(await registry.getActiveForAgent("a1")).toBeNull();
  });

  it("passes when no surfaces.actionCapabilityIds declared", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", {});
    await registry.setActive("a1", "v1", { knownCapabilityIds: ["files-bundle"] });
    expect(await registry.getActiveForAgent("a1")).toBe("v1");
  });

  it("passes when bundle id does not collide with known capability ids", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", {
      surfaces: { actionCapabilityIds: ["files-bundle"] },
    });
    await registry.setActive("a1", "v1", {
      knownCapabilityIds: ["tavily-web-search"],
    });
    expect(await registry.getActiveForAgent("a1")).toBe("v1");
  });
});

describe("InMemoryBundleRegistry.setActive — skipCatalogCheck path", () => {
  it("skips both route and action-id validation when skipCatalogCheck=true", async () => {
    const registry = new InMemoryBundleRegistry();
    seed(registry, "v1", {
      surfaces: {
        httpRoutes: [{ method: "POST", path: "/skills/install", capabilityId: "skills" }],
        actionCapabilityIds: ["tavily-web-search"],
      },
    });
    // Even with colliding known sets, skipCatalogCheck makes setActive succeed.
    await registry.setActive("a1", "v1", {
      skipCatalogCheck: true,
      knownCapabilityIds: ["tavily-web-search"],
      knownHttpRoutes: [{ method: "POST", path: "/skills/install" }],
    });
    expect(await registry.getActiveForAgent("a1")).toBe("v1");
  });
});
