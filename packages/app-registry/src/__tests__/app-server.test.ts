import { describe, expect, it } from "vitest";
import { handleAppRequest } from "../app-server.js";
import type { AppRequestOptions } from "../types.js";

function makeOpts(url: string): AppRequestOptions {
  return {
    request: new Request(url),
    agentNamespace: {} as any,
    storageBucket: {} as any,
    loader: {} as any,
  };
}

describe("handleAppRequest", () => {
  it("returns null for non-matching paths", () => {
    expect(handleAppRequest(makeOpts("http://localhost/other"))).toBeNull();
    expect(handleAppRequest(makeOpts("http://localhost/deploy/abc/123"))).toBeNull();
    expect(handleAppRequest(makeOpts("http://localhost/api/stuff"))).toBeNull();
  });

  it("returns a promise for matching /apps/:slug paths", () => {
    const result = handleAppRequest(makeOpts("http://localhost/apps/todo-app/"));
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Promise);
  });

  it("matches /apps/:slug without trailing slash", () => {
    const result = handleAppRequest(makeOpts("http://localhost/apps/my-app"));
    expect(result).not.toBeNull();
  });

  it("matches /apps/:slug/subpath", () => {
    const result = handleAppRequest(makeOpts("http://localhost/apps/my-app/index.html"));
    expect(result).not.toBeNull();
  });
});
