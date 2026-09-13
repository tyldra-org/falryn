#!/usr/bin/env python3
"""Exercise the selector CLI with the real Falryn auditor and synthetic data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPOSITORY = 'tyldra-org/falryn'
DOCS = 'tyldra-org/falryn-docs'
STAMP = '2026-09-03T00:00:00.000Z'
ROOT = None
CONTRACT = None


def issue(number, owner='maintainer', readiness='Needs Planning', repository=REPOSITORY):
    return {
        'repository': repository, 'number': number, 'title': f'Synthetic work {number}',
        'body': '## Outcome\nTest the selector.\n\n## Relationship\n'
                'Planning relationship: Standalone-v1.\n\n## Ready checklist\n'
                '- [x] Verify the fixture.\n',
        'state': 'OPEN', 'createdAt': STAMP, 'updatedAt': STAMP, 'closedAt': None,
        'assignees': [owner], 'labels': ['type: infrastructure', 'area: docs'],
        'parent': None, 'subIssues': [], 'blockedBy': [], 'closingPullRequests': [],
        'projectItems': [{'id': f'{repository}-{number}', 'status': 'Todo',
                          'statusUpdatedAt': STAMP, 'priority': 'P2', 'readiness': readiness,
                          'targetRelease': 'Synthetic A', 'releaseException': None}],
    }


def relation(item):
    return {name: item[name] for name in ('repository', 'number', 'state')}


def snapshot(issues):
    return {
        **CONTRACT, 'schemaVersion': 3, 'generatedAt': STAMP,
        'projectOwner': 'tyldra-org', 'projectNumber': 1, 'projectId': 'synthetic-project',
        'projectPublic': False, 'repositories': [REPOSITORY, DOCS],
        'repositoryIssueCounts': [{'repository': repo,
                                  'count': sum(i['repository'] == repo for i in issues)}
                                 for repo in (REPOSITORY, DOCS)],
        'targetReleaseOptions': [{'name': f'Synthetic {name}', 'description': 'State: OPEN',
                                  'color': 'BLUE'} for name in ('A', 'B')],
        'issues': issues, 'nonIssueProjectItems': [],
    }


class SelectionTests(unittest.TestCase):
    def run_selection(self, data, *args, expected_code=0):
        with tempfile.TemporaryDirectory(prefix='falryn-next-test-') as directory:
            path = Path(directory) / 'roadmap.json'
            path.write_text(json.dumps(data))
            before = path.read_bytes()
            run = subprocess.run(
                [sys.executable, '-B', str(Path(__file__).with_name('select_next.py')),
                 '--falryn-root', str(ROOT), '--snapshot', str(path), '--owner', 'maintainer',
                 *args], capture_output=True, text=True, timeout=70,
            )
            self.assertEqual(run.returncode, expected_code, run.stdout + run.stderr)
            self.assertEqual(path.read_bytes(), before, 'selection modified its input')
            return json.loads(run.stdout) if run.stdout else run.stderr

    def test_skips_other_owner_and_open_blocker_then_keeps_planning(self):
        other, blocked, planning, ready = [issue(n) for n in range(1, 5)]
        other['assignees'] = ['another-owner']
        blocked['blockedBy'] = [relation(other)]
        ready['projectItems'][0]['readiness'] = 'Ready'
        result = self.run_selection(snapshot([other, blocked, planning, ready]))
        self.assertEqual(result['issue'], f'{REPOSITORY}#3')
        self.assertEqual(result['position'], 3)
        self.assertEqual(result['skipped'], {'outsideScope': 0, 'otherOwner': 1, 'blocked': 1})

    def test_decision_stops_before_ready(self):
        decision = issue(1, readiness='Needs Decision')
        decision['body'] += '\nDecision required: @human — Choose the contract.\n'
        result = self.run_selection(snapshot([decision, issue(2, readiness='Ready')]))
        self.assertEqual(result['state'], 'decision-required')
        self.assertEqual(result['decisionOwner'], '@human')
        self.assertEqual(result['issue'], f'{REPOSITORY}#1')

    def test_scope_does_not_expand_to_prerequisite(self):
        prerequisite, target = issue(1), issue(2)
        target['blockedBy'] = [relation(prerequisite)]
        result = self.run_selection(snapshot([prerequisite, target]), '--scope', f'{REPOSITORY}#2')
        self.assertEqual(result['state'], 'none')
        self.assertEqual(result['scopedOpenPrerequisites'], [f'{REPOSITORY}#1'])

    def test_decision_owner_comes_from_the_audited_complete_request(self):
        decision = issue(1, readiness='Needs Decision')
        decision['body'] += ('\nDecision required: @stale —invalid\n'
                             'Decision required: @human — Choose the contract.\n')
        result = self.run_selection(snapshot([decision]))
        self.assertEqual(result['state'], 'decision-required')
        self.assertEqual(result['decisionOwner'], '@human')

    def test_parent_scope_selects_child_without_renumbering(self):
        outside, parent, child = issue(1), issue(2, readiness='Parent'), issue(3)
        outside['projectItems'][0]['priority'] = 'P1'
        parent['subIssues'] = [relation(child)]
        child['parent'] = relation(parent)
        child['body'] = child['body'].replace('Planning relationship: Standalone-v1.', '')
        result = self.run_selection(snapshot([outside, parent, child]), '--scope', f'{REPOSITORY}#2')
        self.assertEqual(result['issue'], f'{REPOSITORY}#3')
        self.assertEqual(result['position'], 2)

    def test_release_filter_preserves_order(self):
        first, second = issue(1), issue(2)
        second['projectItems'][0]['targetRelease'] = 'Synthetic B'
        result = self.run_selection(snapshot([first, second]), '--target-release', 'Synthetic B')
        self.assertEqual(result['issue'], f'{REPOSITORY}#2')
        self.assertEqual(result['position'], 2)

    def test_docs_identity_and_open_pr_candidates(self):
        target = issue(1, owner='Maintainer', readiness='Ready', repository=DOCS)
        target['projectItems'][0]['status'] = 'In Progress'
        target['closingPullRequests'] = [
            {'repository': DOCS, 'number': n, 'state': state, 'isDraft': False,
             'updatedAt': STAMP} for n, state in ((3, 'CLOSED'), (4, 'OPEN'))]
        result = self.run_selection(snapshot([target]))
        self.assertEqual(result['issue'], f'{DOCS}#1')
        self.assertEqual(result['pullRequestsToVerify'], [f'{DOCS}#4'])

    def test_release_range_uses_catalog_order(self):
        first, second = issue(1, owner='someone-else'), issue(2)
        second['projectItems'][0]['targetRelease'] = 'Synthetic B'
        result = self.run_selection(snapshot([first, second]),
                                    '--target-release', 'Synthetic A',
                                    '--through-release', 'Synthetic B')
        self.assertEqual(result['issue'], f'{REPOSITORY}#2')
        self.assertEqual(result['position'], 2)

    def test_reversed_release_range_is_unavailable(self):
        result = self.run_selection(snapshot([issue(1)]),
                                    '--target-release', 'Synthetic B',
                                    '--through-release', 'Synthetic A', expected_code=2)
        self.assertIn('reversed', result)

    def test_no_owned_candidate(self):
        result = self.run_selection(snapshot([issue(1, owner='someone-else')]))
        self.assertEqual(result['state'], 'none')

    def test_audit_diagnostic_prevents_selection(self):
        data = snapshot([issue(1)])
        data['projectPublic'] = True
        result = self.run_selection(data, expected_code=1)
        self.assertEqual(result['state'], 'audit-failed')
        self.assertIn('project-public', result['diagnosticCodes'])
        self.assertNotIn('issue', result)

    def test_invalid_schema_is_unavailable(self):
        data = snapshot([issue(1)])
        data['schemaVersion'] = 2
        result = self.run_selection(data, expected_code=2)
        self.assertIn('unavailable', result)

    def test_missing_scope_is_not_broad_selection(self):
        self.run_selection(snapshot([issue(1)]), '--scope', f'{REPOSITORY}#99', expected_code=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--falryn-root', type=Path, required=True)
    options, remaining = parser.parse_known_args()
    ROOT = options.falryn_root.resolve()
    module = (ROOT / 'tools/governance/roadmap-governance/contracts.ts').as_uri()
    code = (f'const c = await import({json.dumps(module)}); console.log(JSON.stringify({{'
            'statusOptions:c.ROADMAP_STATUS_OPTIONS, priorityOptions:c.ROADMAP_PRIORITY_OPTIONS,'
            'readinessOptions:c.ROADMAP_READINESS_OPTIONS,'
            'projectWorkflows:c.ROADMAP_REQUIRED_WORKFLOWS.map(name=>({name,enabled:true}))}));')
    CONTRACT = json.loads(subprocess.check_output(['bun', '-e', code], cwd=ROOT, text=True))
    unittest.main(argv=[sys.argv[0], *remaining])
