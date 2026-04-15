import { describe, expect, it, vi } from "vitest";
import { agentWorkshop, encodeEnvelope } from "../index.js";
import {
  createMockContext,
  createMockRegistry,
  createMockStorage,
  findTool,
  runTool,
} from "./test-helpers.js";

const FAKE_RUNTIME = "/* FAKE BUNDLE RUNTIME v1 */\nexport const marker = 1;\n";

function fakeCreateWorker() {
  return vi.fn(async (opts: { files: Record<string, string> }) => {
    const entry = opts.files["src/index.ts"] ?? "";
    // Trivial fake: wrap source in an IIFE that exposes a default export,
    // and inline the runtime marker so tests can assert it flows through.
    const runtime = opts.files["_claw/bundle-runtime.js"] ?? "";
    const js = `/* runtime:${runtime.length} */\n${entry}\nexport default { fetch() { return new Response('ok'); } };\n`;
    return {
      mainModule: "bundle.js",
      modules: { "bundle.js": js },
    };
  });
}

function makeWorkshop(overrides: Partial<Parameters<typeof agentWorkshop>[1]> = {}) {
  const { storage, mock } = createMockStorage("ns");
  const { registry, versions, active, setActiveCalls } = createMockRegistry();
  const createWorker = overrides.createWorker ?? fakeCreateWorker();
  const runtimeSource = overrides.getBundleRuntimeSource?.() ?? FAKE_RUNTIME;
  const cap = agentWorkshop(
    { registry, storage, deployRateLimitPerMinute: 3 },
    {
      createWorker: createWorker as never,
      getBundleRuntimeSource: overrides.getBundleRuntimeSource ?? (() => runtimeSource),
    },
  );
  return { cap, storage, mock, registry, versions, active, setActiveCalls, createWorker };
}

