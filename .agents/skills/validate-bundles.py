#!/usr/bin/env python3
"""Validate the seven vendored skill bundles and optional source parity."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
PORTABLE = (
    "gh-cli",
    "git-workflow",
    "change-review",
    "engineering-best-practices",
    "typescript-best-practices",
    "opentui-best-practices",
)
PROJECT = ("falryn-workflow",)
SKILLS = PORTABLE + PROJECT
FORBIDDEN_PORTABLE = (
    "falryn",
    "tyldra",
    "yogeshprasad",
    "current-state.md",
    "documentation-map.md",
    "/users/",
)
LOCAL_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def declared_name(path: Path) -> str | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None
    match = re.search(r"(?m)^name:\s*([^\s]+)\s*$", text[4:end])
    return match.group(1) if match else None


def strip_fences(text: str) -> str:
    return re.sub(r"(?:```|~~~).*?(?:```|~~~)", "", text, flags=re.DOTALL)


def heading_slug(heading: str) -> str:
    without_markup = re.sub(r"<[^>]+>|[`*_~]", "", heading).strip().lower()
    allowed = "".join(
        character
        for character in without_markup
        if character in {" ", "-", "_"}
        or unicodedata.category(character).startswith(("L", "N"))
    )
    return re.sub(r"\s+", "-", allowed)


def heading_anchors(path: Path) -> set[str]:
    anchors: set[str] = set()
    occurrences: dict[str, int] = {}
    text = strip_fences(path.read_text(encoding="utf-8"))
    for match in re.finditer(r"(?m)^#{1,6}\s+(.+?)\s*#*\s*$", text):
        base = heading_slug(match.group(1))
        occurrence = occurrences.get(base, 0)
        occurrences[base] = occurrence + 1
        anchors.add(base if occurrence == 0 else f"{base}-{occurrence}")
    return anchors


def validate_links(root: Path, errors: list[str]) -> int:
    checked = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".md", ".mdx"}:
            continue
        for raw in LOCAL_LINK.findall(strip_fences(path.read_text(encoding="utf-8"))):
            target = raw.strip().split(' "', 1)[0].split(" '", 1)[0]
            if target.startswith(("http://", "https://", "mailto:", "/")):
                continue
            relative, separator, fragment = target.partition("#")
            target_path = path if not relative else (path.parent / relative).resolve()
            checked += 1
            if not target_path.exists():
                fail(errors, f"broken local link: {path.relative_to(ROOT)} -> {target}")
                continue
            if separator and fragment and target_path.suffix.lower() in {".md", ".mdx"}:
                anchor = unquote(fragment).lower()
                if anchor not in heading_anchors(target_path):
                    fail(errors, f"broken local anchor: {path.relative_to(ROOT)} -> {target}")
    return checked


def file_manifest(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name == ".DS_Store":
            continue
        relative = path.relative_to(root).as_posix()
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def validate_source_parity(source: Path, errors: list[str]) -> None:
    for skill in SKILLS:
        source_root = source / skill
        destination_root = ROOT / skill
        if not source_root.is_dir():
            fail(errors, f"missing parity source bundle: {skill}")
            continue
        source_manifest = file_manifest(source_root)
        destination_manifest = file_manifest(destination_root)
        if source_manifest != destination_manifest:
            source_only = sorted(source_manifest.keys() - destination_manifest.keys())
            destination_only = sorted(destination_manifest.keys() - source_manifest.keys())
            changed = sorted(
                key
                for key in source_manifest.keys() & destination_manifest.keys()
                if source_manifest[key] != destination_manifest[key]
            )
            fail(
                errors,
                f"parity mismatch {skill}: source-only={source_only}, "
                f"destination-only={destination_only}, changed={changed}",
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        help="optional source skill directory for exact SHA-256 parity",
    )
    args = parser.parse_args()
    errors: list[str] = []

    for metadata in ROOT.rglob(".DS_Store"):
        fail(errors, f"Finder metadata is not allowed: {metadata.relative_to(ROOT)}")

    for skill in SKILLS:
        skill_root = ROOT / skill
        entrypoint = skill_root / "SKILL.md"
        if not skill_root.is_dir() or not entrypoint.is_file():
            fail(errors, f"missing required bundle or entrypoint: {skill}")
            continue
        if declared_name(entrypoint) != skill:
            fail(errors, f"entrypoint identity mismatch: {skill}")
        nested = [path for path in skill_root.rglob("SKILL.md") if path != entrypoint]
        for path in nested:
            fail(errors, f"nested skill entrypoint is not allowed: {path.relative_to(ROOT)}")
        for guide in skill_root.rglob("GUIDE.md"):
            if declared_name(guide) is not None:
                fail(errors, f"internal guide declares a skill identity: {guide.relative_to(ROOT)}")

    for skill in PORTABLE:
        root = ROOT / skill
        text = "\n".join(
            path.read_text(encoding="utf-8", errors="replace")
            for path in sorted(root.rglob("*"))
            if path.is_file() and path.name != ".DS_Store"
        ).lower()
        for forbidden in FORBIDDEN_PORTABLE:
            if forbidden in text:
                fail(errors, f"portable bundle {skill} contains forbidden text: {forbidden}")

    git_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((ROOT / "git-workflow").rglob("*.md"))
    ).lower()
    for retired_policy in (
        "autocommit is on by default",
        "for this user's default subject-only policy",
        "never create or preserve a commit body",
        "recreated commits are always subject-only",
        "sed -i ''",
    ):
        if retired_policy in git_text:
            fail(errors, f"retired Git policy remains: {retired_policy}")

    release_lines = (
        ROOT / "gh-cli" / "process" / "release.md"
    ).read_text(encoding="utf-8").splitlines()
    for line in release_lines:
        if "gh release create" in line and "--draft" not in line:
            fail(errors, "every documented release-create command must remain a draft")

    parent_delivery = (
        ROOT / "falryn-workflow" / "references" / "parent-delivery.md"
    ).read_text(encoding="utf-8")
    if "first ordered, unblocked," not in parent_delivery or "never skips ahead" not in parent_delivery:
        fail(errors, "parent delivery must retain canonical ordered-child planning semantics")

    stale_paths = (
        ROOT / "gh-cli" / "reference",
        ROOT / "opentui-best-practices" / "modules" / "opentui-extended",
        ROOT / "typescript-best-practices" / "modules" / "typescript-pro",
        ROOT / "typescript-best-practices" / "modules" / "typescript-expert",
        ROOT / "typescript-best-practices" / "modules" / "typescript-toolkit",
    )
    for path in stale_paths:
        if path.exists():
            fail(errors, f"retired duplicate path still exists: {path.relative_to(ROOT)}")

    expected_ts_modules = {
        "nextjs-react-typescript",
        "typescript",
        "typescript-advanced-types",
        "typescript-best-practices",
        "typescript-docs",
        "typescript-react-reviewer",
    }
    actual_ts_modules = {
        path.name
        for path in (ROOT / "typescript-best-practices" / "modules").iterdir()
        if path.is_dir()
    }
    if actual_ts_modules != expected_ts_modules:
        fail(errors, f"unexpected TypeScript modules: {sorted(actual_ts_modules ^ expected_ts_modules)}")

    opentui = ROOT / "opentui-best-practices"
    docs = sorted((opentui / "docs").rglob("*.mdx"))
    if len(docs) != 76:
        fail(errors, f"OpenTUI snapshot must contain 76 MDX files, found {len(docs)}")
    provenance = (opentui / "UPSTREAM.md").read_text(encoding="utf-8")
    for expected in (
        "v0.5.9",
        "df2fc1594bb7a1274fc490155305e3d9f61f1b01",
        "packages/web/src/content/docs/",
        "LICENSE.opentui",
    ):
        if expected not in provenance:
            fail(errors, f"OpenTUI provenance is missing: {expected}")
    if not (opentui / "LICENSE.opentui").is_file():
        fail(errors, "OpenTUI upstream license is missing")

    checked_links = validate_links(ROOT, errors)
    if args.source is not None:
        validate_source_parity(args.source.expanduser().resolve(), errors)

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        print(f"skill bundle validation failed with {len(errors)} error(s)", file=sys.stderr)
        return 1

    parity = " with source parity" if args.source is not None else ""
    print(f"validated {len(SKILLS)} skill bundles and {checked_links} local links{parity}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
