#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const cwd = process.cwd();
const pkgPath = join(cwd, "package.json");
if (!existsSync(pkgPath)) {
  console.error(`[build-package] no package.json at ${cwd}`);
  process.exit(1);
}

type PackageExport = string | { types?: string; import?: string; default?: string };
type Pkg = {
  name: string;
  exports?: Record<string, PackageExport> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const pkg: Pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const distDir = join(cwd, "dist");

function entryFromExport(exp: PackageExport): string | null {
  if (typeof exp === "string") return exp;
  return exp.import ?? exp.default ?? null;
}

function isSource(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) && !path.startsWith("./dist/");
}

const entries: string[] = [];
const assets: string[] = [];

const exportsMap: Record<string, PackageExport> = (() => {
  if (!pkg.exports) return { ".": "./src/index.ts" };
  if (typeof pkg.exports === "string") return { ".": pkg.exports };
  return pkg.exports;
})();

for (const value of Object.values(exportsMap)) {
  const sourcePath = entryFromExport(value);
  if (!sourcePath) continue;
  if (isSource(sourcePath)) {
    entries.push(sourcePath);
  } else if (/\.css$/.test(sourcePath)) {
    assets.push(sourcePath);
  }
}

if (entries.length === 0 && assets.length === 0) {
  console.log(`[${pkg.name}] no buildable entries; skipping`);
  process.exit(0);
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const externalSet = new Set<string>();
for (const m of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
  if (!m) continue;
  for (const name of Object.keys(m)) externalSet.add(name);
}
externalSet.add("cloudflare:workers");
externalSet.add("cloudflare:sockets");
externalSet.add("node:*");

if (entries.length > 0) {
  const build = await Bun.build({
    entrypoints: entries.map((e) => resolve(cwd, e)),
    outdir: distDir,
    target: "browser",
    format: "esm",
    external: [...externalSet],
    minify: false,
    sourcemap: "external",
    root: resolve(cwd, "src"),
  });

  if (!build.success) {
    for (const log of build.logs) console.error(log);
    process.exit(1);
  }
}

for (const asset of assets) {
  const src = resolve(cwd, asset);
  const dest = join(distDir, relative(resolve(cwd, "src"), src));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

if (entries.length > 0) {
  const buildTsconfigPath = join(cwd, "tsconfig.build.json");
  const buildTsconfig = {
    extends: "./tsconfig.json",
    compilerOptions: {
      noEmit: false,
      rootDir: "src",
      outDir: "dist",
      declaration: true,
      declarationMap: true,
      emitDeclarationOnly: true,
    },
    include: ["src"],
    exclude: [
      "src/**/__tests__/**",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/test-helpers/**",
    ],
  };
  writeFileSync(buildTsconfigPath, JSON.stringify(buildTsconfig, null, 2));
  try {
    execSync("bun x tsc -p tsconfig.build.json", { cwd, stdio: "inherit" });
  } catch (_err) {
    console.error(`[${pkg.name}] tsc declaration emit failed`);
    rmSync(buildTsconfigPath, { force: true });
    process.exit(1);
  }
  rmSync(buildTsconfigPath, { force: true });
}

console.log(
  `[${pkg.name}] built ${entries.length} ${entries.length === 1 ? "entry" : "entries"}${assets.length ? ` + ${assets.length} ${assets.length === 1 ? "asset" : "assets"}` : ""}`,
);
