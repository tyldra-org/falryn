#!/usr/bin/env bash
# Copy distributed maintainer skills into this repo after complete source preflight.
set -euo pipefail

SRC_RAW="${SKILLS_SRC:-$HOME/.agents/skills}"
SRC="$SRC_RAW"
DST_RAW="$(dirname -- "$0")"
DST_LOGICAL="$(cd -L -- "$DST_RAW" && pwd -L)"
DST="$(cd -P -- "$DST_RAW" && pwd -P)"
DESTINATION_ROOT_USES_SYMLINK=0
if [[ "/$DST_RAW/" == *"/../"* || "$DST_LOGICAL" != "$DST" ]]; then
  DESTINATION_ROOT_USES_SYMLINK=1
fi
PORTABLE_SKILLS=(gh-cli git-workflow change-review typescript-best-practices opentui-best-practices)
PROJECT_SKILLS=(falryn-workflow)
DISTRIBUTED_SKILLS=("${PORTABLE_SKILLS[@]}" "${PROJECT_SKILLS[@]}")
RETIRED_DESTINATION_SKILLS=(engineering-best-practices)
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
      echo "  --check: verify exact parity and retired-bundle absence without mutation."
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
SRC_LOGICAL="$(cd -L -- "$SRC_RAW" && pwd -L)"
SRC="$(cd -P -- "$SRC_RAW" && pwd -P)"
if [[ "/$SRC_RAW/" == *"/../"* || "$SRC_LOGICAL" != "$SRC" ]]; then
  echo "Source skill root resolves through a symlink: $SRC_LOGICAL" >&2
  exit 1
fi

preflight_failed=0
for skill in "${DISTRIBUTED_SKILLS[@]}"; do
  source_skill="$SRC/$skill"
  if [[ ! -d "$source_skill" ]]; then
    echo "Missing required source bundle: $skill" >&2
    preflight_failed=1
    continue
  fi
  source_link="$(find "$source_skill" -type l -print -quit)"
  if [[ -L "$source_skill" || -n "$source_link" ]]; then
    echo "Source bundle contains a prohibited symlink: $skill" >&2
    preflight_failed=1
    continue
  fi
  source_special="$(find "$source_skill" ! -type d ! -type f ! -type l -print -quit)"
  if [[ -n "$source_special" ]]; then
    echo "Source bundle contains an unsupported filesystem entry: $skill" >&2
    preflight_failed=1
    continue
  fi
  source_invalid_finder="$(find "$source_skill" -name .DS_Store ! -type f -print -quit)"
  if [[ -n "$source_invalid_finder" ]]; then
    echo "Source bundle contains unsupported Finder metadata: $skill" >&2
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

TMP_BASE="${TMPDIR:-/tmp}"
if [[ ! -d "$TMP_BASE" ]]; then
  echo "Temporary directory is unavailable: $TMP_BASE" >&2
  exit 1
fi
TMP_BASE="$(cd -P -- "$TMP_BASE" && pwd -P)"
if [[ "$TMP_BASE" == "$DST" || "$TMP_BASE" == "$DST/"* ]]; then
  echo "Temporary directory must be outside the destination skill tree: $TMP_BASE" >&2
  exit 1
fi
if [[ "$TMP_BASE" == "$SRC" || "$TMP_BASE" == "$SRC/"* ]]; then
  echo "Temporary directory must be outside the source skill tree: $TMP_BASE" >&2
  exit 1
fi
SCAN_DIR="$(mktemp -d "$TMP_BASE/falryn-skill-sync.XXXXXX")"
trap 'rm -rf -- "$SCAN_DIR"' EXIT
DESTINATION_SPECIALS="$SCAN_DIR/destination-specials"
DESTINATION_ENTRIES="$SCAN_DIR/destination-entries"

is_distributed_skill() {
  local candidate_name="$1"
  local skill
  for skill in "${DISTRIBUTED_SKILLS[@]}"; do
    if [[ "$candidate_name" == "$skill" ]]; then
      return 0
    fi
  done
  return 1
}

is_retired_path() {
  local candidate_path="$1"
  local skill
  for skill in "${RETIRED_DESTINATION_SKILLS[@]}"; do
    if [[ "$candidate_path" == "$DST/$skill" ]]; then
      return 0
    fi
  done
  return 1
}

scan_destination() {
  : >"$DESTINATION_SPECIALS"
  : >"$DESTINATION_ENTRIES"
  if ! find "$DST" \( -type l -o -name .DS_Store -o \( ! -type d -a ! -type f \) \) -print0 >"$DESTINATION_SPECIALS"; then
    echo "Unable to inspect destination skill symlinks, metadata, and special entries: $DST" >&2
    return 1
  fi
  if ! find "$DST" -mindepth 1 -maxdepth 1 -print0 >"$DESTINATION_ENTRIES"; then
    echo "Unable to inspect destination skill inventory: $DST" >&2
    return 1
  fi
  return 0
}

