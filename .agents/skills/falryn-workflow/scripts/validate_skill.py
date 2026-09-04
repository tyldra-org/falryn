#!/usr/bin/env python3
"""Validate falryn-workflow structure, routing, privacy, and local links."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
REFERENCES = ROOT / "references"
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)
MACHINE_PATH_RE = re.compile(r"(?:^|[`\s(])(?:/(?:Users|home)/|[A-Za-z]:\\Users\\)")
PRIVATE_LINK_RE = re.compile(
    r"\[[^\]]+\]\(https?://github\.com/tyldra-org/falryn-docs(?:[/)#]|$)",
    re.IGNORECASE,
)
ALLOWED_ROOT_ENTRIES = {"SKILL.md", "references", "scripts"}
IGNORED_ROOT_ENTRIES = {".gitignore"}
REQUIRED_REFERENCES = {
    "corrections.md",
    "deliver.md",
    "documentation-delivery.md",
    "governance-audits.md",
    "implement.md",
    "issue-governance.md",
    "merge.md",
    "next.md",
    "parent-delivery.md",
    "plan.md",
    "private-authority.md",
    "roadmap-fields.md",
    "reporting.md",
    "review.md",
    "targets-and-transitions.md",
    "verify.md",
}
REQUIRED_ENTRYPOINT_MARKERS = {
    "## Request classification",
    "## Route one mode",
    "## Access boundary",
    "## Non-negotiable boundaries",
    "## Reporting",
    "## Distribution",
}


def slugify(heading: str) -> str:
    heading = re.sub(r"<[^>]+>", "", heading.strip().lower())
    heading = re.sub(r"[^\w\- ]", "", heading, flags=re.UNICODE)
    return re.sub(r"[\s\-]+", "-", heading).strip("-")


def split_target(raw_target: str) -> tuple[str, str]:
    target = raw_target.strip()
    target = re.split(r"\s+[\"']", target, maxsplit=1)[0]
    path_text, separator, anchor = target.partition("#")
    return unquote(path_text), unquote(anchor) if separator else ""


def inside_root(path: Path) -> bool:
    try:
        path.relative_to(ROOT)
        return True
    except ValueError:
        return False


def validate_frontmatter(text: str, errors: list[str]) -> None:
    if not text.startswith("---\n") or text.count("---") < 2:
        errors.append("SKILL.md is missing closed YAML frontmatter")
        return
    _, frontmatter, _ = text.split("---", maxsplit=2)
    keys = {
        match.group(1)
        for line in frontmatter.splitlines()
        if (match := re.match(r"^([A-Za-z0-9_-]+):", line))
    }
    if keys != {"name", "description"}:
        errors.append("SKILL.md frontmatter must contain only name and description")
    if "name: falryn-workflow" not in frontmatter:
        errors.append("SKILL.md name must be falryn-workflow")


def main() -> int:
    errors: list[str] = []

    if not SKILL.is_file():
        print(f"ERROR: missing {SKILL}")
        return 1

    root_entries = {path.name for path in ROOT.iterdir()} - IGNORED_ROOT_ENTRIES
    unexpected = sorted(root_entries - ALLOWED_ROOT_ENTRIES)
    if unexpected:
        errors.append(f"unexpected root entries: {', '.join(unexpected)}")

    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if path.is_symlink():
            errors.append(f"symlink is not allowed: {relative}")
        if path.name in {".DS_Store", "__pycache__"}:
            errors.append(f"generated debris is not allowed: {relative}")

    skill_text = SKILL.read_text(encoding="utf-8")
    validate_frontmatter(skill_text, errors)
    for marker in sorted(REQUIRED_ENTRYPOINT_MARKERS):
        if marker not in skill_text:
            errors.append(f"SKILL.md is missing required section: {marker}")

    reference_files = set(REFERENCES.glob("*.md"))
    reference_names = {path.name for path in reference_files}
    if reference_names != REQUIRED_REFERENCES:
        missing = sorted(REQUIRED_REFERENCES - reference_names)
        extra = sorted(reference_names - REQUIRED_REFERENCES)
        if missing:
            errors.append(f"missing required references: {', '.join(missing)}")
        if extra:
            errors.append(f"unregistered references: {', '.join(extra)}")

    markdown_files = [SKILL, *sorted(reference_files)]
    linked_references: set[Path] = set()
    for source in markdown_files:
        text = source.read_text(encoding="utf-8")
        relative_source = source.relative_to(ROOT)
        if MACHINE_PATH_RE.search(text):
            errors.append(f"{relative_source} contains a machine-specific home path")
        if PRIVATE_LINK_RE.search(text):
            errors.append(f"{relative_source} depends on a private repository link")

        for raw_target in LINK_RE.findall(text):
            if raw_target.startswith(("http://", "https://", "mailto:")):
                continue
            path_text, anchor = split_target(raw_target)
            destination = source if not path_text else (source.parent / path_text).resolve()
            if not inside_root(destination):
                errors.append(f"{relative_source} links outside the bundle: {raw_target}")
                continue
            if not destination.is_file():
                errors.append(f"{relative_source} links to missing {raw_target}")
                continue
            if source == SKILL and destination.parent == REFERENCES:
                linked_references.add(destination)
            if anchor:
                headings = {
                    slugify(heading)
                    for heading in HEADING_RE.findall(destination.read_text(encoding="utf-8"))
                }
                if anchor not in headings:
                    errors.append(f"{relative_source} links to missing anchor {raw_target}")

    unlinked = sorted(reference_files - linked_references)
    if unlinked:
        errors.append(
            "references not linked directly from SKILL.md: "
            + ", ".join(path.name for path in unlinked)
        )

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print(
        "falryn-workflow validation passed: "
        f"{len(reference_files)} references, {len(markdown_files)} Markdown files"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
