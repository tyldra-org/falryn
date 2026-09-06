import { biomeOutput, rubocopOutput } from "./diagnostics.ts";
import { jestOutput, playwrightOutput, pytestOutput, rspecOutput, vitestOutput } from "./test.ts";

export function npxOutput(argv: readonly string[]): string {
  const tool = argv.find((argument) => ["jest", "vitest", "playwright"].includes(argument));
  if (tool === "jest") return jestOutput(argv);
  if (tool === "vitest") return vitestOutput(argv);
  if (tool === "playwright") return playwrightOutput(argv);
  return packageRunnerOutput();
}

export function npmOutput(argv: readonly string[]): string {
  const action = argv[0] ?? "";
  if (["install", "i", "ci"].includes(action)) {
    return [
      "added 12 packages, and audited 13 packages in 1s",
      "",
      "2 packages are looking for funding",
      "  run `npm fund` for details",
      "",
      "found 0 vulnerabilities",
    ].join("\n");
  }
  if (action === "list" || action === "ls") {
    return [
      "falryn@0.3.0 /workspace",
      "├── @falryn/context@0.3.0",
      "├── zod@4.0.0",
      "└── typescript@5.9.2",
    ].join("\n");
  }
  if (action === "outdated") {
    return [
      "Package          Current  Wanted  Latest  Location                       Depended by",
      "@falryn/context  0.2.0    0.2.5   0.3.0   node_modules/@falryn/context  falryn",
      "zod              3.24.0   3.25.0  4.0.0   node_modules/zod              falryn",
    ].join("\n");
  }
  if (action === "run" || action === "run-script") {
    return [
      "> falryn@0.3.0 verify",
      "> node tools/verify-packages.mjs",
      "",
      "checking package graph",
      "verified 12 packages",
    ].join("\n");
  }
  throw new Error(`unsupported npm fixture arguments: ${argv.join(" ")}`);
}

export function pnpmOutput(argv: readonly string[]): string {
  const action = argv.find((argument) => ["install", "list", "outdated", "run"].includes(argument));
  if (action === "install") {
    return [
      "Progress: resolved 12, reused 10, downloaded 2, added 3",
      "Packages: +3",
      "+++",
      "Progress: resolved 12, reused 10, downloaded 2, added 3, done",
      "",
      "dependencies:",
      "+ @falryn/context 0.3.0",
      "+ zod 4.0.0",
      "",
      "devDependencies:",
      "+ typescript 5.9.2",
      "",
      "Done in 1.2s using pnpm v11.0.0",
    ].join("\n");
  }
  if (action === "list") {
    if (argv.includes("--json") || argv.some((argument) => argument.startsWith("--json="))) {
      return JSON.stringify([
        {
          name: "falryn",
          version: "0.3.0",
          dependencies: {
            "@falryn/context": { version: "0.3.0" },
            zod: { version: "4.0.0" },
          },
          devDependencies: { typescript: { version: "5.9.2" } },
        },
      ]);
    }
    return [
      "Legend: production dependency, optional only, dev only",
      "",
      "falryn@0.3.0 /workspace",
      "",
      "dependencies:",
      "@falryn/context 0.3.0",
      "zod 4.0.0",
      "",
      "devDependencies:",
      "typescript 5.9.2",
    ].join("\n");
  }
  if (action === "outdated") {
    if (argv.includes("json")) {
      return JSON.stringify({
        "@falryn/context": {
          current: "0.2.0",
          wanted: "0.2.5",
          latest: "0.3.0",
          dependencyType: "dependencies",
        },
        zod: {
          current: "3.24.0",
          wanted: "3.25.0",
          latest: "4.0.0",
          dependencyType: "dependencies",
        },
      });
    }
    return [
      "Package          Current  Wanted  Latest  Package Type",
      "@falryn/context  0.2.0    0.2.5   0.3.0   dependencies",
      "zod              3.24.0   3.25.0  4.0.0   dependencies",
    ].join("\n");
  }
  if (action === "run") {
    return [
      "> falryn@0.3.0 verify /workspace",
      "> node tools/verify-packages.mjs",
      "",
      "checking package graph",
      "verified 12 packages",
    ].join("\n");
  }
  throw new Error(`unsupported pnpm fixture arguments: ${argv.join(" ")}`);
}

