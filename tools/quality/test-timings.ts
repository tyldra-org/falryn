/**
 * Pulls the per-file test durations the CI test jobs recorded and writes one timings file
 * per host, `.github/test-timings/<platform>.json`, which balances that host's shards.
 *
 * Each CI shard records only its own files, so the latest successful `main` run's
 * artifacts are merged per host. A file no shard ran in that run keeps its previous
 * duration, and a file that no longer exists is dropped. Commit the result when shards
 * drift out of balance; a stale record only unbalances them.
 *
 * Usage: `bun run test:timings [--run <id>]`. Needs an authenticated `gh`.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { timingsFile } from "./test-shards.ts";

/** The artifact each CI test job uploads: `test-timings-<platform>-<job index>`. */
export const ARTIFACT_PATTERN = "test-timings-*";
export const PLATFORMS = ["darwin", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

const timingsSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string(), z.number().nonnegative()),
});
export type Timings = z.infer<typeof timingsSchema>;

export function parseTimings(text: string): Timings | null {
  try {
    const parsed = timingsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The previous record, overwritten by every shard's measurements and limited to the test
 * files that exist now, sorted by path so the committed diff stays readable.
 */
export function mergeTimings(
  previous: Timings | null,
  shards: readonly Timings[],
  existing: ReadonlySet<string>,
): Timings {
  const merged: Record<string, number> = { ...previous?.files };
  for (const shard of shards) Object.assign(merged, shard.files);
  const files = Object.fromEntries(
    Object.entries(merged)
      .filter(([file]) => existing.has(file))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return { version: 1, files };
}

async function run(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
  return out;
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--run");
  const runId =
    at === -1
      ? (
          await run([
            "gh",
            "run",
            "list",
            "--workflow",
            "CI",
            "--branch",
            "main",
            "--event",
            "push",
            "--status",
            "success",
            "--limit",
            "1",
            "--json",
            "databaseId",
            "--jq",
            ".[0].databaseId",
          ])
        ).trim()
      : process.argv[at + 1];
  if (runId === undefined || runId === "") throw new Error("no successful main CI run found");

  const directory = await mkdtemp(join(tmpdir(), "falryn-test-timings-"));
  try {
    await run(["gh", "run", "download", runId, "--pattern", ARTIFACT_PATTERN, "--dir", directory]);
    const existing = new Set(
      (await run(["git", "ls-files", "*.test.ts", "*.test.tsx"])).split("\n").filter(Boolean),
    );
    for (const platform of PLATFORMS) {
      const shards: Timings[] = [];
      for (const artifact of await readdir(directory)) {
        if (!artifact.startsWith(`test-timings-${platform}-`)) continue;
        const parsed = parseTimings(
          await Bun.file(join(directory, artifact, `${platform}.json`)).text(),
        );
        if (parsed === null) throw new Error(`${artifact} is not a timings file`);
        shards.push(parsed);
      }
      if (shards.length === 0) throw new Error(`run ${runId} recorded no ${platform} timings`);
      const target = timingsFile(platform);
      const previous = (await Bun.file(target).exists())
        ? parseTimings(await Bun.file(target).text())
        : null;
      const merged = mergeTimings(previous, shards, existing);
      await Bun.write(target, `${JSON.stringify(merged, null, 2)}\n`);
      console.log(
        `${target}: ${Object.keys(merged.files).length} files from ${shards.length} shards of run ${runId}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
