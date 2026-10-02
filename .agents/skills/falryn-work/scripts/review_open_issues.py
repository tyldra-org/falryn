#!/usr/bin/env python3
"""Search every open issue in the Falryn repositories for a change's terms.

The issue-contract review reads every open issue once per repository and then
the matches in full. This makes the "every open issue, both repositories" step
mechanical: it reports how many issues each repository had, so a review that
skipped a repository or used a partial list is visible in its own output.
Issue bodies stay in memory or in the caller's private --input directory.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_REPOS = ('tyldra-org/falryn', 'tyldra-org/falryn-docs')
LIMIT = 1000


def fetch(repo: str) -> list[dict]:
    out = subprocess.run(
        ['gh', 'issue', 'list', '-R', repo, '--state', 'open', '--limit', str(LIMIT),
         '--json', 'number,title,body'],
        check=True, capture_output=True, text=True,
    ).stdout
    issues = json.loads(out)
    if len(issues) >= LIMIT:
        raise SystemExit(f'{repo}: {LIMIT}+ open issues; the list may be incomplete')
    return issues


def load(repo: str, directory: Path) -> list[dict]:
    return json.loads((directory / (repo.replace('/', '__') + '.json')).read_text())


def patterns(terms: list[str], issues: list[str]) -> list[re.Pattern]:
    found = [re.compile(term, re.IGNORECASE) for term in terms]
    found += [re.compile(rf'#{number}\b') for number in issues]
    return found


def review(repo: str, issues: list[dict], compiled: list[re.Pattern], lines: int) -> list[dict]:
    matches = []
    for issue in issues:
        text = f"{issue['title']}\n{issue.get('body') or ''}"
        hits = [p.pattern for p in compiled if p.search(text)]
        if not hits:
            continue
        excerpts = [line.strip()[:200] for line in text.splitlines()
                    if any(p.search(line) for p in compiled)][:lines]
        matches.append({'repo': repo, 'number': issue['number'], 'title': issue['title'],
                        'score': len(hits), 'terms': hits, 'lines': excerpts})
    return matches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', action='append', help='repository; defaults to both Falryn repositories')
    parser.add_argument('--term', action='append', default=[], help='case-insensitive regular expression')
    parser.add_argument('--issue', action='append', default=[], help='issue number whose references count as matches')
    parser.add_argument('--input', type=Path, help='directory of previously fetched <owner>__<repo>.json files')
    parser.add_argument('--lines', type=int, default=3, help='matching lines shown per issue')
    parser.add_argument('--json', action='store_true', help='print the report as JSON')
    args = parser.parse_args(argv)
    if not args.term and not args.issue:
        parser.error('give at least one --term or --issue')
    repos = args.repo or list(DEFAULT_REPOS)
    compiled = patterns(args.term, args.issue)
    searched, matches = [], []
    for repo in repos:
        issues = load(repo, args.input) if args.input else fetch(repo)
        searched.append({'repo': repo, 'open': len(issues)})
        matches += review(repo, issues, compiled, args.lines)
    matches.sort(key=lambda m: (-m['score'], m['repo'], m['number']))
    if args.json:
        print(json.dumps({'searched': searched, 'matches': matches}, indent=2))
        return 0
    for entry in searched:
        print(f"searched {entry['repo']}: {entry['open']} open issues")
    print(f'{len(matches)} matching issues; read each relevant one in full')
    for m in matches:
        print(f"{m['score']} {m['repo']}#{m['number']} {m['title']}")
        for line in m['lines']:
            print(f'    {line}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