export function yarnOutput(argv: readonly string[]): string {
  const action = argv[0] ?? "";
  if (action === "install") {
    return [
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
    ].join("\n");
  }
  if (action === "list") {
    return [
      "yarn list v1.22.22",
      "├─ @falryn/context@0.3.0",
      "├─ zod@4.0.0",
      "└─ typescript@5.9.2",
      "Done in 0.21s.",
    ].join("\n");
  }
  if (action === "outdated") {
    return [
      "Package          Current  Wanted  Latest  Package Type  URL",
      "@falryn/context  0.2.0    0.2.5   0.3.0   dependencies  https://example.test/context",
      "zod              3.24.0   3.25.0  4.0.0   dependencies  https://example.test/zod",
    ].join("\n");
  }
  if (action === "run") {
    return [
      "yarn run v1.22.22",
      "$ node tools/verify-packages.mjs",
      "checking package graph",
      "verified 12 packages",
      "Done in 0.18s.",
    ].join("\n");
  }
  throw new Error(`unsupported yarn fixture arguments: ${argv.join(" ")}`);
}

export function packageRunnerOutput(): string {
  return [
    "checking package graph",
    "checking package graph",
    "checking package graph",
    "verified 12 packages",
  ].join("\n");
}

export function bunOutput(argv: readonly string[]): string {
  const action = argv[0] ?? "";
  if (action === "test") {
    return [
      "bun test v1.4.0",
      "✓ complete",
      "✓ budget",
      "",
      "2 pass",
      "0 fail",
      "4 expect() calls",
      "Ran 2 tests across 1 file. [12.00ms]",
    ].join("\n");
  }
  if (action === "install" || action === "add") {
    return [
      `bun ${action} v1.4.0 (0aa2b1cd)`,
      "Resolving dependencies",
      "Resolved, downloaded and extracted [12]",
      "Saved lockfile",
      "",
      "+ @falryn/context@0.3.0",
      "+ zod@4.0.0",
      "+ typescript@5.9.2",
      "",
      "12 packages installed [118.00ms]",
    ].join("\n");
  }
  if (action === "run") {
    if (argv[1] === "build") {
      return [
        "$ bun build src/index.ts --outdir dist",
        "Bundled 42 modules in 48ms",
        "  dist/falryn.js 1.2MB (entry point)",
      ].join("\n");
    }
    if (argv[1] === "typecheck") {
      return [
        "src/runtime.ts(14,6): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/router.ts(28,3): error TS2339: Property 'route' does not exist on type 'Context'.",
        "Found 2 errors in 2 files.",
      ].join("\n");
    }
    if (argv[1] === "check" || argv[1] === "lint") {
      return `$ biome check .\n${biomeOutput()}`;
    }
    return [
      "$ bun run tools/verify-packages.mjs",
      "checking package graph",
      "checking package graph",
      "checking package graph",
      "verified 12 packages",
    ].join("\n");
  }
  if (action === "outdated") {
    return [
      "Package          Current  Wanted  Latest  Location                       Depended by",
      "@falryn/context  0.2.0    0.2.5   0.3.0   node_modules/@falryn/context  falryn",
      "zod              3.24.0   3.25.0  4.0.0   node_modules/zod              falryn",
    ].join("\n");
  }
  if (action === "audit") {
    return "No vulnerabilities found";
  }
  if (action === "pm" && argv[1] === "ls") {
    return [
      "/workspace node_modules (3)",
      "├── @falryn/context@0.3.0",
      "├── zod@4.0.0",
      "└── typescript@5.9.2",
    ].join("\n");
  }
  throw new Error(`unsupported bun fixture arguments: ${argv.join(" ")}`);
}

