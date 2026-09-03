#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/source"
DST="$TMP/destination"
DISTRIBUTED=(gh-cli git-workflow change-review typescript-best-practices opentui-best-practices falryn-workflow)
SOURCE_ONLY=(engineering-best-practices)
mkdir -p "$SRC" "$DST"
SRC="$(cd "$SRC" && pwd -P)"
DST="$(cd "$DST" && pwd -P)"
cp "$SCRIPT_DIR/sync-from-global.sh" "$DST/sync-from-global.sh"
chmod +x "$DST/sync-from-global.sh"

make_bundle() {
  local root="$1"
  local skill="$2"
  mkdir -p "$root/$skill"
  printf -- '---\nname: %s\ndescription: fixture\n---\n\n# %s\n' "$skill" "$skill" > "$root/$skill/SKILL.md"
}

for skill in "${DISTRIBUTED[@]}" "${SOURCE_ONLY[@]}"; do
  make_bundle "$SRC" "$skill"
done
for skill in "${DISTRIBUTED[@]}"; do
  make_bundle "$DST" "$skill"
done
printf 'global-only-sentinel\n' > "$SRC/engineering-best-practices/untouched.txt"
engineering_before="$(cksum "$SRC/engineering-best-practices/untouched.txt")"
make_bundle "$DST" engineering-best-practices

# A symlinked source root is rejected before destination mutation.
SOURCE_ROOT_LINK="$TMP/source-root-link"
ln -s "$SRC" "$SOURCE_ROOT_LINK"
printf 'preserve source-root rejection\n' >"$DST/change-review/root-sentinel.txt"
if SKILLS_SRC="$SOURCE_ROOT_LINK" "$DST/sync-from-global.sh" --apply >"$TMP/source-root-link.out" 2>"$TMP/source-root-link.err"; then
  echo "expected symlinked source root to fail before mutation" >&2
  exit 1
fi
grep -q 'Source skill root resolves through a symlink' "$TMP/source-root-link.err"
grep -q 'preserve source-root rejection' "$DST/change-review/root-sentinel.txt"
rm "$DST/change-review/root-sentinel.txt" "$SOURCE_ROOT_LINK"

# Leading-option source and destination names are treated as paths.
TMP_PHYSICAL="$(dirname "$SRC")"
LEADING_SOURCE="$TMP_PHYSICAL/-P"
cp -R "$SRC" "$LEADING_SOURCE"
(
  cd "$TMP_PHYSICAL"
  SKILLS_SRC="-P" "$DST/sync-from-global.sh" --dry-run >"$TMP/leading-source.out"
)
grep -q 'preview complete' "$TMP/leading-source.out"
LEADING_DESTINATION="$TMP_PHYSICAL/-L"
cp -R "$DST" "$LEADING_DESTINATION"
(
  cd "$TMP_PHYSICAL"
  SKILLS_SRC="$SRC" bash -- "-L/sync-from-global.sh" --dry-run >"$TMP/leading-destination.out"
)
grep -q 'preview complete' "$TMP/leading-destination.out"
rm -rf "$LEADING_SOURCE" "$LEADING_DESTINATION"

# Invoking through a symlinked destination root fails before synchronization.
ROOT_LINK="$TMP/destination-root-link"
ln -s "$DST" "$ROOT_LINK"
printf 'preserve root target\n' >"$DST/change-review/root-sentinel.txt"
if SKILLS_SRC="$SRC" "$ROOT_LINK/sync-from-global.sh" --apply >"$TMP/root-link.out" 2>"$TMP/root-link.err"; then
  echo "expected symlinked destination root to fail before mutation" >&2
  exit 1
fi
grep -q 'Destination skill root resolves through a symlink' "$TMP/root-link.err"
grep -q 'preserve root target' "$DST/change-review/root-sentinel.txt"
rm "$DST/change-review/root-sentinel.txt" "$ROOT_LINK"

# A symlink component canceled by a parent segment is still rejected.
mkdir "$TMP/alias-target"
ln -s "$TMP/alias-target" "$TMP/cancel-link"
printf 'preserve canceled-link target\n' >"$DST/change-review/root-sentinel.txt"
CANCELED_ROOT="$TMP/cancel-link/../destination"
if SKILLS_SRC="$SRC" "$CANCELED_ROOT/sync-from-global.sh" --apply >"$TMP/canceled-root.out" 2>"$TMP/canceled-root.err"; then
  echo "expected canceled symlink component to fail before mutation" >&2
  exit 1
fi
grep -q 'Destination skill root resolves through a symlink' "$TMP/canceled-root.err"
grep -q 'preserve canceled-link target' "$DST/change-review/root-sentinel.txt"
rm "$DST/change-review/root-sentinel.txt" "$TMP/cancel-link"
rmdir "$TMP/alias-target"

