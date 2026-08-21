import { describe, expect, test } from "bun:test";

import {
  auditRepository,
  DIRECT_DEPENDENCY_POLICY,
  type RepositoryIntegrityInput,
} from "./repository-integrity.ts";

function validInput(): RepositoryIntegrityInput {
  const dependencies = Object.fromEntries(
    DIRECT_DEPENDENCY_POLICY.filter((policy) => policy.group === "dependencies").map((policy) => [
      policy.name,
      policy.version,
    ]),
  );
  const devDependencies = Object.fromEntries(
    DIRECT_DEPENDENCY_POLICY.filter((policy) => policy.group === "devDependencies").map(
      (policy) => [policy.name, policy.version],
    ),
  );
  const installedPackages = new Map(
    DIRECT_DEPENDENCY_POLICY.map((policy) => [
      policy.name,
      {
        name: policy.name,
        version: policy.version,
        license: policy.license,
        repository: { url: `${policy.repository}.git` },
        scripts: {},
      },
    ]),
  );
  const packages = Object.fromEntries(
    DIRECT_DEPENDENCY_POLICY.map((policy) => [
      policy.name,
      [`${policy.name}@${policy.version}`, "", {}, "sha512-policy-fixture"],
    ]),
  );

  return {
    manifest: {
      dependencies,
      devDependencies,
      patchedDependencies: {
        "@opentui/core@0.5.6": "patches/@opentui%2Fcore@0.5.6.patch",
        "@opentui/react@0.5.6": "patches/@opentui%2Freact@0.5.6.patch",
      },
      scripts: {
        build: "bun build src/main.ts --compile --outfile dist/falryn",
      },
    },
    lockfile: { packages },
    installedPackages,
    sourcePaths: new Set([
      "src/main.ts",
      "patches/@opentui%2Fcore@0.5.6.patch",
      "patches/@opentui%2Freact@0.5.6.patch",
    ]),
    gitignore: "/dist/\n",
    trackedPaths: [],
  };
}

function codes(input: RepositoryIntegrityInput): readonly string[] {
  return auditRepository(input).map((issue) => issue.code);
}

describe("repository integrity", () => {
  test("accepts the complete direct-dependency and build-output policy", () => {
    expect(auditRepository(validInput())).toEqual([]);
  });

  test("refuses missing, moved, range-versioned, and unapproved dependencies", () => {
    const input = validInput();
    const manifest = input.manifest as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    delete manifest.dependencies.zod;
    manifest.devDependencies.react = manifest.dependencies.react ?? "19.2.8";
    delete manifest.dependencies.react;
    manifest.dependencies["jsonc-parser"] = "^3.3.1";
    manifest.dependencies["unreviewed-package"] = "1.0.0";

    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "dependency-missing",
        "dependency-category-mismatch",
        "dependency-version-mismatch",
        "dependency-unapproved",
      ]),
    );
  });

  test("refuses a missing lock integrity, mismatched package metadata, and install hook", () => {
    const input = validInput();
    const lockfile = input.lockfile as { packages: Record<string, unknown[]> };
    lockfile.packages.zod = ["zod@4.4.3", "", {}];
    const zod = input.installedPackages.get("zod") as {
      license: string;
      scripts: Record<string, string>;
    };
    zod.license = "Unknown";
    zod.scripts.postinstall = "unexpected";

    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "lock-integrity-missing",
        "package-metadata-mismatch",
        "install-lifecycle-hook",
      ]),
    );
  });

  test("refuses an unapproved, escaping, or missing patch", () => {
    const input = validInput();
    const manifest = input.manifest as { patchedDependencies: Record<string, string> };
    manifest.patchedDependencies["unreviewed-package@1.0.0"] = "patches/unreviewed.patch";
    manifest.patchedDependencies["@opentui/react@0.5.6"] = "../outside.patch";

    expect(codes(input)).toEqual(
      expect.arrayContaining(["patch-unapproved", "patch-path-invalid", "patch-missing"]),
    );
  });

  test("refuses an unowned generated output", () => {
    const input = validInput();
    const manifest = input.manifest as { scripts: { build: string } };
    manifest.scripts.build = "bun build src/main.ts";

    expect(codes({ ...input, gitignore: "dist/\n", trackedPaths: ["dist/falryn"] })).toEqual(
      expect.arrayContaining([
        "generated-build-mismatch",
        "generated-output-not-ignored",
        "generated-output-tracked",
      ]),
    );
  });
});
