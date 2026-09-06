import { genericLintOutput } from "./diagnostics.ts";

export function genericBuildOutput(argv: readonly string[] = []): string {
  if (argv.includes("--fail")) return genericLintOutput();
  return [
    "Falryn build",
    "Build step 1/3: compile context engine",
    "Build step 2/3: bundle runtime",
    "Build step 3/3: write manifest",
    "Build complete: dist/falryn (1.2 MB) in 420 ms",
  ].join("\n");
}

export function errOutput(argv: readonly string[]): string {
  if (argv[0] !== "build" || argv[1] !== "--fail") {
    throw new Error(`unsupported err fixture arguments: ${argv.join(" ")}`);
  }
  return [
    "src/runtime.ts:14:6: error BUILD001: Missing provider route.",
    "src/router.ts:28:3: warning BUILD002: Fallback route is not explicit.",
    "2 issues (1 error, 1 warning)",
  ].join("\n");
}

export function nextBuildOutput(): string {
  return [
    "▲ Next.js 15.4.0",
    "Creating an optimized production build",
    "✓ Compiled successfully in 4.2s",
    "Collecting page data",
    "Generating static pages (2/2)",
    "Finalizing page optimization",
    "Route (app) Size First Load JS",
    "○ / 5.2kB 102kB",
    "ƒ /api/context 0B 97kB",
  ].join("\n");
}

export function nxBuildOutput(): string {
  return [
    "NX Running target build for project falryn",
    "> nx run falryn:build",
    "output: dist/apps/falryn",
    "Successfully ran target build for project falryn (2.1s)",
  ].join("\n");
}

export function turboBuildOutput(): string {
  return [
    "• Packages in scope: @falryn/app, @falryn/core",
    "• Running build in 2 packages",
    "• Remote caching disabled",
    "@falryn/core:build: cache miss, executing 2d736",
    "@falryn/core:build: built dist/core.js",
    "@falryn/app:build: cache miss, executing 784aa",
    "@falryn/app:build: built dist/app.js",
    "Tasks: 2 successful, 2 total",
    "Cached: 0 cached, 2 total",
    "Time: 1.2s",
  ].join("\n");
}

export function prismaOutput(argv: readonly string[]): string {
  const prefix = [
    "Environment variables loaded from .env",
    "Prisma schema loaded from prisma/schema.prisma",
  ];
  if (argv[0] === "generate") {
    return [
      ...prefix,
      "✔ Generated Prisma Client (v6.14.0) to ./node_modules/@prisma/client in 123ms",
      "Start by importing your Prisma Client",
    ].join("\n");
  }
  if (argv[0] === "migrate" && argv[1] === "dev") {
    return [
      ...prefix,
      'Datasource "db": SQLite database "dev.db" at "file:./dev.db"',
      "Applying migration `20260825_add_context_receipts`",
      "The following migration(s) have been applied:",
      "migrations/",
      "  └─ 20260825_add_context_receipts/",
      "Your database is now in sync with your schema.",
    ].join("\n");
  }
  if (argv[0] === "migrate" && argv[1] === "status") {
    return [
      ...prefix,
      'Datasource "db": SQLite database "dev.db" at "file:./dev.db"',
      "12 migrations found in prisma/migrations",
      "Database schema is up to date!",
    ].join("\n");
  }
  if (argv[0] === "db" && argv[1] === "push") {
    return [
      ...prefix,
      'Datasource "db": SQLite database "dev.db" at "file:./dev.db"',
      "🚀 Your database is now in sync with your Prisma schema. Done in 84ms",
    ].join("\n");
  }
  if (argv[0] === "validate") {
    return [...prefix, "The schema at prisma/schema.prisma is valid 🚀"].join("\n");
  }
  throw new Error(`unsupported prisma fixture arguments: ${argv.join(" ")}`);
}

function mixOutput(): string {
  return [
    "** (Mix) mix format failed due to --check-formatted.",
    "The following files are not formatted:",
    "  * lib/falryn.ex",
    "  * lib/router.ex",
  ].join("\n");
}

export function mixCommandOutput(argv: readonly string[]): string {
  if (argv[0] === "format") return mixOutput();
  if (argv[0] === "compile") {
    return ["Compiling 42 files (.ex)", "Generated falryn app"].join("\n");
  }
  throw new Error(`unsupported mix fixture arguments: ${argv.join(" ")}`);
}

export function compilerBuildOutput(source: string): string {
  return `${source}:14:6: warning: unused variable 'context' [-Wunused-variable]`;
}

export function platformIoBuildOutput(): string {
  return [
    "Processing native (platform: native; board: native)",
    "----------------------------------------------------------------",
    "Verbose mode can be enabled via `-v, --verbose` option",
    "RAM:   [==        ]  18.4% (used 6024 bytes from 32768 bytes)",
    "Flash: [====      ]  42.1% (used 44160 bytes from 104857 bytes)",
    "Building .pio/build/native/program",
    "========================= [SUCCESS] Took 1.23 seconds =========================",
  ].join("\n");
}

export function quartoBuildOutput(): string {
  return [
    "Rendering docs/index.qmd",
    "pandoc index.md --to html --output _site/index.html",
    "Output created: _site/index.html",
  ].join("\n");
}

export function trunkBuildOutput(): string {
  return [
    "2026-08-25T12:00:00Z INFO starting build",
    "2026-08-25T12:00:00Z INFO spawning asset pipelines",
    "2026-08-25T12:00:01Z INFO Finished `release` target(s) in 0.42s",
    "2026-08-25T12:00:01Z INFO success: Build completed to dist/index.html",
  ].join("\n");
}

export function taskRunnerBuildOutput(prefix: string): string {
  return [
    prefix,
    "Falryn build",
    "Build step 1/3: compile context engine",
    "Build step 2/3: bundle runtime",
    "Build step 3/3: write manifest",
    "Build complete: dist/falryn (1.2 MB) in 420 ms",
  ].join("\n");
}

export function shopifyOutput(argv: readonly string[]): string {
  const action = argv[0] === "theme" ? (argv[1] ?? "push") : (argv[0] ?? "push");
  return [
    "⠋ Uploading theme files",
    `Theme falryn-${action} ${action === "pull" ? "pulled from" : "pushed to"} falryn-store.myshopify.com (42 files)`,
    "Preview URL: https://falryn-store.myshopify.com?preview_theme_id=736",
  ].join("\n");
}

export function ollamaOutput(argv: readonly string[]): string {
  return argv[0] === "run"
    ? "Falryn model response: every required build fact is preserved."
    : "ollama operation complete";
}

export function javaOutput(argv: readonly string[]): string {
  return argv[0] === "-jar"
    ? "Falryn Java application: context engine ready"
    : "Falryn Java operation complete";
}

export function buildkitOutput(compose: boolean): string {
  return [
    '#0 building with "desktop-linux" instance using docker driver',
    "#1 [internal] load build definition from Dockerfile",
    "#1 DONE 0.0s",
    "#2 [internal] load metadata for docker.io/library/bun:1.4",
    "#2 DONE 0.2s",
    "#3 [1/2] COPY . /app",
    "#3 DONE 0.1s",
    "#4 [2/2] RUN bun run build",
    "#4 DONE 0.3s",
    "#5 exporting to image",
    "#5 writing image sha256:736abc784def",
    "#5 naming to docker.io/library/falryn:latest",
    "#5 DONE 0.1s",
    ...(compose ? [" falryn Built"] : []),
  ].join("\n");
}
