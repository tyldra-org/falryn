#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/source"
DST="$TMP/destination"
SKILLS=(gh-cli git-workflow change-review engineering-best-practices typescript-best-practices opentui-best-practices falryn-workflow)
mkdir -p "$SRC" "$DST"
cp "$SCRIPT_DIR/sync-from-global.sh" "$DST/sync-from-global.sh"
chmod +x "$DST/sync-from-global.sh"

make_bundle() {
  local root="$1"
  local skill="$2"
  mkdir -p "$root/$skill"
  printf -- '---\nname: %s\ndescription: fixture\n---\n\n# %s\n' "$skill" "$skill" > "$root/$skill/SKILL.md"
}

for skill in "${SKILLS[@]}"; do
  make_bundle "$SRC" "$skill"
  make_bundle "$DST" "$skill"
done

# Missing input fails before changing any destination bundle.
printf 'preserve\n' > "$DST/change-review/sentinel.txt"
rm -rf "$SRC/opentui-best-practices"
if SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/missing.out" 2>"$TMP/missing.err"; then
  echo "expected missing-source preflight to fail" >&2
  exit 1
fi
grep -q 'Missing required source bundle: opentui-best-practices' "$TMP/missing.err"
test -f "$DST/change-review/sentinel.txt"
make_bundle "$SRC" opentui-best-practices

# Preview reports differences but does not mutate.
printf 'source-only\n' > "$SRC/gh-cli/value.txt"
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" >"$TMP/preview.out"
grep -q 'sync: gh-cli' "$TMP/preview.out"
test ! -e "$DST/gh-cli/value.txt"

# Apply copies updates, deletes stale files, and verifies exact parity.
printf 'stale\n' > "$DST/git-workflow/stale.txt"
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --apply >"$TMP/apply.out"
grep -q 'synced and verified' "$TMP/apply.out"
test -f "$DST/gh-cli/value.txt"
test ! -e "$DST/git-workflow/stale.txt"

# Check mode is read-only and succeeds only at exact parity.
SKILLS_SRC="$SRC" "$DST/sync-from-global.sh" --check >"$TMP/check.out"
grep -q 'all seven source and vendored skill bundles match' "$TMP/check.out"

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