describe("agentWorkshop — file tools", () => {
  it("workshop_init writes package.json and src/index.ts to R2", async () => {
    const { cap, mock } = makeWorkshop();
    const ctx = createMockContext();
    const tools = cap.tools!(ctx);
    const result = await runTool(findTool(tools, "workshop_init"), { name: "my-brain" });
    expect(result).toContain("created");
    expect(mock.store.has("ns/workshop/bundles/my-brain/package.json")).toBe(true);
    expect(mock.store.has("ns/workshop/bundles/my-brain/src/index.ts")).toBe(true);
    // Runtime must NOT be persisted — it's injected only at build time.
    expect(mock.store.has("ns/workshop/bundles/my-brain/_claw/bundle-runtime.js")).toBe(false);
    // Starter imports the virtual runtime via the natural package
    // path. `workshop_build` injects the runtime bytes at the
    // `@claw-for-cloudflare/agent-bundle/bundle` virtual file key so
    // worker-bundler's bare-specifier resolution hits it directly.
    const starter = mock.store.get("ns/workshop/bundles/my-brain/src/index.ts")!;
    expect(starter).toContain('from "@claw-for-cloudflare/agent-bundle/bundle"');
    expect(starter).toContain("defineBundleAgent");
  });

  it("workshop_init refuses to overwrite an existing workspace", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "dup" });
    const second = await runTool(findTool(tools, "workshop_init"), { name: "dup" });
    expect(second).toMatch(/already exists/);
  });

  it("workshop_init rejects invalid names", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    const result = await runTool(findTool(tools, "workshop_init"), { name: "../escape" });
    expect(result).toMatch(/Error/);
  });

  it("workshop_file_write persists content and workshop_file_read round-trips", async () => {
    const { cap, mock } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b1" });
    await runTool(findTool(tools, "workshop_file_write"), {
      name: "b1",
      path: "src/tool.ts",
      content: "export const x = 42;",
    });
    expect(mock.store.get("ns/workshop/bundles/b1/src/tool.ts")).toBe("export const x = 42;");
    const read = await runTool(findTool(tools, "workshop_file_read"), {
      name: "b1",
      path: "src/tool.ts",
    });
    expect(read).toBe("export const x = 42;");
  });

  it("workshop_file_write rejects path traversal", async () => {
    const { cap, mock } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b2" });
    const result = await runTool(findTool(tools, "workshop_file_write"), {
      name: "b2",
      path: "../escape.ts",
      content: "pwned",
    });
    expect(result).toMatch(/\.\./);
    // Nothing should leak outside the bundle prefix.
    for (const key of mock.store.keys()) {
      expect(key.startsWith("ns/workshop/bundles/b2/")).toBe(true);
    }
  });

  it("workshop_file_write refuses to write under _claw/ (reserved prefix)", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b3" });
    const result = await runTool(findTool(tools, "workshop_file_write"), {
      name: "b3",
      path: "_claw/bundle-runtime.js",
      content: "// sabotage",
    });
    expect(result).toMatch(/reserved/);
  });

  it("workshop_file_edit round-trips a single replacement", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b4" });
    await runTool(findTool(tools, "workshop_file_write"), {
      name: "b4",
      path: "src/x.ts",
      content: "const greeting = 'hello';\nconst other = 'world';",
    });
    const result = await runTool(findTool(tools, "workshop_file_edit"), {
      name: "b4",
      path: "src/x.ts",
      oldString: "'hello'",
      newString: "'hi'",
    });
    expect(result).toMatch(/Edited/);
    const read = await runTool(findTool(tools, "workshop_file_read"), {
      name: "b4",
      path: "src/x.ts",
    });
    expect(read).toContain("'hi'");
    expect(read).toContain("'world'");
  });

  it("workshop_file_edit refuses ambiguous replacements", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b5" });
    await runTool(findTool(tools, "workshop_file_write"), {
      name: "b5",
      path: "src/x.ts",
      content: "a; a;",
    });
    const result = await runTool(findTool(tools, "workshop_file_edit"), {
      name: "b5",
      path: "src/x.ts",
      oldString: "a",
      newString: "b",
    });
    expect(result).toMatch(/more than once/);
  });

  it("workshop_file_list returns only user files, hides _claw/", async () => {
    const { cap, mock } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b6" });
    // Simulate a legacy _claw/ entry somehow ending up in R2.
    mock.store.set("ns/workshop/bundles/b6/_claw/bundle-runtime.js", "rogue");
    const listed = await runTool(findTool(tools, "workshop_file_list"), { name: "b6" });
    expect(listed).toContain("package.json");
    expect(listed).toContain("src/index.ts");
    expect(listed).not.toContain("_claw/");
  });

  it("workshop_file_delete removes a file", async () => {
    const { cap, mock } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b7" });
    await runTool(findTool(tools, "workshop_file_delete"), {
      name: "b7",
      path: "src/index.ts",
    });
    expect(mock.store.has("ns/workshop/bundles/b7/src/index.ts")).toBe(false);
    expect(mock.store.has("ns/workshop/bundles/b7/package.json")).toBe(true);
  });
});

