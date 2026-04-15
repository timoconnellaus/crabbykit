/**
 * BundleBuilder — host-side helpers for compiling authored bundle source
 * into the v1 envelope dispatched by BundleDispatcher.
 *
 * These helpers are shared between:
 *
 *   1. The workshop capability's `workshop_build` / `workshop_deploy`
 *      tools (agent-facing).
 *   2. The auto-rebuild path in `bundle-dispatcher.ts`, which re-runs
 *      the build when the injected `BUNDLE_RUNTIME_SOURCE` has drifted
 *      from the hash recorded against the currently active version.
 *
 * Keeping the logic here means drift rebuilds work for any agent with
 * a `bundle` field — not just those that happen to have the workshop
 * capability installed.
 */

import {
  BUNDLE_RUNTIME_HASH,
  BUNDLE_RUNTIME_SOURCE,
} from "@claw-for-cloudflare/bundle-sdk/runtime-source";

/**
 * `@cloudflare/worker-bundler` pulls in esbuild-wasm, which eagerly loads a
 * `.wasm` asset at module evaluation. That works inside a real Worker isolate
 * but fails when a Node test runner imports this file — the wasm asset is not
 * resolvable from Node's loader. Lazy-import keeps this module safe to unit-
 * test while still using the real bundler at runtime.
 */
type CreateWorker = typeof import("@cloudflare/worker-bundler").createWorker;
let cachedCreateWorker: CreateWorker | null = null;
async function loadCreateWorker(): Promise<CreateWorker> {
  if (!cachedCreateWorker) {
    const mod = await import("@cloudflare/worker-bundler");
    cachedCreateWorker = mod.createWorker;
  }
  return cachedCreateWorker;
}

/**
 * R2 bucket interface used by the loader. Kept deliberately narrow so
 * tests (and consumers outside Cloudflare Workers) can supply a tiny
 * in-memory stand-in.
 */
