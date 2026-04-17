## Why

`packages/` has grown to 37 packages with no organizing principle beyond alphabetical. A reader opening the repo cannot tell which packages are the platform engine, which are infrastructure providers that hold native Cloudflare bindings, which are brain-facing tools, which are input channels, and which are federation/multi-agent concerns. Every package looks the same from the outside, and the mental model for "what does this thing do?" has to be reconstructed from source every time.

This becomes a real drag in three places:
1. **Onboarding and navigation.** New contributors (human or agent) cannot orient themselves without reading CLAUDE.md front-to-back. The flat layout forces alphabetical scanning over structural reasoning.
2. **Dependency direction is un-enforced.** The core runtime should not import from capabilities; capabilities should not import from channels; ui should not import server-side infra. Today these rules live in people's heads. Nothing catches a wrong-direction import until it causes a refactor to fail.
3. **Name collisions tell lies.** `r2-storage` sounds like an R2 provider but is actually "file tools that happen to use R2" — the R2 *identity* lives in `agent-storage`. The name is wrong enough to confuse every reader who encounters it.

This change reorganizes `packages/` into six role-based buckets, renames the two packages whose names mislead, and adds a CI rule enforcing the dependency direction the buckets imply. It is a pure structural refactor — zero runtime behavior changes, zero package name changes except the two renames, zero API changes.

It is deliberately scoped narrow. A follow-up proposal (`split-agent-bundle-host-and-sdk`) splits the `agent-bundle` package into its two internal halves; that is a separate concern and ships on its own timeline.

## What Changes

- **Reorganize `packages/` into six role-based buckets.** The flat list becomes:
  - `packages/runtime/` — the engine and bundle system plumbing. `agent-runtime`, `agent-core`, `ai`, `ai-proxy`, `agent-bundle`, `bundle-registry`, `agent-workshop`.
  - `packages/infra/` — native-binding-holding, deploy-time-wired providers. `agent-storage`, `agent-auth`, `credential-store`, `skill-registry`, `agent-registry`, `app-registry`, `container-db`, `cloudflare-sandbox`.
  - `packages/capabilities/` — brain-facing tools and hooks. `tavily-web-search`, `file-tools` (renamed from `r2-storage`), `vector-memory`, `browserbase`, `skills`, `prompt-scheduler`, `task-tracker`, `sandbox`, `vibe-coder`, `batch-tool`, `subagent`, `subagent-explorer`, `doom-loop-detection`, `tool-output-truncation`, `compaction-summary`, `heartbeat`.
  - `packages/channels/` — input surfaces. `channel-telegram`.
  - `packages/federation/` — multi-agent coordination. `a2a`, `agent-fleet`, `agent-peering`.
  - `packages/ui/` — client-side React. `agent-ui`.
  - `packages/dev/` — build/dev tooling. `vite-plugin`.
- **Package directories move; package names do not change.** Every `@claw-for-cloudflare/*` identifier stays identical. Import paths in consumer code are untouched. Only the filesystem location of each package directory changes. Bun's workspace glob becomes `packages/*/*` instead of `packages/*`.
- **Rename `r2-storage` → `file-tools`.** The current name describes its storage substrate, not its purpose. The capability is "nine file tools that happen to be backed by R2". The R2 bucket identity already has a home in `agent-storage`, which is the real "R2 storage" package. Renaming frees the `r2-*` namespace for future substrate packages and removes a persistent name-lie. The package's public API (`r2Storage({ storage })` factory function) is renamed to `fileTools({ storage })`. Existing consumers update two imports each.
- **Add a dependency-direction lint rule.** A CI check (plain `grep`-based script or Biome custom rule) fails the build if:
  - Any file in `packages/runtime/*` imports from `@claw-for-cloudflare/*` packages that live in `packages/capabilities/*`, `packages/channels/*`, `packages/federation/*`, or `packages/ui/*`.
  - Any file in `packages/infra/*` imports from `packages/capabilities/*`, `packages/channels/*`, or `packages/federation/*`.
  - Any file in `packages/capabilities/*` imports from `packages/channels/*`.
  - Any file in `packages/ui/*` imports server-side runtime internals (only transport types are allowed).
