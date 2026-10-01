import { describe, expect, test } from "bun:test";

import {
  auditRepository,
  DIRECT_DEPENDENCY_POLICY,
  type RepositoryIntegrityInput,
} from "./repository-integrity.ts";

/** Every fixture dependency is declared, locked and installed at this version. */
const VERSION = "1.2.3";

function validInput(): RepositoryIntegrityInput {
  const dependencies = Object.fromEntries(
    DIRECT_DEPENDENCY_POLICY.filter((policy) => policy.group === "dependencies").map((policy) => [
      policy.name,
      VERSION,
    ]),
  );
  const devDependencies = Object.fromEntries(
    DIRECT_DEPENDENCY_POLICY.filter((policy) => policy.group === "devDependencies").map(
      (policy) => [policy.name, VERSION],
    ),
  );
  const installedPackages = new Map(
    DIRECT_DEPENDENCY_POLICY.map((policy) => [
      policy.name,
      {
        name: policy.name,
        version: VERSION,
        license: policy.license,
        repository: { url: `${policy.repository}.git` },
        scripts: { ...policy.installLifecycleHooks },
      },
    ]),
  );
  const packages = Object.fromEntries(
    DIRECT_DEPENDENCY_POLICY.map((policy) => [
      policy.name,
      [`${policy.name}@${VERSION}`, "", {}, "sha512-policy-fixture"],
    ]),
  );

  return {
    manifest: {
      dependencies,
      devDependencies,
      patchedDependencies: {},
      scripts: {
        build: "bun build src/main.ts --compile --outfile dist/falryn",
      },
    },
    lockfile: { packages },
    installedPackages,
    sourcePaths: new Set(["src/main.ts"]),
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
        "dependency-version-inexact",
        "dependency-unapproved",
      ]),
    );
  });

  test("a version bump agreed by the manifest, lockfile and installed package needs no policy edit", () => {
    const input = validInput();
    const manifest = input.manifest as { dependencies: Record<string, string> };
    const lockfile = input.lockfile as { packages: Record<string, unknown[]> };
    const zod = input.installedPackages.get("zod") as { version: string };
    manifest.dependencies.zod = "9.0.0";
    lockfile.packages.zod = ["zod@9.0.0", "", {}, "sha512-bumped"];
    zod.version = "9.0.0";
    expect(auditRepository(input)).toEqual([]);

    lockfile.packages.zod = ["zod@8.0.0", "", {}, "sha512-stale"];
    zod.version = "8.0.0";
    expect(codes(input)).toEqual(["lock-version-mismatch", "package-metadata-mismatch"]);
  });

  test("refuses a missing lock integrity, mismatched package metadata, and install hook", () => {
    const input = validInput();
    const lockfile = input.lockfile as { packages: Record<string, unknown[]> };
    lockfile.packages.zod = [`zod@${VERSION}`, "", {}];
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
    manifest.patchedDependencies[`@opentui/react@${VERSION}`] = "../outside.patch";

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