export interface BundleSourceBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(opts: { prefix: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

/**
 * Relative virtual paths at which the pre-compiled bundle runtime is
 * injected. Both map to the same `BUNDLE_RUNTIME_SOURCE` so relative
 * imports resolve no matter which shape the bundle author chose:
 *
 *   - `_claw/bundle-runtime.js` — project-root-relative. Bundle source
 *     `../_claw/bundle-runtime.js` from `src/index.ts` walks up out of
 *     `src/` and lands here.
 *   - `src/_claw/bundle-runtime.js` — matches `./_claw/bundle-runtime.js`
 *     from `src/index.ts`. Covers older starters that used the `./`
 *     form verbatim.
 *
 * The reserved `_claw/` prefix holds — bundle source may not overwrite
 * either path.
 */
export const RELATIVE_RUNTIME_PATHS = [
  "_claw/bundle-runtime.js",
  "src/_claw/bundle-runtime.js",
] as const;

/**
 * Virtual `node_modules/@claw-for-cloudflare/bundle-sdk` package that
 * `@cloudflare/worker-bundler`'s `resolvePackage` can find when bundle
 * source uses the natural package import
 * `import from "@claw-for-cloudflare/bundle-sdk"`. The bundler parses
 * the specifier into `(packageName, subpath)`, reads
 * `node_modules/{packageName}/package.json`, uses the `exports` map to
 * resolve `./{subpath}`, and loads
 * `node_modules/{packageName}/{resolvedPath}`. Seeding a full virtual
 * package (package.json + bundle.js) is the ONLY layout that resolver
 * accepts — a bare key at the specifier path is ignored.
 */
const VIRTUAL_PACKAGE_DIR = "node_modules/@claw-for-cloudflare/bundle-sdk";
const VIRTUAL_PACKAGE_JSON_PATH = `${VIRTUAL_PACKAGE_DIR}/package.json`;
const VIRTUAL_PACKAGE_BUNDLE_PATH = `${VIRTUAL_PACKAGE_DIR}/bundle.js`;
const VIRTUAL_PACKAGE_JSON = JSON.stringify({
  name: "@claw-for-cloudflare/bundle-sdk",
  version: "0.0.0-virtual",
  type: "module",
  exports: {
    ".": "./bundle.js",
  },
});

/** R2 layout: `{namespace}/workshop/bundles/{name}/...`. */
export const WORKSHOP_BUNDLE_PREFIX = "workshop/bundles";

export interface LoadedBundleFiles {
  files: Record<string, string>;
  /** Count of R2 objects read, excluding the injected virtual runtime files. */
  userFileCount: number;
  totalBytes: number;
}

export interface BuildBundleResult {
  mainModule: string;
  modules: Record<string, unknown>;
  userFileCount: number;
}

export interface LoadBundleFilesOptions {
  bucket: BundleSourceBucket;
  namespace: string;
  name: string;
  /**
   * Runtime source override. Defaults to the current `BUNDLE_RUNTIME_SOURCE`
   * exported by the bundle-sdk build. Tests inject a different string to
   * verify the auto-rebuild-on-drift behavior.
   */
  runtimeSource?: string;
}

export interface BuildBundleOptions extends LoadBundleFilesOptions {
  /**
   * Override `createWorker` for isolated unit tests. Production callers omit
   * this and the real `@cloudflare/worker-bundler` is lazy-loaded on first
   * build.
   */
  createWorker?: CreateWorker;
}

export const BUNDLE_ENVELOPE_VERSION = 1;

export function bundlePrefix(namespace: string, name: string): string {
  return `${namespace}/${WORKSHOP_BUNDLE_PREFIX}/${name}`;
}

export function bundleFileR2Key(namespace: string, name: string, relPath: string): string {
  return `${bundlePrefix(namespace, name)}/${relPath}`;
}

/**
 * List all R2 objects under the bundle prefix, fetch their contents, and
 * merge the compiled bundle-sdk runtime as virtual files at every path
 * listed in `RELATIVE_RUNTIME_PATHS`, plus the synthetic
 * `node_modules/@claw-for-cloudflare/bundle-sdk` package. The result is
 * ready to be passed to `createWorker`.
 *
 * The runtime is injected on EVERY call — never persisted to R2 — so
 * existing bundles pick up runtime changes automatically on their next
 * build.
 */
export async function loadBundleFiles(opts: LoadBundleFilesOptions): Promise<LoadedBundleFiles> {
  const prefix = `${bundlePrefix(opts.namespace, opts.name)}/`;
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let userFileCount = 0;

  const listed = await opts.bucket.list({ prefix });
  for (const obj of listed.objects) {
    const rel = obj.key.slice(prefix.length);
    if (!rel) continue;
    const got = await opts.bucket.get(obj.key);
    if (!got) continue;
    const contents = await got.text();
    files[rel] = contents;
    totalBytes += contents.length;
    userFileCount++;
  }

  const runtimeSource = opts.runtimeSource ?? BUNDLE_RUNTIME_SOURCE;
  for (const path of RELATIVE_RUNTIME_PATHS) {
    files[path] = runtimeSource;
  }
  files[VIRTUAL_PACKAGE_JSON_PATH] = VIRTUAL_PACKAGE_JSON;
  files[VIRTUAL_PACKAGE_BUNDLE_PATH] = runtimeSource;

  return { files, userFileCount, totalBytes };
}

/**
 * Build a bundle end-to-end: list source files from R2, inject the runtime,
 * and call `@cloudflare/worker-bundler#createWorker`. Throws if the workspace
 * contains no user-authored files.
 */
export async function buildBundle(opts: BuildBundleOptions): Promise<BuildBundleResult> {
  const loaded = await loadBundleFiles(opts);
  if (loaded.userFileCount === 0) {
    throw new Error(
      `No files under ${WORKSHOP_BUNDLE_PREFIX}/${opts.name}/. Run workshop_init first.`,
    );
  }

  const create = opts.createWorker ?? (await loadCreateWorker());
  const result = await create({ files: loaded.files });
  return {
    mainModule: result.mainModule,
    modules: result.modules as Record<string, unknown>,
    userFileCount: loaded.userFileCount,
  };
}

/**
 * Encode a built bundle into the v1 JSON envelope the dispatcher expects.
 * Exported so tests can assert the payload shape without running a full
 * deploy.
 */
export function encodeEnvelope(mainModule: string, modules: Record<string, unknown>): ArrayBuffer {
  const payload = JSON.stringify({
    v: BUNDLE_ENVELOPE_VERSION,
    mainModule,
    modules,
  });
  const bytes = new TextEncoder().encode(payload);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** Current runtime hash — exported for consumers that need to stamp bundles. */
export { BUNDLE_RUNTIME_HASH, BUNDLE_RUNTIME_SOURCE };
