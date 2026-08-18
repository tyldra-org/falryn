import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODES } from "./cli/index.ts";
import { PRODUCT_SCHEMA_VERSION } from "./data/index.ts";
import {
  createStaticEnvironment,
  DEFAULT_PHASE_GRACE_MS,
  type LocalPath,
  localPath,
  SHUTDOWN_PHASES,
} from "./domain/index.ts";
import { type BootstrapOptions, bootstrapExitCode, main } from "./main.ts";

const roots: string[] = [];

/**
 * A root per run.
 *
 * The bootstrap opens a real database, so a test that let it resolve the
 * platform default would write into the developer's own state directory.
 */
async function isolated(): Promise<BootstrapOptions & { readonly root: LocalPath }> {
  const created = await mkdtemp(join(tmpdir(), "falryn-bootstrap-"));
  roots.push(created);
  const root = localPath(created);
  return {
    root,
    platform: "darwin",
    home: root,
    environment: createStaticEnvironment({ FALRYN_STATE_DIR: root }),
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("application bootstrap", () => {
  test("composes the lifecycle and shuts down cleanly", async () => {
    const options = await isolated();
    const report = await main(options);

    expect(report.shutdown.outcome).toEqual({ kind: "completed" });
    expect(report.shutdown.unfinished).toEqual([]);
    expect(report.shutdown.failures).toEqual([]);
    expect(report.shutdown.phases.map((phase) => phase.phase)).toEqual([...SHUTDOWN_PHASES]);
  });

  test("opens the database in the state root and migrates it", async () => {
    const options = await isolated();
    const report = await main(options);

    expect(report.storage.ok).toBe(true);
    expect(report.storage.ok && report.storage.value.path).toBe(
      localPath(`${options.root}/falryn.sqlite`),
    );
    expect(report.storage.ok && report.storage.value.created).toBe(true);
    // The production set is migrations 0001 through 0004, so a clean run ends
    // at the current schema with the record, artifact, run, and provenance
    // tables in place.
    expect(report.storage.ok && report.storage.value.schemaVersion).toBe(PRODUCT_SCHEMA_VERSION);
    expect(report.storage.ok && report.storage.value.appliedThisRun).toEqual([1, 2, 3, 4]);
  });

  test("registers the persistence phases in the order they have to run", async () => {
    const options = await isolated();
    const report = await main(options);

    const participants = (phase: string): readonly string[] =>
      report.shutdown.phases
        .find((entry) => entry.phase === phase)
        ?.participants.map((entry) => entry.name) ?? [];

    // `finalize-artifacts` settles or discards in-flight bytes first, so
    // nothing downstream persists an outcome that references an artifact still
    // being written. `persist-outcomes` then stops accepting appends,
    // `checkpoint-projections` writes each cursor, and only then does
    // `close-storage` run its truncating checkpoint against a database with
    // nothing still writing to it.
    expect(participants("finalize-artifacts")).toEqual(["artifact-store"]);
    // Both are durable writes and both belong here: the run's clean end is the
    // fact recovery reads on the next start, and `close-storage` is too late
    // for it because participants inside one phase run concurrently.
    expect(participants("persist-outcomes")).toEqual(["event-store", "run-record"]);
    expect(participants("checkpoint-projections")).toEqual(["projection-cursors"]);
    expect(participants("close-storage")).toEqual(["sqlite-store"]);
    expect(report.shutdown.failures).toEqual([]);
  });

  test("closes storage through the close-storage phase, leaving one file", async () => {
    const options = await isolated();
    const report = await main(options);

    const closeStorage = report.shutdown.phases.find((phase) => phase.phase === "close-storage");
    expect(closeStorage?.participants.map((entry) => entry.name)).toEqual(["sqlite-store"]);
    expect(closeStorage?.participants.every((entry) => entry.status === "completed")).toBe(true);
    expect(await readdir(options.root)).toEqual(["falryn.sqlite"]);
  });

  test("reopens the same database on a second run without recreating it", async () => {
    const options = await isolated();
    await main(options);
    const second = await main(options);

    expect(second.storage.ok && second.storage.value.created).toBe(false);
    expect(second.shutdown.outcome).toEqual({ kind: "completed" });
  });

  test("releases its host signal subscription", async () => {
    const options = await isolated();
    const before = process.listenerCount("SIGINT");
    await main(options);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("resolves its exit status through the CLI table", async () => {
    const options = await isolated();
    expect(bootstrapExitCode(await main(options))).toBe(EXIT_CODES.COMPLETED);
  });

  test("reports storage that never opened through the failure it actually carried", async () => {
    // The state root is a file, so it cannot be prepared. `fromUnknown` records
    // that nothing observed the effect of the code that threw, and uncertain
    // effect outranks the `internal` category — so this exits 8, not 70, and
    // certainly not the flat 1 this replaced. A caller reading 8 knows to look
    // before it retries, which is exactly right for a half-prepared state root.
    const file = join(await mkdtemp(join(tmpdir(), "falryn-unusable-")), "not-a-directory");
    roots.push(dirname(file));
    await Bun.write(file, "");

    const report = await main({
      platform: "darwin",
      home: localPath(file),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: file }),
    });

    expect(report.storage.ok).toBe(false);
    expect(report.storage.ok || report.storage.error.effect).toBe("uncertain");
    expect(bootstrapExitCode(report)).toBe(EXIT_CODES.UNCERTAIN_EFFECT);
  });
});

/**
 * How long a whole run may take, measured from spawn to exit.
 *
 * Sized to catch a held resource, not to benchmark: a warm run finishes in tens
 * of milliseconds, and the budget still leaves room for a cold interpreter
 * start on a loaded machine. What it will not tolerate is a wait of one phase
 * grace, which is what an unreleased shutdown timer costs.
 */
const EXIT_BUDGET_MS = 2_000;

describe("process exit", () => {
  test("a clean run exits without waiting out a shutdown phase grace", async () => {
    expect(EXIT_BUDGET_MS).toBeLessThan(DEFAULT_PHASE_GRACE_MS);

    const options = await isolated();
    const entry = join(dirname(import.meta.path), "main.ts");

    // A real process is the only place this is observable: the report already
    // said the sequence finished in milliseconds while the host stayed alive
    // for an armed timer nobody was waiting on. Synchronous on purpose — the
    // run writes nothing, and an undrained pipe could block the exit being
    // measured.
    const startedAt = Date.now();
    const finished = Bun.spawnSync([process.execPath, "run", entry], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.root,
        FALRYN_STATE_DIR: options.root,
      },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(finished.exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(EXIT_BUDGET_MS);
    // Above the budget so a regression fails on the measured latency rather
    // than on a framework timeout that reports nothing about the cause.
  }, 10_000);
});
