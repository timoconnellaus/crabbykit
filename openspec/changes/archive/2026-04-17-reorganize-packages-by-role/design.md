## Why this layout and not another

Three layouts were considered:

1. **Flat with prefix** — keep `packages/` flat, prefix substrate-locked packages with their provider (`cloudflare-bundle-registry`, `cloudflare-skill-registry`, etc.). Rejected: prefixes become noise in a Cloudflare-only repo, and the role distinction (engine vs. infra vs. capability) is still invisible.
2. **Split by tier** — separate folders for tier 1 (infra), tier 2 (brain), tier 3 (config). Rejected: most packages span multiple tiers (tavily has a tier-1 service, a tier-2 client, and tier-3 config defaults). Organizing by tier would split every non-trivial package across folders, which is worse than the current flat layout.
3. **Split by role** — the chosen approach. Each package has one primary role even if it touches multiple tiers. A capability package like `tavily-web-search` lives entirely in `capabilities/` even though it has both infra (service.ts) and brain (client.ts) halves; the 4-subpath pattern inside the package handles the tier split.

The chosen buckets correspond to questions a reader actually asks:
- "What runs the agent?" → `runtime/`
- "What holds the native bindings and secrets?" → `infra/`
- "What tools can the brain call?" → `capabilities/`
- "How do messages get into agents?" → `channels/`
- "How do agents talk to each other?" → `federation/`
- "What does the user see in the browser?" → `ui/`
- "What's build-time tooling?" → `dev/`

Every package answers exactly one of these questions as its primary role. Packages that arguably answer two (e.g. `agent-workshop` is a "capability" but sits next to bundle infra) are placed in the bucket matching their dominant role — workshop is a capability, but it's adjacent enough to `agent-bundle` and `bundle-registry` that grouping it under `runtime/` keeps the bundle story together. This is a judgment call and can be revisited.

## Dependency direction rules

```
ui/  →  (nothing server-side except transport types)

runtime/  →  runtime/
runtime/  ↛  capabilities/, channels/, federation/, ui/, dev/

infra/    →  runtime/, infra/
infra/    ↛  capabilities/, channels/, federation/, ui/, dev/

capabilities/  →  runtime/, infra/, capabilities/
capabilities/  ↛  channels/, federation/, ui/, dev/

channels/      →  runtime/, infra/, capabilities/, channels/
channels/      ↛  federation/, ui/, dev/

federation/    →  runtime/, infra/, federation/
federation/    ↛  capabilities/, channels/, ui/, dev/

dev/      →  (whatever — build-time only)
```

The central invariant: **`runtime/` does not know what a capability is.** The runtime loads capabilities by interface; it does not import any specific one. This is already true in the code today — it just isn't enforced. This proposal makes the invariant visible and un-violate-able.

A secondary invariant: **`federation/` and `capabilities/` are peers, not dependents.** Federation code (a2a, fleet, peering) orchestrates agents but does not import tool capabilities. A capability that wanted to call into federation would be solving a design smell.

## Why `agent-workshop` goes in `runtime/` and not `capabilities/`

`agent-workshop` exposes tools to the brain (`workshop_init`, `workshop_build`, `workshop_deploy`, etc.). By the "exposes tools → capability" heuristic, it belongs in `capabilities/`.

Counter-argument: it is tightly coupled to the bundle system. Its tools operate on `bundle-registry`, invoke the host dispatcher, and care about HKDF token minting. Grouping it with `agent-bundle` and `bundle-registry` under `runtime/` keeps the entire bundle story in one place — a reader exploring "how do bundles work?" finds the SDK, the host, the registry, and the workshop tools all in the same folder.

Decision: put it in `runtime/`. The "bundle cluster" cohesion outweighs the "it's a capability" taxonomic purity. If a second bundle-adjacent capability appears, this decision is reinforced; if not, a future proposal can move it to `capabilities/` with a one-line rationale.

## Why `r2-storage` is renamed but `vector-memory` is not

`r2-storage` and `vector-memory` both sound like they describe a substrate more than a capability. Why rename one and not the other?

`r2-storage` actively lies: it suggests "the package that provides R2 storage", but the package that provides the R2 bucket identity is `agent-storage`. Two packages with the same substrate in their names, both plausibly "the R2 one", is a trap every new reader falls into.

`vector-memory` does not lie. It is the only package in the repo that wraps Vectorize for semantic memory. "Vector memory" describes what it does (semantic memory keyed by vector similarity), not just its backend. A reader who sees the name forms the correct mental model on first read.