# Missing input fails before changing or deleting any destination bundle.
printf 'preserve\n' > "$DST/change-review/sentinel.txt"
rm -rf "$SRC/opentui-best-practices"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/missing.out" 2>"$TMP/missing.err"; then
  echo "expected missing-source preflight to fail" >&2
  exit 1
fi
grep -q 'Missing required source bundle: opentui-best-practices' "$TMP/missing.err"
test -f "$DST/change-review/sentinel.txt"
test -d "$DST/engineering-best-practices"
make_bundle "$SRC" opentui-best-practices

# Preview reports copies and retired-bundle removal without mutating.
printf 'source-only\n' > "$SRC/gh-cli/value.txt"
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" >"$TMP/preview.out"
grep -q 'sync: gh-cli' "$TMP/preview.out"
grep -q 'would remove retired destination bundle: engineering-best-practices' "$TMP/preview.out"
test ! -e "$DST/gh-cli/value.txt"
test -d "$DST/engineering-best-practices"

# Apply copies updates, deletes stale files, retires engineering, and verifies parity.
printf 'stale\n' > "$DST/git-workflow/stale.txt"
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/apply.out"
grep -q 'synced and verified' "$TMP/apply.out"
test -f "$DST/gh-cli/value.txt"
test ! -e "$DST/git-workflow/stale.txt"
test ! -e "$DST/engineering-best-practices"
engineering_after="$(cksum "$SRC/engineering-best-practices/untouched.txt")"
test "$engineering_after" = "$engineering_before"

# Check mode is read-only and succeeds only at exact six-bundle parity.
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --check >"$TMP/check.out"
grep -q 'all six distributed skill bundles match; global-only skills were not inspected' "$TMP/check.out"
rm -rf "$SRC/engineering-best-practices"
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --check >"$TMP/check-without-global-only.out"
grep -q 'all six distributed skill bundles match; global-only skills were not inspected' "$TMP/check-without-global-only.out"

# Reintroducing a retired destination bundle makes check mode fail.
make_bundle "$DST" engineering-best-practices
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --check >"$TMP/retired.out" 2>"$TMP/retired.err"; then
  echo "expected retired destination bundle check to fail" >&2
  exit 1
fi
grep -q 'Retired destination bundle remains: engineering-best-practices' "$TMP/retired.err"
rm -rf "$DST/engineering-best-practices"

# Unknown bundle identities are reported but never deleted automatically.
make_bundle "$DST" unexpected-skill
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --check >"$TMP/unexpected.out" 2>"$TMP/unexpected.err"; then
  echo "expected unexpected destination bundle check to fail" >&2
  exit 1
fi
grep -q 'Unexpected destination bundle remains: unexpected-skill' "$TMP/unexpected.err"
test -f "$DST/unexpected-skill/SKILL.md"
rm -rf "$DST/unexpected-skill"

# Hidden unknown bundles are part of the exact destination inventory.
make_bundle "$DST" .unexpected-skill
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/hidden.out" 2>"$TMP/hidden.err"; then
  echo "expected hidden unknown destination bundle to fail closed" >&2
  exit 1
fi
grep -q 'Unexpected destination bundle remains: .unexpected-skill' "$TMP/hidden.err"
test -f "$DST/.unexpected-skill/SKILL.md"
rm -rf "$DST/.unexpected-skill"

# Finder metadata is forbidden destination residue, not ignored parity.
printf 'metadata\n' >"$DST/gh-cli/.DS_Store"
echo 'must survive metadata rejection' >"$DST/git-workflow/preflight-sentinel"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/metadata.out" 2>"$TMP/metadata.err"; then
  echo "expected destination Finder metadata to fail before mutation" >&2
  exit 1
fi
grep -q 'Finder metadata is not allowed in destination skills: gh-cli/.DS_Store' "$TMP/metadata.err"
grep -q 'must survive metadata rejection' "$DST/git-workflow/preflight-sentinel"
rm "$DST/gh-cli/.DS_Store" "$DST/git-workflow/preflight-sentinel"

# Nested and top-level special files fail before rsync can delete them.
mkfifo "$DST/gh-cli/unexpected-pipe" "$DST/top-level-pipe"
echo 'must survive destination special-file rejection' >"$DST/git-workflow/preflight-sentinel"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/destination-special.out" 2>"$TMP/destination-special.err"; then
  echo "expected destination special files to fail before mutation" >&2
  exit 1
fi
grep -q 'Unsupported filesystem entry in destination skills: gh-cli/unexpected-pipe' "$TMP/destination-special.err"
grep -q 'Unsupported filesystem entry in destination skills: top-level-pipe' "$TMP/destination-special.err"
test -p "$DST/gh-cli/unexpected-pipe"
test -p "$DST/top-level-pipe"
grep -q 'must survive destination special-file rejection' "$DST/git-workflow/preflight-sentinel"
rm "$DST/gh-cli/unexpected-pipe" "$DST/top-level-pipe" "$DST/git-workflow/preflight-sentinel"

