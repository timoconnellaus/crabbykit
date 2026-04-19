import { describe, expect, it } from "vitest";
import {
  deserializeResponseFromBundle,
  serializeActionForBundle,
  serializeRequestForBundle,
} from "../serialization.js";

describe("serializeRequestForBundle", () => {
  it("captures method, declared path, query, headers, base64 body", () => {
    const request = new Request("https://host/skills/registry?foo=bar&baz=qux", {
      method: "POST",
      headers: { "x-custom": "Value", "Content-Type": "text/plain" },
    });
    const env = serializeRequestForBundle({
      request,
      capabilityId: "skills",
      declaredPath: "/skills/registry",
      sessionId: "s1",
      bodyBytes: new TextEncoder().encode("hello"),
    });
    expect(env.capabilityId).toBe("skills");
    expect(env.method).toBe("POST");
    expect(env.path).toBe("/skills/registry");
    expect(env.query).toEqual({ foo: "bar", baz: "qux" });
    // Headers are lowercased
    expect(env.headers["x-custom"]).toBe("Value");
    expect(env.headers["content-type"]).toBe("text/plain");
    expect(env.bodyBase64).toBe(btoa("hello"));
    expect(env.sessionId).toBe("s1");
  });

  it("emits null body when bodyBytes is null/empty", () => {
    const request = new Request("https://host/x", { method: "GET" });
    const env = serializeRequestForBundle({
      request,
      capabilityId: "demo",
      declaredPath: "/x",
      sessionId: null,
      bodyBytes: null,
    });
    expect(env.bodyBase64).toBeNull();
    expect(env.sessionId).toBeNull();
  });
});

describe("deserializeResponseFromBundle", () => {
  it("round-trips body + status + headers", async () => {
    const body = btoa("response-body");
    const response = deserializeResponseFromBundle({
      status: 201,
      headers: { "content-type": "text/plain" },
      bodyBase64: body,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("response-body");
  });

  it("supports empty body", async () => {
    const response = deserializeResponseFromBundle({ status: 204 });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("serializeActionForBundle", () => {
  it("emits the four canonical fields verbatim", () => {
    const env = serializeActionForBundle({
      capabilityId: "files",
      action: "delete",
      data: { id: "f1" },
      sessionId: "s1",
    });
    expect(env).toEqual({
      capabilityId: "files",
      action: "delete",
      data: { id: "f1" },
      sessionId: "s1",
    });
  });
});
