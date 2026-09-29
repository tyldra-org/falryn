/**
 * The source suite as concurrent `bun test --shard` processes (#1196).
 *
 * One `bun test` process runs every file in turn, so the suite takes as long as
 * all files together. Separate processes each run a balanced share of files, and
 * each process keeps its own globals, which Bun's in-process `--parallel` does not
 * isolate well enough for the product-host suites. Compiled suites are excluded
 * here: the smoke scripts and CI compiled-smoke jobs run them against a fresh build.
 *
 * Usage: `bun run test [bun test arguments]`. `FALRYN_TEST_SHARDS` overrides the
 * shard count (1 runs the plain serial suite).
 */
import { availableParallelism } from "node:os";

export const TIMINGS_FILE = ".github/test-timings.json";
export const COMPILED_SUITES = "**/*.compiled.test.ts";
export const MAX_TEST_SHARDS = 16;

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

export function shardArguments(
  shard: number,
  shards: number,
  passthrough: readonly string[],
): string[] {
  return [
    "test",
    ...(shards > 1 ? [`--shard=${shard}/${shards}`] : []),
    `--timings=${TIMINGS_FILE}`,
    `--path-ignore-patterns=${COMPILED_SUITES}`,
    ...passthrough,
  ];
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
  return [
    ...[...results]
      .sort((a, b) => a.shard - b.shard)
      .map(
        (result) =>
          `shard ${result.shard}/${shards} ${result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`} in ${result.seconds.toFixed(0)}s${result.ran === null ? "" : ` — ${result.ran}`}`,
      ),
    failed.length === 0
      ? `all ${shards} shards passed in ${seconds.toFixed(0)}s`
      : `${failed.length} of ${shards} shards failed after ${seconds.toFixed(0)}s: ${failed.map((result) => result.shard).join(", ")}`,
  ];
}

async function main(passthrough: readonly string[]): Promise<number> {
  const count = testShardCount(process.env.FALRYN_TEST_SHARDS, availableParallelism());
  if (!count.ok) {
    process.stderr.write(`${count.reason}\n`);
    return 2;
  }
  const { shards } = count;
  const started = performance.now();
  const children = Array.from({ length: shards }, (_, index) => ({
    shard: index + 1,
    process: Bun.spawn([process.execPath, ...shardArguments(index + 1, shards, passthrough)], {
      stdin: "ignore",
      stdout: shards === 1 ? "inherit" : "pipe",
      stderr: shards === 1 ? "inherit" : "pipe",
      env: process.env,
    }),
    started: performance.now(),
  }));
  // Interrupting the runner stops every shard rather than leaving them running.
  const stop = () => {
    for (const child of children) child.process.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (shards === 1) {
    const exitCode = await children[0]?.process.exited;
    return exitCode ?? 1;
  }
  process.stderr.write(`running the source suite in ${shards} shards\n`);
  // Each shard's output is printed whole when it finishes, so shards never interleave.
  const results = await Promise.all(
    children.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.process.stdout as ReadableStream).text(),
        new Response(child.process.stderr as ReadableStream).text(),
        child.process.exited,
      ]);
      const seconds = (performance.now() - child.started) / 1000;
      process.stderr.write(
        `\n── shard ${child.shard}/${shards} (exit ${exitCode}, ${seconds.toFixed(0)}s) ──\n`,
      );
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      const ran = /Ran \d+ tests? across \d+ files?/u.exec(stderr + stdout)?.[0] ?? null;
      return { shard: child.shard, exitCode, seconds, ran };
    }),
  );
  const lines = shardSummary(results, shards, (performance.now() - started) / 1000);
  process.stderr.write(`\n${lines.join("\n")}\n`);
  return results.every((result) => result.exitCode === 0) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
