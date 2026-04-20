#!/usr/bin/env bash
# Extract the npm auth token from a local .npmrc and set it as the NPM_TOKEN
# GitHub Actions secret on this repo.
#
# Looks for .npmrc in: ./.npmrc, then ~/.npmrc
# Expects a line of the form: //registry.npmjs.org/:_authToken=<TOKEN>
#
# Requires: gh (authenticated via `gh auth login`)

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
candidates=("$repo_root/.npmrc" "$HOME/.npmrc")

npmrc=""
for path in "${candidates[@]}"; do
  if [[ -f "$path" ]]; then
    npmrc="$path"
    break
  fi
done

if [[ -z "$npmrc" ]]; then
  echo "error: no .npmrc found at ${candidates[*]}" >&2
  echo "hint: copy .npmrc.example to .npmrc and set your token first" >&2
  exit 1
fi

token="$(grep -E '^//registry\.npmjs\.org/:_authToken=' "$npmrc" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"

if [[ -z "$token" || "$token" == "\${NPM_TOKEN}" ]]; then
  echo "error: no literal _authToken found in $npmrc" >&2
  echo "hint: set //registry.npmjs.org/:_authToken=<token> in $npmrc" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not installed (brew install gh)" >&2
  exit 1
fi

echo "Setting NPM_TOKEN secret from $npmrc on $(gh repo view --json nameWithOwner -q .nameWithOwner)"
printf '%s' "$token" | gh secret set NPM_TOKEN --body -
echo "done"
