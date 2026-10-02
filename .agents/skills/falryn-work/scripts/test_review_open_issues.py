"""Tests for review_open_issues.py, using offline fixtures."""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import review_open_issues as subject


def fixture(directory: Path) -> None:
    (directory / 'tyldra-org__falryn.json').write_text(json.dumps([
        {'number': 863, 'title': 'Harden catalog refresh', 'body': 'Owns catalog refresh.\nOther line.'},
        {'number': 852, 'title': 'Local runtimes', 'body': 'Discovery runs through #863.'},
        {'number': 10, 'title': 'Unrelated', 'body': 'Nothing here.'},
    ]))
    (directory / 'tyldra-org__falryn-docs.json').write_text(json.dumps([
        {'number': 4, 'title': 'Reconcile docs', 'body': None},
    ]))


class ReviewTest(unittest.TestCase):
    def run_json(self, *argv: str) -> dict:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            fixture(directory)
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(subject.main(['--input', raw, '--json', *argv]), 0)
            return json.loads(out.getvalue())

    def test_searches_both_repositories_by_default(self):
        report = self.run_json('--term', 'catalog refresh')
        self.assertEqual([s['repo'] for s in report['searched']],
                         ['tyldra-org/falryn', 'tyldra-org/falryn-docs'])
        self.assertEqual([s['open'] for s in report['searched']], [3, 1])

    def test_ranks_by_matched_terms_and_counts_issue_references(self):
        report = self.run_json('--term', 'catalog refresh', '--term', 'owns', '--issue', '863')
        self.assertEqual([(m['number'], m['score']) for m in report['matches']], [(863, 2), (852, 1)])
        self.assertEqual(report['matches'][0]['lines'], ['Harden catalog refresh', 'Owns catalog refresh.'])
        self.assertEqual(report['matches'][1]['terms'], [r'#863\b'])

    def test_a_null_body_and_no_match_are_handled(self):
        report = self.run_json('--term', 'reconcile')
        self.assertEqual([m['number'] for m in report['matches']], [4])

    def test_requires_a_term(self):
        with self.assertRaises(SystemExit):
            with redirect_stdout(io.StringIO()):
                subject.main(['--input', '.'])


if __name__ == '__main__':
    unittest.main()
