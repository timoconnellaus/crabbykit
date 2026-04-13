# Phase 0 Spike Results

## Spike 0.A: pi-agent-core import inside Worker Loader isolate

**Result: GREEN**

### Approach
- Created `spike/pi-import/` with a minimal worker hosting a `SpikeAgent` DO
- Bundle source (`bundle-src/index.ts`) imports `Agent` from `@claw-for-cloudflare/agent-core`, `getModel` from `@claw-for-cloudflare/ai`, and `defineTool` from `@claw-for-cloudflare/agent-runtime`
- Compiled via `bun build --target=browser --format=esm --external "cloudflare:workers" --external "cloudflare:sockets"`
- Host DO loads compiled bundle via `LOADER.get(cacheKey, factory)` and invokes `worker.getEntrypoint().fetch()`

### Findings
- **All imports resolved successfully** inside the Worker Loader isolate
- `Agent` (pi-agent-core): `typeof === "function"`, `constructable === true`
- `getModel` (pi-ai): `typeof === "function"`
- `defineTool` (agent-runtime): `typeof === "function"`
- **`partial-json` CJS issue**: bun build's `__commonJS` shim wraps the CJS module into ESM, completely bypassing the issue that requires the `loadPiSdk()` workaround in the Workers test pool
- No upstream fixes required
- Bundle compiles in ~35ms

### Key insight
The `partial-json` CJS issue only manifests when Workers runtime tries to load CJS modules directly. When `bun build` pre-compiles everything into a single ESM bundle, the CJS interop is handled at build time by bun's `__commonJS` helper. The loader isolate receives a pure ESM module and never encounters CJS resolution.

### Required externals
`cloudflare:workers` and `cloudflare:sockets` must be externalized — they're provided by the Workers runtime, not bundled.

---

## Spike 0.B: Cold-start latency baseline

**Result: GREEN**

### Bundle sizes

| Bundle | Modules | Build time | Size |
|--------|---------|-----------|------|
| Minimal (core + ai + runtime) | 642 | 35ms | 1,774,980 bytes (1.73 MB) |
| Representative (+ compaction, prompt-scheduler, tavily) | 652 | 32ms | 1,799,793 bytes (1.76 MB) |

### Latency (local wrangler dev)

| Metric | First load | Warm cache |
|--------|-----------|------------|
| Load (LOADER.get) | <1ms | <1ms |
| Execution (fetch) | 26ms | <1ms |
| Total | 26ms | <1ms |

### Notes
- Local wrangler dev uses miniflare, so these numbers reflect local overhead, not CF edge
- The representative bundle (1.76 MB) is well under KV's 25 MiB limit
- Adding 3 capabilities only increased bundle size by ~25 KB (1.4%), suggesting most weight is pi-agent-core/pi-ai/agent-runtime shared code
- Cold-start latency is dominated by isolate compilation, not module count
- Phase 2 decision gate (3x static latency) will need measurement on deployed workers

---

## Spike 0.C: Read-only mount feasibility on Cloudflare Containers

**Result: DEFERRED — approach documented, requires container deployment to verify**

### Approach options
1. **Docker `--read-only` mount**: Standard Docker supports read-only volume mounts (`-v /opt/claw-sdk:/opt/claw-sdk:ro`). Cloudflare Containers use Docker images, so this should work.
2. **Filesystem-level immutability**: `chattr +i` or `chmod` after COPY in Dockerfile — simpler, works regardless of mount semantics.
3. **Fallback**: If read-only mount isn't achievable, per-build integrity verification via SHA-256 manifest (accept smaller TOCTOU window per design doc).

### Recommendation
Option 2 (filesystem immutability at image build time) is the most portable and doesn't depend on Cloudflare Containers supporting Docker mount flags. The Dockerfile would:
```dockerfile
COPY claw-sdk/ /opt/claw-sdk/
RUN chmod -R a-w /opt/claw-sdk/
```

Actual verification deferred to Phase 5 implementation when container access is available.

---

## Decision Checkpoint

| Spike | Result | Proceed? |
|-------|--------|----------|
| 0.A: pi-agent-core in loader | GREEN | Yes |
| 0.B: Cold-start baseline | GREEN | Yes |
| 0.C: Read-only mount | DEFERRED | Yes (fallback documented) |

**Recommendation: Proceed to Phase 1.**
