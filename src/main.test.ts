import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStaticEnvironment,
  type LocalPath,
  localPath,
  SHUTDOWN_PHASES,
} from "./domain/index.ts";
import { type BootstrapOptions, main } from "./main.ts";

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
    // The production set is migrations 0001 through 0003, so a clean run ends
    // at version 3 with the record, artifact, and run schemas in place.
    expect(report.storage.ok && report.storage.value.schemaVersion).toBe(3);
    expect(report.storage.ok && report.storage.value.appliedThisRun).toEqual([1, 2, 3]);
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
});