# A required bundle path with the wrong filesystem type fails before mutation.
rm -rf "$DST/change-review"
printf 'not a directory\n' >"$DST/change-review"
echo 'must survive required-path rejection' >"$DST/gh-cli/preflight-sentinel"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/required-file.out" 2>"$TMP/required-file.err"; then
  echo "expected required destination file to fail before mutation" >&2
  exit 1
fi
grep -q 'Required destination bundle is not a directory: change-review' "$TMP/required-file.err"
grep -q 'must survive required-path rejection' "$DST/gh-cli/preflight-sentinel"
rm "$DST/change-review" "$DST/gh-cli/preflight-sentinel"
make_bundle "$DST" change-review

# Dangling retired and required-bundle symlinks cannot evade verification.
ln -s "$DST/missing-engineering-bundle" "$DST/engineering-best-practices"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --check >"$TMP/dangling.out" 2>"$TMP/dangling.err"; then
  echo "expected dangling retired bundle symlink check to fail" >&2
  exit 1
fi
grep -q 'Retired destination bundle remains: engineering-best-practices' "$TMP/dangling.err"
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/remove-dangling.out"
test ! -e "$DST/engineering-best-practices"
test ! -L "$DST/engineering-best-practices"
rm -rf "$DST/change-review"
echo 'must survive rejected apply' >"$DST/gh-cli/preflight-sentinel"
ln -s "$DST/gh-cli" "$DST/change-review"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/destination-link.out" 2>"$TMP/destination-link.err"; then
  echo "expected required destination bundle symlink apply to fail before mutation" >&2
  exit 1
fi
grep -q 'Required destination bundle is a symlink: change-review' "$TMP/destination-link.err"
grep -q 'must survive rejected apply' "$DST/gh-cli/preflight-sentinel"
rm "$DST/change-review" "$DST/gh-cli/preflight-sentinel"
make_bundle "$DST" change-review

# Only the exact retired path is removable; nested retired-path symlinks fail.
make_bundle "$DST" engineering-best-practices
ln -s "$DST/missing-retired-child" "$DST/engineering-best-practices/nested-link"
echo 'must survive nested-link rejection' >"$DST/gh-cli/preflight-sentinel"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/retired-nested.out" 2>"$TMP/retired-nested.err"; then
  echo "expected nested retired-path symlink apply to fail before mutation" >&2
  exit 1
fi
grep -q 'Destination skill symlink is not allowed: engineering-best-practices/nested-link' "$TMP/retired-nested.err"
grep -q 'must survive nested-link rejection' "$DST/gh-cli/preflight-sentinel"
rm -rf "$DST/engineering-best-practices" "$DST/gh-cli/preflight-sentinel"

# Scan artifacts cannot be created inside the destination through TMPDIR.
echo 'must survive unsafe temporary root rejection' >"$DST/gh-cli/preflight-sentinel"
if TMPDIR="$DST" SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/tmpdir.out" 2>"$TMP/tmpdir.err"; then
  echo "expected destination-contained temporary root to fail before mutation" >&2
  exit 1
fi
grep -q 'Temporary directory must be outside the destination skill tree' "$TMP/tmpdir.err"
grep -q 'must survive unsafe temporary root rejection' "$DST/gh-cli/preflight-sentinel"
if find "$DST" -maxdepth 1 -name 'falryn-skill-sync.*' -print | grep -q .; then
  echo "temporary scan artifacts entered the destination" >&2
  exit 1
fi
rm "$DST/gh-cli/preflight-sentinel"

# Scan artifacts cannot be created inside the source through TMPDIR.
echo 'must survive source-contained temporary root rejection' >"$DST/gh-cli/preflight-sentinel"
if TMPDIR="$SRC" SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/source-tmpdir.out" 2>"$TMP/source-tmpdir.err"; then
  echo "expected source-contained temporary root to fail before mutation" >&2
  exit 1
fi
grep -q 'Temporary directory must be outside the source skill tree' "$TMP/source-tmpdir.err"
grep -q 'must survive source-contained temporary root rejection' "$DST/gh-cli/preflight-sentinel"
if find "$SRC" -maxdepth 1 -name 'falryn-skill-sync.*' -print | grep -q .; then
  echo "temporary scan artifacts entered the source" >&2
  exit 1
fi
rm "$DST/gh-cli/preflight-sentinel"

