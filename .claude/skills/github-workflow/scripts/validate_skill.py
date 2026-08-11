#!/usr/bin/env python3
"""Validate github-workflow structure, routing, links, and agent metadata."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)
ALLOWED_ROOT_ENTRIES = {"SKILL.md", "agents", "reference", "scripts"}


def slugify(heading: str) -> str:
    heading = re.sub(r"<[^>]+>", "", heading.strip().lower())
    heading = re.sub(r"[^\w\- ]", "", heading, flags=re.UNICODE)
    return re.sub(r"[\s\-]+", "-", heading).strip("-")


def split_target(raw_target: str) -> tuple[str, str]:
    target = raw_target.strip()
    target = re.split(r"""\s+["']""", target, maxsplit=1)[0]
    path_text, separator, anchor = target.partition("#")
    return unquote(path_text), unquote(anchor) if separator else ""


def main() -> int:
    errors: list[str] = []

    if not SKILL.is_file():
        print(f"ERROR: missing {SKILL}")
        return 1

    root_entries = {path.name for path in ROOT.iterdir()}
    unexpected = sorted(root_entries - ALLOWED_ROOT_ENTRIES)
    if unexpected:
        errors.append(f"unexpected root entries: {', '.join(unexpected)}")

    skill_text = SKILL.read_text(encoding="utf-8")
    if not skill_text.startswith("---\n"):
        errors.append("SKILL.md is missing YAML frontmatter")
    else:
        _, frontmatter, _ = skill_text.split("---", maxsplit=2)
        keys = {
            match.group(1)
            for line in frontmatter.splitlines()
            if (match := re.match(r"^([A-Za-z0-9_-]+):", line))
        }
        if keys != {"name", "description"}:
            errors.append(
                "SKILL.md frontmatter must contain only name and description"
            )
        if "name: github-workflow" not in frontmatter:
            errors.append("SKILL.md name must be github-workflow")

    markdown_files = [SKILL, *sorted((ROOT / "reference").glob("*.md"))]
    linked_references: set[Path] = set()

    for source in markdown_files:
        text = source.read_text(encoding="utf-8")
        for raw_target in LINK_RE.findall(text):
            if raw_target.startswith(("http://", "https://", "mailto:")):
                continue

            path_text, anchor = split_target(raw_target)
            destination = (
                source
                if not path_text
                else (source.parent / path_text).resolve()
            )

            if not destination.is_file():
                errors.append(
                    f"{source.relative_to(ROOT)} links to missing {raw_target}"
                )
                continue

            if source == SKILL and destination.parent == ROOT / "reference":
                linked_references.add(destination)

            if anchor:
                headings = {
                    slugify(heading)
                    for heading in HEADING_RE.findall(
                        destination.read_text(encoding="utf-8")
                    )
                }
                if anchor not in headings:
                    errors.append(
                        f"{source.relative_to(ROOT)} links to missing anchor "
                        f"{raw_target}"
                    )

    reference_files = set((ROOT / "reference").glob("*.md"))
    unlinked = sorted(reference_files - linked_references)
    if unlinked:
        errors.append(
            "references not linked directly from SKILL.md: "
            + ", ".join(path.name for path in unlinked)
        )

    metadata = ROOT / "agents" / "openai.yaml"
    if not metadata.is_file():
        errors.append("missing agents/openai.yaml")
    elif "$github-workflow" not in metadata.read_text(encoding="utf-8"):
        errors.append("agents/openai.yaml default prompt must mention $github-workflow")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print(
        "github-workflow validation passed: "
        f"{len(reference_files)} references, {len(markdown_files)} Markdown files"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
