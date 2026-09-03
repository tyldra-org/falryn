#!/usr/bin/env bash
# Copy maintainer global skills into this repo for contributor distribution.
set -euo pipefail

SRC="${SKILLS_SRC:-$HOME/.agents/skills}"
DST="$(cd "$(dirname "$0")" && pwd)"
PORTABLE_SKILLS=(gh-cli git-workflow change-review engineering-best-practices typescript-best-practices opentui-best-practices)
PROJECT_SKILLS=(falryn-workflow)
SKILLS=("${PORTABLE_SKILLS[@]}" "${PROJECT_SKILLS[@]}")
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) ;;
    -h|--help)
      echo "Usage: $0 [--apply]"
      echo "  SKILLS_SRC overrides source (default: ~/.agents/skills)"
      echo "  Default: preview changes only; --apply performs the sync."
      echo "  --dry-run is accepted but redundant because preview is the default."
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

RSYNC=(rsync -a --no-times --checksum --delete --exclude=.DS_Store --itemize-changes)
if [[ "$APPLY" -eq 0 ]]; then
  RSYNC+=(--dry-run)
  echo "preview only; review the itemized changes, then rerun with --apply"
fi

for skill in "${SKILLS[@]}"; do
  if [[ ! -d "$SRC/$skill" ]]; then
    echo "skip (missing globally): $skill" >&2
    continue
  fi
  echo "sync: $skill"
  # With --no-times, rsync emits .f..T.... placeholders for checksum-equal
  # files. Hide only those timestamp-only records so review output shows real
  # transfers and deletions.
  "${RSYNC[@]}" "$SRC/$skill/" "$DST/$skill/" | sed -E '/^\.[fd]\.\.T\.\.\.\./d'
done

if [[ "$APPLY" -eq 1 ]]; then
  echo "synced → $DST"
else
  echo "preview complete → $DST"
fi
