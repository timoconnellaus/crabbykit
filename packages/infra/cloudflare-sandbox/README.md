# @claw-for-cloudflare/cloudflare-sandbox

Sandbox provider for Cloudflare Containers. Provides controlled shell execution, file operations, and process management inside a container DO.

## Container Image Rebuild

The Dockerfile vendors workspace packages that need to be available inside the container at runtime. When these packages change, the container image must be rebuilt.

### Vendored packages

| Path in container | Source | Purpose |
|-------------------|--------|---------|
| `/usr/local/lib/claw-vite-plugin/` | `container/claw-vite-plugin/` (prebuilt blob) | Vite plugin for vibe-coded apps |
| `/usr/local/lib/claw-container-db/` | `packages/container-db/src/index.ts` | DB client for container apps |
| `/opt/claw-sdk/agent-bundle/` | `packages/agent-bundle/src/bundle/` | Bundle authoring API (`defineBundleAgent`) |
| `/opt/claw-sdk/tavily-client/` | `packages/tavily-web-search/src/{client,schemas}.ts` | Tavily bundle-side client |

### When to rebuild

Rebuild the container image when:
- Any file in `packages/agent-bundle/src/bundle/` changes
- `packages/tavily-web-search/src/client.ts` or `src/schemas.ts` changes
- `packages/container-db/src/index.ts` changes
- `container/claw-vite-plugin/` contents change
- The Dockerfile itself changes

### How to rebuild

The image is built automatically by wrangler when deploying or running `wrangler dev` with the `containers` config. The build context is the repo root (configured via `image_build_context: "../../"` in wrangler.jsonc).

```bash
# Local dev — wrangler rebuilds automatically
cd examples/basic-agent && bun dev

# Manual rebuild (if needed)
docker build -f packages/cloudflare-sandbox/container/Dockerfile -t claw-sandbox .
```

### Integrity verification

`/opt/claw-sdk/INTEGRITY.json` contains SHA-256 hashes of every vendored file, generated at image build time. `workshop_build` verifies this manifest before running `bun build` to detect tampering by adversarial bundle code.

The vendored SDK at `/opt/claw-sdk/` is mounted read-only (`chmod -R a-w`) to prevent modification at runtime.

### Security: what's vendored vs. excluded

Only bundle-side subpaths are vendored — never host-side WorkerEntrypoint classes:

- **Included**: `defineBundleAgent`, bundle types, `tavilyClient`, shared schemas
- **Excluded**: `SpineService`, `LlmService`, `TavilyService`, capability token minting, registry internals
