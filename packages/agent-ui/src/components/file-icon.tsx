import { Icon } from "@iconify/react";
import type { ReactElement } from "react";

/**
 * Per-extension map to icons from the `vscode-icons` set on Iconify.
 * These are the same icons shipped in the official VS Code "vscode-icons"
 * extension — real language logos, rendered per-type. Unknown extensions
 * fall back to a generic file outline.
 *
 * Iconify fetches icons lazily from api.iconify.design on first render
 * and caches them in the browser, so there's no up-front bundle cost.
 */
const EXT_TO_ICON: Record<string, string> = {
  // JS / TS
  ts: "vscode-icons:file-type-typescript",
  tsx: "vscode-icons:file-type-reactts",
  js: "vscode-icons:file-type-js",
  jsx: "vscode-icons:file-type-reactjs",
  mjs: "vscode-icons:file-type-js",
  cjs: "vscode-icons:file-type-js",

  // Data / config
  json: "vscode-icons:file-type-json",
  jsonc: "vscode-icons:file-type-json",
  yaml: "vscode-icons:file-type-yaml",
  yml: "vscode-icons:file-type-yaml",
  toml: "vscode-icons:file-type-toml",
  xml: "vscode-icons:file-type-xml",
  ini: "vscode-icons:file-type-config",
  env: "vscode-icons:file-type-dotenv",

  // Docs
  md: "vscode-icons:file-type-markdown",
  mdx: "vscode-icons:file-type-markdown",
  markdown: "vscode-icons:file-type-markdown",
  txt: "vscode-icons:file-type-text",
  pdf: "vscode-icons:file-type-pdf2",

  // Languages
  py: "vscode-icons:file-type-python",
  rs: "vscode-icons:file-type-rust",
  go: "vscode-icons:file-type-go-gopher",
  rb: "vscode-icons:file-type-ruby",
  php: "vscode-icons:file-type-php",
  java: "vscode-icons:file-type-java",
  kt: "vscode-icons:file-type-kotlin",
  swift: "vscode-icons:file-type-swift",
  c: "vscode-icons:file-type-c",
  h: "vscode-icons:file-type-cheader",
  cpp: "vscode-icons:file-type-cpp",
  cc: "vscode-icons:file-type-cpp",
  cxx: "vscode-icons:file-type-cpp",
  hpp: "vscode-icons:file-type-cppheader",
  cs: "vscode-icons:file-type-csharp",
  lua: "vscode-icons:file-type-lua",
  r: "vscode-icons:file-type-r",
  zig: "vscode-icons:file-type-zig",

  // Web
  html: "vscode-icons:file-type-html",
  htm: "vscode-icons:file-type-html",
  css: "vscode-icons:file-type-css",
  scss: "vscode-icons:file-type-scss",
  sass: "vscode-icons:file-type-sass",
  less: "vscode-icons:file-type-less",
  vue: "vscode-icons:file-type-vue",
  svelte: "vscode-icons:file-type-svelte",

  // Shell / ops
  sh: "vscode-icons:file-type-shell",
  bash: "vscode-icons:file-type-shell",
  zsh: "vscode-icons:file-type-shell",
  fish: "vscode-icons:file-type-shell",
  ps1: "vscode-icons:file-type-powershell",
  dockerfile: "vscode-icons:file-type-docker",

  // Data
  sql: "vscode-icons:file-type-sql",
  csv: "vscode-icons:file-type-excel",
  xlsx: "vscode-icons:file-type-excel",

  // Images
  png: "vscode-icons:file-type-image",
  jpg: "vscode-icons:file-type-image",
  jpeg: "vscode-icons:file-type-image",
  gif: "vscode-icons:file-type-image",
  webp: "vscode-icons:file-type-image",
  svg: "vscode-icons:file-type-svg",
  ico: "vscode-icons:file-type-favicon",

  // Archives / binaries
  zip: "vscode-icons:file-type-zip",
  tar: "vscode-icons:file-type-zip",
  gz: "vscode-icons:file-type-zip",
  wasm: "vscode-icons:file-type-wasm",
  lock: "vscode-icons:file-type-lock",
  log: "vscode-icons:file-type-log",
};

/**
 * Special-case filenames that should override extension-based dispatch.
 * VS Code's icon theme recognizes these by full name rather than extension.
 */
const SPECIAL_NAMES: Record<string, string> = {
  "package.json": "vscode-icons:file-type-node",
  "package-lock.json": "vscode-icons:file-type-node",
  "tsconfig.json": "vscode-icons:file-type-tsconfig",
  "biome.json": "vscode-icons:file-type-biome",
  "bun.lockb": "vscode-icons:file-type-bun",
  "bun.lock": "vscode-icons:file-type-bun",
  "yarn.lock": "vscode-icons:file-type-yarn",
  "pnpm-lock.yaml": "vscode-icons:file-type-pnpm",
  dockerfile: "vscode-icons:file-type-docker2",
  makefile: "vscode-icons:file-type-makefile",
  ".gitignore": "vscode-icons:file-type-git",
  ".gitattributes": "vscode-icons:file-type-git",
  ".editorconfig": "vscode-icons:file-type-editorconfig",
  "readme.md": "vscode-icons:file-type-info",
  license: "vscode-icons:file-type-license",
  "license.md": "vscode-icons:file-type-license",
};

const DEFAULT_FILE_ICON = "vscode-icons:default-file";
const FOLDER_ICON = "vscode-icons:default-folder";
const FOLDER_OPEN_ICON = "vscode-icons:default-folder-opened";

function resolveFileIcon(name: string): string {
  const lower = name.toLowerCase();
  const special = SPECIAL_NAMES[lower];
  if (special) return special;

  const dot = lower.lastIndexOf(".");
  if (dot === -1) return DEFAULT_FILE_ICON;
  const ext = lower.slice(dot + 1);
  return EXT_TO_ICON[ext] ?? DEFAULT_FILE_ICON;
}

export interface FileIconProps {
  name: string;
  type: "file" | "directory";
  expanded?: boolean;
}

/**
 * Colored per-type icon for a file or directory, backed by the
 * `vscode-icons` collection on Iconify. For the full list of available
 * icons see https://icon-sets.iconify.design/vscode-icons/ .
 */
export function FileIcon({ name, type, expanded }: FileIconProps): ReactElement {
  const iconName =
    type === "directory" ? (expanded ? FOLDER_OPEN_ICON : FOLDER_ICON) : resolveFileIcon(name);

  return (
    <Icon
      icon={iconName}
      width="14"
      height="14"
      data-agent-ui="file-tree-icon"
      aria-hidden="true"
    />
  );
}
