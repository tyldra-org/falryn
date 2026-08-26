import { describe, expect, test } from "bun:test";

import {
  formatPackageInstall,
  formatPackageList,
  formatPackageOutdated,
  formatPackageRunner,
  formatPackageScript,
  formatPackageShow,
} from "./format.ts";

describe("Hush package formats", () => {
  test("compacts npm install facts without losing funding or audit state", () => {
    expect(
      formatPackageInstall(
        "npm",
        [
          "added 12 packages, and audited 13 packages in 1s",
          "",
          "2 packages are looking for funding",
          "  run `npm fund` for details",
          "",
          "found 0 vulnerabilities",
        ].join("\n"),
      ),
    ).toBe("packages +12; audited 13; 1s\nfunding 2: npm fund\nvulnerabilities 0");
  });

  test("keeps every pnpm dependency and its role while removing progress", () => {
    expect(
      formatPackageInstall(
        "pnpm",
        [
          "Progress: resolved 12, reused 10, downloaded 2, added 2",
          "Packages: +2",
          "++",
          "dependencies:",
          "+ @falryn/context 0.3.0",
          "devDependencies:",
          "+ typescript 5.9.2",
          "Done in 1.2s using pnpm v11.0.0",
        ].join("\n"),
      ),
    ).toBe("+2 packages\nprod @falryn/context 0.3.0\ndev typescript 5.9.2");
  });

  test("compacts Yarn install framing but retains every dependency", () => {
    expect(
      formatPackageInstall(
        "yarn",
        [
          "yarn install v1.22.22",
          "[1/4] Resolving packages...",
          "[2/4] Fetching packages...",
          "[3/4] Linking dependencies...",
          "[4/4] Building fresh packages...",
          "success Saved lockfile.",
          "success Saved 2 new dependencies.",
          "info Direct dependencies",
          "└─ @falryn/context@0.3.0",
          "info All dependencies",
          "├─ @falryn/context@0.3.0",
          "└─ typescript@5.9.2",
          "Done in 2.14s.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "lockfile saved",
        "dependencies +2",
        "direct:",
        "@falryn/context@0.3.0",
        "all:",
        "@falryn/context@0.3.0",
        "typescript@5.9.2",
      ].join("\n"),
    );
  });

  test("compacts complete Bun install framing while retaining every fact", () => {
    expect(
      formatPackageInstall(
        "bun",
        [
          "bun install v1.4.0 (0aa2b1cd)",
          "Resolving dependencies",
          "Resolved, downloaded and extracted [12]",
          "Saved lockfile",
          "",
          "+ @falryn/context@0.3.0",
          "+ zod@4.0.0",
          "+ typescript@5.9.2",
          "",
          "12 packages installed [118.00ms]",
        ].join("\n"),
      ),
    ).toBe(
      [
        "bun install v1.4.0 (0aa2b1cd)",
        "resolved/downloaded/extracted 12",
        "lockfile saved",
        "+ @falryn/context@0.3.0",
        "+ zod@4.0.0",
        "+ typescript@5.9.2",
        "installed 12 packages [118.00ms]",
      ].join("\n"),
    );
  });

  test("keeps uncapped dependency trees and lists", () => {
    const dependencies = Array.from(
      { length: 75 },
      (_, index) => `├── package-${String(index + 1).padStart(2, "0")}@1.0.${index}`,
    );
    const npm = formatPackageList("npm", ["falryn@0.3.0 /workspace", ...dependencies].join("\n"));
    expect(npm?.split("\n")).toHaveLength(76);
    expect(npm).toContain("- package-01@1.0.0");
    expect(npm).toContain("- package-75@1.0.74");
    expect(npm).not.toContain("omitted");

    expect(
      formatPackageList(
        "pnpm",
        [
          "Legend: production dependency, optional only, dev only",
          "",
          "falryn@0.3.0 /workspace",
          "",
          "dependencies:",
          "@falryn/context 0.3.0",
          "zod 4.0.0",
          "devDependencies:",
          "typescript 5.9.2",
        ].join("\n"),
      ),
    ).toBe(
      "falryn@0.3.0 /workspace\nprod: @falryn/context@0.3.0, zod@4.0.0\ndev: typescript@5.9.2",
    );
  });

  test("keeps decision fields from outdated tables while dropping layout-only columns", () => {
    expect(
      formatPackageOutdated(
        "npm",
        [
          "Package          Current  Wanted  Latest  Location                       Depended by",
          "@falryn/context  0.2.0    0.2.5   0.3.0   node_modules/@falryn/context  falryn",
          "zod              3.24.0   3.25.0  4.0.0   node_modules/zod              falryn",
        ].join("\n"),
      ),
    ).toBe("current>wanted>latest\n@falryn/context 0.2.0>0.2.5>0.3.0\nzod 3.24.0>3.25.0>4.0.0");
  });

  test("compacts Python package outcomes without dropping packages", () => {
    expect(
      formatPackageInstall(
        "pip",
        [
          "Collecting requests",
          "Using cached requests-2.32.3-py3-none-any.whl",
          "Installing collected packages: urllib3, requests",
          "Successfully installed requests-2.32.3 urllib3-2.2.2",
        ].join("\n"),
      ),
    ).toBe("installed requests-2.32.3 urllib3-2.2.2");
    expect(
      formatPackageInstall(
        "uv",
        [
          "Resolved 42 packages in 123ms",
          "Prepared 2 packages in 15ms",
          "Installed 2 packages in 23ms",
          " + certifi==2026.8.1",
          " + requests==2.32.3",
        ].join("\n"),
      ),
    ).toBe("resolved 42\n+2\n+ certifi@2026.8.1\n+ requests@2.32.3");
    expect(
      formatPackageInstall(
        "poetry",
        [
          "Installing dependencies from lock file",
          "Package operations: 2 installs, 1 update, 0 removals",
          "  - Installing certifi (2026.8.1)",
          "  - Installing urllib3 (2.2.2)",
          "  - Updating requests (2.31.0 -> 2.32.3)",
          "Writing lock file",
        ].join("\n"),
      ),
    ).toBe(
      "+2 ~1 -0\n+ certifi@2026.8.1\n+ urllib3@2.2.2\n~ requests 2.31.0>2.32.3\nlockfile written",
    );

    const packages = Array.from(
      { length: 75 },
      (_, index) => `package-${String(index + 1).padStart(2, "0")}  1.0.${index}`,
    );
    const pipList = formatPackageList(
      "pip3",
      ["Package     Version", "----------- -------", ...packages].join("\n"),
    );
    expect(pipList?.split("\n")).toHaveLength(76);
    expect(pipList).toContain("package-01@1.0.0");
    expect(pipList).toContain("package-75@1.0.74");
    expect(pipList).not.toContain("omitted");

    expect(
      formatPackageOutdated(
        "pip",
        [
          "Package   Version  Latest  Type",
          "--------- -------- ------- -----",
          "requests  2.31.0   2.32.3  wheel",
          "urllib3   2.1.0    2.2.2   wheel",
        ].join("\n"),
      ),
    ).toBe("current>latest wheel\nrequests 2.31.0>2.32.3\nurllib3 2.1.0>2.2.2");
  });

  test("compacts pip show while preserving every field", () => {
    expect(
      formatPackageShow(
        "pip",
        [
          "Name: requests",
          "Version: 2.32.3",
          "Summary: Python HTTP for Humans.",
          "Home-page: https://requests.readthedocs.io",
          "Author-email: Kenneth Reitz <me@kennethreitz.org>",
          "License: Apache-2.0",
          "Location: /workspace/.venv/lib/python3.13/site-packages",
          "Requires: certifi, charset-normalizer, idna, urllib3",
          "Required-by: falryn-tools",
        ].join("\n"),
      ),
    ).toBe(
      [
        "requests@2.32.3",
        "summary=Python HTTP for Humans.",
        "home=https://requests.readthedocs.io",
        "author=Kenneth Reitz <me@kennethreitz.org>",
        "license=Apache-2.0",
        "location=/workspace/.venv/lib/python3.13/site-packages",
        "requires=certifi, charset-normalizer, idna, urllib3",
        "required-by=falryn-tools",
      ].join("\n"),
    );
  });

  test("compacts Poetry and Composer package inventories", () => {
    expect(
      formatPackageList(
        "poetry",
        "certifi          2026.8.1         Python package for CA Bundles\nrequests         2.32.3           Python HTTP for Humans.",
      ),
    ).toBe(
      "packages 2\ncertifi@2026.8.1 Python package for CA Bundles\nrequests@2.32.3 Python HTTP for Humans.",
    );
    expect(
      formatPackageList(
        "composer",
        "psr/log          3.0.2          Common logging interface\nsymfony/console  v7.3.0         Symfony Console Component",
      ),
    ).toBe(
      "packages 2\npsr/log@3.0.2 Common logging interface\nsymfony/console@v7.3.0 Symfony Console Component",
    );
  });

  test("compacts Homebrew, Composer, and Bundler terminal facts", () => {
    expect(
      formatPackageInstall(
        "brew",
        [
          "==> Fetching downloads for: jq",
          "==> Downloading https://ghcr.io/v2/homebrew/core/jq/manifests/1.8.1",
          "Already downloaded: /Users/test/Library/Caches/Homebrew/downloads/jq.bottle_manifest.json",
          "==> Pouring jq--1.8.1.arm64_sequoia.bottle.tar.gz",
          "🍺  /opt/homebrew/Cellar/jq/1.8.1: 20 files, 1.4MB",
        ].join("\n"),
      ),
    ).toBe("installed jq@1.8.1; 20 files, 1.4MB");
    expect(
      formatPackageInstall(
        "composer",
        [
          "Installing dependencies from lock file (including require-dev)",
          "Package operations: 2 installs, 0 updates, 0 removals",
          "  - Downloading psr/log (3.0.2)",
          "  - Installing psr/log (3.0.2): Extracting archive",
          "  - Installing symfony/console (v7.3.0): Extracting archive",
          "Writing lock file",
          "Generating optimized autoload files",
        ].join("\n"),
      ),
    ).toBe(
      "+2 ~0 -0\n+ psr/log@3.0.2\n+ symfony/console@v7.3.0\nlockfile written\nautoload optimized",
    );
    expect(
      formatPackageInstall(
        "bundle",
        "Bundle complete! 85 Gemfile dependencies, 200 gems now installed.\nBundled gems are installed into `./vendor/bundle`",
      ),
    ).toBe("complete 85/200");
  });

  test("removes only validated script framing and counts repeated runner lines", () => {
    expect(
      formatPackageScript(
        "npm",
        [
          "> falryn@0.3.0 verify",
          "> node tools/verify.mjs",
          "",
          "checking package graph",
          "verified 12 packages",
        ].join("\n"),
      ),
    ).toBe("node tools/verify.mjs\n\nchecking package graph\nverified 12 packages");
    expect(
      formatPackageScript(
        "bun",
        [
          "$ bun run tools/verify-packages.mjs",
          "checking package graph",
          "checking package graph",
          "checking package graph",
          "verified 12 packages",
        ].join("\n"),
      ),
    ).toBe("bun run tools/verify-packages.mjs\nchecking package graph ×3\nverified 12 packages");
    expect(
      formatPackageRunner(
        [
          "checking package graph",
          "checking package graph",
          "checking package graph",
          "verified 12 packages",
        ].join("\n"),
      ),
    ).toBe("checking package graph ×3\nverified 12 packages");
  });

  test("declines incomplete or unfamiliar manager shapes", () => {
    expect(formatPackageInstall("pnpm", "Progress: resolved 2, added 1")).toBeNull();
    expect(
      formatPackageInstall(
        "bun",
        "bun install v1.4.0 (0aa2b1cd)\nResolving dependencies\nSaved lockfile",
      ),
    ).toBeNull();
    expect(formatPackageList("npm", "falryn@0.3.0 /workspace")).toBeNull();
    expect(formatPackageOutdated("npm", "unexpected output")).toBeNull();
    expect(
      formatPackageInstall("pip", "WARNING: Retrying request\nSuccessfully installed x-1"),
    ).toBeNull();
    expect(formatPackageInstall("brew", "Error: jq installation failed")).toBeNull();
    expect(
      formatPackageInstall(
        "composer",
        "Nothing to install, update or remove\nWarning: abandoned package",
      ),
    ).toBeNull();
    expect(
      formatPackageInstall(
        "bundle",
        "Bundle complete! 4 Gemfile dependencies, 17 gems now installed.\nWarning: post-install failed",
      ),
    ).toBeNull();
    expect(
      formatPackageScript("npm", "result line\n> embedded@1.0.0 example\n> do not remove"),
    ).toBeNull();
  });
});
