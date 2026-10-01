/**
 * The source suite as concurrent `bun test --shard` processes (#1196).
 *
 * Bun deals the files out by path, which spreads each directory's heavy files across
 * shards. Recorded per-file durations (`--timings`) balanced worse: they leave out the
 * cost of loading a file's modules, so one shard received hundreds of small files.
 *
 * One `bun test` process runs every file in turn, so the suite takes as long as
 * all files together. Separate processes each run a balanced share of files, and
 * each process keeps its own globals, which Bun's in-process `--parallel` does not
 * isolate well enough for the product-host suites. Compiled suites are excluded
 * here: the smoke scripts and CI compiled-smoke jobs run them against a fresh build.
 *
 * A flaky test is a defect with an owner, not noise. Only a file registered in
 * `.github/known-flaky-tests.json`, with the open issue that owns its fix, is ever
 * run again: once, on its own, in a fresh process. It keeps the run green only by
 * passing then, and is reported with its issue either way. Any other failing file
 * fails the run at once, even if it would pass on a second try, because a change can
 * introduce exactly that kind of failure. CI runs its shards through this runner, so
 * both places share one policy.
 *
 * Usage: `bun run test [bun test arguments]`. `FALRYN_TEST_SHARDS` overrides the
 * shard count (1 runs the plain serial suite). `FALRYN_TEST_SHARD=i/N` runs only
 * shard i of N, as a CI job does. `FALRYN_TEST_RETRIES=0` disables the retry.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { z } from "zod";

export const KNOWN_FLAKES_FILE = ".github/known-flaky-tests.json";
export const COMPILED_SUITES = "**/*.compiled.test.ts";
export const MAX_TEST_SHARDS = 16;
/** More failing files than this is breakage, not flakiness, and nothing is retried. */
export const MAX_RETRIED_FILES = 3;
/** A registry this long has stopped being a list of exceptions. */
export const MAX_KNOWN_FLAKES = 32;

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** A registered flaky file: the issue that owns its fix and what it looks like. */
export type KnownFlake = { readonly issue: number; readonly symptom: string };

const knownFlakesSchema = z.strictObject({
  version: z.literal(1),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(/^(?:src|tools)\/(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/u),
        issue: z.number().int().positive(),
        symptom: z.string().trim().min(1).max(240),
      }),
    )
    .max(MAX_KNOWN_FLAKES),
});

/**
 * The known-flake registry. It fails closed: a malformed document, a duplicate or an
 * entry naming a file that no longer exists stops the run, so a fixed or moved test
 * cannot leave a stale exception behind.
 */
export function parseKnownFlakes(
  text: string | null,
  exists: (path: string) => boolean,
): Parsed<ReadonlyMap<string, KnownFlake>> {
  if (text === null) return { ok: true, value: new Map() };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${KNOWN_FLAKES_FILE} is not valid JSON` };
  }
  const parsed = knownFlakesSchema.safeParse(json);
  if (!parsed.success)
    return {
      ok: false,
      reason: `${KNOWN_FLAKES_FILE} is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  const known = new Map<string, KnownFlake>();
  for (const entry of parsed.data.files) {
    if (known.has(entry.path))
      return { ok: false, reason: `${KNOWN_FLAKES_FILE} lists ${entry.path} twice` };
    if (!exists(entry.path))
      return {
        ok: false,
        reason: `${KNOWN_FLAKES_FILE} lists ${entry.path}, which does not exist; remove the entry`,
      };
    known.set(entry.path, { issue: entry.issue, symptom: entry.symptom });
  }
  return { ok: true, value: known };
}

/**
 * Half the logical cores, at most four: each shard spawns product hosts and child
 * processes of its own, so one shard per core oversubscribes the machine.
 */
export function testShardCount(
  override: string | undefined,
  cores: number,
):
  | { readonly ok: true; readonly shards: number }
  | { readonly ok: false; readonly reason: string } {
  if (override !== undefined && override !== "") {
    const value = Number(override);
    return Number.isInteger(value) && value >= 1 && value <= MAX_TEST_SHARDS
      ? { ok: true, shards: value }
      : { ok: false, reason: `FALRYN_TEST_SHARDS must be an integer from 1 to ${MAX_TEST_SHARDS}` };
  }
  return { ok: true, shards: Math.max(1, Math.min(4, Math.floor(cores / 2))) };
}

/** `FALRYN_TEST_SHARD=i/N`: run only that shard, or null to run them all. */
export function testShardSelection(
  value: string | undefined,
): Parsed<{ readonly shard: number; readonly shards: number } | null> {
  if (value === undefined || value === "") return { ok: true, value: null };
  const matched = /^(\d{1,2})\/(\d{1,2})$/u.exec(value);
  const shard = Number(matched?.[1]);
  const shards = Number(matched?.[2]);
  return matched !== null &&
    shards >= 1 &&
    shards <= MAX_TEST_SHARDS &&
    shard >= 1 &&
    shard <= shards
    ? { ok: true, value: { shard, shards } }
    : { ok: false, reason: `FALRYN_TEST_SHARD must be i/N with 1 <= i <= N <= ${MAX_TEST_SHARDS}` };
}

