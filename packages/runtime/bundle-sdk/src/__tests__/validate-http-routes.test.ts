/**
 * Build-time validation for the flat list of HTTP route declarations
 * collected by `defineBundleAgent` from `setup.capabilities(probeEnv)`.
 */

import { describe, expect, it } from "vitest";
import type { BundleRouteDeclaration } from "../types.js";
import { validateHttpRoutes } from "../validate.js";

const route = (
  partial: Partial<BundleRouteDeclaration> & { path: string },
): BundleRouteDeclaration => ({
  method: "GET",
  capabilityId: "demo",
  ...partial,
});

describe("validateHttpRoutes", () => {
  it("accepts a well-formed allow-list", () => {
    expect(() =>
      validateHttpRoutes([
        route({ method: "GET", path: "/files/list" }),
        route({ method: "POST", path: "/files/:id/move" }),
        route({ method: "DELETE", path: "/files/:id" }),
        route({ method: "PUT", path: "/files/:id" }),
      ]),
    ).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => validateHttpRoutes([])).not.toThrow();
  });

  describe("reserved prefixes", () => {
    for (const prefix of [
      "/bundle/",
      "/a2a",
      "/a2a-callback",
      "/.well-known/",
      "/__",
      "/mcp/",
      "/schedules",
    ]) {
      it(`rejects path under ${prefix}`, () => {
        expect(() => validateHttpRoutes([route({ path: `${prefix}thing` })])).toThrow(
          new RegExp(`reserved prefix "${prefix.replace(/[/.]/g, "\\$&")}"`),
        );
      });
    }
  });

  describe("reserved literals", () => {
    for (const literal of ["/", "/prompt"]) {
      it(`rejects literal ${literal}`, () => {
        expect(() => validateHttpRoutes([route({ path: literal })])).toThrow(
          /reserved host literal/,
        );
      });
    }
  });

  it("rejects duplicate method+path", () => {
    expect(() =>
      validateHttpRoutes([
        route({ method: "GET", path: "/files/list" }),
        route({ method: "GET", path: "/files/list", capabilityId: "other" }),
      ]),
    ).toThrow(/duplicates an earlier declaration/);
  });

  it("allows same path on different methods", () => {
    expect(() =>
      validateHttpRoutes([
        route({ method: "GET", path: "/files/list" }),
        route({ method: "POST", path: "/files/list" }),
      ]),
    ).not.toThrow();
  });

  it("rejects malformed method", () => {
    expect(() =>
      validateHttpRoutes([route({ method: "PATCH" as never, path: "/files/list" })]),
    ).toThrow(/unsupported method "PATCH"/);
  });

  it("rejects missing leading slash", () => {
    expect(() => validateHttpRoutes([route({ path: "files/list" })])).toThrow(
      /must start with a leading "\/"/,
    );
  });

  it("rejects oversize path (>256 chars)", () => {
    const long = `/${"a".repeat(257)}`;
    expect(() => validateHttpRoutes([route({ path: long })])).toThrow(/exceeds 256 characters/);
  });

  it("rejects empty path", () => {
    expect(() => validateHttpRoutes([route({ path: "" })])).toThrow(
      /must declare a non-empty path string/,
    );
  });

  it("error message names the offending capability id", () => {
    expect(() =>
      validateHttpRoutes([route({ capabilityId: "tavily-web-search", path: "/bundle/disable" })]),
    ).toThrow(/capability "tavily-web-search"/);
  });
});