# Destination traversal failures fail closed before mutation and after apply.
REAL_FIND="$(command -v find)"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/find" <<'SH'
#!/bin/sh
if [ "${1-}" = "${FAIL_FIND_ROOT-}" ]; then
  if [ "${FAIL_FIND_INVENTORY-0}" = "1" ]; then
    if [ "${2-}" = "-mindepth" ]; then
      exit 73
    fi
  elif [ -z "${FAIL_AFTER_MARKER-}" ] || [ -e "$FAIL_AFTER_MARKER" ]; then
    exit 73
  fi
fi
exec "$REAL_FIND" "$@"
SH
chmod +x "$TMP/bin/find"
echo 'must survive failed destination scan' >"$DST/gh-cli/preflight-sentinel"
if PATH="$TMP/bin:$PATH" REAL_FIND="$REAL_FIND" FAIL_FIND_ROOT="$DST" \
  SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/find-preflight.out" 2>"$TMP/find-preflight.err"; then
  echo "expected destination preflight traversal failure" >&2
  exit 1
fi
grep -q 'Unable to inspect destination skill symlinks' "$TMP/find-preflight.err"
grep -q 'must survive failed destination scan' "$DST/gh-cli/preflight-sentinel"
rm "$DST/gh-cli/preflight-sentinel"
echo 'must survive failed inventory scan' >"$DST/gh-cli/preflight-sentinel"
if PATH="$TMP/bin:$PATH" REAL_FIND="$REAL_FIND" FAIL_FIND_ROOT="$DST" FAIL_FIND_INVENTORY=1 \
  SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/find-inventory.out" 2>"$TMP/find-inventory.err"; then
  echo "expected destination inventory traversal failure" >&2
  exit 1
fi
grep -q 'Unable to inspect destination skill inventory' "$TMP/find-inventory.err"
grep -q 'must survive failed inventory scan' "$DST/gh-cli/preflight-sentinel"
rm "$DST/gh-cli/preflight-sentinel"
echo 'post-apply scan marker' >"$SRC/gh-cli/post-apply-marker"
if PATH="$TMP/bin:$PATH" REAL_FIND="$REAL_FIND" FAIL_FIND_ROOT="$DST" \
  FAIL_AFTER_MARKER="$DST/gh-cli/post-apply-marker" \
  SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/find-verify.out" 2>"$TMP/find-verify.err"; then
  echo "expected post-apply destination traversal failure" >&2
  exit 1
fi
grep -q 'Unable to inspect destination skill symlinks' "$TMP/find-verify.err"
test -f "$DST/gh-cli/post-apply-marker"
rm "$SRC/gh-cli/post-apply-marker" "$DST/gh-cli/post-apply-marker"

# Source symlinks fail preflight before destination mutation.
rm -rf "$SRC/change-review"
ln -s "$SRC/gh-cli" "$SRC/change-review"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/source-link.out" 2>"$TMP/source-link.err"; then
  echo "expected source bundle symlink preflight to fail" >&2
  exit 1
fi
grep -q 'Source bundle contains a prohibited symlink: change-review' "$TMP/source-link.err"
rm "$SRC/change-review"
make_bundle "$SRC" change-review

# Non-regular source entries fail before destination mutation.
mkfifo "$SRC/gh-cli/unexpected-pipe"
echo 'must survive source special-file rejection' >"$DST/gh-cli/preflight-sentinel"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/source-special.out" 2>"$TMP/source-special.err"; then
  echo "expected non-regular source entry preflight to fail" >&2
  exit 1
fi
grep -q 'Source bundle contains an unsupported filesystem entry: gh-cli' "$TMP/source-special.err"
grep -q 'must survive source special-file rejection' "$DST/gh-cli/preflight-sentinel"
rm "$SRC/gh-cli/unexpected-pipe" "$DST/gh-cli/preflight-sentinel"

# A source directory named like Finder metadata is not silently excluded.
mkdir "$SRC/gh-cli/.DS_Store"
echo 'must survive invalid source metadata rejection' >"$DST/gh-cli/preflight-sentinel"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/source-metadata.out" 2>"$TMP/source-metadata.err"; then
  echo "expected invalid source Finder metadata to fail" >&2
  exit 1
fi
grep -q 'Source bundle contains unsupported Finder metadata: gh-cli' "$TMP/source-metadata.err"
grep -q 'must survive invalid source metadata rejection' "$DST/gh-cli/preflight-sentinel"
rmdir "$SRC/gh-cli/.DS_Store"
rm "$DST/gh-cli/preflight-sentinel"

# A mismatched entrypoint identity fails before synchronization.
python3 - "$SRC/gh-cli/SKILL.md" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace("name: gh-cli", "name: wrong"))
PY
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/identity.out" 2>"$TMP/identity.err"; then
  echo "expected identity preflight to fail" >&2
  exit 1
fi
grep -q "Source identity mismatch: gh-cli declares 'wrong'" "$TMP/identity.err"

printf 'sync-from-global tests passed\n'
