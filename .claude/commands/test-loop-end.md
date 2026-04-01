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

## Step 5: Update CLAUDE.md

If any of these changed during the loop, update CLAUDE.md:
- New test patterns or conventions
- New packages or files added
- Architecture rules discovered or clarified
- Testing rules updated

## Step 6: Retrospective

Reflect on this loop iteration and suggest improvements to the process itself. Consider:

- **Did the test-loop command give good enough guidance?** If you had to deviate from it, suggest how to improve the instructions.
- **Did quality-check.sh catch the right things?** If you found issues it missed, suggest new checks to add (e.g., missing exports, unused code, type coverage).
- **Was the progress.md format useful?** If you needed information that wasn't tracked, suggest additions.
- **Were there friction points?** Things that slowed you down — missing test helpers, awkward test setup, unclear conventions.
- **Were there patterns worth extracting?** If you wrote test utilities or helpers that would be useful across packages, note them.

Present suggestions as concrete proposals:
- "Add check to quality-check.sh: [what and why]"
- "Update test-loop command: [specific change]"
- "Create shared test helper for: [pattern]"

The user will decide which suggestions to adopt. Don't make changes to the loop infrastructure without asking.
