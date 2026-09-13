#!/usr/bin/env python3
"""Validate the distributed Falryn skill pair and its local reference graph."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
from urllib.parse import unquote

BUNDLES = ('falryn-work', 'falryn-roadmap')
LINK = re.compile(r'\[[^\]]+\]\(([^)]+)\)')
HEADING = re.compile(r'^#{1,6}\s+(.+?)\s*$', re.MULTILINE)
HOME_PATH = re.compile(r'(?:^|[`\s(])(?:/(?:Users|home)/|[A-Za-z]:\\Users\\)')
PRIVATE_LINK = re.compile(r'https?://github\.com/tyldra-org/falryn-docs(?:[/)#]|$)', re.I)


def slug(text: str) -> str:
    text = re.sub(r'<[^>]+>', '', text.strip().lower())
    text = re.sub(r'[^\w\- ]', '', text)
    return re.sub(r'[\s\-]+', '-', text).strip('-')


def validate(parent: Path) -> list[str]:
    parent = parent.resolve()
    roots = tuple(parent / name for name in BUNDLES)
    errors = []
    markdown = {}
    for root in roots:
        if root.is_symlink() or not root.is_dir():
            errors.append(f'{root.name}: missing real skill directory')
            continue
        unexpected = {p.name for p in root.iterdir()} - {
            'SKILL.md', 'references', 'scripts', '.gitignore',
        }
        if unexpected:
            errors.append(f'{root.name}: unexpected entries {sorted(unexpected)}')
        for path in root.rglob('*'):
            if path.is_symlink() or path.name in {'.DS_Store', '__pycache__'}:
                errors.append(f'{path.relative_to(parent)}: symlink or generated debris')
        entry = root / 'SKILL.md'
        if not entry.is_file() or entry.is_symlink():
            errors.append(f'{root.name}: missing SKILL.md')
            continue
        files = [entry, *sorted((root / 'references').rglob('*.md'))]
        for path in files:
            if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != parent):
                continue
            markdown[path] = path.read_text(encoding='utf-8')
        body = markdown.get(entry, '')
        front = re.match(r'\A---\n(.*?)\n---\n', body, re.S)
        if not front:
            errors.append(f'{root.name}: missing closed frontmatter')
        else:
            fields = dict(re.findall(r'^([a-z_-]+):\s*(.*)$', front[1], re.M))
            if set(fields) != {'name', 'description'} or fields.get('name') != root.name or not fields.get('description'):
                errors.append(f'{root.name}: invalid name/description frontmatter')
    edges = {path: set() for path in markdown}
    for source, body in markdown.items():
        label = source.relative_to(parent)
        if HOME_PATH.search(body):
            errors.append(f'{label}: machine-specific home path')
        for raw in LINK.findall(body):
            if PRIVATE_LINK.search(raw):
                errors.append(f'{label}: private repository dependency')
            if raw.startswith(('https://', 'http://', 'mailto:')):
                continue
            target = re.split(r'\s+[\"\']', raw.strip(), maxsplit=1)[0]
            name, _, anchor = target.partition('#')
            destination = (source.parent / unquote(name)).resolve() if name else source
            if not any(destination == root or root in destination.parents for root in roots):
                errors.append(f'{label}: link leaves Falryn pair: {raw}')
                continue
            if not destination.is_file():
                errors.append(f'{label}: missing link: {raw}')
                continue
            if destination in edges:
                edges[source].add(destination)
            if anchor and unquote(anchor) not in {slug(h) for h in HEADING.findall(destination.read_text())}:
                errors.append(f'{label}: missing anchor: {raw}')
    reached = set()
    pending = [root / 'SKILL.md' for root in roots if root / 'SKILL.md' in markdown]
    while pending:
        path = pending.pop()
        if path not in reached:
            reached.add(path)
            pending.extend(edges[path] - reached)
    for path in markdown.keys() - reached:
        errors.append(f'{path.relative_to(parent)}: unreachable reference')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skills-root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    errors = validate(args.skills_root)
    for error in errors:
        print(f'ERROR: {error}')
    if errors:
        return 1
    print('Falryn skill pair validation passed: entrypoints, references, links and public boundaries')
    return 0


if __name__ == '__main__':
    sys.exit(main())
