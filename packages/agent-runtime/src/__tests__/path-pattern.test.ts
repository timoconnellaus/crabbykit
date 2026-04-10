import { describe, expect, it } from "vitest";
import { matchPathPattern } from "../agent-runtime-helpers.js";

describe("matchPathPattern", () => {
  describe("exact-match paths (no wildcards)", () => {
    it("returns {} when the path exactly matches the pattern", () => {
      expect(matchPathPattern("/a/b", "/a/b")).toEqual({});
    });

    it("returns null when the path differs in a segment", () => {
      expect(matchPathPattern("/a/b", "/a/c")).toBeNull();
    });

    it("returns null on segment count mismatch", () => {
      expect(matchPathPattern("/a/b", "/a/b/c")).toBeNull();
      expect(matchPathPattern("/a/b/c", "/a/b")).toBeNull();
    });

    it("handles the root path", () => {
      expect(matchPathPattern("/", "/")).toEqual({});
    });

    it("distinguishes trailing slash vs no slash", () => {
      // This is the existing exact-match semantic; a trailing slash is
      // a meaningful difference in segment count.
      expect(matchPathPattern("/a/b", "/a/b/")).toBeNull();
    });
  });

  describe("single :param wildcards", () => {
    it("extracts a single named parameter", () => {
      expect(matchPathPattern("/users/:id", "/users/alice")).toEqual({ id: "alice" });
    });

    it("extracts a parameter mid-path", () => {
      expect(matchPathPattern("/telegram/webhook/:accountId", "/telegram/webhook/support")).toEqual(
        { accountId: "support" },
      );
    });

    it("returns null when the surrounding segments differ", () => {
      expect(matchPathPattern("/telegram/webhook/:accountId", "/discord/webhook/support")).toBeNull();
    });

    it("returns null when the segment count is off even with a wildcard", () => {
      expect(matchPathPattern("/users/:id", "/users")).toBeNull();
      expect(matchPathPattern("/users/:id", "/users/alice/extra")).toBeNull();
    });

    it("treats an empty wildcard segment as a non-match", () => {
      // `/users/` has a trailing empty segment; `/users/:id` requires
      // a non-empty value. A blank segment should not capture the
      // empty string because callers doing `session.get(id)` would
      // lose all safety.
      expect(matchPathPattern("/users/:id", "/users/")).toBeNull();
    });
  });

  describe("multiple :param wildcards", () => {
    it("extracts two parameters", () => {
      expect(matchPathPattern("/a/:x/b/:y", "/a/1/b/2")).toEqual({ x: "1", y: "2" });
    });

    it("returns null when the second literal segment does not match", () => {
      expect(matchPathPattern("/a/:x/b/:y", "/a/1/c/2")).toBeNull();
    });

    it("handles adjacent wildcards", () => {
      expect(matchPathPattern("/:a/:b", "/hello/world")).toEqual({ a: "hello", b: "world" });
    });
  });

  describe("URL-encoded values", () => {
    it("decodes percent-encoded wildcard values", () => {
      // An account id like "@alice" may arrive URL-encoded in the path.
      expect(matchPathPattern("/:sender", "/%40alice")).toEqual({ sender: "@alice" });
    });
  });

  describe("regex safety", () => {
    it("does not let literal regex metacharacters in the pattern match arbitrary paths", () => {
      // The implementation must not use regex construction on the
      // pattern; `.` in the pattern must match only a literal dot.
      expect(matchPathPattern("/v1.0/:id", "/v1X0/abc")).toBeNull();
      expect(matchPathPattern("/v1.0/:id", "/v1.0/abc")).toEqual({ id: "abc" });
    });
  });
});
