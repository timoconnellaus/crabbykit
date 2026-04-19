import { describe, expect, it, vi } from "vitest";
import {
  BUNDLE_RUNTIME_HASH,
  buildBundle,
  encodeEnvelope,
  loadBundleFiles,
} from "../bundle-builder.js";

interface InMemoryBucket {
  store: Map<string, string>;
  bucket: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    list(opts: { prefix: string }): Promise<{
      objects: Array<{ key: string }>;
      truncated?: boolean;
      cursor?: string;
    }>;
  };
}

function createInMemoryBucket(seed: Record<string, string> = {}): InMemoryBucket {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    bucket: {
      async get(key) {
        const value = store.get(key);
        if (value == null) return null;
        return { text: async () => value };
      },
      async list({ prefix }) {
        const objects = Array.from(store.keys())
          .filter((k) => k.startsWith(prefix))
          .sort()
          .map((key) => ({ key }));
        return { objects, truncated: false };
      },
    },
  };
}

describe("loadBundleFiles", () => {
  it("reads user source files under the workshop/bundles prefix", async () => {
    const { bucket } = createInMemoryBucket({
      "ns/workshop/bundles/brain/package.json": `{"name":"brain"}`,
      "ns/workshop/bundles/brain/src/index.ts": `export default {};`,
      "ns/workshop/bundles/other/ignore.ts": `nope`,
    });
    const loaded = await loadBundleFiles({
      bucket,
      namespace: "ns",
      name: "brain",
      runtimeSource: "/* RUNTIME */",
    });
    expect(loaded.userFileCount).toBe(2);
    expect(loaded.files["package.json"]).toBe(`{"name":"brain"}`);
    expect(loaded.files["src/index.ts"]).toBe(`export default {};`);
    expect(loaded.files["ignore.ts"]).toBeUndefined();
  });

  it("injects the runtime source at every virtual path the resolver checks", async () => {
    const { bucket } = createInMemoryBucket({
      "ns/workshop/bundles/b/package.json": `{}`,
    });
    const loaded = await loadBundleFiles({
      bucket,
      namespace: "ns",
      name: "b",
      runtimeSource: "/* INJECTED v3 */",
    });
    expect(loaded.files["_claw/bundle-runtime.js"]).toBe("/* INJECTED v3 */");
    expect(loaded.files["src/_claw/bundle-runtime.js"]).toBe("/* INJECTED v3 */");
    expect(loaded.files["node_modules/@crabbykit/bundle-sdk/bundle.js"]).toBe("/* INJECTED v3 */");
    const pkg = JSON.parse(loaded.files["node_modules/@crabbykit/bundle-sdk/package.json"]!);
    expect(pkg.exports["."]).toBe("./bundle.js");
  });

  it("defaults to the bundled BUNDLE_RUNTIME_SOURCE when no override is passed", async () => {
    const { bucket } = createInMemoryBucket({
      "ns/workshop/bundles/b/package.json": `{}`,
    });
    const loaded = await loadBundleFiles({ bucket, namespace: "ns", name: "b" });
    // Sanity-check: the default runtime source is non-empty and stable.
    expect(loaded.files["_claw/bundle-runtime.js"]).toBeTruthy();
    expect(loaded.files["_claw/bundle-runtime.js"].length).toBeGreaterThan(100);
  });
});

describe("buildBundle", () => {
  it("throws when the workspace has no user files", async () => {
    const { bucket } = createInMemoryBucket();
    await expect(
      buildBundle({
        bucket,
        namespace: "ns",
        name: "empty",
        runtimeSource: "/* */",
        createWorker: vi.fn(),
      }),
    ).rejects.toThrow(/No files under/);
  });

  it("calls the supplied createWorker with the merged file set", async () => {
    const { bucket } = createInMemoryBucket({
      "ns/workshop/bundles/b/src/index.ts": `export default {};`,
    });
    const createWorker = vi.fn(async () => ({
      mainModule: "bundle.js",
      modules: { "bundle.js": "export default {};" },
    }));
    const result = await buildBundle({
      bucket,
      namespace: "ns",
      name: "b",
      runtimeSource: "/* RUNTIME */",
      createWorker: createWorker as never,
    });
    expect(createWorker).toHaveBeenCalledOnce();
    const passed = createWorker.mock.calls[0][0] as { files: Record<string, string> };
    expect(passed.files["src/index.ts"]).toBe("export default {};");
    expect(passed.files["_claw/bundle-runtime.js"]).toBe("/* RUNTIME */");
    expect(result.userFileCount).toBe(1);
    expect(result.mainModule).toBe("bundle.js");
  });
});

describe("encodeEnvelope", () => {
  it("emits a v1 JSON envelope with mainModule and modules", () => {
    const bytes = encodeEnvelope("bundle.js", { "bundle.js": "export default 1;" });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed).toEqual({
      v: 1,
      mainModule: "bundle.js",
      modules: { "bundle.js": "export default 1;" },
    });
  });
});

describe("BUNDLE_RUNTIME_HASH", () => {
  it("is a 64-char sha256 hex string", () => {
    expect(BUNDLE_RUNTIME_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
