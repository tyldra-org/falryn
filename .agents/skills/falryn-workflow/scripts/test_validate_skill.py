#!/usr/bin/env python3
"""Check packaging failures that would break the installed skill pair."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('validate_skill.py')


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='falryn-skills-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('falryn-workflow', 'falryn-roadmap'):
            directory = self.root / name
            directory.mkdir()
            (directory / 'references').mkdir()
            (directory / 'SKILL.md').write_text(
                f'---\nname: {name}\ndescription: Test fixture\n---\n\n# Fixture\n')

    def check(self, expected):
        run = subprocess.run([sys.executable, '-B', str(SCRIPT), '--skills-root', str(self.root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, expected, run.stdout + run.stderr)
        return run.stdout

    def test_link_to_sibling_skill_anchor(self):
        path = self.root / 'falryn-workflow/SKILL.md'
        path.write_text(path.read_text() + '\n[Other](../falryn-roadmap/SKILL.md#fixture)\n')
        self.check(0)

    def test_missing_distributed_member(self):
        (self.root / 'falryn-roadmap/SKILL.md').unlink()
        self.assertIn('missing SKILL.md', self.check(1))

    def test_deleted_reference_is_detected(self):
        path = self.root / 'falryn-workflow/SKILL.md'
        path.write_text(path.read_text() + '\n[Missing](references/removed.md)\n')
        self.assertIn('missing link', self.check(1))

    def test_unreachable_reference_is_detected(self):
        (self.root / 'falryn-workflow/references/orphan.md').write_text('# Unreachable\n')
        self.assertIn('unreachable reference', self.check(1))

    def test_link_cannot_escape_into_other_installed_files(self):
        (self.root / 'outside.md').write_text('# Outside\n')
        path = self.root / 'falryn-workflow/SKILL.md'
        path.write_text(path.read_text() + '\n[Outside](../outside.md)\n')
        self.assertIn('leaves Falryn pair', self.check(1))

    def test_private_dependency_is_detected(self):
        path = self.root / 'falryn-workflow/SKILL.md'
        path.write_text(path.read_text() + '\n[Private](https://github.com/tyldra-org/falryn-docs/blob/main/private.md)\n')
        self.assertIn('private repository dependency', self.check(1))

    def test_bad_anchor_is_detected(self):
        path = self.root / 'falryn-workflow/SKILL.md'
        path.write_text(path.read_text() + '\n[Wrong](../falryn-roadmap/SKILL.md#missing)\n')
        self.assertIn('missing anchor', self.check(1))

    def test_symlink_cannot_replace_a_skill(self):
        (self.root / 'falryn-roadmap/SKILL.md').unlink()
        (self.root / 'falryn-roadmap/SKILL.md').symlink_to(self.root / 'falryn-workflow/SKILL.md')
        self.assertIn('symlink', self.check(1))


if __name__ == '__main__':
    unittest.main()