/** `FALRYN_TEST_RETRIES`: 1 (the default) retries a failing file once; 0 never does. */
export function testRetries(value: string | undefined): Parsed<0 | 1> {
  if (value === undefined || value === "" || value === "1") return { ok: true, value: 1 };
  return value === "0"
    ? { ok: true, value: 0 }
    : { ok: false, reason: "FALRYN_TEST_RETRIES must be 0 or 1" };
}

export function shardArguments(
  shard: number,
  shards: number,
  passthrough: readonly string[],
): string[] {
  return [
    "test",
    ...(shards > 1 ? [`--shard=${shard}/${shards}`] : []),
    `--path-ignore-patterns=${COMPILED_SUITES}`,
    ...passthrough,
  ];
}

/** A lone file, by exact path, with the caller's flags but no shard selection. */
export function retryArguments(file: string, passthrough: readonly string[]): string[] {
  return ["test", ...passthrough, `./${file}`];
}

const FILE_HEADER = /^(?:::group::)?(\S+\.test\.[cm]?[jt]sx?):$/u;
/**
 * Colour codes Bun adds when a terminal or `FORCE_COLOR` asks for them. Built from the
 * escape character rather than written as a literal, which the source-text test refuses.
 */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/**
 * The test files one `bun test` run reported failures in. `attributed` is false
 * when a failure appeared outside any file, which no single-file retry can repeat.
 */
export function failingTestFiles(output: string): {
  readonly files: readonly string[];
  readonly attributed: boolean;
} {
  const files = new Set<string>();
  let current: string | null = null;
  let attributed = true;
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.replace(ANSI_SGR, "");
    // Bun ends a run by repeating every failure under "N tests failed:", outside any
    // file. Each one already appeared inside its own file, so the recap adds nothing.
    if (/^\d+ tests? failed:$/u.test(line)) break;
    const header = FILE_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      continue;
    }
    if (line.startsWith("::endgroup::")) current = null;
    // A coloured run marks a failure "✗ name" where a plain one writes "(fail) name".
    else if (
      line.startsWith("(fail) ") ||
      line.startsWith("\u2717 ") ||
      line.startsWith("# Unhandled error")
    ) {
      if (current === null) attributed = false;
      else files.add(current);
    }
  }
  return { files: [...files], attributed };
}

export type RetryPlan =
  | { readonly kind: "none" }
  | { readonly kind: "retry"; readonly files: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

/** Whether the failed runs' files may be retried: all registered, and few of them. */
export function retryPlan(
  failed: readonly { readonly output: string }[],
  retries: 0 | 1,
  known: ReadonlyMap<string, KnownFlake>,
): RetryPlan {
  if (failed.length === 0) return { kind: "none" };
  if (retries === 0) return { kind: "refused", reason: "retries are disabled" };
  const files = new Set<string>();
  for (const run of failed) {
    const found = failingTestFiles(run.output);
    if (!found.attributed || found.files.length === 0)
      return { kind: "refused", reason: "a failure could not be tied to a test file" };
    for (const file of found.files) files.add(file);
  }
  if (files.size > MAX_RETRIED_FILES)
    return {
      kind: "refused",
      reason: `${files.size} files failed; more than ${MAX_RETRIED_FILES} is not treated as flakiness`,
    };
  const unknown = [...files].filter((file) => !known.has(file)).sort();
  return unknown.length > 0
    ? {
        kind: "refused",
        reason: `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a known flake. Fix the failure; if it is a flake, it needs an owning issue and an entry in ${KNOWN_FLAKES_FILE} first`,
      }
    : { kind: "retry", files: [...files].sort() };
}

export type ShardResult = {
  readonly shard: number;
  readonly exitCode: number;
  readonly seconds: number;
  /** "Ran N tests across M files", when Bun reported it. */
  readonly ran: string | null;
};

export function shardSummary(
  results: readonly ShardResult[],
  shards: number,
  seconds: number,
): string[] {
  const failed = results.filter((result) => result.exitCode !== 0);
  const scope =
    results.length === shards
      ? `all ${shards} shards`
      : `shard ${results.map((result) => result.shard).join(", ")}`;
  return [
    ...[...results]
      .sort((a, b) => a.shard - b.shard)
      .map(
        (result) =>
          `shard ${result.shard}/${shards} ${result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`} in ${result.seconds.toFixed(0)}s${result.ran === null ? "" : ` — ${result.ran}`}`,
      ),
    failed.length === 0
      ? `${scope} passed in ${seconds.toFixed(0)}s`
      : `${failed.length} of ${results.length} shards failed after ${seconds.toFixed(0)}s: ${failed.map((result) => result.shard).join(", ")}`,
  ];
}

export type RetryResult = {
  readonly file: string;
  readonly passed: boolean;
  readonly flake: KnownFlake;
};

/** The verdict after retries. Every retried file is named with its owning issue. */
export function retrySummary(results: readonly RetryResult[]): {
  readonly passed: boolean;
  readonly flaky: readonly RetryResult[];
  readonly lines: readonly string[];
} {
  const flaky = results.filter((result) => result.passed);
  const failing = results.filter((result) => !result.passed);
  return {
    passed: failing.length === 0,
    flaky,
    lines: [
      ...flaky.map(
        (result) =>
          `KNOWN FLAKE ${result.file} (#${result.flake.issue}): failed in its shard, passed when run alone`,
      ),
      ...failing.map(
        (result) =>
          `FAILED ${result.file} (known flake #${result.flake.issue}): failed again when run alone`,
      ),
      failing.length === 0
        ? `the run passes on known flakes; their issues own the fix`
        : `the run fails: ${failing.length} ${failing.length === 1 ? "file fails" : "files fail"} on retry`,
    ],
  };
}