describe("agentWorkshop — build / test", () => {
  it("workshop_build injects BUNDLE_RUNTIME_SOURCE at every reserved runtime path", async () => {
    const createWorker = fakeCreateWorker();
    const { cap } = makeWorkshop({ createWorker });
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b8" });
    const result = await runTool(findTool(tools, "workshop_build"), { name: "b8" });
    expect(result).toContain("Build successful");
    // The bundler must have seen the runtime at every injection site
    // workshop seeds: two relative-path locations for authors using
    // `./_claw/` or `../_claw/` imports, plus a full virtual
    // node_modules package for the natural
    // `@claw-for-cloudflare/agent-bundle/bundle` import that
    // worker-bundler's resolvePackage can discover via package.json +
    // exports map.
    expect(createWorker).toHaveBeenCalledTimes(1);
    const call = createWorker.mock.calls[0][0];
    expect(call.files["_claw/bundle-runtime.js"]).toBe(FAKE_RUNTIME);
    expect(call.files["src/_claw/bundle-runtime.js"]).toBe(FAKE_RUNTIME);
    expect(call.files["node_modules/@claw-for-cloudflare/agent-bundle/bundle.js"]).toBe(
      FAKE_RUNTIME,
    );
    const pkgJson = JSON.parse(
      call.files["node_modules/@claw-for-cloudflare/agent-bundle/package.json"] as string,
    );
    expect(pkgJson.name).toBe("@claw-for-cloudflare/agent-bundle");
    expect(pkgJson.exports?.["./bundle"]).toBe("./bundle.js");
    expect(call.files["src/index.ts"]).toContain(
      'from "@claw-for-cloudflare/agent-bundle/bundle"',
    );
  });

  it("workshop_build surfaces bundler errors", async () => {
    const boom = vi.fn(async () => {
      throw new Error("syntax error at line 1");
    });
    const { cap } = makeWorkshop({ createWorker: boom as never });
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b9" });
    const result = await runTool(findTool(tools, "workshop_build"), { name: "b9" });
    expect(result).toMatch(/Build failed.*syntax error/);
  });

  it("workshop_build refuses an empty workspace", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    const result = await runTool(findTool(tools, "workshop_build"), { name: "ghost" });
    expect(result).toMatch(/No files/);
  });

  it("workshop_test fails when the main module has no default export", async () => {
    const noDefault = vi.fn(async () => ({
      mainModule: "bundle.js",
      modules: { "bundle.js": "export const hi = 1;" },
    }));
    const { cap } = makeWorkshop({ createWorker: noDefault as never });
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b10" });
    const result = await runTool(findTool(tools, "workshop_test"), { name: "b10" });
    expect(result).toMatch(/no default export/);
  });

  it("workshop_test passes for a well-formed bundle", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "b11" });
    const result = await runTool(findTool(tools, "workshop_test"), { name: "b11" });
    expect(result).toContain("Test passed");
  });
});

