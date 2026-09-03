#!/usr/bin/env python3
"""Focused negative tests for validate-bundles.py."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parent


class BundleValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temporary.name).resolve()
        self.root = self.temp_root / "skills"
        shutil.copytree(
            SOURCE,
            self.root,
            ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc"),
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_validator(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        environment = dict(os.environ)
        environment["HOME"] = str(self.temp_root / "empty-home")
        return subprocess.run(
            [str(self.root / "validate-bundles.py"), *arguments],
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def assert_failure(self, expected: str) -> None:
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(expected, result.stderr)

    def test_public_only_copy_passes_without_private_dependencies(self) -> None:
        self.assertFalse((self.temp_root / "falryn-docs").exists())
        self.assertFalse((self.root / "engineering-best-practices").exists())
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("validated 6 vendored skill bundles", result.stdout)

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

    def test_rejects_unexpected_vendored_bundle(self) -> None:
        path = self.root / "unexpected-skill"
        path.mkdir()
        (path / "SKILL.md").write_text(
            "---\nname: unexpected-skill\ndescription: fixture\n---\n",
            encoding="utf-8",
        )
        self.assert_failure("unexpected vendored skill inventory")

    def test_rejects_vendored_global_only_engineering_bundle(self) -> None:
        path = self.root / "engineering-best-practices"
        path.mkdir()
        (path / "SKILL.md").write_text(
            "---\nname: engineering-best-practices\ndescription: fixture\n---\n",
            encoding="utf-8",
        )
        self.assert_failure("global-only bundle must not be vendored")

    def test_rejects_dangling_retired_bundle_symlink(self) -> None:
        path = self.root / "engineering-best-practices"
        path.symlink_to(self.root / "missing-engineering-bundle", target_is_directory=True)
        self.assert_failure("global-only bundle must not be vendored")

    def test_rejects_required_bundle_symlink(self) -> None:
        path = self.root / "change-review"
        shutil.rmtree(path)
        path.symlink_to(self.root / "gh-cli", target_is_directory=True)
        self.assert_failure("vendored skill symlink is not allowed")

    def test_rejects_non_regular_filesystem_entry(self) -> None:
        if not hasattr(os, "mkfifo"):
            self.skipTest("mkfifo is unavailable on this platform")
        path = self.root / "gh-cli" / "unexpected-pipe"
        os.mkfifo(path)
        self.assert_failure("unsupported vendored filesystem entry")

    def test_rejects_inaccessible_subtree(self) -> None:
        if os.name != "posix" or (hasattr(os, "geteuid") and os.geteuid() == 0):
            self.skipTest("permission denial is unavailable on this platform")
        path = self.root / "gh-cli" / "inaccessible"
        path.mkdir()
        (path / "hidden.md").write_text("hidden\n", encoding="utf-8")
        path.chmod(0)
        try:
            self.assert_failure("unable to traverse")
        finally:
            path.chmod(0o700)

    def test_rejects_private_documentation_link_in_public_workflow(self) -> None:
        path = self.root / "falryn-workflow" / "references" / "review.md"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(
                "\nhttps://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md\n",
            )
        self.assert_failure("must not require private HTTP documentation links")

    def test_rejects_incomplete_private_authority_contract(self) -> None:
        path = self.root / "falryn-workflow" / "references" / "private-authority.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace("tyldra-org/falryn-docs", "unspecified-private-repository"),
            encoding="utf-8",
        )
        self.assert_failure("missing access outcome: tyldra-org/falryn-docs")

    def test_source_parity_rejects_symlinked_bundle(self) -> None:
        source = self.temp_root / "source"
        shutil.copytree(self.root, source)
        shutil.rmtree(source / "change-review")
        (source / "change-review").symlink_to(source / "gh-cli", target_is_directory=True)
        result = self.run_validator("--source", str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("parity source symlink is not allowed", result.stderr)

    def test_source_parity_rejects_symlinked_root(self) -> None:
        source = self.temp_root / "source"
        source_link = self.temp_root / "source-link"
        shutil.copytree(self.root, source)
        source_link.symlink_to(source, target_is_directory=True)
        result = self.run_validator("--source", str(source_link))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("parity source root resolves through a symlink", result.stderr)

    def test_source_parity_detects_empty_directory_drift(self) -> None:
        source = self.temp_root / "source"
        shutil.copytree(self.root, source)
        (source / "gh-cli" / "source-only-empty-directory").mkdir()
        result = self.run_validator("--source", str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("directory:source-only-empty-directory", result.stderr)

    def test_source_parity_rejects_special_finder_metadata_entry(self) -> None:
        if not hasattr(os, "mkfifo"):
            self.skipTest("mkfifo is unavailable on this platform")
        source = self.temp_root / "source"
        shutil.copytree(self.root, source)
        os.mkfifo(source / "gh-cli" / ".DS_Store")
        result = self.run_validator("--source", str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported Finder metadata entry", result.stderr)

    def test_source_parity_does_not_require_global_only_engineering(self) -> None:
        source = self.temp_root / "source"
        shutil.copytree(self.root, source)
        result = self.run_validator("--source", str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("distributed-source parity", result.stdout)


if __name__ == "__main__":
    unittest.main()
