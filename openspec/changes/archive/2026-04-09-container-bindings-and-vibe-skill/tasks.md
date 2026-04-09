## 1. Container Binding Interception

- [x] 1.1 Add `static outboundByHost` to `SandboxContainer` DO in `packages/cloudflare-sandbox/src/container-do.ts` mapping `db.internal` → `handleDbRequest` and `ai.internal` → `handleAiRequest`
- [x] 1.2 Implement `handleDbRequest` — parse `POST /exec` and `POST /batch`, call `env.DB_SERVICE.exec()` / `.batch()`, return JSON response. Handle errors with 400/500 responses.
- [x] 1.3 Implement `handleAiRequest` — forward requests to the OpenRouter proxy (reuse the existing proxy-handler logic from ai-proxy). Needs `env.OPENROUTER_API_KEY` on the DO.
- [x] 1.4 Add `DB_SERVICE` service binding to SandboxContainer env type and `wrangler.jsonc` configuration
- [x] 1.5 Add `OPENROUTER_API_KEY` to SandboxContainer env (for AI interception)
- [x] 1.6 Inject `CLAW_DB_BACKEND_ID` env var into container on elevate (in sandbox capability's afterToolExecution hook or via the provider start options)
- [x] 1.7 Add tests for `handleDbRequest`: exec query, batch statements, missing sql, missing backendId
- [x] 1.8 Add tests for `handleAiRequest`: chat completion forwarding, models listing

## 2. Container DB Client Package

- [x] 2.1 Scaffold `packages/container-db` — package.json, tsconfig.json, src/index.ts
- [x] 2.2 Implement `createDB(options?)` factory — reads `CLAW_DB_BACKEND_ID` from process.env, returns `{ exec, batch }` object that fetches `http://db.internal/*`
- [x] 2.3 Implement `exec(sql, params?)` — POST to `http://db.internal/exec`, parse JSON response, throw on error
- [x] 2.4 Implement `batch(statements)` — POST to `http://db.internal/batch`, parse JSON response
- [x] 2.5 Export `DB` type interface matching the deployed `env.DB` shape
- [x] 2.6 Add tests: exec happy path, exec with params, batch, missing backendId error, server error handling

## 3. AI Proxy Migration

- [x] 3.1 Remove `CLAW_AI_BASE_URL` + `CLAW_AI_TOKEN` env var injection from ai-proxy capability's `afterToolExecution` hook
- [x] 3.2 Remove token generation/storage/validation from ai-proxy (no longer needed — interception is trusted)
- [x] 3.3 Update ai-proxy prompt sections to teach `http://ai.internal/v1` pattern instead of env vars
- [x] 3.4 Update ai-proxy HTTP handlers to work both from interception (no token) and from external requests (legacy compatibility)
- [x] 3.5 Update ai-proxy tests for the new pattern

## 4. Remove Prompt Sections

- [x] 4.1 Remove `promptSections` from vibe-coder capability entirely — the vibe-webapp skill provides all instructions
- [x] 4.2 Remove `promptSections` from app-registry capability entirely — the skill covers deployment
- [x] 4.3 Remove `promptSections` from ai-proxy capability entirely — the skill covers AI usage

## 5. Vibe-Webapp Skill

- [x] 5.1 Write the SKILL.md content covering: project structure, Bun.serve() server pattern, frontend with React, database with container-db, styling with Tailwind, dev workflow, deployment, common mistakes
- [x] 5.2 Add `vibe-webapp` to `EXAMPLE_SKILL_SEEDS` in `examples/basic-agent/src/worker.ts`
- [x] 5.3 Add `{ id: "vibe-webapp", enabled: true, autoUpdate: true }` to the skills declaration
- [x] 5.4 Verify skill content is under 500 lines and description under 250 chars

## 6. Example App Wiring

- [x] 6.1 Add `DB_SERVICE` service binding to SandboxContainer in `examples/basic-agent/wrangler.jsonc`
- [x] 6.2 Add `OPENROUTER_API_KEY` secret access for SandboxContainer DO
- [x] 6.3 Verify example app typechecks with all changes

## 7. Documentation

- [x] 7.1 Update CLAUDE.md — add `packages/container-db` to packages list
- [x] 7.2 Update README.md — add `container-db` to packages table
