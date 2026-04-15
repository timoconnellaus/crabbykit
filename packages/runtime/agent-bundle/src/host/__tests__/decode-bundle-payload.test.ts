import { describe, expect, it } from "vitest";
import { decodeBundlePayload } from "../bundle-dispatcher.js";

/**
 * Envelope encoder that mirrors workshop's `encodeEnvelope`. Duplicated
 * instead of imported so agent-bundle's test doesn't pull in agent-workshop
 * as a dep, keeping the dispatcher package self-contained.
 */
function encodeEnvelope(mainModule: string, modules: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, mainModule, modules });
}

describe("decodeBundlePayload", () => {
  it("decodes a v1 envelope with a single module", () => {
    const envelope = JSON.stringify({
      v: 1,
      mainModule: "bundle.js",
      modules: {
        "bundle.js": "export default { fetch() { return new Response('ok'); } };",
      },
    });
    const { mainModule, modules } = decodeBundlePayload(envelope);
    expect(mainModule).toBe("bundle.js");
    expect(Object.keys(modules)).toEqual(["bundle.js"]);
    expect(modules["bundle.js"]).toContain("export default");
  });

  it("decodes a v1 envelope with multiple modules", () => {
    const envelope = JSON.stringify({
      v: 1,
      mainModule: "a.js",
      modules: {
        "a.js": "export default 'main';",
        "b.js": "export const helper = 42;",
      },
    });
    const { mainModule, modules } = decodeBundlePayload(envelope);
    expect(mainModule).toBe("a.js");
    expect(Object.keys(modules).sort()).toEqual(["a.js", "b.js"]);
  });

  it("decodes a v1 envelope with leading whitespace", () => {
    const envelope = `  \n  ${JSON.stringify({
      v: 1,
      mainModule: "x.js",
      modules: { "x.js": "export default 1;" },
    })}`;
    const { mainModule } = decodeBundlePayload(envelope);
    expect(mainModule).toBe("x.js");
  });

  it("falls back to legacy shape for raw JS bytes (no JSON envelope)", () => {
    const raw = "export default { fetch() { return new Response('legacy'); } };";
    const { mainModule, modules } = decodeBundlePayload(raw);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(raw);
  });

  it("falls back to legacy shape for raw JS that happens to start with {", () => {
    const raw = "{ /* block */ } export default { fetch() { return new Response('x'); } };";
    const { mainModule, modules } = decodeBundlePayload(raw);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(raw);
  });

  it("falls back to legacy shape for malformed JSON starting with {", () => {
    const malformed = `{"v": 1, "mainModule": "broken",`;
    const { mainModule, modules } = decodeBundlePayload(malformed);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(malformed);
  });

  it("falls back to legacy shape when v sentinel is missing", () => {
    const noSentinel = JSON.stringify({
      mainModule: "y.js",
      modules: { "y.js": "export default 2;" },
    });
    const { mainModule, modules } = decodeBundlePayload(noSentinel);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(noSentinel);
  });

  it("falls back to legacy shape when v sentinel is wrong version", () => {
    const wrongVersion = JSON.stringify({
      v: 2,
      mainModule: "z.js",
      modules: { "z.js": "export default 3;" },
    });
    const { mainModule, modules } = decodeBundlePayload(wrongVersion);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(wrongVersion);
  });

  it("falls back to legacy shape when mainModule is not a string", () => {
    const badMain = JSON.stringify({
      v: 1,
      mainModule: 42,
      modules: { "w.js": "export default 4;" },
    });
    const { mainModule, modules } = decodeBundlePayload(badMain);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(badMain);
  });

  it("falls back to legacy shape when modules is null", () => {
    const badModules = JSON.stringify({
      v: 1,
      mainModule: "n.js",
      modules: null,
    });
    const { mainModule, modules } = decodeBundlePayload(badModules);
    expect(mainModule).toBe("bundle.js");
    expect(modules["bundle.js"]).toBe(badModules);
  });

  it("round-trips a workshop-encoded envelope via the dispatcher decoder", () => {
    const encoded = encodeEnvelope("bundle.js", {
      "bundle.js": "export default { fetch() { return new Response('hi'); } };",
      "_claw/bundle-runtime.js": "// runtime injected at build time",
    });
    const decoded = decodeBundlePayload(encoded);
    expect(decoded.mainModule).toBe("bundle.js");
    expect(Object.keys(decoded.modules).sort()).toEqual(["_claw/bundle-runtime.js", "bundle.js"]);
    expect(decoded.modules["bundle.js"]).toContain("export default");
    expect(decoded.modules["_claw/bundle-runtime.js"]).toContain("runtime");
  });
});
