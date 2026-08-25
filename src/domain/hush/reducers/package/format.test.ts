import { describe, expect, test } from "bun:test";

import {
  formatPackageInstall,
  formatPackageList,
  formatPackageOutdated,
  formatPackageRunner,
  formatPackageScript,
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
        [
          "Package          Current  Wanted  Latest  Location                       Depended by",
          "@falryn/context  0.2.0    0.2.5   0.3.0   node_modules/@falryn/context  falryn",
          "zod              3.24.0   3.25.0  4.0.0   node_modules/zod              falryn",
        ].join("\n"),
      ),
    ).toBe("current>wanted>latest\n@falryn/context 0.2.0>0.2.5>0.3.0\nzod 3.24.0>3.25.0>4.0.0");
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
    expect(formatPackageOutdated("unexpected output")).toBeNull();
    expect(
      formatPackageScript("npm", "result line\n> embedded@1.0.0 example\n> do not remove"),
    ).toBeNull();
  });
});