describe("agentWorkshop — deploy / envelope", () => {
  it("workshop_deploy persists a v1 envelope and flips setActive", async () => {
    const { cap, registry, versions, setActiveCalls } = makeWorkshop();
    const ctx = createMockContext({ agentId: "agent-a" });
    const tools = cap.tools!(ctx);
    await runTool(findTool(tools, "workshop_init"), { name: "b12" });
    const result = await runTool(findTool(tools, "workshop_deploy"), {
      name: "b12",
      rationale: "test deploy",
    });
    expect(result).toContain("deployed successfully");
    expect(versions.size).toBe(1);
    expect(setActiveCalls).toHaveLength(1);
    expect(setActiveCalls[0].agentId).toBe("agent-a");
    expect(setActiveCalls[0].opts?.rationale).toBe("test deploy");

    // Envelope shape assertion.
    const [entry] = versions.values();
    const text = new TextDecoder().decode(entry.bytes);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(1);
    expect(parsed.mainModule).toBe("bundle.js");
    expect(parsed.modules["bundle.js"]).toContain("export default");
    const activeId = await registry.getActiveForAgent("agent-a");
    expect(activeId).toBe(entry.version.versionId);
  });

  it("workshop_deploy calls notifyBundlePointerChanged for self-edit", async () => {
    const notify = vi.fn(async () => {});
    const { cap } = makeWorkshop();
    const ctx = createMockContext({ agentId: "self", notifyBundlePointerChanged: notify });
    const tools = cap.tools!(ctx);
    await runTool(findTool(tools, "workshop_init"), { name: "b13" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "b13" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("workshop_deploy skips notifyBundlePointerChanged when targeting another agent", async () => {
    const notify = vi.fn(async () => {});
    const { cap } = makeWorkshop();
    const ctx = createMockContext({ agentId: "self", notifyBundlePointerChanged: notify });
    const tools = cap.tools!(ctx);
    await runTool(findTool(tools, "workshop_init"), { name: "b14" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "b14", targetAgentId: "other" });
    expect(notify).toHaveBeenCalledTimes(0);
  });

  it("workshop_deploy enforces the rate limit", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "r1" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "r1" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "r1" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "r1" });
    const fourth = await runTool(findTool(tools, "workshop_deploy"), { name: "r1" });
    expect(fourth).toMatch(/rate limit/);
  });

  it("encodeEnvelope round-trips to parseable JSON of the expected shape", () => {
    const buf = encodeEnvelope("bundle.js", { "bundle.js": "export default 1;" });
    const parsed = JSON.parse(new TextDecoder().decode(buf));
    expect(parsed).toEqual({
      v: 1,
      mainModule: "bundle.js",
      modules: { "bundle.js": "export default 1;" },
    });
  });

  it("workshop_disable flips active to null and notifies the cache", async () => {
    const notify = vi.fn(async () => {});
    const { cap, registry, setActiveCalls } = makeWorkshop();
    const ctx = createMockContext({ agentId: "self", notifyBundlePointerChanged: notify });
    const tools = cap.tools!(ctx);
    await runTool(findTool(tools, "workshop_init"), { name: "d1" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "d1" });
    notify.mockClear();
    const result = await runTool(findTool(tools, "workshop_disable"), {});
    expect(result).toContain("disabled");
    expect(await registry.getActiveForAgent("self")).toBeNull();
    expect(setActiveCalls.at(-1)?.versionId).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("workshop_versions reports the active version", async () => {
    const { cap } = makeWorkshop();
    const tools = cap.tools!(createMockContext({ agentId: "self" }));
    await runTool(findTool(tools, "workshop_init"), { name: "v1" });
    await runTool(findTool(tools, "workshop_deploy"), { name: "v1" });
    const result = await runTool(findTool(tools, "workshop_versions"), {});
    expect(result).toContain("Active version");
    expect(result).not.toMatch(/\(none — static brain\)/);
  });
});

describe("agentWorkshop — runtime auto-upgrade", () => {
  it("injects a new BUNDLE_RUNTIME_SOURCE on each build (no persisted copy)", async () => {
    const createWorker = fakeCreateWorker();
    let runtimeVersion = "v1";
    const { cap } = makeWorkshop({
      createWorker,
      getBundleRuntimeSource: () => `/* runtime:${runtimeVersion} */`,
    });
    const tools = cap.tools!(createMockContext());
    await runTool(findTool(tools, "workshop_init"), { name: "upgrade" });
    await runTool(findTool(tools, "workshop_build"), { name: "upgrade" });
    expect(createWorker.mock.calls[0][0].files["_claw/bundle-runtime.js"]).toBe("/* runtime:v1 */");

    // Bump the runtime — simulates an SDK redeploy between builds.
    runtimeVersion = "v2";
    await runTool(findTool(tools, "workshop_build"), { name: "upgrade" });
    expect(createWorker.mock.calls[1][0].files["_claw/bundle-runtime.js"]).toBe("/* runtime:v2 */");
  });
});

describe("agentWorkshop — prompt section", () => {
  it("describes the R2/no-container workflow and reserves _claw/", () => {
    const { cap } = makeWorkshop();
    const sections = cap.promptSections!();
    const included = sections.find((s) => s.kind === "included");
    expect(included).toBeTruthy();
    const section = included as { kind: "included"; content: string };
    expect(section.content).toContain("workshop_init");
    expect(section.content).toContain("workshop_build");
    expect(section.content).toContain("workshop_deploy");
    expect(section.content).toContain("_claw/");
    // No container / elevation guidance should remain.
    expect(section.content).not.toContain("elevate");
    expect(section.content).not.toContain("sandbox");
  });
});