export function pipOutput(argv: readonly string[]): string {
  const outdated = argv.includes("outdated") || argv.includes("--outdated");
  const json = argv.some((argument) => argument === "--format=json" || argument === "--json");
  if (json) {
    return JSON.stringify(
      outdated
        ? [
            { name: "requests", version: "2.31.0", latest_version: "2.32.3" },
            { name: "urllib3", version: "2.1.0", latest_version: "2.2.2" },
          ]
        : [
            { name: "certifi", version: "2026.8.1" },
            { name: "requests", version: "2.32.3" },
            { name: "urllib3", version: "2.2.2" },
          ],
    );
  }
  if (outdated) {
    return [
      "Package   Version  Latest  Type",
      "--------- -------- ------- -----",
      "requests  2.31.0   2.32.3  wheel",
      "urllib3   2.1.0    2.2.2   wheel",
    ].join("\n");
  }
  if (argv[0] === "list") {
    return [
      "Package   Version",
      "--------- --------",
      "certifi   2026.8.1",
      "requests  2.32.3",
      "urllib3   2.2.2",
    ].join("\n");
  }
  if (argv[0] === "install") {
    return [
      "Collecting requests",
      "Using cached requests-2.32.3-py3-none-any.whl",
      "Installing collected packages: requests",
      "Successfully installed requests-2.32.3",
    ].join("\n");
  }
  throw new Error(`unsupported pip fixture arguments: ${argv.join(" ")}`);
}

export function uvOutput(argv: readonly string[]): string {
  if (argv[0] === "run" && argv[1] === "pytest") {
    return pytestOutput();
  }
  if (argv[0] !== "sync") {
    throw new Error(`unsupported uv fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "  Downloading requests-2.32.3-py3-none-any.whl (64.9 kB)",
    "  Using cached certifi-2026.8.1-py3-none-any.whl (161 kB)",
    "Prepared 2 packages in 15ms",
    "Installed 2 packages in 23ms",
    " + certifi==2026.8.1",
    " + requests==2.32.3",
  ].join("\n");
}

export function poetryOutput(argv: readonly string[]): string {
  if (argv[0] !== "install") {
    throw new Error(`unsupported poetry fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "Installing dependencies from lock file",
    "",
    "No dependencies to install or update",
  ].join("\n");
}

export function brewOutput(argv: readonly string[]): string {
  if (argv[0] !== "install") {
    throw new Error(`unsupported brew fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "==> Fetching downloads for: jq",
    "==> Downloading https://ghcr.io/v2/homebrew/core/jq/manifests/1.8.1",
    "######################################################################## 100.0%",
    "==> Pouring jq--1.8.1.arm64_sequoia.bottle.tar.gz",
    "==> Summary",
    "🍺  /opt/homebrew/Cellar/jq/1.8.1: 20 files, 1.4MB",
  ].join("\n");
}

export function composerOutput(argv: readonly string[]): string {
  if (argv[0] !== "install") {
    throw new Error(`unsupported composer fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "Loading composer repositories with package information",
    "Updating dependencies",
    "Lock file operations: 0 installs, 0 updates, 0 removals",
    "Nothing to install, update or remove",
    "Generating autoload files",
  ].join("\n");
}

export function bundleOutput(argv: readonly string[]): string {
  if (argv[0] === "exec" && argv[1] === "rspec") {
    return rspecOutput(argv.slice(2));
  }
  if (argv[0] === "exec" && argv[1] === "rubocop") {
    return rubocopOutput(argv.slice(2));
  }
  if (argv[0] !== "install") {
    throw new Error(`unsupported bundle fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "Using bundler 2.5.6",
    "Using rake 13.1.0",
    "Using ast 2.4.2",
    "Using minitest 5.22.2",
    "Bundle complete! 85 Gemfile dependencies, 200 gems now installed.",
    "Use `bundle info [gemname]` to see where a bundled gem is installed.",
  ].join("\n");
}
