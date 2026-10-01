/**
 * Which CI tier a pull request needs.
 *
 * A documentation change touches nothing a test or a build reads, so it runs the static
 * checks only. A scoped change touches source that only the tests reaching it can break,
 * and few of them. It runs those tests, not the whole suite, on Linux and macOS. The
 * compiled smoke suites and the Windows baseline run for every pull request that is not
 * documentation only. Every other change runs the full suite, and so does every push to
 * `main`, so a wrong verdict costs a red `main`, never an unchecked release.
 *
 * Scoping is by test, not by platform: four of the last 120 pull-request runs failed
 * only on macOS or Windows, and each failure was in a test that imports the code it
 * exercises, or in a compiled suite that always runs. The whole-tree suites at the
 * `src/` root take a few seconds and also run every time, because no import edge
 * connects them to the file whose placement or text they check.
 *
 * The rule fails open by construction. A change is scoped only when every changed path
 * is on an allowlist and none is on an exclusion. A path nobody listed, a diff that
 * could not be read, a selection that could not be measured, or an event other than a
 * pull request all select the full tier.
 *
 * Usage: `bun run tools/quality/ci-profile.ts --event <name> [--base <sha>]`. It
 * prints one JSON line and, in GitHub Actions, writes `profile` and `reason` outputs.
 */
import { appendFileSync } from "node:fs";

export const CI_PROFILES = ["docs", "scoped", "full"] as const;
export type CiProfile = (typeof CI_PROFILES)[number];

/** More reachable test files than this and scoping saves too little to be worth the risk. */
export const SCOPED_MAX_TEST_FILES = 200;
/** A diff this wide is a refactor or a rename wave, not a scoped change. */
export const SCOPED_MAX_CHANGED_PATHS = 120;
/** How long the selection probe may take before the tier falls back to full. */
export const SELECTION_TIMEOUT_MS = 90_000;

/** Documentation that no test or build step reads. */
const DOCUMENTATION = ["*.md", "docs/**", ".agents/**/*.md", "LICENSE", "NOTICE"] as const;

/** TypeScript whose breakage shows in the tests that import it, on any platform. */
const SCOPED_ELIGIBLE = ["src/**/*.ts", "src/**/*.tsx"] as const;

/**
 * Inside the allowlist, what still needs the whole suite: the entrypoint every build and
 * every compiled suite starts from. A hub module needs no entry here, because its reach
 * exceeds the limit below, and a compiled suite needs none, because the compiled smoke
 * jobs run it whole on every platform for every pull request.
 */
const ALWAYS_FULL = ["src/main.ts"] as const;

/** Git reports normalized relative paths; anything else is not evidence about a scoped change. */
const isUnnormalized = (path: string) =>
  path.startsWith("/") ||
  path.includes("\\") ||
  path.split("/").some((part) => part === ".." || part === ".");

const matchers = (patterns: readonly string[]) => patterns.map((pattern) => new Bun.Glob(pattern));
const documentation = matchers(DOCUMENTATION);
const eligible = matchers(SCOPED_ELIGIBLE);
const excluded = matchers(ALWAYS_FULL);
const matches = (globs: readonly Bun.Glob[], path: string) =>
  globs.some((glob) => glob.match(path));

export type ChangeEvidence = {
  readonly event: string;
  /** Every changed path, renames as a deletion plus an addition; null when unreadable. */
  readonly changedPaths: readonly string[] | null;
  /** Test files `bun test --changed` would run, and in total; null when not measured. */
  readonly selection: { readonly selected: number; readonly total: number } | null;
};
export type Classification = { readonly profile: CiProfile; readonly reason: string };

const full = (reason: string): Classification => ({ profile: "full", reason });