preflight_destination() {
  local failed=0
  local destination_special
  local candidate
  local name
  if [[ "$DESTINATION_ROOT_USES_SYMLINK" -eq 1 || -L "$DST" ]]; then
    echo "Destination skill root resolves through a symlink: $DST_LOGICAL" >&2
    return 1
  fi
  if ! scan_destination; then
    return 1
  fi
  while IFS= read -r -d '' destination_special; do
    name="${destination_special#"$DST/"}"
    if [[ "${destination_special##*/}" == ".DS_Store" ]]; then
      echo "Finder metadata is not allowed in destination skills: $name" >&2
      failed=1
      continue
    fi
    if [[ ! -L "$destination_special" ]]; then
      echo "Unsupported filesystem entry in destination skills: $name" >&2
      failed=1
      continue
    fi
    if is_retired_path "$destination_special"; then
      continue
    fi
    if [[ "$name" != */* ]] && is_distributed_skill "$name"; then
      echo "Required destination bundle is a symlink: $name" >&2
    else
      echo "Destination skill symlink is not allowed: $name" >&2
    fi
    failed=1
  done <"$DESTINATION_SPECIALS"
  while IFS= read -r -d '' candidate; do
    name="${candidate##*/}"
    if is_distributed_skill "$name"; then
      if [[ ! -d "$candidate" ]]; then
        echo "Required destination bundle is not a directory: $name" >&2
        failed=1
      fi
      continue
    fi
    if is_retired_path "$candidate" || [[ ! -d "$candidate" || ! -f "$candidate/SKILL.md" ]]; then
      continue
    fi
    echo "Unexpected destination bundle remains: $name" >&2
    failed=1
  done <"$DESTINATION_ENTRIES"
  return "$failed"
}

verify_distribution() {
  local failed=0
  local skill
  local destination_special
  if ! scan_destination; then
    return 1
  fi
  while IFS= read -r -d '' destination_special; do
    if [[ "${destination_special##*/}" == ".DS_Store" ]]; then
      echo "Finder metadata is not allowed in destination skills: ${destination_special#"$DST/"}" >&2
    elif [[ -L "$destination_special" ]]; then
      echo "Destination skill symlink is not allowed: ${destination_special#"$DST/"}" >&2
    else
      echo "Unsupported filesystem entry in destination skills: ${destination_special#"$DST/"}" >&2
    fi
    failed=1
  done <"$DESTINATION_SPECIALS"
  for skill in "${DISTRIBUTED_SKILLS[@]}"; do
    if [[ -L "$DST/$skill" ]]; then
      echo "Required destination bundle is a symlink: $skill" >&2
      failed=1
      continue
    fi
    if [[ ! -d "$DST/$skill" ]]; then
      echo "Missing required destination bundle: $skill" >&2
      failed=1
      continue
    fi
    if ! diff -qr --exclude=.DS_Store "$SRC/$skill" "$DST/$skill"; then
      failed=1
    fi
  done
  for skill in "${RETIRED_DESTINATION_SKILLS[@]}"; do
    if [[ -e "$DST/$skill" || -L "$DST/$skill" ]]; then
      echo "Retired destination bundle remains: $skill" >&2
      failed=1
    fi
  done
  while IFS= read -r -d '' candidate; do
    local name="${candidate##*/}"
    if [[ ! -d "$candidate" || ! -f "$candidate/SKILL.md" ]] || is_distributed_skill "$name"; then
      continue
    fi
    echo "Unexpected destination bundle remains: $name" >&2
    failed=1
  done <"$DESTINATION_ENTRIES"
  return "$failed"
}

if ! preflight_destination; then
  exit 1
fi

if [[ "$CHECK" -eq 1 ]]; then
  verify_distribution
  echo "all six distributed skill bundles match; global-only skills were not inspected"
  exit 0
fi

RSYNC=(rsync -a --no-times --checksum --delete --exclude=.DS_Store --itemize-changes)
if [[ "$APPLY" -eq 0 ]]; then
  RSYNC+=(--dry-run)
  echo "preview only; review the itemized changes, then rerun with --apply"
fi

for skill in "${RETIRED_DESTINATION_SKILLS[@]}"; do
  if [[ -e "$DST/$skill" || -L "$DST/$skill" ]]; then
    if [[ "$APPLY" -eq 1 ]]; then
      echo "remove retired destination bundle: $skill"
      rm -rf -- "$DST/$skill"
    else
      echo "would remove retired destination bundle: $skill"
    fi
  fi
done

for skill in "${DISTRIBUTED_SKILLS[@]}"; do
  echo "sync: $skill"
  "${RSYNC[@]}" "$SRC/$skill/" "$DST/$skill/" | sed -E '/^\.[fd]\.\.T\.\.\.\./d'
done

if [[ "$APPLY" -eq 1 ]]; then
  verify_distribution
  echo "synced and verified -> $DST"
else
  echo "preview complete -> $DST"
fi
