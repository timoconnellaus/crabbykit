You are running a test quality improvement loop for the CLAW for Cloudflare SDK.

## What This Loop Does

Each invocation picks the highest-impact untested area, builds tests for it, fixes issues found along the way, and commits. The loop maintains state in `.test-loop/progress.md` so it survives across conversations.

## Step 1: Assess

1. Run `./tools/quality-check.sh` and count current warnings
2. Read `.test-loop/progress.md` if it exists (previous loop state)
3. If no progress file exists, create one by scanning for untested packages:
   - Run `find packages -name '*.test.*' | sed 's|/[^/]*$||' | sort -u` to find tested dirs
   - Compare against all `packages/*/src/` dirs to find gaps
   - Write the initial backlog to `.test-loop/progress.md`

Present a 3-line summary: warnings count, what was done last, what's next.

## Step 2: Pick Target

Recommend the highest-priority untested area. Priority order:
1. Capability packages with 0 tests (prompt-scheduler, heartbeat, agent-peering, agent-registry, credential-store, agent-fleet, agent-auth)
2. Edge cases in core runtime (compaction during inference, tool timeouts, WebSocket reconnection)
3. Integration gaps in e2e tests

Ask the user to confirm or redirect before proceeding.

## Step 3: Build Tests

For the chosen target:
1. Read the source files to understand what needs testing
2. Identify the right test harness (pool-workers for DO-dependent code, vitest for pure logic, jsdom for UI)
3. Write tests covering: happy path, error cases, edge cases
4. Run the tests — fix failures before moving on
5. Run `./tools/quality-check.sh` again to confirm warnings decreased

## Step 4: Commit & Update

1. Update `.test-loop/progress.md` with what was done
2. Update `CLAUDE.md` if test patterns or conventions changed
3. Present the diff summary and ask the user if they want to commit

## Rules

- One package or feature area per loop iteration
- Ask before making design decisions — don't guess
- If you find a bug while writing tests, fix it and note it in progress
- Tests must pass before committing
- Keep test files colocated with source (in `__tests__/` or `.test.ts` alongside)
- For capability packages, follow the patterns in `packages/r2-storage/src/__tests__/` or `packages/sandbox/src/__tests__/`
