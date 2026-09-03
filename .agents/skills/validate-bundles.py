#!/usr/bin/env python3
"""Validate six vendored skill bundles and optional distributed-source parity."""

from __future__ import annotations

import argparse
import hashlib
import os
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
    "typescript-best-practices",
    "opentui-best-practices",
)
PROJECT = ("falryn-workflow",)
RETIRED = ("engineering-best-practices",)
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


def walk_entries(root: Path) -> list[Path]:
    entries: list[Path] = []
    traversal_errors: list[OSError] = []

    def record_error(error: OSError) -> None:
        traversal_errors.append(error)

    for directory, directory_names, file_names in os.walk(
        root,
        topdown=True,
        onerror=record_error,
        followlinks=False,
    ):
        directory_names.sort()
        file_names.sort()
        parent = Path(directory)
        entries.extend(parent / name for name in directory_names)
        entries.extend(parent / name for name in file_names)
    if traversal_errors:
        details = "; ".join(str(error) for error in traversal_errors)
        raise ValueError(f"unable to traverse {root}: {details}")
    return entries


def file_manifest(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in walk_entries(root):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise ValueError(f"filesystem symlink is not allowed: {path}")
        if path.name == ".DS_Store":
            if not path.is_file():
                raise ValueError(f"unsupported Finder metadata entry: {path}")
            continue
        if path.is_dir():
            result[f"directory:{relative}"] = ""
        elif path.is_file():
            result[f"file:{relative}"] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            raise ValueError(f"unsupported filesystem entry: {path}")
    return result


def validate_source_parity(source: Path, errors: list[str]) -> None:
    if ".." in source.parts:
        fail(errors, f"parity source path contains a parent segment: {source}")
        return
    try:
        if source.absolute() != source.resolve(strict=True):
            fail(errors, f"parity source root resolves through a symlink: {source}")
            return
    except OSError as error:
        fail(errors, f"unable to resolve parity source root {source}: {error}")
        return
    for skill in SKILLS:
        source_root = source / skill
        destination_root = ROOT / skill
        if not source_root.is_dir():
            fail(errors, f"missing parity source bundle: {skill}")
            continue
        source_links = [source_root] if source_root.is_symlink() else []
        source_links.extend(path for path in source_root.rglob("*") if path.is_symlink())
        if source_links:
            for path in source_links:
                fail(errors, f"parity source symlink is not allowed: {path}")
            continue
        try:
            source_manifest = file_manifest(source_root)
            destination_manifest = file_manifest(destination_root)
        except ValueError as error:
            fail(errors, str(error))
            continue
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

    try:
        root_entries = walk_entries(ROOT)
    except ValueError as error:
        fail(errors, str(error))
        root_entries = []

    for metadata in (path for path in root_entries if path.name == ".DS_Store"):
        fail(errors, f"Finder metadata is not allowed: {metadata.relative_to(ROOT)}")

    for path in root_entries:
        if path.is_symlink():
            fail(errors, f"vendored skill symlink is not allowed: {path.relative_to(ROOT)}")
        elif not path.is_dir() and not path.is_file():
            fail(errors, f"unsupported vendored filesystem entry: {path.relative_to(ROOT)}")

    actual_bundles = {
        path.name
        for path in ROOT.iterdir()
        if path.is_dir() and (path / "SKILL.md").is_file()
    }
    if actual_bundles != set(SKILLS):
        fail(errors, f"unexpected vendored skill inventory: {sorted(actual_bundles ^ set(SKILLS))}")

    for skill in RETIRED:
        if (ROOT / skill).exists() or (ROOT / skill).is_symlink():
            fail(errors, f"global-only bundle must not be vendored: {skill}")

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

    workflow_root = ROOT / "falryn-workflow"
    workflow_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(workflow_root.rglob("*.md"))
    ).lower()
    if "https://github.com/tyldra-org/falryn-docs" in workflow_text:
        fail(errors, "Falryn workflow must not require private HTTP documentation links")
    if "complete executable workflow" not in workflow_text:
        fail(errors, "Falryn workflow must declare its self-contained public contract")
    for required_access_term in (
        "public-only",
        "authenticated maintainer",
        "private-roadmap-unavailable",
        "private-update-required",
        "tyldra-org/falryn-docs",
        "roadmap project 1",
        "never clone it automatically",
        "do not print private document text",
    ):
        if required_access_term not in workflow_text:
            fail(errors, f"Falryn workflow is missing access outcome: {required_access_term}")

    workflow_contracts = {
        "plan.md": ("one public Falryn issue", "no required implementation fact may exist only there"),
        "implement.md": ("complete public issue handoff", "A private link cannot fill"),
        "review.md": ("current diff", "documentation verification as unavailable"),
        "verify.md": ("Public-only verification", "must not claim full delivery-bundle readiness"),
        "merge.md": ("A public-only application PR may merge only", "private maintainer authority is mandatory"),
        "next.md": ("Next unavailable", "Do not list, infer, or approximate private candidates"),
        "reporting.md": ("private Project fields", "private Roadmap unavailable"),
    }
    for filename, phrases in workflow_contracts.items():
        text = (workflow_root / "references" / filename).read_text(encoding="utf-8")
        for phrase in phrases:
            if phrase not in text:
                fail(errors, f"Falryn workflow {filename} is missing required contract: {phrase}")

    parent_delivery = (
        workflow_root / "references" / "parent-delivery.md"
    ).read_text(encoding="utf-8")
    if "first ordered, unblocked, incomplete child" not in parent_delivery or "never skips ahead" not in parent_delivery:
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
        validate_source_parity(args.source.expanduser(), errors)

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        print(f"skill bundle validation failed with {len(errors)} error(s)", file=sys.stderr)
        return 1

    parity = " with distributed-source parity" if args.source is not None else ""
    print(f"validated {len(SKILLS)} vendored skill bundles and {checked_links} local links{parity}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