- **Update CLAUDE.md.** Replace the current flat package list with the role-bucketed list. Add a one-paragraph "Workspace layout" section describing the six buckets and the dependency direction rules. Every other section stays identical.
- **Update workspace glob and tsconfig references.** `package.json` workspaces field becomes `"packages/*/*"`. Root `tsconfig.json` `references` entries update to the new paths. Individual package `tsconfig.json` files update their `extends` and `references` paths.
- **Update Biome config.** `biome.json` file globs update to reflect the new depth. No rule changes.
- **Move examples and e2e ABOVE `packages/`**, not inside it. `examples/` and `e2e/` stay at the repo root as they do today.

## Capabilities

### New Capabilities

- `workspace-layout`: the structural convention describing the six role-based package buckets, the role each bucket encodes, the dependency direction rules between buckets, and the CI enforcement mechanism. Lives as spec only — it's a repo convention, not a runtime artifact. Any future package introduction must declare which bucket it belongs to; any future proposal that moves a package between buckets must update this spec.

### Modified Capabilities

None. This change is purely structural. No runtime capability's behavior, API, or contract changes.

The `r2-storage` → `file-tools` rename changes one capability's package name and factory function name but not its tool schemas, its behavior, or its runtime surface. Existing capability specs that mention `r2-storage` by name (if any) will be updated in this change's spec deltas for consistency.

## Impact

- **Package directories move**: every `packages/<name>/` path becomes `packages/<bucket>/<name>/`. ~37 directory moves. Scripted via `git mv` to preserve history.
- **Two packages renamed**:
  - `packages/r2-storage/` → `packages/capabilities/file-tools/`
  - Package name `@claw-for-cloudflare/r2-storage` → `@claw-for-cloudflare/file-tools`
  - Factory function `r2Storage()` → `fileTools()`
  - Consumer code in `examples/basic-agent`, any other internal consumers, and CLAUDE.md's examples all update to the new name
- **Workspace glob update**: `package.json` `workspaces: ["packages/*"]` → `["packages/*/*"]`. Examples and e2e stay at their current root paths.
- **CI gains a dependency-direction check**: a new script at `scripts/check-deps.ts` (or similar) runs during `bun run lint` and in CI. Walks every `src/**/*.ts` file in `packages/`, parses imports, and fails if any import crosses a forbidden bucket boundary. No runtime impact; build-time only.
- **CLAUDE.md updated**: the "## Packages" section is rewritten to show packages grouped by bucket. The "## Architecture Rules" section gains a new "### Workspace layout" subsection describing the dependency direction rules and pointing at the `workspace-layout` spec.
- **No behavior changes**: every existing example, every existing test, every existing wrangler binding, every existing deployed agent continues to work. This is a structural refactor with a rename.
- **No breaking changes for external consumers**: `@claw-for-cloudflare/r2-storage` is renamed to `@claw-for-cloudflare/file-tools`. This is the only breaking change in this proposal; it is deliberate because the old name actively misleads. No deprecation alias — the repo is pre-release and greenfield; legacy shims are not introduced. Internal consumers update as part of this change.
- **Out of scope**:
  - Splitting `agent-bundle` into its host and SDK halves — deferred to the `split-agent-bundle-host-and-sdk` proposal which depends on this one having landed.
  - Documenting the three-tier (infra / brain / config) capability model as a reference spec — deferred to a later `document-three-tier-capability-model` spec-only proposal if/when it becomes load-bearing.
  - Renaming to `@crabbykit/*` scope — mechanical rename, separate concern, deferred.
  - Extracting interfaces for portability to non-Cloudflare substrates — deferred indefinitely. This proposal assumes Cloudflare-only and organizes accordingly.
  - Any capability rename other than `r2-storage` → `file-tools`. Other packages (`agent-storage`, `vector-memory`, etc.) keep their current names even if arguably improvable, because the cost of additional renames exceeds the value in this proposal's scope.
- **Approval gate**: this proposal must land before `split-agent-bundle-host-and-sdk` begins, because the latter places its new packages inside the `packages/runtime/` bucket this proposal creates.