/** The path-only part of the decision. `null` means paths alone do not decide. */
export function classifyPaths(
  event: string,
  paths: readonly string[] | null,
): Classification | null {
  if (event !== "pull_request") return full(`${event} runs every platform`);
  if (paths === null) return full("the changed paths could not be read");
  if (paths.length === 0) return full("no changed paths were found");
  if (paths.length > SCOPED_MAX_CHANGED_PATHS)
    return full(`${paths.length} changed paths exceed ${SCOPED_MAX_CHANGED_PATHS}`);
  const unlisted = paths.find(
    (path) =>
      isUnnormalized(path) ||
      (!matches(documentation, path) && (!matches(eligible, path) || matches(excluded, path))),
  );
  if (unlisted !== undefined) return full(`${unlisted} needs every platform`);
  return null;
}

/** Whether the decision needs the reachable-test count, which costs an install. */
export function needsSelection(event: string, paths: readonly string[] | null): boolean {
  return classifyPaths(event, paths) === null && !(paths ?? []).every(isDocumentation);
}
const isDocumentation = (path: string) => matches(documentation, path);

export function classifyChange(evidence: ChangeEvidence): Classification {
  const byPath = classifyPaths(evidence.event, evidence.changedPaths);
  if (byPath !== null) return byPath;
  const paths = evidence.changedPaths ?? [];
  if (paths.every(isDocumentation))
    return { profile: "docs", reason: "documentation only: no test or build reads it" };
  const { selection } = evidence;
  if (selection === null) return full("the reachable tests could not be counted");
  if (selection.selected > SCOPED_MAX_TEST_FILES)
    return full(
      `${selection.selected} of ${selection.total} test files are reachable, over ${SCOPED_MAX_TEST_FILES}`,
    );
  return {
    profile: "scoped",
    reason: `${paths.length} paths reach ${selection.selected} of ${selection.total} test files`,
  };
}

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/** Reads Bun's opening `--changed:` line. Null when Bun printed neither form. */
export function parseSelection(output: string): ChangeEvidence["selection"] {
  const text = output.replace(ANSI_SGR, "");
  const running = /--changed: .*running (\d+)\/(\d+) test files/u.exec(text);
  if (running?.[1] !== undefined && running[2] !== undefined)
    return { selected: Number(running[1]), total: Number(running[2]) };
  if (/--changed: .*no test files are affected/u.test(text)) return { selected: 0, total: 0 };
  return null;
}

async function git(args: readonly string[]): Promise<string | null> {
  const run = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(run.stdout).text();
  return (await run.exited) === 0 ? text : null;
}

/** Both sides of a rename appear, so a moved file cannot hide the one it left. */
async function changedPaths(base: string): Promise<readonly string[] | null> {
  const out = await git(["diff", "--no-renames", "--name-only", base, "HEAD"]);
  return out === null ? null : out.split("\n").filter((line) => line.length > 0);
}

/**
 * Starts `bun test --changed` only to read the count Bun prints before it runs any
 * file, then stops it. No test result is used.
 */
async function measureSelection(base: string): Promise<ChangeEvidence["selection"]> {
  const run = Bun.spawn(["bun", "test", `--changed=${base}`, "--only-failures"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const timer = setTimeout(() => run.kill("SIGKILL"), SELECTION_TIMEOUT_MS);
  let seen = "";
  try {
    const reader = run.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
      const found = parseSelection(seen);
      if (found !== null) return found;
    }
    return parseSelection(seen);
  } finally {
    clearTimeout(timer);
    run.kill("SIGKILL");
    await run.exited;
  }
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (import.meta.main) {
  const event = argument("--event") ?? "unknown";
  const base = argument("--base");
  const paths = base === undefined || event !== "pull_request" ? null : await changedPaths(base);
  const selection =
    base !== undefined && needsSelection(event, paths) ? await measureSelection(base) : null;
  const result = classifyChange({ event, changedPaths: paths, selection });
  const line = JSON.stringify({ ...result, event, changedPaths: paths?.length ?? null, selection });
  console.log(line);
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined)
    appendFileSync(output, `profile=${result.profile}\nreason=${result.reason}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined)
    appendFileSync(summary, `CI tier: **${result.profile}** (${result.reason})\n`);
}
