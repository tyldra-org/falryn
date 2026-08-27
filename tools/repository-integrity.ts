/**
 * Offline admission checks for direct dependencies and generated build output.
 *
 * This is repository maintenance tooling, not a product import. The frozen
 * lockfile owns the resolved transitive graph; this policy makes the smaller
 * direct-admission boundary deliberate and reviewable.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";

type DependencyGroup = "dependencies" | "devDependencies";
const INSTALL_LIFECYCLE_HOOKS = ["preinstall", "install", "postinstall"] as const;
type InstallLifecycleHook = (typeof INSTALL_LIFECYCLE_HOOKS)[number];

export type DirectDependencyPolicy = Readonly<{
  name: string;
  group: DependencyGroup;
  version: string;
  license: string;
  repository: string;
  installLifecycleHooks?: Readonly<Partial<Record<InstallLifecycleHook, string>>>;
}>;

export const DIRECT_DEPENDENCY_POLICY: readonly DirectDependencyPolicy[] = [
  {
    name: "@anthropic-ai/sdk",
    group: "dependencies",
    version: "0.91.1",
    license: "MIT",
    repository: "github:anthropics/anthropic-sdk-typescript",
  },
  {
    name: "@google/genai",
    group: "dependencies",
    version: "1.52.0",
    license: "Apache-2.0",
    repository: "https://github.com/googleapis/js-genai",
    installLifecycleHooks: { preinstall: "echo 'preinstall: no-op'" },
  },
  {
    name: "@opentui/core",
    group: "dependencies",
    version: "0.5.6",
    license: "MIT",
    repository: "https://github.com/anomalyco/opentui",
  },
  {
    name: "@opentui/keymap",
    group: "dependencies",
    version: "0.5.6",
    license: "MIT",
    repository: "https://github.com/anomalyco/opentui",
  },
  {
    name: "@opentui/react",
    group: "dependencies",
    version: "0.5.6",
    license: "MIT",
    repository: "https://github.com/anomalyco/opentui",
  },
  {
    name: "jsonc-parser",
    group: "dependencies",
    version: "3.3.1",
    license: "MIT",
    repository: "https://github.com/microsoft/node-jsonc-parser",
  },
  {
    name: "openai",
    group: "dependencies",
    version: "6.40.0",
    license: "Apache-2.0",
    repository: "github:openai/openai-node",
  },
  {
    name: "react",
    group: "dependencies",
    version: "19.2.8",
    license: "MIT",
    repository: "https://github.com/react/react",
  },
  {
    name: "yargs",
    group: "dependencies",
    version: "18.1.0",
    license: "MIT",
    repository: "https://github.com/yargs/yargs",
  },
  {
    name: "zod",
    group: "dependencies",
    version: "4.4.3",
    license: "MIT",
    repository: "https://github.com/colinhacks/zod",
  },
  {
    name: "@biomejs/biome",
    group: "devDependencies",
    version: "2.5.9",
    license: "MIT OR Apache-2.0",
    repository: "https://github.com/biomejs/biome",
  },
  {
    name: "@xterm/headless",
    group: "devDependencies",
    version: "6.0.0",
    license: "MIT",
    repository: "https://github.com/xtermjs/xterm.js",
  },
  {
    name: "@types/bun",
    group: "devDependencies",
    version: "1.4.0",
    license: "MIT",
    repository: "https://github.com/DefinitelyTyped/DefinitelyTyped",
  },
  {
    name: "@types/react",
    group: "devDependencies",
    version: "19.2.18",
    license: "MIT",
    repository: "https://github.com/DefinitelyTyped/DefinitelyTyped",
  },
  {
    name: "@types/react-reconciler",
    group: "devDependencies",
    version: "0.33.0",
    license: "MIT",
    repository: "https://github.com/DefinitelyTyped/DefinitelyTyped",
  },
  {
    name: "@types/yargs",
    group: "devDependencies",
    version: "17.0.35",
    license: "MIT",
    repository: "https://github.com/DefinitelyTyped/DefinitelyTyped",
  },
  {
    name: "typescript",
    group: "devDependencies",
    version: "7.0.2",
    license: "Apache-2.0",
    repository: "https://github.com/microsoft/TypeScript",
  },
];

const GENERATED_EXECUTABLE = {
  source: "src/main.ts",
  script: "build",
  destination: "dist/falryn",
  ignoredDirectory: "/dist/",
} as const;

export const REPOSITORY_INTEGRITY_CODES = [
  "manifest-invalid",
  "dependency-missing",
  "dependency-unapproved",
  "dependency-category-mismatch",
  "dependency-version-mismatch",
  "lock-missing",
  "lock-version-mismatch",
  "lock-integrity-missing",
  "package-metadata-missing",
  "package-metadata-mismatch",
  "install-lifecycle-hook",
  "patch-unapproved",
  "patch-path-invalid",
  "patch-missing",
  "generated-source-missing",
  "generated-build-mismatch",
  "generated-output-not-ignored",
  "generated-output-tracked",
] as const;

export type RepositoryIntegrityCode = (typeof REPOSITORY_INTEGRITY_CODES)[number];

export type RepositoryIntegrityIssue = Readonly<{
  code: RepositoryIntegrityCode;
  subject: string;
}>;

export type RepositoryIntegrityInput = Readonly<{
  manifest: unknown;
  lockfile: unknown;
  installedPackages: ReadonlyMap<string, unknown>;
  sourcePaths: ReadonlySet<string>;
  gitignore: string;
  trackedPaths: readonly string[];
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringMap(value: unknown): ReadonlyMap<string, string> | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const entries: [string, string][] = [];
  for (const [key, candidate] of Object.entries(record)) {
    if (typeof candidate !== "string") {
      return null;
    }
    entries.push([key, candidate]);
  }
  return new Map(entries);
}

function stringAt(record: JsonRecord, key: string): string | null {
  const candidate = record[key];
  return typeof candidate === "string" ? candidate : null;
}

function normalizedRepository(value: unknown): string | null {
  const candidate = typeof value === "string" ? value : stringAt(asRecord(value) ?? {}, "url");
  if (candidate === null) {
    return null;
  }

  return candidate
    .replace(/^git\+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

function isPatchPath(path: string): boolean {
  return (
    path.startsWith("patches/") &&
    path.endsWith(".patch") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function add(
  issues: RepositoryIntegrityIssue[],
  code: RepositoryIntegrityCode,
  subject: string,
): void {
  issues.push({ code, subject });
}

function manifestGroups(
  manifest: JsonRecord,
  issues: RepositoryIntegrityIssue[],
): ReadonlyMap<DependencyGroup, ReadonlyMap<string, string>> | null {
  const dependencies = stringMap(manifest.dependencies);
  const devDependencies = stringMap(manifest.devDependencies);
  if (dependencies === null || devDependencies === null) {
    add(issues, "manifest-invalid", "direct dependency groups");
    return null;
  }
  return new Map([
    ["dependencies", dependencies],
    ["devDependencies", devDependencies],
  ]);
}

function checkDirectDependencies(manifest: JsonRecord, issues: RepositoryIntegrityIssue[]): void {
  const groups = manifestGroups(manifest, issues);
  if (groups === null) {
    return;
  }

  const policiesByName = new Map<string, DirectDependencyPolicy>(
    DIRECT_DEPENDENCY_POLICY.map((policy) => [policy.name, policy]),
  );
  for (const policy of DIRECT_DEPENDENCY_POLICY) {
    const expectedGroup = groups.get(policy.group);
    const otherGroup = groups.get(
      policy.group === "dependencies" ? "devDependencies" : "dependencies",
    );
    const declaredVersion = expectedGroup?.get(policy.name);
    if (declaredVersion === undefined) {
      add(
        issues,
        otherGroup?.has(policy.name) === true
          ? "dependency-category-mismatch"
          : "dependency-missing",
        policy.name,
      );
      continue;
    }
    if (declaredVersion !== policy.version) {
      add(issues, "dependency-version-mismatch", policy.name);
    }
  }

  for (const group of ["dependencies", "devDependencies"] as const) {
    for (const dependencyName of groups.get(group)?.keys() ?? []) {
      if (!policiesByName.has(dependencyName)) {
        add(issues, "dependency-unapproved", dependencyName);
      }
    }
  }
}

function checkLockfile(lockfile: unknown, issues: RepositoryIntegrityIssue[]): void {
  const packages = asRecord(asRecord(lockfile)?.packages);
  if (packages === null) {
    add(issues, "manifest-invalid", "lockfile packages");
    return;
  }

  for (const policy of DIRECT_DEPENDENCY_POLICY) {
    const entry = packages[policy.name];
    if (!Array.isArray(entry)) {
      add(issues, "lock-missing", policy.name);
      continue;
    }

    if (entry[0] !== `${policy.name}@${policy.version}`) {
      add(issues, "lock-version-mismatch", policy.name);
    }
    const integrity = entry.at(-1);
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      add(issues, "lock-integrity-missing", policy.name);
    }
  }
}

function checkInstalledPackages(
  installedPackages: ReadonlyMap<string, unknown>,
  issues: RepositoryIntegrityIssue[],
): void {
  for (const policy of DIRECT_DEPENDENCY_POLICY) {
    const packageManifest = asRecord(installedPackages.get(policy.name));
    if (packageManifest === null) {
      add(issues, "package-metadata-missing", policy.name);
      continue;
    }

    if (
      stringAt(packageManifest, "name") !== policy.name ||
      stringAt(packageManifest, "version") !== policy.version ||
      stringAt(packageManifest, "license") !== policy.license ||
      normalizedRepository(packageManifest.repository) !== policy.repository
    ) {
      add(issues, "package-metadata-mismatch", policy.name);
    }

    const scripts = asRecord(packageManifest.scripts) ?? {};
    for (const hook of INSTALL_LIFECYCLE_HOOKS) {
      const declared = stringAt(scripts, hook);
      const approved = policy.installLifecycleHooks?.[hook] ?? null;
      if (declared !== approved) {
        add(issues, "install-lifecycle-hook", `${policy.name}:${hook}`);
      }
    }
  }
}

function checkPatches(
  manifest: JsonRecord,
  sourcePaths: ReadonlySet<string>,
  issues: RepositoryIntegrityIssue[],
): void {
  const declaredPatches = manifest.patchedDependencies;
  if (declaredPatches === undefined) {
    return;
  }

  const patches = stringMap(declaredPatches);
  if (patches === null) {
    add(issues, "manifest-invalid", "patched dependencies");
    return;
  }

  const policyReferences = new Set<string>(
    DIRECT_DEPENDENCY_POLICY.map((policy) => `${policy.name}@${policy.version}`),
  );
  for (const [reference, patchPath] of patches) {
    if (!policyReferences.has(reference)) {
      add(issues, "patch-unapproved", reference);
    }
    if (!isPatchPath(patchPath)) {
      add(issues, "patch-path-invalid", reference);
    }
    if (!sourcePaths.has(patchPath)) {
      add(issues, "patch-missing", reference);
    }
  }
}

function checkGeneratedOutput(
  manifest: JsonRecord,
  sourcePaths: ReadonlySet<string>,
  gitignore: string,
  trackedPaths: readonly string[],
  issues: RepositoryIntegrityIssue[],
): void {
  if (!sourcePaths.has(GENERATED_EXECUTABLE.source)) {
    add(issues, "generated-source-missing", GENERATED_EXECUTABLE.source);
  }

  const scripts = asRecord(manifest.scripts);
  const build = scripts === null ? null : stringAt(scripts, GENERATED_EXECUTABLE.script);
  if (
    build === null ||
    !build.includes("bun build") ||
    !build.includes(GENERATED_EXECUTABLE.source) ||
    // The destination is named in one piece rather than as a `cd` plus a bare
    // filename, so the build script stays runnable on a Windows shell that has
    // no `mkdir -p`. Bun creates the missing directory itself.
    !build.includes(`--outfile ${GENERATED_EXECUTABLE.destination}`)
  ) {
    add(issues, "generated-build-mismatch", GENERATED_EXECUTABLE.destination);
  }

  if (
    !gitignore.split(/\r?\n/).some((line) => line.trim() === GENERATED_EXECUTABLE.ignoredDirectory)
  ) {
    add(issues, "generated-output-not-ignored", GENERATED_EXECUTABLE.destination);
  }

  if (trackedPaths.some((path) => path === "dist" || path.startsWith("dist/"))) {
    add(issues, "generated-output-tracked", GENERATED_EXECUTABLE.destination);
  }
}

export function auditRepository(
  input: RepositoryIntegrityInput,
): readonly RepositoryIntegrityIssue[] {
  const issues: RepositoryIntegrityIssue[] = [];
  const manifest = asRecord(input.manifest);
  if (manifest === null) {
    add(issues, "manifest-invalid", "package manifest");
    return issues;
  }

  checkDirectDependencies(manifest, issues);
  checkLockfile(input.lockfile, issues);
  checkInstalledPackages(input.installedPackages, issues);
  checkPatches(manifest, input.sourcePaths, issues);
  checkGeneratedOutput(manifest, input.sourcePaths, input.gitignore, input.trackedPaths, issues);
  return issues;
}

async function readJson(path: string): Promise<unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(await readFile(path, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new Error("invalid repository JSON");
  }
  return parsed;
}

async function readSourcePaths(root: string, manifest: unknown): Promise<ReadonlySet<string>> {
  const paths = new Set<string>([GENERATED_EXECUTABLE.source]);
  const patches = stringMap(asRecord(manifest)?.patchedDependencies);
  for (const path of patches?.values() ?? []) {
    if (isPatchPath(path)) {
      paths.add(path);
    }
  }

  const present = await Promise.all(
    [...paths].map(async (path) => [path, await Bun.file(join(root, path)).exists()] as const),
  );
  return new Set(present.filter(([, exists]) => exists).map(([path]) => path));
}

function trackedPaths(root: string): readonly string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, "ls-files", "--cached", "--", "dist"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    throw new Error("could not inspect the repository index");
  }
  return new TextDecoder().decode(result.stdout).split("\n").filter(Boolean);
}

async function readRepositoryInput(root: string): Promise<RepositoryIntegrityInput> {
  const manifest = await readJson(join(root, "package.json"));
  const [lockfile, gitignore, sourcePaths] = await Promise.all([
    readJson(join(root, "bun.lock")),
    readFile(join(root, ".gitignore"), "utf8"),
    readSourcePaths(root, manifest),
  ]);
  const installedPackages = new Map<string, unknown>();
  for (const policy of DIRECT_DEPENDENCY_POLICY) {
    installedPackages.set(
      policy.name,
      await readJson(join(root, "node_modules", policy.name, "package.json")),
    );
  }

  return {
    manifest,
    lockfile,
    installedPackages,
    sourcePaths,
    gitignore,
    trackedPaths: trackedPaths(root),
  };
}

async function main(): Promise<void> {
  try {
    const root = dirname(dirname(import.meta.path));
    const issues = auditRepository(await readRepositoryInput(root));
    if (issues.length === 0) {
      console.log(
        `repository integrity verified for ${DIRECT_DEPENDENCY_POLICY.length} direct dependencies`,
      );
      return;
    }

    for (const issue of issues) {
      console.error(`repository integrity: ${issue.code} (${issue.subject})`);
    }
    process.exitCode = 1;
  } catch {
    console.error("repository integrity could not read required local metadata");
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
