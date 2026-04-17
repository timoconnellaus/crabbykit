## 1. Phase 1 — Create target layout (no moves yet)

- [x] 1.1 Create empty directories: `packages/runtime/`, `packages/infra/`, `packages/capabilities/`, `packages/channels/`, `packages/federation/`, `packages/ui/`, `packages/dev/` (each with a `.gitkeep` to commit the empty dir)
- [x] 1.2 Update root `package.json` `workspaces` from `["packages/*"]` to `["packages/*/*"]` — also keeping whatever non-packages globs (`examples/*`, `e2e/*`) already exist
- [x] 1.3 Run `bun install` and verify no existing packages are dropped from the workspace (the new glob still matches none of the current flat packages yet — they'll be matched after step 2 moves them)
- [x] 1.4 Commit: "chore: scaffold role-based packages/ layout"

## 2. Phase 2 — Move packages into buckets (git mv, no renames)

### 2A. Runtime bucket

- [x] 2.1 `git mv packages/agent-runtime packages/runtime/agent-runtime`
- [x] 2.2 `git mv packages/agent-core packages/runtime/agent-core`
- [x] 2.3 `git mv packages/ai packages/runtime/ai`
- [x] 2.4 `git mv packages/ai-proxy packages/runtime/ai-proxy`
- [x] 2.5 `git mv packages/agent-bundle packages/runtime/agent-bundle`
- [x] 2.6 `git mv packages/bundle-registry packages/runtime/bundle-registry`
- [x] 2.7 `git mv packages/agent-workshop packages/runtime/agent-workshop`

### 2B. Infra bucket

- [x] 2.8 `git mv packages/agent-storage packages/infra/agent-storage`
- [x] 2.9 `git mv packages/agent-auth packages/infra/agent-auth`
- [x] 2.10 `git mv packages/credential-store packages/infra/credential-store`
- [x] 2.11 `git mv packages/skill-registry packages/infra/skill-registry`
- [x] 2.12 `git mv packages/agent-registry packages/infra/agent-registry`
- [x] 2.13 `git mv packages/app-registry packages/infra/app-registry`
- [x] 2.14 `git mv packages/container-db packages/infra/container-db`
- [x] 2.15 `git mv packages/cloudflare-sandbox packages/infra/cloudflare-sandbox`

### 2C. Capabilities bucket

- [x] 2.16 `git mv packages/tavily-web-search packages/capabilities/tavily-web-search`
- [x] 2.17 `git mv packages/r2-storage packages/capabilities/r2-storage` — still the old name at this step; rename happens in Phase 4
- [x] 2.18 `git mv packages/vector-memory packages/capabilities/vector-memory`
- [x] 2.19 `git mv packages/browserbase packages/capabilities/browserbase`
- [x] 2.20 `git mv packages/skills packages/capabilities/skills`
- [x] 2.21 `git mv packages/prompt-scheduler packages/capabilities/prompt-scheduler`
- [x] 2.22 `git mv packages/task-tracker packages/capabilities/task-tracker`
- [x] 2.23 `git mv packages/sandbox packages/capabilities/sandbox`
- [x] 2.24 `git mv packages/vibe-coder packages/capabilities/vibe-coder`
- [x] 2.25 `git mv packages/batch-tool packages/capabilities/batch-tool`
- [x] 2.26 `git mv packages/subagent packages/capabilities/subagent`
- [x] 2.27 `git mv packages/subagent-explorer packages/capabilities/subagent-explorer`
- [x] 2.28 `git mv packages/doom-loop-detection packages/capabilities/doom-loop-detection`
- [x] 2.29 `git mv packages/tool-output-truncation packages/capabilities/tool-output-truncation`
- [x] 2.30 `git mv packages/compaction-summary packages/capabilities/compaction-summary`
- [x] 2.31 `git mv packages/heartbeat packages/capabilities/heartbeat`

### 2D. Channels, federation, ui, dev buckets

- [x] 2.32 `git mv packages/channel-telegram packages/channels/channel-telegram`
- [x] 2.33 `git mv packages/a2a packages/federation/a2a`
- [x] 2.34 `git mv packages/agent-fleet packages/federation/agent-fleet`
- [x] 2.35 `git mv packages/agent-peering packages/federation/agent-peering`
- [x] 2.36 `git mv packages/agent-ui packages/ui/agent-ui`
- [x] 2.37 `git mv packages/vite-plugin packages/dev/vite-plugin`

### 2E. Verify move

- [x] 2.38 Run `ls packages/` — confirm only the seven bucket directories plus whatever was previously there (examples, e2e should not be in packages/ — audit and correct if so)
- [x] 2.39 Run `bun install` — confirm every package is picked up by the new workspace glob (count matches 37)
- [x] 2.40 Run `bun run typecheck` at repo root — expect it to PASS (package names haven't changed, only directories)
- [x] 2.41 Run `bun run test` at repo root — expect it to PASS
- [x] 2.42 Commit: "refactor(packages): reorganize into role-based buckets"

## 3. Phase 3 — Update tsconfig references and tooling paths

- [x] 3.1 Update root `tsconfig.json` `references` entries from `packages/<name>` to `packages/<bucket>/<name>`
- [x] 3.2 Update each package's `tsconfig.json` `extends` path (`"../../tsconfig.base.json"` → `"../../../tsconfig.base.json"` if base moves require it; more commonly just verify the path depth)
- [x] 3.3 Update each package's `tsconfig.json` `references` entries that point to sibling packages — depth changes from `../../<name>` to `../../<other-bucket>/<name>` or `../<name>` for same-bucket siblings
- [x] 3.4 Update `biome.json` `files.includes` globs if they hardcode `packages/*/src` — change to `packages/*/*/src`
- [x] 3.5 Update any `vitest.config.ts` or `vitest.*.config.ts` files with hardcoded package paths
- [x] 3.6 Update `scripts/` directory contents (if any) that walk `packages/*`
- [x] 3.7 Run `bun run typecheck` — expect PASS after all references are updated
- [x] 3.8 Commit: "chore(tsconfig): update project references for bucketed layout"

## 4. Phase 4 — Rename r2-storage to file-tools

- [x] 4.1 `git mv packages/capabilities/r2-storage packages/capabilities/file-tools`
- [x] 4.2 Update `packages/capabilities/file-tools/package.json`: `"name": "@claw-for-cloudflare/r2-storage"` → `"name": "@claw-for-cloudflare/file-tools"`
- [x] 4.3 Update `packages/capabilities/file-tools/src/capability.ts`: rename the factory function `r2Storage` → `fileTools`, rename the options type `R2StorageOptions` → `FileToolsOptions`, update the capability `id` from `"r2-storage"` to `"file-tools"`, update the capability `name` and `description` to match
- [x] 4.4 Update `packages/capabilities/file-tools/src/index.ts` re-exports (`r2Storage` → `fileTools`, `R2StorageOptions` → `FileToolsOptions`)
- [x] 4.5 Grep the repo for remaining uses of `@claw-for-cloudflare/r2-storage` and replace with `@claw-for-cloudflare/file-tools`
- [x] 4.6 Grep the repo for remaining uses of `r2Storage(` and replace with `fileTools(`
- [x] 4.7 Grep the repo for remaining uses of `R2StorageOptions` and replace with `FileToolsOptions`
- [x] 4.8 Update `examples/basic-agent` capability wiring to use `fileTools`
- [x] 4.9 Update any e2e test that uses `r2Storage`
- [x] 4.10 Update any session-entry capability-id references in tests — the id changes from `"r2-storage"` to `"file-tools"`, so any test that asserts on the id needs updating
- [x] 4.11 Run `bun run typecheck` — expect PASS
- [x] 4.12 Run `bun run test` — expect PASS
- [x] 4.13 Run `bun run lint` — expect PASS
- [x] 4.14 Commit: "refactor(file-tools): rename r2-storage → file-tools"

## 5. Phase 5 — Dependency-direction CI check

- [x] 5.1 Create `scripts/check-package-deps.ts` — a plain TypeScript script (run via `bun scripts/check-package-deps.ts`)
- [x] 5.2 Implement: walk `packages/*/*/src/**/*.{ts,tsx}` and `packages/*/*/test/**/*.{ts,tsx}` (tests can be excluded if they legitimately cross-cut, but default to enforcing on tests too), parse each file's top-level import statements with a regex matching `from\s+["']@claw-for-cloudflare/([^"']+)["']`
- [x] 5.3 Build a map of package name → bucket (derived from the filesystem location of each `packages/<bucket>/<name>/package.json`)
- [x] 5.4 For each import, resolve source package (from file path) and target package (from import specifier) to their buckets; check the pair against the allowed-direction table
- [x] 5.5 Encode the allowed-direction table as a constant at the top of the script — source bucket → set of allowed target buckets. Include self-imports within a bucket as always allowed.
- [x] 5.6 On violation: print source file, source bucket, import specifier, target bucket, and the specific rule violated; exit with code 1
- [x] 5.7 On success: exit 0, print no output (or a one-line summary with count of files scanned and imports checked)
- [x] 5.8 Add unit tests for the script itself covering: same-bucket allowed, runtime → capabilities disallowed, capabilities → infra allowed, capabilities → channels disallowed, ui → runtime disallowed, unknown package import ignored (external deps)
- [x] 5.9 Wire into `bun run lint` — add to the `lint` script in root `package.json` so it runs alongside `biome check`
- [x] 5.10 Run `bun run lint` — expect PASS if the current repo already satisfies the rules; if it fails, the failure is a pre-existing architectural violation to investigate (NOT a bug in this script)
- [x] 5.11 If pre-existing violations exist: audit them, determine whether they are bugs (fix) or whether the rule is too strict (relax the rule or add an exception list documented in the script)
- [x] 5.12 Add CI invocation if not already covered by `lint` — confirm in `.github/workflows/*` or equivalent
- [x] 5.13 Commit: "build: enforce package dependency direction in CI"

## 6. Phase 6 — Documentation

- [x] 6.1 Update `CLAUDE.md` "## Packages" section — replace the flat list with a bucketed list matching the new layout
- [x] 6.2 Update `CLAUDE.md` "## Architecture Rules" — add a new "### Workspace layout" subsection describing the six buckets, their roles, and the dependency direction invariants
- [x] 6.3 Update `README.md` packages table — match the new bucketed structure
- [x] 6.4 Update `README.md` any example code that imports from `@claw-for-cloudflare/r2-storage` → `file-tools`
- [x] 6.5 Search repo for any other markdown files (`docs/`, per-package READMEs) referencing the old flat layout or the old `r2-storage` name, update where necessary
- [x] 6.6 Commit: "docs: update workspace layout and file-tools rename references"

## 7. Phase 7 — Final verification

- [x] 7.1 `bun install` — clean state
- [x] 7.2 `bun run typecheck` — PASS
- [x] 7.3 `bun run lint` — PASS (includes dependency-direction check)
- [x] 7.4 `bun run test` — PASS
- [x] 7.5 `cd examples/basic-agent && bun run typecheck` — PASS
- [x] 7.6 `cd e2e/agent-runtime && bun test` — PASS
- [x] 7.7 Spot-check: open `CLAUDE.md`, verify the packages section matches the new layout
- [x] 7.8 Spot-check: `ls packages/` returns the seven bucket directories and nothing else (aside from whatever root files exist)
- [x] 7.9 Spot-check: `grep -r "r2-storage" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.json"` — expect only historical references (git log, archived proposals, this proposal)
