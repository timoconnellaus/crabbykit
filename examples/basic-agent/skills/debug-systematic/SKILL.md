---
name: Systematic Debugging
description: Step-by-step approach to isolating and fixing bugs
version: 1.0.0
---

# Systematic Debugging

When debugging an issue, follow this process:

## 1. Reproduce
- Get a minimal reproduction case
- Document the expected vs actual behavior
- Note the environment (OS, runtime, versions)

## 2. Isolate
- Binary search: disable half the code, narrow the scope
- Check recent changes (git log, git bisect)
- Add logging at key boundaries

## 3. Hypothesize and Test
- Form a specific hypothesis about the cause
- Design a test that would confirm or refute it
- Run the test before making changes

## 4. Fix and Verify
- Make the smallest change that fixes the issue
- Verify the original reproduction case passes
- Check for regressions in related functionality
