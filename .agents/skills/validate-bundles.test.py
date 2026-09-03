#!/usr/bin/env python3
"""Focused negative tests for validate-bundles.py."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parent


class BundleValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "skills"
        shutil.copytree(
            SOURCE,
            self.root,
            ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc"),
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_validator(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.root / "validate-bundles.py")],
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
        )

    def assert_failure(self, expected: str) -> None:
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(expected, result.stderr)

    def test_current_bundle_passes(self) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("validated 7 skill bundles", result.stdout)

    def test_rejects_publishing_notes_file_release(self) -> None:
        path = self.root / "gh-cli" / "process" / "release.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace("CHANGELOG-v1.4.0.md --draft", "CHANGELOG-v1.4.0.md"),
            encoding="utf-8",
        )
        self.assert_failure("every documented release-create command must remain a draft")

    def test_rejects_publishing_generated_notes(self) -> None:
        path = self.root / "gh-cli" / "process" / "release.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace("--generate-notes --draft", "--generate-notes"),
            encoding="utf-8",
        )
        self.assert_failure("every documented release-create command must remain a draft")

    def test_rejects_publishing_prerelease(self) -> None:
        path = self.root / "gh-cli" / "process" / "release.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace("--prerelease --draft", "--prerelease"),
            encoding="utf-8",
        )
        self.assert_failure("every documented release-create command must remain a draft")

    def test_rejects_broken_heading_anchor(self) -> None:
        path = self.root / "gh-cli" / "process" / "issues.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace("#remote-body-and-metadata-safety", "#missing-safety-owner"),
            encoding="utf-8",
        )
        self.assert_failure("broken local anchor")

    def test_rejects_retired_personal_git_policy(self) -> None:
        path = self.root / "git-workflow" / "SKILL.md"
        with path.open("a", encoding="utf-8") as handle:
            handle.write("\nAutocommit is on by default.\n")
        self.assert_failure("retired Git policy remains")

    def test_rejects_incomplete_opentui_snapshot(self) -> None:
        path = self.root / "opentui-best-practices" / "docs" / "getting-started.mdx"
        path.unlink()
        self.assert_failure("OpenTUI snapshot must contain 76 MDX files")

    def test_rejects_nested_skill_identity(self) -> None:
        nested = self.root / "typescript-best-practices" / "modules" / "nested" / "SKILL.md"
        nested.parent.mkdir()
        nested.write_text("---\nname: nested\n---\n", encoding="utf-8")
        self.assert_failure("nested skill entrypoint is not allowed")


if __name__ == "__main__":
    unittest.main()
