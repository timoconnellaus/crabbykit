#!/usr/bin/env bun
/**
 * Subprocess runner that bundles a set of virtual files via `esbuild-wasm`
 * and writes the result as JSON to stdout. Exists because
 * `real-build.test.ts` needs to assert invariants over the REAL bundler
 * output (no unresolved `@claw-for-cloudflare/*` imports), and:
 *
 *   1. `@cloudflare/worker-bundler`'s bundled dist imports its wasm via
 *      `import esbuildWasm from "./esbuild.wasm"`. Bun returns the wasm
 *      import as a **string path**, not a `WebAssembly.Module`, so
 *      worker-bundler's internal `esbuild.initialize(...)` fails with
 *      `"wasmModule" must be a WebAssembly.Module`.
 *   2. The two esbuild-wasm module instances (ours vs. worker-bundler's
 *      bundled import) don't share state in bun's module graph, so
 *      pre-initializing esbuild from this runner doesn't help.
 *
 * We bypass worker-bundler and call esbuild-wasm directly. The options
 * mirror what workshop's build path asks for (ESM target, externals for
 * `cloudflare:*`, bundle = true). The output passes through the same
 * invariant check as the production path, which is enough to catch an
 * unresolved `@claw-for-cloudflare/agent-bundle/bundle` external.
 *
 * Input:  single JSON argv[2] of shape `{ files: Record<string,string>, entryPoint?: string }`
 * Output: JSON `{ ok: true, mainModule, modules }` or `{ ok: false, error }`
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type BuildInput = { files: Record<string, string>; entryPoint?: string };
type BuildOutput =
  | { ok: true; mainModule: string; modules: Record<string, string> }
  | { ok: false; error: string; stack?: string };

async function loadEsbuild(): Promise<{
  initialize(opts: { wasmModule: WebAssembly.Module; worker: boolean }): Promise<void>;
  build(opts: Record<string, unknown>): Promise<{
    outputFiles?: Array<{ path: string; text: string }>;
    errors: Array<{ text: string }>;
  }>;
}> {
  const esbuild = (await import("esbuild-wasm/lib/browser.js")) as never;

  // Locate and compile esbuild's wasm blob. Use `import.meta.resolve`
  // to find the esbuild-wasm package root — works in bun's ESM.
  const wasmUrl = import.meta.resolve("esbuild-wasm/esbuild.wasm");
  const wasmPath = fileURLToPath(wasmUrl);
  const wasmBytes = await readFile(wasmPath);
  const wasmModule = await WebAssembly.compile(wasmBytes);

  try {
    await (esbuild as unknown as { initialize: (o: unknown) => Promise<void> }).initialize({
      wasmModule,
      worker: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/more than once/i.test(msg)) throw err;
  }
  return esbuild as never;
}

async function bundleViaEsbuild(input: BuildInput): Promise<BuildOutput> {
  const esbuild = await loadEsbuild();
  const entry = input.entryPoint ?? "src/index.ts";
  const files = input.files;
  if (!files[entry]) {
    return { ok: false, error: `entry point not found: ${entry}` };
  }

  // Mirror worker-bundler's `resolveModule`. Three cases:
  //
  //   1. Relative specifiers (./foo, ../bar): join with importer's
  //      directory, try extensions, try index files.
  //   2. Bare package specifiers (@scope/pkg/subpath or lodash/util):
  //      read `node_modules/{packageName}/package.json`, resolve the
  //      subpath via the `exports` map, load
  //      `node_modules/{packageName}/{resolvedPath}`. Only this shape
  //      — NOT a direct `files[spec]` lookup — matches production.
  //   3. Absolute specifiers: strip leading slash and try files.
  const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

  const tryWithExtensions = (base: string): string | null => {
    if (files[base] !== undefined) return base;
    for (const ext of EXTENSIONS) {
      if (files[base + ext] !== undefined) return base + ext;
    }
    for (const ext of EXTENSIONS) {
      const idx = `${base}/index${ext}`;
      if (files[idx] !== undefined) return idx;
    }
    return null;
  };

  const resolveRelative = (spec: string, importer: string): string | null => {
    const base = importer.replace(/[^/]*$/, "");
    const parts = `${base}${spec}`.split("/");
    const stack: string[] = [];
    for (const p of parts) {
      if (p === "" || p === ".") continue;
      if (p === "..") {
        stack.pop();
        continue;
      }
      stack.push(p);
    }
    return tryWithExtensions(stack.join("/"));
  };

  const parsePackageSpec = (spec: string): { packageName: string; subpath: string | undefined } => {
    if (spec.startsWith("@")) {
      const parts = spec.split("/");
      if (parts.length >= 2) {
        return {
          packageName: `${parts[0]}/${parts[1]}`,
          subpath: parts.slice(2).join("/") || undefined,
        };
      }
    }
    const slash = spec.indexOf("/");
    if (slash === -1) return { packageName: spec, subpath: undefined };
    return { packageName: spec.slice(0, slash), subpath: spec.slice(slash + 1) };
  };

  /**
   * Resolve an `exports` map entry. Supports string entries and the
   * common conditional object shape with `import`/`default`/`browser`
   * conditions. Mirrors worker-bundler's use of `resolve.exports` at
   * the level of detail we need to faithfully reproduce the behavior
   * that was leaking the `@claw-for-cloudflare/agent-bundle/bundle`
   * import. Doesn't implement pattern matching — bundles we care about
   * use literal subpaths.
   */
  const resolveExportsEntry = (
    exportsField: unknown,
    subpath: string | undefined,
  ): string | null => {
    const key = subpath ? `./${subpath}` : ".";
    if (typeof exportsField === "string") {
      return subpath ? null : exportsField;
    }
    if (exportsField && typeof exportsField === "object") {
      const record = exportsField as Record<string, unknown>;
      const entry = record[key];
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const cond = entry as Record<string, unknown>;
        for (const k of ["import", "browser", "default"]) {
          const v = cond[k];
          if (typeof v === "string") return v;
        }
      }
    }
    return null;
  };

  const resolvePackage = (spec: string): string | null => {
    const { packageName, subpath } = parsePackageSpec(spec);
    const pkgJsonPath = `node_modules/${packageName}/package.json`;
    const pkgJsonRaw = files[pkgJsonPath];
    if (pkgJsonRaw === undefined) return null;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(pkgJsonRaw) as Record<string, unknown>;
    } catch {
      return null;
    }
    const resolved = resolveExportsEntry(pkg.exports, subpath);
    if (resolved) {
      const clean = resolved.replace(/^\.\//, "");
      const full = `node_modules/${packageName}/${clean}`;
      if (files[full] !== undefined) return full;
    }
    // Fallback: try subpath directly + index resolution.
    const base = `node_modules/${packageName}${subpath ? `/${subpath}` : ""}`;
    return tryWithExtensions(base);
  };

  const resolveFile = (spec: string, importer: string): string | null => {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      return resolveRelative(spec, importer);
    }
    if (spec.startsWith("/")) {
      const norm = spec.slice(1);
      return files[norm] !== undefined ? norm : null;
    }
    return resolvePackage(spec);
  };

  // Mirror worker-bundler's `virtual-fs` resolver. Crucially: when a
  // relative or bare import cannot be found in the virtual files map,
  // it is marked EXTERNAL. That's the exact behavior that lets a
  // mistyped `./_claw/bundle-runtime.js` or a user-written
  // `@claw-for-cloudflare/agent-bundle/bundle` slip through build and
  // blow up at runtime with "No such module". We replicate it here so
  // the test can grep the output for stray externals.
  const virtualPlugin = {
    name: "virtual-fs",
    setup(build: {
      onResolve(
        f: { filter: RegExp },
        cb: (args: { path: string; importer: string; kind: string; resolveDir: string }) => unknown,
      ): void;
      onLoad(
        f: { filter: RegExp; namespace?: string },
        cb: (args: { path: string }) => unknown,
      ): void;
    }) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "virtual" };
        }
        // cloudflare:* always external (matches production config).
        if (args.path.startsWith("cloudflare:")) {
          return { path: args.path, external: true };
        }
        const resolved = resolveFile(args.path, args.importer || entry);
        if (resolved !== null) return { path: resolved, namespace: "virtual" };
        // Fall through to external — matches worker-bundler's fallback
        // behavior, which is the root cause of "No such module" at
        // runtime. The grep check in the test picks up the leak.
        return { path: args.path, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `File not found: ${args.path}` }] };
        }
        const ext = args.path.split(".").pop() ?? "";
        const loaderMap: Record<string, string> = {
          ts: "ts",
          tsx: "tsx",
          js: "js",
          mjs: "js",
          json: "json",
        };
        const lastSlash = args.path.lastIndexOf("/");
        return {
          contents,
          loader: (loaderMap[ext] ?? "js") as never,
          resolveDir: lastSlash >= 0 ? args.path.slice(0, lastSlash) : "",
        };
      });
    },
  };

  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      target: "es2022",
      platform: "browser",
      write: false,
      plugins: [virtualPlugin],
      logLevel: "silent",
    });
    if (result.errors && result.errors.length > 0) {
      return {
        ok: false,
        error: result.errors.map((e) => e.text).join("\n"),
      };
    }
    const mainOutput = result.outputFiles?.[0];
    if (!mainOutput) {
      return { ok: false, error: "esbuild produced no output files" };
    }
    return {
      ok: true,
      mainModule: "bundle.js",
      modules: { "bundle.js": mainOutput.text },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write("usage: real-build-runner.ts <json>\n");
    process.exit(2);
  }
  const input = JSON.parse(raw) as BuildInput;
  const result = await bundleViaEsbuild(input);
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(`real-build-runner crash: ${String(err)}\n`);
  process.exit(3);
});
