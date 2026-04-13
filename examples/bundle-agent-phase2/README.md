# Bundle Agent — Phase 2 Demo

Demonstrates the bundle brain override: a `defineAgent`-produced DO that can
dispatch turns into a pre-compiled bundle loaded via Worker Loader, with
automatic fallback to the static brain.

## Setup

```bash
# From repo root
bun install

# Compile the test bundle
bun build examples/bundle-agent-phase2/bundle-src/index.ts \
  --target=browser --format=esm \
  --outfile=examples/bundle-agent-phase2/dist/test.bundle.js \
  --external "cloudflare:workers" --external "cloudflare:sockets"

# Start dev server
cd examples/bundle-agent-phase2 && npx wrangler dev --port 8788
```

## Demo Flow

```bash
# 1. Prompt without bundle — static brain handles the turn
curl -X POST http://localhost:8788/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "hello"}'

# 2. Register the bundle as active
curl -X POST http://localhost:8788/seed-bundle

# 3. Prompt with bundle active — bundle brain handles the turn
curl -X POST http://localhost:8788/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "hello from bundle"}'

# 4. Disable bundle — revert to static brain
curl -X POST http://localhost:8788/disable

# 5. Check deployment history
curl http://localhost:8788/status
```

## Architecture

- `src/server.ts` — Uses `defineAgent` with the optional `bundle` config field
- `bundle-src/index.ts` — Uses `defineBundleAgent` to create a bundle brain
- `dist/test.bundle.js` — Pre-compiled bundle loaded via Worker Loader
- Uses `InMemoryBundleRegistry` (in production, this would be `D1BundleRegistry`)

## What This Validates

- `defineAgent` with `bundle` config produces a working DO
- Static brain runs when no bundle is active
- Bundle dispatch intercepts `handlePrompt` when a bundle is registered
- Bundle is loaded via `LOADER.get()` with content-addressed cache key
- Auto-revert to static brain after consecutive load failures
- `POST /bundle/disable` clears the active pointer
- `POST /bundle/refresh` refreshes the cached pointer
- Registry tracks deployments with rationale
