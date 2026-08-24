#!/usr/bin/env bash
# Copy a skill from the local agent skills directory into this repo, then lint.
# Usage: scripts/sync.sh log-wide-events [more-skills...]
#        SRC=~/.claude/skills scripts/sync.sh my-skill
set -euo pipefail

SRC="${SRC:-$HOME/.agents/skills}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "usage: $(basename "$0") <skill-name> [skill-name...]" >&2
  echo "current skills in repo:" >&2
  ls "$REPO_ROOT/skills" >&2
  exit 64
fi

for name in "$@"; do
  from="$SRC/$name"
  to="$REPO_ROOT/skills/$name"

  [ -d "$from" ] || { echo "not found: $from" >&2; exit 66; }
  [ -f "$from/SKILL.md" ] || { echo "no SKILL.md in $from" >&2; exit 65; }

  rm -rf "$to"
  mkdir -p "$to"
  # Skip local scratch that has no business being published.
  rsync -a --delete \
    --exclude '.git' --exclude '.DS_Store' --exclude 'evals/' \
    --exclude '*-workspace/' --exclude '.omo/' \
    "$from/" "$to/"
  echo "synced $name ($(find "$to" -type f | wc -l | tr -d ' ') files)"
done

node "$REPO_ROOT/scripts/lint-skills.mjs"
