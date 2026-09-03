#!/usr/bin/env bash
# Copy maintainer global skills into this repo for contributor distribution.
set -euo pipefail

SRC="${SKILLS_SRC:-$HOME/.agents/skills}"
DST="$(cd "$(dirname "$0")" && pwd)"
PORTABLE_SKILLS=(gh-cli git-workflow change-review engineering-best-practices typescript-best-practices opentui-best-practices)
PROJECT_SKILLS=(falryn-workflow)
SKILLS=("${PORTABLE_SKILLS[@]}" "${PROJECT_SKILLS[@]}")
APPLY=0
CHECK=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --check) CHECK=1 ;;
    --dry-run) ;;
    -h|--help)
      echo "Usage: $0 [--apply | --check]"
      echo "  SKILLS_SRC overrides source (default: ~/.agents/skills)"
      echo "  Default: preview itemized changes without mutating the destination."
      echo "  --apply: synchronize after complete source preflight, then verify parity."
      echo "  --check: verify exact parity without running rsync."
      echo "  --dry-run is accepted but redundant because preview is the default."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$APPLY" -eq 1 && "$CHECK" -eq 1 ]]; then
  echo "--apply and --check are mutually exclusive" >&2
  exit 1
fi

if [[ ! -d "$SRC" ]]; then
  echo "Source not found: $SRC" >&2
  exit 1
fi

# Preflight the complete set before any destination mutation. A missing or
# misidentified bundle is an error, never a partial successful synchronization.
preflight_failed=0
for skill in "${SKILLS[@]}"; do
  source_skill="$SRC/$skill"
  if [[ ! -d "$source_skill" ]]; then
    echo "Missing required source bundle: $skill" >&2
    preflight_failed=1
    continue
  fi
  if [[ ! -f "$source_skill/SKILL.md" ]]; then
    echo "Missing required source entrypoint: $skill/SKILL.md" >&2
    preflight_failed=1
    continue
  fi
  declared_name="$(awk '/^---$/{markers += 1; next} markers == 1 && /^name: /{sub(/^name: /, ""); print; exit}' "$source_skill/SKILL.md")"
  if [[ "$declared_name" != "$skill" ]]; then
    echo "Source identity mismatch: $skill declares '${declared_name:-<missing>}'" >&2
    preflight_failed=1
  fi
done
if [[ "$preflight_failed" -ne 0 ]]; then
  exit 1
fi

verify_parity() {
  local failed=0
  local skill
  for skill in "${SKILLS[@]}"; do
    if [[ ! -d "$DST/$skill" ]]; then
      echo "Missing required destination bundle: $skill" >&2
      failed=1
      continue
    fi
    if ! diff -qr --exclude=.DS_Store "$SRC/$skill" "$DST/$skill"; then
      failed=1
    fi
  done
  return "$failed"
}

if [[ "$CHECK" -eq 1 ]]; then
  verify_parity
  echo "all seven source and vendored skill bundles match"
  exit 0
fi

RSYNC=(rsync -a --no-times --checksum --delete --exclude=.DS_Store --itemize-changes)
if [[ "$APPLY" -eq 0 ]]; then
  RSYNC+=(--dry-run)
  echo "preview only; review the itemized changes, then rerun with --apply"
fi

for skill in "${SKILLS[@]}"; do
  echo "sync: $skill"
  # With --no-times, rsync emits .f..T.... placeholders for checksum-equal
  # files. Hide only those timestamp-only records so review output shows real
  # transfers and deletions.
  "${RSYNC[@]}" "$SRC/$skill/" "$DST/$skill/" | sed -E '/^\.[fd]\.\.T\.\.\.\./d'
done

if [[ "$APPLY" -eq 1 ]]; then
  verify_parity
  echo "synced and verified → $DST"
else
  echo "preview complete → $DST"
fi