The rule: rename if the name causes a name collision or actively misleads. Otherwise, leave it.

`vibe-coder` is a weird name but it is distinctive and unambiguous. `batch-tool` is generic but unique in this repo. `sandbox` and `cloudflare-sandbox` are confusingly close but each is honest about what it is (tool-side vs. provider-side). None of these meet the rename bar.

## Why a CI lint rule and not just a README

A README documenting the dependency direction rules would be ignored the moment someone is in a hurry. A CI lint rule catches the violation before merge, every time, without requiring reviewer vigilance.

The rule is trivially implemented: walk every TypeScript source file under `packages/<bucket>/*/src/**`, extract imports matching `@crabbykit/*`, resolve each import to its bucket, and fail if the cross-bucket direction is disallowed. A 50-line script. No parser more complex than a regex is required because package names are structured.

The rule runs in `bun run lint` and in CI. It is not a Biome plugin (custom Biome plugins are still experimental and overkill here). It is a plain TypeScript script checked in at `scripts/check-package-deps.ts` and invoked from the lint command.

## What breaks, specifically

1. **Bun workspace glob.** `"packages/*"` → `"packages/*/*"`. Also applies to `wrangler.toml`/`wrangler.jsonc` alias blocks if any exist (none do today).
2. **`tsconfig.json` project references.** Every root and per-package `references` array that points into `packages/<name>` updates to `packages/<bucket>/<name>`. Mechanically derivable from the rename map.
3. **Biome glob includes** in `biome.json`. Same mechanical update.
4. **`r2-storage` consumers.** `examples/basic-agent/src/capability-*.ts` and any other internal importers update `@crabbykit/r2-storage` → `@crabbykit/file-tools` and `r2Storage({ storage })` → `fileTools({ storage })`. Find-replace, not hand-editing.
5. **Documentation.** CLAUDE.md package list is rewritten. README.md packages table is rewritten. Any architecture docs that reference `packages/` paths update.
6. **Per-package internal README files** (where they exist). No updates needed — these reference package-local paths, not repo-global ones.

Nothing else breaks. No runtime code, no test code, no wrangler config, no DO class registrations. The DO classes remain `@crabbykit/agent-runtime`, which is still the same package name even though its directory moved.

## Risk

Low. The only places this can fail are:
- A missed import rewrite (caught by `bun run typecheck`).
- A missed workspace glob update (caught by `bun install`).
- A dependency-rule violation introduced by the move itself (caught by the new CI check once it's written).

All three failure modes have fast, obvious detection and immediate fixes. There is no silent breakage path.

The change is also easy to bisect if something does break — the reorg is one commit, the rename is one commit, the CI check is one commit. A failure in CI pinpoints which step introduced it.

## Alternatives considered and rejected

- **Do nothing.** The current flat layout works and every tool chain accepts it. Rejected because the cost of onboarding and reasoning about dependency direction compounds with every new package, and the repo is about to add several more as the shape-2 capability pattern generalizes.
- **Rename to `@crabbykit/*` scope at the same time.** Would save one churn cycle. Rejected because it couples two unrelated mechanical changes (reorg + scope rename) into one proposal, and the scope rename has its own considerations (package registry publication, changelog, announcements) that don't belong here.
- **Organize into finer-grained buckets** — e.g., split `capabilities/` into `capabilities/tools/`, `capabilities/hooks/`, `capabilities/runtime-internal/`. Rejected because 16 packages across 3 sub-buckets is less useful than 16 packages in one bucket — the sub-division invents distinctions that are fuzzy and will need re-litigation for every new capability.
- **Keep `r2-storage` name.** Rejected because every new reader has been bitten by the ambiguity with `agent-storage`, and the rename cost is trivial.
- **Add a deprecation alias package** (`@crabbykit/r2-storage` re-exporting from `@crabbykit/file-tools`). Rejected because the repo is greenfield and CLAUDE.md explicitly forbids legacy compat shims.

## What this proposal deliberately does not decide

- Where future CF-provider split will draw the line. If portability later becomes a goal, this layout is a stepping stone but not a commitment. The `runtime/` bucket will likely be re-split between "substrate-free core" and "Cloudflare-specific runtime" when that time comes. The current proposal does not pre-suppose that split.
- Whether `agent-workshop` should move to `capabilities/` eventually. See "Why agent-workshop goes in runtime/" above. Revisitable.
- How tier 3 (runtime config) should be unified across `ConfigStore` and `CapabilityStorage`. That's a separate architectural question; this proposal just moves packages around.
