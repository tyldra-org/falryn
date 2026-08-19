#!/usr/bin/env bash
# Copy maintainer global skills into this repo for contributor distribution.
set -euo pipefail

SRC="${SKILLS_SRC:-$HOME/.agents/skills}"
DST="$(cd "$(dirname "$0")" && pwd)"
SKILLS=(gh-cli git-workflow typescript-best-practices opentui falryn-loop)
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo "  SKILLS_SRC overrides source (default: ~/.agents/skills)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$SRC" ]]; then
  echo "Source not found: $SRC" >&2
  exit 1
fi

RSYNC=(rsync -a --delete)
if [[ "$DRY_RUN" -eq 1 ]]; then
  RSYNC+=(--dry-run --itemize-changes)
fi

for skill in "${SKILLS[@]}"; do
  if [[ ! -d "$SRC/$skill" ]]; then
    echo "skip (missing globally): $skill" >&2
    continue
  fi
  echo "sync: $skill"
  "${RSYNC[@]}" "$SRC/$skill/" "$DST/$skill/"
done

echo "done → $DST"
