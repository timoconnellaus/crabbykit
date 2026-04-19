#!/usr/bin/env bun
/**
 * Update every package under packages/*\/*\/ to make it npm-publishable.
 *
 * - adds `build` / `prepublishOnly` scripts
 * - removes `private: true`
 * - adds `license`, `files`, `publishConfig`, `repository`, `homepage`, `bugs`
 * - rewrites `publishConfig.exports` to point to dist/ paths
 *
 * Idempotent — running twice produces the same output.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = "/Users/tim/repos/claw-for-cloudflare";
const GITHUB_URL = "https://github.com/crabbykit/claw";
const LICENSE = "MIT";
const AUTHOR = "Tim O'Connell";

type PackageExport = string | { types?: string; import?: string; default?: string };
type Pkg = {
  name: string;
  version?: string;
  private?: boolean;
  type?: string;
  exports?: Record<string, PackageExport> | string;
  scripts?: Record<string, string>;
  license?: string;
  author?: string;
  files?: string[];
  publishConfig?: Record<string, unknown>;
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  sideEffects?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: unknown;
};

function listPackages(): string[] {
  const packagesDir = join(REPO_ROOT, "packages");
  const buckets = readdirSync(packagesDir);
  const paths: string[] = [];
  for (const bucket of buckets) {
    const bucketDir = join(packagesDir, bucket);
    const names = readdirSync(bucketDir);
    for (const name of names) {
      const pkgPath = join(bucketDir, name, "package.json");
      try {
        readFileSync(pkgPath);
        paths.push(join(bucketDir, name));
      } catch {}
    }
  }
  return paths;
}

function rewriteExportValue(value: PackageExport): PackageExport {
  if (typeof value === "string") {
    if (/\.(ts|tsx)$/.test(value)) {
      const js = value.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".js");
      const dts = value.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".d.ts");
      return { types: dts, import: js };
    }
    if (value.startsWith("./src/")) {
      return value.replace(/^\.\/src\//, "./dist/");
    }
    return value;
  }
  const next: { types?: string; import?: string; default?: string } = { ...value };
  if (next.import && /\.(ts|tsx)$/.test(next.import)) {
    const js = next.import.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".js");
    const dts = next.import.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".d.ts");
    next.import = js;
    next.types = next.types ?? dts;
  }
  return next;
}

function buildPublishExports(pkg: Pkg): Record<string, PackageExport> | undefined {
  if (!pkg.exports) return undefined;
  const src = typeof pkg.exports === "string" ? { ".": pkg.exports } : pkg.exports;
  const out: Record<string, PackageExport> = {};
  for (const [key, value] of Object.entries(src)) {
    out[key] = rewriteExportValue(value);
  }
  return out;
}

function orderKeys(pkg: Pkg): Pkg {
  const order = [
    "name",
    "version",
    "description",
    "keywords",
    "homepage",
    "bugs",
    "repository",
    "license",
    "author",
    "type",
    "sideEffects",
    "exports",
    "files",
    "scripts",
    "dependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "devDependencies",
    "publishConfig",
  ];
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (key in pkg) out[key] = pkg[key as keyof Pkg];
  }
  for (const key of Object.keys(pkg)) {
    if (!(key in out)) out[key] = pkg[key as keyof Pkg];
  }
  return out as Pkg;
}

for (const pkgDir of listPackages()) {
  const pkgPath = join(pkgDir, "package.json");
  const pkg: Pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  delete pkg.private;
  pkg.license = LICENSE;
  pkg.author = AUTHOR;
  pkg.homepage = `${GITHUB_URL}#readme`;
  pkg.bugs = { url: `${GITHUB_URL}/issues` };
  pkg.repository = {
    type: "git",
    url: `git+${GITHUB_URL}.git`,
    directory: pkgDir.slice(REPO_ROOT.length + 1),
  };

  const existingFiles = new Set(pkg.files ?? []);
  existingFiles.add("dist");
  pkg.files = [...existingFiles].sort();

  pkg.scripts = pkg.scripts ?? {};
  const shortName = pkg.name.split("/").pop() ?? pkg.name;
  if (shortName !== "bundle-sdk") {
    pkg.scripts.build = `bun ${"../".repeat(3)}scripts/build-package.ts`;
  }
  pkg.scripts.prepublishOnly = "bun run build";

  const publishExports = buildPublishExports(pkg);
  pkg.publishConfig = {
    access: "public",
    ...(publishExports ? { exports: publishExports } : {}),
  };

  const ordered = orderKeys(pkg);
  writeFileSync(pkgPath, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`[setup-publish] updated ${pkg.name}`);
}
