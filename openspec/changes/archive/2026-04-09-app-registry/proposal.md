## Why

The vibe-coder capability lets agents build and deploy full-stack apps, but deployed apps are invisible after creation. Each deploy produces a disposable UUID-based URL (`/deploy/{agentId}/{deployId}/`) with no naming, no version history, and no way to list or manage them. There is no transport message to surface deployed apps to the UI, so consumers cannot build an "Apps" panel analogous to the existing Schedules panel. Agents cannot iterate on a previously deployed app across sessions because there is no registry linking an app identity to its deploy history.

## What Changes

- Introduce `app-registry` as a new capability package that owns the full app lifecycle: creation, naming, versioned deployment, rollback, deletion, and real-time broadcast to clients.
- Add SQL-backed persistence (apps + app_versions tables) in the agent DO's SQLite database, following the same pattern as ScheduleStore.
- Add `app_list` server transport message and `delete_app` / `rollback_app` client transport messages, following the schedule_list pattern.
- Add client-side state (`apps` in ChatState, `SET_APPS` reducer action, `useChat().apps`) so the UI can render an apps panel.
- Require a clean git working tree for deployment. The deploy tool reads HEAD commit hash and message to tag each version, giving apps git-based version history without coupling deploy to commit.
- Store built artifacts per version in R2 (`.deploys/vN/`) for instant rollback without rebuilding.
- Add a `/apps/{slug}/` serving route that resolves the current version and delegates to existing `handleDeployRequest` internals.
- Move `deploy_app` from vibe-coder into app-registry. Vibe-coder retains dev-experience tools only (preview, console logs).

## Capabilities

### New Capabilities
- `app-registry`: App lifecycle management -- SQL store, versioned deploy with git integration, rollback, deletion, transport broadcast, and serving route handler. Provides tools: `deploy_app`, `list_apps`, `rollback_app`, `delete_app`, `get_app_history`.

### Modified Capabilities
- `vibe-coder`: Remove `deploy_app` tool. Vibe-coder retains only dev-experience tools (show_preview, hide_preview, get_console_logs, start_backend).

## Impact

- **New package**: `packages/app-registry/` with capability, SQL store, tools, and serving route handler.
- **`packages/agent-runtime/src/transport/types.ts`**: New `app_list` server message, `delete_app` and `rollback_app` client messages.
- **`packages/agent-runtime/src/client/`**: ChatState gains `apps` field, reducer handles `SET_APPS`, message-handler dispatches `app_list`, useAgentChat exposes `apps` + action methods.
- **`packages/vibe-coder/`**: `deploy_app` tool and `deploy-app.ts` removed. Capability options drop `deploy` config. `deploy-server.ts` serving logic extracted or shared with app-registry.
- **`examples/basic-agent/src/worker.ts`**: Adds app-registry capability registration and `/apps/{slug}/` route handler.
- **Consumer API**: Agents that use `deploy` config on vibe-coder switch to registering `app-registry` as a separate capability. **BREAKING** for consumers currently using `vibeCoder({ deploy: { ... } })`.