/** GitHub Actions warnings and a job summary, so a flaky pass stays visible on the PR. */
function reportFlakyToActions(flaky: readonly RetryResult[]): void {
  if (process.env.GITHUB_ACTIONS !== "true" || flaky.length === 0) return;
  for (const { file, flake } of flaky)
    process.stdout.write(
      `::warning file=${file},title=Known flaky test (#${flake.issue})::${file} failed in its shard and passed when run alone. Its fix is owned by #${flake.issue}.\n`,
    );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(
      summary,
      `### Known flaky tests that failed and passed alone\n\n${flaky.map(({ file, flake }) => `- \`${file}\` (#${flake.issue}): ${flake.symptom}`).join("\n")}\n`,
    );
}

type Run = { readonly exitCode: number; readonly output: string; readonly seconds: number };

const running = new Set<Bun.Subprocess>();

/** One `bun test` process. A live run streams while capturing; others print when done. */
async function runBunTest(args: readonly string[], live: boolean, label: string): Promise<Run> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  running.add(child);
  try {
    const collect = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        if (live) sink.write(chunk);
        text += decoder.decode(chunk, { stream: true });
      }
      return text + decoder.decode();
    };
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout, process.stdout),
      collect(child.stderr, process.stderr),
      child.exited,
    ]);
    const seconds = (performance.now() - started) / 1000;
    if (!live) {
      process.stderr.write(`\n── ${label} (exit ${exitCode}, ${seconds.toFixed(0)}s) ──\n`);
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    }
    return { exitCode, output: stderr + stdout, seconds };
  } finally {
    running.delete(child);
  }
}

async function main(passthrough: readonly string[]): Promise<number> {
  const count = testShardCount(process.env.FALRYN_TEST_SHARDS, availableParallelism());
  const selection = testShardSelection(process.env.FALRYN_TEST_SHARD);
  const retries = testRetries(process.env.FALRYN_TEST_RETRIES);
  const known = parseKnownFlakes(
    existsSync(KNOWN_FLAKES_FILE) ? readFileSync(KNOWN_FLAKES_FILE, "utf8") : null,
    existsSync,
  );
  if (!count.ok || !selection.ok || !retries.ok || !known.ok) {
    for (const parsed of [count, selection, retries, known])
      if (!parsed.ok) process.stderr.write(`${parsed.reason}\n`);
    return 2;
  }
  const shards = selection.value?.shards ?? count.shards;
  const selected =
    selection.value === null
      ? Array.from({ length: shards }, (_, index) => index + 1)
      : [selection.value.shard];
  // Interrupting the runner stops every test process rather than leaving them running.
  const stop = () => {
    for (const child of running) child.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const started = performance.now();
  const live = selected.length === 1;
  if (!live) process.stderr.write(`running the source suite in ${shards} shards\n`);
  // Concurrent shards print whole when each finishes, so their output never interleaves.
  const runs = await Promise.all(
    selected.map(async (shard) => ({
      shard,
      ...(await runBunTest(
        shardArguments(shard, shards, passthrough),
        live,
        `shard ${shard}/${shards}`,
      )),
    })),
  );
  const results: ShardResult[] = runs.map((run) => ({
    shard: run.shard,
    exitCode: run.exitCode,
    seconds: run.seconds,
    ran: /Ran \d+ tests? across \d+ files?/u.exec(run.output)?.[0] ?? null,
  }));
  process.stderr.write(
    `\n${shardSummary(results, shards, (performance.now() - started) / 1000).join("\n")}\n`,
  );

  const plan = retryPlan(
    runs.filter((run) => run.exitCode !== 0),
    retries.value,
    known.value,
  );
  if (plan.kind === "none") return 0;
  if (plan.kind === "refused") {
    process.stderr.write(`not retrying: ${plan.reason}\n`);
    return 1;
  }
  process.stderr.write(`\nretrying ${plan.files.length} known flaky file(s) alone, once each\n`);
  const retried: RetryResult[] = [];
  for (const file of plan.files) {
    const flake = known.value.get(file);
    if (flake === undefined) return 1;
    const run = await runBunTest(retryArguments(file, passthrough), false, `retry ${file}`);
    retried.push({ file, passed: run.exitCode === 0, flake });
  }
  const verdict = retrySummary(retried);
  process.stderr.write(`\n${verdict.lines.join("\n")}\n`);
  reportFlakyToActions(verdict.flaky);
  return verdict.passed ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
