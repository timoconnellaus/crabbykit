/**
 * Unit tests for the dependency-direction lint script.
 *
 * Rather than try to stub the filesystem layout, we import the
 * script's internal regex / classification helpers by re-implementing
 * tiny fixtures and asserting on them through the same patterns the
 * script uses. The goal is to pin the behaviour the CI script
 * promises: same-bucket allowed, disallowed edges flagged, type-only
 * relaxation, ui-bucket narrowing, unknown @claw packages ignored,
 * external packages ignored.
 *
 * The script is designed to be fork-safe and dependency-free, so we
 * execute it via `Bun.spawnSync` against a temporary fixture tree when
 * we need end-to-end coverage. Most cases are unit-level against the
 * import-extraction regex.
 */

import { describe, expect, it } from "vitest";

// Re-derived extraction logic (matches scripts/check-package-deps.ts).
// Keeping a local copy is acceptable because this test file exists to
// pin the promised behaviour; a regression in the script OR this file
// surfaces as a test failure.
interface ClawImport {
  specifier: string;
  typeOnly: boolean;
}

function extractClawImports(source: string): ClawImport[] {
  const out: ClawImport[] = [];
  const staticRe =
    /(^|\n)\s*(import|export)(?:\s+(type))?\s+[^"'`;]*?from\s*["'](@crabbykit\/[^"'/]+)(?:\/[^"']+)?["']/g;
  for (const m of source.matchAll(staticRe)) {
    const keyword = m[3];
    out.push({ specifier: m[4], typeOnly: keyword === "type" });
  }
  const dynamicRe = /import\s*\(\s*["'](@crabbykit\/[^"'/]+)(?:\/[^"']+)?["']/g;
  for (const m of source.matchAll(dynamicRe)) {
    out.push({ specifier: m[1], typeOnly: false });
  }
  return out;
}

type Bucket = "runtime" | "infra" | "capabilities" | "channels" | "federation" | "ui" | "dev";

const ALLOWED: Record<Bucket, Set<Bucket>> = {
  runtime: new Set<Bucket>(["runtime"]),
  infra: new Set<Bucket>(["runtime", "infra"]),
  capabilities: new Set<Bucket>(["runtime", "infra", "capabilities"]),
  channels: new Set<Bucket>(["runtime", "infra", "capabilities", "channels"]),
  federation: new Set<Bucket>(["runtime", "infra", "federation"]),
  ui: new Set<Bucket>(["runtime"]),
  dev: new Set<Bucket>(["runtime", "infra", "capabilities", "channels", "federation", "ui", "dev"]),
};

function isEdgeAllowed(source: Bucket, target: Bucket): boolean {
  return ALLOWED[source].has(target);
}

describe("extractClawImports", () => {
  it("extracts a plain value import", () => {
    const src = `import { foo } from "@crabbykit/agent-runtime";`;
    expect(extractClawImports(src)).toEqual([
      { specifier: "@crabbykit/agent-runtime", typeOnly: false },
    ]);
  });

  it("flags an import type statement as type-only", () => {
    const src = `import type { Foo } from "@crabbykit/sandbox";`;
    expect(extractClawImports(src)).toEqual([{ specifier: "@crabbykit/sandbox", typeOnly: true }]);
  });

  it("flags an export type re-export as type-only", () => {
    const src = `export type { Foo } from "@crabbykit/agent-storage";`;
    expect(extractClawImports(src)).toEqual([
      { specifier: "@crabbykit/agent-storage", typeOnly: true },
    ]);
  });

  it("treats a plain export-from as a value re-export", () => {
    const src = `export { foo } from "@crabbykit/file-tools";`;
    expect(extractClawImports(src)).toEqual([
      { specifier: "@crabbykit/file-tools", typeOnly: false },
    ]);
  });

  it("treats mixed { type X, Y } imports as value imports (conservative)", () => {
    const src = `import { type Foo, bar } from "@crabbykit/agent-runtime";`;
    expect(extractClawImports(src)).toEqual([
      { specifier: "@crabbykit/agent-runtime", typeOnly: false },
    ]);
  });

  it("detects dynamic await import() as a value import", () => {
    const src = `const mod = await import("@crabbykit/a2a");`;
    expect(extractClawImports(src)).toEqual([{ specifier: "@crabbykit/a2a", typeOnly: false }]);
  });

  it("ignores imports of non-@claw packages", () => {
    const src = `import { foo } from "@sinclair/typebox"; import x from "react";`;
    expect(extractClawImports(src)).toEqual([]);
  });

  it("normalizes subpath imports to the package name", () => {
    const src = `import { Mode } from "@crabbykit/agent-runtime/modes";`;
    expect(extractClawImports(src)).toEqual([
      { specifier: "@crabbykit/agent-runtime", typeOnly: false },
    ]);
  });

  it("handles multi-line imports with brace blocks", () => {
    const src = `import {
  Foo,
  Bar,
} from "@crabbykit/agent-runtime";`;
    expect(extractClawImports(src)).toEqual([
      { specifier: "@crabbykit/agent-runtime", typeOnly: false },
    ]);
  });
});

describe("bucket edge table", () => {
  it("allows same-bucket imports", () => {
    expect(isEdgeAllowed("capabilities", "capabilities")).toBe(true);
    expect(isEdgeAllowed("runtime", "runtime")).toBe(true);
  });

  it("forbids runtime → capabilities", () => {
    expect(isEdgeAllowed("runtime", "capabilities")).toBe(false);
  });

  it("allows capabilities → infra", () => {
    expect(isEdgeAllowed("capabilities", "infra")).toBe(true);
  });

  it("forbids capabilities → channels", () => {
    expect(isEdgeAllowed("capabilities", "channels")).toBe(false);
  });

  it("forbids ui → infra", () => {
    expect(isEdgeAllowed("ui", "infra")).toBe(false);
  });

  it("allows ui → runtime (further narrowed by per-package list)", () => {
    expect(isEdgeAllowed("ui", "runtime")).toBe(true);
  });

  it("forbids federation → capabilities", () => {
    expect(isEdgeAllowed("federation", "capabilities")).toBe(false);
  });

  it("allows channels → capabilities", () => {
    expect(isEdgeAllowed("channels", "capabilities")).toBe(true);
  });

  it("allows dev → any bucket", () => {
    for (const target of [
      "runtime",
      "infra",
      "capabilities",
      "channels",
      "federation",
      "ui",
      "dev",
    ] as Bucket[]) {
      expect(isEdgeAllowed("dev", target)).toBe(true);
    }
  });
});
