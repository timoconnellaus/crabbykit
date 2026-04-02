## Context

The vibe-coder capability currently owns `deploy_app`, which copies build output to R2 and optionally bundles a backend Worker. Deployed apps are served via `handleDeployRequest()` in `deploy-server.ts`, which loads assets from R2, generates an embedded-asset Worker script, and caches it via `WorkerLoader`. Backend API routes are served by loading `bundle.json` from R2 and injecting `DbService` as an environment binding.

This infrastructure works but treats each deploy as a standalone, unnamed artifact. There is no registry, no version lineage, and no transport message to surface apps to clients.

Schedules provide the reference pattern: `ScheduleStore` (SQL), `broadcastScheduleList()`, `schedule_list` transport message, `SET_SCHEDULES` reducer action, `useChat().schedules`, and `toggle_schedule` client message. The app-registry follows this pattern exactly.

## Goals / Non-Goals

**Goals:**
- Named apps with human-readable slugs and meaningful URLs (`/apps/{slug}/`)
- Git-based version history: deploy requires clean working tree, reads HEAD commit hash + message
- Built artifact snapshots per version for instant rollback without rebuilding
- Full schedule-pattern transport pipeline: SQL store, broadcast on connect/change, reducer state, hook exposure
- Client actions: delete app, rollback to version (via transport messages)
- Clean capability split: app-registry owns deployment lifecycle, vibe-coder owns dev experience
- Full compliance with project testing and code quality standards (98% statement coverage, 90% branch coverage, 100% function coverage, 99% line coverage, zero `any` in production, biome clean)

**Non-Goals:**
- Custom domain mapping for deployed apps
- Access control / authentication on deployed app URLs
- App analytics or usage metrics
- CI/CD integration (webhook-triggered deploys)
- Multi-agent app sharing (apps belong to one agent DO)
- Backend-only deploys (apps always have a frontend; backend is optional)

## Decisions

### 1. SQL store in DO SQLite, not capability KV storage

The app registry uses two SQL tables (`apps`, `app_versions`) in the agent DO's SQLite database, accessed through an `AppStore` class modeled on `ScheduleStore`.

**Why not capability KV storage?** The current `deploy:{id}` KV pattern cannot efficiently list all apps, query by slug, or join apps with their versions. SQL gives us indexed lookups by slug, ordered version queries, and atomic multi-table operations.

**Alternative considered:** D1 for cross-DO queries. Rejected because apps belong to a single agent DO and the schedule pattern already proves DO SQLite works for this.

### 2. Git clean-tree gate, not auto-commit on deploy

`deploy_app` requires `git status --porcelain` to return empty before proceeding. It reads `git rev-parse HEAD` for the commit hash and `git log -1 --format=%s` for the version description.

**Why not auto-commit?** The agent already commits as part of its development workflow. Auto-committing on deploy conflates "save my work" with "release this version" and could create commits with no meaningful message. Requiring a clean tree ensures the agent has committed intentionally.

**Why not tag-based?** Git tags add complexity. The commit hash stored in `app_versions` is sufficient to identify the exact code state. The agent can always `git log` to see full history.

### 3. Artifact snapshots per version in R2

Each deploy copies the build output to `/{agentDoId}/apps/{slug}/.deploys/v{N}/`. A `CURRENT` file at `/{agentDoId}/apps/{slug}/.deploys/CURRENT` contains the active version number as plain text.

**Why snapshots over git checkout + rebuild for rollback?** Rollback must work without a running container. Build tooling may change between versions. Snapshots trade storage (small -- built assets are typically <5MB) for reliability and speed.

**Why a `CURRENT` file over symlinks?** FUSE-mounted R2 may not support symlinks reliably. A plain text file is universally safe.

### 4. Worker-level route handler for `/apps/{slug}/`

`handleAppRequest()` is a new function in the app-registry package, called from the consumer's Worker `fetch()` alongside `handleDeployRequest()`. It reads the `CURRENT` file from R2 to resolve slug + version to the deploy path, then delegates to the existing asset-serving internals.

**Why not serve from the DO?** Static file serving should not wake a Durable Object. The Worker can resolve the version via a single R2 read (`CURRENT` file) and serve directly.

**Alternative considered:** DO-based resolution with a cache. More complex, same result. The `CURRENT` file is simpler and already in the serving hot path.

### 5. App-registry owns deploy_app, vibe-coder loses it

Clean capability split. `deploy_app` moves entirely to app-registry. The build + copy + bundle logic from `vibe-coder/src/tools/deploy-app.ts` is extracted into app-registry with the additional git gate, versioning, and SQL registration.

Consumers register both capabilities independently. An agent could use app-registry without vibe-coder (e.g., deploying from R2 files directly).

### 6. Transport follows schedule pattern exactly

- `app_list` server message broadcast on WebSocket connect and after any mutation
- `delete_app` and `rollback_app` client messages handled in `agent-do.ts`
- `ChatState.apps` array, `SET_APPS` reducer action, `useChat().apps` + `deleteApp()` + `rollbackApp()` in the hook

No innovation needed here -- the schedule pattern is proven and consistent.

### 7. Slug generation and uniqueness

The `deploy_app` tool accepts `name` (human-readable) and optionally `slug` (URL-safe). If slug is omitted, it is derived from name via lowercasing, replacing spaces/special chars with hyphens, and deduplication with a numeric suffix if needed. Uniqueness enforced by SQL UNIQUE constraint on `slug`.

## Risks / Trade-offs

- **[FUSE + git performance]** Git operations on a FUSE-mounted R2 filesystem may be slow for repos with many commits or large files. Mitigation: the agent's apps are typically small (< 100 files). Monitor and document performance characteristics. If needed, git operations can run on the container's local filesystem with periodic sync.

- **[Breaking change for vibe-coder consumers]** Removing `deploy_app` from vibe-coder breaks consumers using `vibeCoder({ deploy: { ... } })`. Mitigation: document migration in changelog. The capability registration change is straightforward -- add `appRegistry()` to the capabilities array and remove `deploy` from vibe-coder options.

- **[R2 `CURRENT` file as serving hot path]** Every request to `/apps/{slug}/` reads the `CURRENT` file. Mitigation: `WorkerLoader` already caches the generated worker script by deploy path. The `CURRENT` file read only happens on cache miss (new version deployed or cache evicted). Could add a short-TTL in-memory cache if needed.

- **[Orphaned artifacts on delete]** Deleting an app removes SQL records but R2 artifacts (source repo, deploy snapshots) must also be cleaned up. Mitigation: `delete_app` tool cleans up R2 via sandbox `rm -rf`. If container is unavailable, orphaned R2 data is inert (not served, not listed).
