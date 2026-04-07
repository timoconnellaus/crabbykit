import { describe, it, expect, vi, afterEach } from "vitest";
import { mergeCookies } from "../cookie-merge.js";
import type { Cookie } from "../types.js";

function cookie(overrides: Partial<Cookie> & { name: string; domain: string }): Cookie {
  return {
    value: "val",
    path: "/",
    expires: -1,
    size: 10,
    httpOnly: false,
    secure: false,
    session: true,
    ...overrides,
  };
}

describe("mergeCookies", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds new cookies from incoming", () => {
    const stored = [cookie({ name: "a", domain: "x.com", value: "1" })];
    const incoming = [
      cookie({ name: "a", domain: "x.com", value: "1" }),
      cookie({ name: "b", domain: "y.com", value: "2" }),
    ];

    const result = mergeCookies(stored, incoming);

    expect(result).toHaveLength(2);
    expect(result.find((c) => c.name === "b")?.domain).toBe("y.com");
  });

  it("overwrites stored cookie when incoming has newer expiry", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const stored = [cookie({ name: "token", domain: "github.com", value: "old", expires: future })];
    const incoming = [
      cookie({ name: "token", domain: "github.com", value: "new", expires: future + 3600 }),
    ];

    const result = mergeCookies(stored, incoming);

    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("new");
  });

  it("keeps stored cookie when incoming has older expiry", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const stored = [
      cookie({ name: "token", domain: "github.com", value: "newer", expires: future + 3600 }),
    ];
    const incoming = [
      cookie({ name: "token", domain: "github.com", value: "older", expires: future }),
    ];

    const result = mergeCookies(stored, incoming);

    expect(result[0].value).toBe("newer");
  });

  it("preserves stored cookies not in incoming (from other sessions)", () => {
    const stored = [
      cookie({ name: "github_session", domain: "github.com", value: "gh" }),
      cookie({ name: "jira_session", domain: "jira.com", value: "jira" }),
    ];
    const incoming = [
      cookie({ name: "github_session", domain: "github.com", value: "gh-updated" }),
    ];

    const result = mergeCookies(stored, incoming);

    expect(result).toHaveLength(2);
    expect(result.find((c) => c.domain === "jira.com")).toBeDefined();
  });

  it("prunes expired cookies", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T12:00:00Z"));

    const now = Date.now() / 1000;
    const stored = [
      cookie({ name: "valid", domain: "a.com", expires: now + 3600 }),
      cookie({ name: "expired", domain: "b.com", expires: now - 100 }),
    ];

    const result = mergeCookies(stored, []);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });

  it("preserves session cookies (expires -1)", () => {
    const stored = [cookie({ name: "sess", domain: "a.com", expires: -1 })];

    const result = mergeCookies(stored, []);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("sess");
  });

  it("preserves session cookies (expires 0)", () => {
    const stored = [cookie({ name: "sess", domain: "a.com", expires: 0 })];

    const result = mergeCookies(stored, []);

    expect(result).toHaveLength(1);
  });

  it("uses domain+path+name as key", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const stored = [
      cookie({ name: "token", domain: "a.com", path: "/", value: "root", expires: future }),
      cookie({ name: "token", domain: "a.com", path: "/api", value: "api", expires: future }),
    ];
    const incoming = [
      cookie({
        name: "token",
        domain: "a.com",
        path: "/api",
        value: "api-updated",
        expires: future + 1,
      }),
    ];

    const result = mergeCookies(stored, incoming);

    expect(result).toHaveLength(2);
    expect(result.find((c) => c.path === "/")?.value).toBe("root");
    expect(result.find((c) => c.path === "/api")?.value).toBe("api-updated");
  });

  it("handles empty stored", () => {
    const incoming = [cookie({ name: "new", domain: "a.com" })];
    const result = mergeCookies([], incoming);
    expect(result).toHaveLength(1);
  });

  it("handles both empty", () => {
    const result = mergeCookies([], []);
    expect(result).toHaveLength(0);
  });
});
