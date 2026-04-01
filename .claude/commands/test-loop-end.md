You are wrapping up a test quality improvement loop for the CLAW for Cloudflare SDK.

## Step 1: Verify

1. Run the tests that were added or modified this loop — they must all pass
2. Run `bun run typecheck` in affected packages — must be clean
3. If anything fails, fix it before proceeding

## Step 2: Measure

1. Run `./tools/quality-check.sh` and capture the warning count
2. Read `.test-loop/progress.md` to find the warning count from the start of this loop
3. Report the delta: "Warnings: X → Y (delta)"

## Step 3: Commit

1. Check `git status` for uncommitted changes
2. If there are uncommitted changes, present the diff summary and create a commit
3. Record the commit hash

## Step 4: Update Tracking

Update `.test-loop/progress.md` with a new entry at the top:

```
## Loop [date] — [target area]
- **What:** [1-2 sentence summary of what was tested/fixed]
- **Commit:** [short hash]
- **Warnings:** [before] → [after]
- **Issues found:** [any bugs discovered and fixed during testing]
- **Next:** [recommended next target based on what we learned]
```

## Step 5: Retrospective (write, don't ask)

Reflect on this loop iteration and write process improvement suggestions directly into `.test-loop/progress.md` under a `### Process suggestions` heading inside the current loop entry. Consider:

- Did quality-check.sh miss things it should catch?
- Were there friction points or missing test helpers?
- Should the test-loop or test-loop-end commands be updated?
- Are there patterns worth extracting into shared utilities?

Write them as concrete one-line proposals. These will be reviewed at the start of the next `/test-loop`.

## Step 6: Update CLAUDE.md

If any of these changed during the loop, update CLAUDE.md:
- New test patterns or conventions
- New packages or files added
- Architecture rules discovered or clarified

## Step 7: Warm Start

End by printing the next loop command ready to copy-paste. If there's a clear next target from the progress entry, include it. If not, just print `/test-loop` — the next loop will explore to find issues.

```
/test-loop [next target, if known]
```

For example: `/test-loop Add tests for prompt-scheduler`
Or just: `/test-loop`
