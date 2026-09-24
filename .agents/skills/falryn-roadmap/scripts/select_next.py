#!/usr/bin/env python3
"""Select from a captured Roadmap through its canonical, read-only auditor."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def key(issue: dict) -> str:
    return f"{issue['repository']}#{issue['number']}"


def release_catalog(snapshot: dict) -> list[str]:
    """Release milestone titles in their audited v<major>.<minor> decimal order."""
    titles = {milestone['title'] for entry in snapshot['milestones']
              for milestone in entry['milestones']}
    ordered = []
    for title in titles:
        match = re.match(r'v(\d+)\.(\d+)(?:\s|$)', title)
        if match:
            ordered.append((float(f'{match[1]}.{match[2]}'), title))
    return [title for _, title in sorted(ordered)]


def in_scope(issue: dict, scope: str | None, issues: dict) -> bool:
    if scope is None:
        return True
    seen = set()
    current = issue
    while current is not None and key(current) not in seen:
        identity = key(current)
        if identity == scope:
            return True
        seen.add(identity)
        parent = current['parent']
        current = issues.get(key(parent)) if parent else None
    return False


def select(snapshot: dict, report: dict, owner: str, scope: str | None,
           release: str | None, through: str | None = None) -> dict:
    """Inputs have passed the canonical parser and analyzer in main()."""
    if report['diagnostics']:
        return {'state': 'audit-failed', 'diagnosticCodes': sorted({
            item['code'] for item in report['diagnostics']
        })}
    issues = {key(issue): issue for issue in snapshot['issues']}
    if scope is not None and scope not in issues:
        raise ValueError('scope is absent from this snapshot')
    catalog = release_catalog(snapshot)
    if release is not None and release not in catalog:
        raise ValueError('target release is absent from this snapshot')
    releases = None if release is None else {release}
    if through is not None:
        if release is None or through not in catalog:
            raise ValueError('a release range needs two catalog bounds')
        start, end = catalog.index(release), catalog.index(through)
        if end < start:
            raise ValueError('release range is reversed in the audited catalog')
        releases = set(catalog[start:end + 1])
    skipped = {'outsideScope': 0, 'otherOwner': 0, 'blocked': 0}
    scoped_blockers = set()
    for entry in report['deliverySequence']:
        identity = f"{entry['repository']}#{entry['issueNumber']}"
        issue = issues[identity]
        if not in_scope(issue, scope, issues) or (
            releases is not None and entry['targetRelease'] not in releases
        ):
            skipped['outsideScope'] += 1
            continue
        if [name.casefold() for name in issue['assignees']] != [owner.casefold()]:
            skipped['otherOwner'] += 1
            continue
        blockers = [key(relation) for relation in issue['blockedBy']
                    if issues.get(key(relation), relation)['state'] == 'OPEN']
        if blockers:
            skipped['blocked'] += 1
            if scope is not None:
                scoped_blockers.update(blockers)
            continue
        decision = entry['readiness'] == 'Needs Decision'
        result = {
            'state': 'decision-required' if decision else 'candidate',
            'issue': identity,
            'position': entry['position'],
            'readiness': entry['readiness'],
            'owner': issue['assignees'][0],
            'pullRequestsToVerify': [key(pr) for pr in issue['closingPullRequests']
                                     if pr['state'] == 'OPEN'],
            'skipped': skipped,
        }
        if decision:
            # Match the complete request accepted by roadmap-governance.ts.
            match = re.search(r'^Decision required:\s+(@[A-Za-z0-9-]+)\s+—\s+\S',
                              issue['body'], re.MULTILINE | re.IGNORECASE)
            result['decisionOwner'] = match[1] if match else None
        return result
    return {'state': 'none', 'skipped': skipped,
            'scopedOpenPrerequisites': sorted(scoped_blockers)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--falryn-root', type=Path, required=True,
                        help='Trusted, identity-verified Falryn checkout')
    parser.add_argument('--snapshot', type=Path, required=True,
                        help='Private schema-v4 Roadmap snapshot; never fetched by this helper')
    parser.add_argument('--owner', required=True, help='Verified authenticated GitHub login')
    parser.add_argument('--scope', help='Exact owner/repository#N issue or parent tree')
    parser.add_argument('--target-release', help='Exact release milestone title')
    parser.add_argument('--through-release', help='Inclusive end of an audited release range')
    args = parser.parse_args()
    try:
        root = args.falryn_root.resolve(strict=True)
        path = args.snapshot.resolve(strict=True)
        if not args.owner.strip() or args.owner != args.owner.strip():
            raise ValueError('owner must be a non-empty login without surrounding whitespace')
        if path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError('snapshot exceeds the 64 MiB selection limit')
        before = path.read_bytes()
        audit = subprocess.run(
            ['bun', 'run', 'audit:roadmap', '--', '--snapshot', str(path), '--json'],
            cwd=root, capture_output=True, text=True, timeout=60,
        )
        if path.read_bytes() != before:
            raise ValueError('snapshot changed during audit; capture or select again')
        if audit.returncode not in (0, 1):
            raise ValueError('Roadmap audit could not complete; run its command for diagnostics')
        try:
            report = json.loads(audit.stdout)
        except json.JSONDecodeError as error:
            raise ValueError('Roadmap audit did not return JSON; run its command for diagnostics') from error
        if audit.returncode != 0 and not report.get('diagnostics'):
            raise ValueError('Roadmap audit failed without a diagnostic report')
        snapshot = json.loads(before)
        result = select(snapshot, report, args.owner, args.scope,
                        args.target_release, args.through_release)
        result.update(generatedAt=snapshot['generatedAt'],
                      snapshotSha256=hashlib.sha256(before).hexdigest())
        print(json.dumps(result, indent=2))
        return 1 if result['state'] == 'audit-failed' else 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f'Next selection unavailable: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
