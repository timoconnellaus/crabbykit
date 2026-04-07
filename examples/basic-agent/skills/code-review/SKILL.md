---
name: Code Review
description: Reviews code changes for bugs, security issues, and style violations
version: 1.0.0
---

# Code Review

When reviewing code, follow this checklist:

## Security
- Check for injection vulnerabilities (SQL, XSS, command injection)
- Verify authentication and authorization checks
- Look for hardcoded secrets or credentials

## Correctness
- Verify error handling covers edge cases
- Check for off-by-one errors and boundary conditions
- Ensure async operations are properly awaited

## Style
- Consistent naming conventions
- No unnecessary complexity
- Functions are focused and reasonably sized
