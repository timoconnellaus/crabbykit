You are running a test quality improvement loop for the CLAW for Cloudflare SDK.

## What This Loop Does

Each invocation picks the highest-impact untested area, builds tests for it, fixes issues found along the way, and commits. The loop maintains state in `.test-loop/progress.md` so it survives across conversations.

## Step 1: Assess

1. Run `./tools/quality-check.sh` and record the warning count (this is your "before" number)
2. Read `.test-loop/progress.md` if it exists (previous loop state)
3. If no progress file exists, create one by scanning for untested packages:
   - Run `find packages -name '*.test.*' | sed 's|/[^/]*$||' | sort -u` to find tested dirs
   - Compare against all `packages/*/src/` dirs to find gaps
   - Write the initial backlog to `.test-loop/progress.md`
4. Check the most recent loop entry for:
   - **Process suggestions** — adopt any that make sense (update commands, quality-check.sh, etc.) and tell the user what you're adopting
   - **Next target** — use as the default recommendation

Present a 3-line summary: warnings count, what was done last, recommended next target.

## Step 2: Pick Target

If the user provided a target in the command invocation (e.g. `/test-loop Add tests for prompt-scheduler`), use that. Otherwise, recommend the target from the previous loop's "Next" field. If none, use this priority order:
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

## Step 4: Wrap Up

Don't commit or update tracking here — that's what `/test-loop-end` is for. Instead, tell the user:

```
Tests passing. Run /test-loop-end to measure, commit, and close this loop.
```

## Rules

- One package or feature area per loop iteration
- Ask before making design decisions — don't guess
- If you find a bug while writing tests, fix it and note it
- Tests must pass before finishing
- Keep test files colocated with source (in `__tests__/` or `.test.ts` alongside)
- For capability packages, follow the patterns in `packages/r2-storage/src/__tests__/` or `packages/sandbox/src/__tests__/`
