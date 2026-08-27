/**
 * The projection runner.
 *
 * Three properties are worth proving here and are hard to prove anywhere else:
 * a cursor never describes state a transaction did not commit, a rebuild from
 * events alone reproduces exactly what incremental application produced, and
 * the `checkpoint-projections` phase does real work rather than ticking.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { createShutdownCoordinator } from "../application/index.ts";
import {
  everyEventKind,
  invocationRecord,
  modelAttemptRecord,
  sessionRecord,
  turnRecord,
} from "../domain/fixtures.ts";
import {
  createManualClock,
  instant,
  type LocalPath,
  type RecordRepositories,
  type SqliteStorePort,
  SqliteWorkError,
  sequence,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  turnId as turnIdCodec,
} from "../domain/index.ts";
import { createSqliteEventStore, type DurableEventStore } from "./event-store.ts";
import {
  FIXTURE_INSTANT,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import {
  createProjectionRunner,
  createProjectionShutdownParticipant,
  type ProjectionRunner,
} from "./projections.ts";
import { createRecordRepositories } from "./repositories.ts";

function temporaryRoot(): Promise<LocalPath> {
  return makeTemporaryRoot("falryn-projections-");
}

afterEach(removeTemporaryRoots);

type Fixture = {
  readonly store: SqliteStorePort;
  readonly events: DurableEventStore;
  readonly repositories: RecordRepositories;
  readonly runner: ProjectionRunner;
};

/** A database holding the fixture records and the events that complete them. */
async function seeded(withEvents = true): Promise<Fixture> {
  const store = await openProductStoreOrThrow(await temporaryRoot());
  const events = createSqliteEventStore(store);
  const repositories = createRecordRepositories(store);
  const runner = createProjectionRunner({
    store,
    events,
    clock: createManualClock(FIXTURE_INSTANT),
  });

  repositories.sessions.insert(sessionRecord());
  repositories.turns.insert(turnRecord());
  repositories.modelAttempts.insert(modelAttemptRecord());
  repositories.invocations.insert(invocationRecord());

  if (withEvents) {
    for (const event of everyEventKind()) {
      const appended = await events.append(event);
      if (!appended.ok) {
        throw new Error(`expected the append to succeed: ${appended.error.code}`);
      }
    }
  }

  return { store, events, repositories, runner };
}

/** The derived columns, read back as the shape a comparison can use. */
function derived(repositories: RecordRepositories) {
  const turn = repositories.turns.get(turnRecord().turnId);
  const attempt = repositories.modelAttempts.get(modelAttemptRecord().modelAttemptId);
  const invocation = repositories.invocations.get(invocationRecord().invocationId);
  return {
    turn: turn.ok ? turn.value : null,
    attempt: attempt.ok ? attempt.value : null,
    invocation: invocation.ok ? invocation.value : null,
  };
}

describe("advancing a projection", () => {
  test("derives every completion the stream holds and records where it stopped", async () => {
    const { store, repositories, runner } = await seeded();

    const run = await runner.advance(sessionRecord().streamId);

    expect(run.ok && run.value).toMatchObject({
      projection: "terminal-outcomes",
      streamId: sessionRecord().streamId,
      eventsRead: everyEventKind().length,
      applied: 3,
      unmatched: 0,
      lastAppliedSequence: sequence.from(9),
      stopped: false,
    });

    const state = derived(repositories);
    expect(state.turn?.outcome).toEqual({ kind: "completed" });
    expect(state.attempt?.outcome).toEqual({ kind: "failed", effect: "none" });
    expect(state.invocation?.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    await store.close();
  });

  test("writes the cursor at the sequence it applied, under its reducer generation", async () => {
    const { store, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);

    expect(runner.readCursor(sessionRecord().streamId)).toEqual({
      ok: true,
      value: {
        projection: "terminal-outcomes",
        streamId: sessionRecord().streamId,
        lastAppliedSequence: sequence.from(9),
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
        updatedAt: turnRecord().startedAt,
      },
    });
    await store.close();
  });

  test("is idempotent: a second pass applies nothing and leaves the cursor alone", async () => {
    const { store, repositories, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);
    const first = derived(repositories);

    const second = await runner.advance(sessionRecord().streamId);

    expect(second.ok && second.value).toMatchObject({ eventsRead: 0, applied: 0 });
    expect(derived(repositories)).toEqual(first);
    await store.close();
  });

  test("reports a completion naming a record this database does not hold", async () => {
    const store = await openProductStoreOrThrow(await temporaryRoot());
    const events = createSqliteEventStore(store);
    const runner = createProjectionRunner({
      store,
      events,
      clock: createManualClock(FIXTURE_INSTANT),
    });
    for (const event of everyEventKind()) {
      await events.append(event);
    }

    const run = await runner.advance(sessionRecord().streamId);

    // An event is a fact. A stream whose records were never written is a gap to
    // see, not a reason to stop projecting.
    expect(run.ok && run.value).toMatchObject({ applied: 0, unmatched: 3 });
    await store.close();
  });

  test("writes no cursor for a stream that holds no events", async () => {
    const { store, runner } = await seeded(false);

    const run = await runner.advance(sessionRecord().streamId);

    expect(run.ok && run.value).toMatchObject({ eventsRead: 0, lastAppliedSequence: null });
    expect(runner.readCursor(sessionRecord().streamId)).toEqual({ ok: true, value: null });
    await store.close();
  });

  test("stops when cancellation is requested and says it stopped", async () => {
    const { store, runner } = await seeded();

    const run = await runner.advance(sessionRecord().streamId, AbortSignal.abort());

    expect(run.ok && run.value).toMatchObject({ eventsRead: 0, stopped: true });
    await store.close();
  });
});

describe("the cursor and the state it describes", () => {
  test("move together: a failed write leaves neither applied", async () => {
    const { store, repositories, runner } = await seeded();
    const original = store.write.bind(store);
    // Fails after the work has run, so the transaction genuinely rolls back —
    // the case where a cursor written beside partial state would survive it.
    (store as { write: typeof store.write }).write = (work, signal) =>
      original((statements) => {
        work(statements);
        throw new SqliteWorkError({
          kind: "sqlite",
          code: "disk-full",
          operation: "transaction",
          driverCode: "SQLITE_FULL",
          detail: null,
        });
      }, signal);

    const run = await runner.advance(sessionRecord().streamId);

    expect(run.ok).toBe(false);
    expect(!run.ok && run.error).toMatchObject({ code: "storage", error: { code: "disk-full" } });
    (store as { write: typeof store.write }).write = original;
    // Neither the derived columns nor the cursor moved.
    expect(derived(repositories).turn?.outcome).toBeNull();
    expect(runner.readCursor(sessionRecord().streamId)).toEqual({ ok: true, value: null });
    await store.close();
  });
});

describe("a rebuild", () => {
  test("drops the derived state and its cursor, then reproduces both exactly", async () => {
    const { store, repositories, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);
    const incremental = derived(repositories);
    const cursor = runner.readCursor(sessionRecord().streamId);

    const rebuilt = await runner.rebuild(sessionRecord().streamId);

    expect(rebuilt.ok && rebuilt.value).toMatchObject({
      eventsRead: everyEventKind().length,
      applied: 3,
    });
    expect(derived(repositories)).toEqual(incremental);
    expect(runner.readCursor(sessionRecord().streamId)).toEqual(cursor);
    await store.close();
  });

  test("clears only the columns it derives, never the facts a producer wrote", async () => {
    const { store, repositories, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);

    await runner.rebuild(sessionRecord().streamId);

    const turn = repositories.turns.get(turnRecord().turnId);
    expect(turn.ok && turn.value).toMatchObject({
      turnId: turnRecord().turnId,
      sessionId: turnRecord().sessionId,
      startedAt: turnRecord().startedAt,
    });
    await store.close();
  });

  test("uses no source but stored events", async () => {
    const { store, events, repositories, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);
    // Quiesced, so nothing can append during the rebuild, and no provider,
    // network, filesystem, or tool call is reachable from the reducer.
    await events.quiesce();

    const rebuilt = await runner.rebuild(sessionRecord().streamId);

    expect(rebuilt.ok).toBe(true);
    expect(derived(repositories).invocation?.outcome).toEqual({
      kind: "uncertain",
      effect: "uncertain",
    });
    await store.close();
  });

  test("is what a cursor from another reducer generation triggers", async () => {
    const { store, repositories, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);
    store.write((statements) =>
      statements.run("UPDATE projection_cursors SET schema_generation = 99"),
    );

    const run = await runner.advance(sessionRecord().streamId);

    // A cursor recorded under a different reducer describes state this build
    // did not produce, so it is rebuilt rather than resumed from.
    expect(run.ok && run.value).toMatchObject({ eventsRead: everyEventKind().length });
    expect(derived(repositories).turn?.outcome).toEqual({ kind: "completed" });
    await store.close();
  });
});

describe("the checkpoint-projections participant", () => {
  test("brings every stream holding events up to date", async () => {
    const { store, repositories, runner } = await seeded();

    const checkpointed = await runner.checkpoint();

    expect(checkpointed.ok && checkpointed.value.truncated).toBe(false);
    expect(checkpointed.ok && checkpointed.value.runs).toHaveLength(1);
    expect(derived(repositories).turn?.outcome).toEqual({ kind: "completed" });
    await store.close();
  });

  test("rebuilds rather than resumes when the reducer generation changed", async () => {
    const { store, repositories, runner } = await seeded();
    // A turn no event completes, carrying derived state an older reducer wrote.
    // Re-applying the stream would leave it untouched; only a rebuild clears it,
    // which is the whole difference a generation change is declared to make.
    const stale = turnRecord({ turnId: turnIdCodec.from("turn-stale") });
    repositories.turns.insert(stale);
    await runner.advance(sessionRecord().streamId);
    store.write((statements) => {
      statements.run(
        `UPDATE turns SET completed_at = $completedAt, outcome_kind = 'failed',
         outcome_effect = 'none' WHERE turn_id = $turnId`,
        { completedAt: stale.startedAt, turnId: stale.turnId },
      );
      statements.run("UPDATE projection_cursors SET schema_generation = 99");
    });

    const checkpointed = await runner.checkpoint();

    expect(checkpointed.ok).toBe(true);
    const rebuilt = repositories.turns.get(stale.turnId);
    expect(rebuilt.ok && rebuilt.value?.outcome).toBeNull();
    expect(rebuilt.ok && rebuilt.value?.completedAt).toBeNull();
    // And the completions the current reducer does derive are still there.
    expect(derived(repositories).turn?.outcome).toEqual({ kind: "completed" });
    await store.close();
  });

  test("does nothing for a stream whose cursor is already at its head", async () => {
    const { store, runner } = await seeded();
    await runner.advance(sessionRecord().streamId);

    const checkpointed = await runner.checkpoint();

    // A phase that ticked by rewriting an unchanged cursor would be reporting
    // work it did not do.
    expect(checkpointed.ok && checkpointed.value.runs).toEqual([]);
    await store.close();
  });

  test("completes its shutdown phase and leaves the cursor current", async () => {
    const { store, runner } = await seeded();
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register(createProjectionShutdownParticipant(runner));

    const pending = coordinator.shutdown();
    await clock.runUntilIdle();
    const report = await pending;

    const phase = report.phases.find((entry) => entry.phase === "checkpoint-projections");
    expect(phase?.participants.map((entry) => entry.name)).toEqual(["projection-cursors"]);
    expect(report.outcome).toEqual({ kind: "completed" });
    expect(runner.readCursor(sessionRecord().streamId)).toMatchObject({
      ok: true,
      value: { lastAppliedSequence: sequence.from(9) },
    });
    await store.close();
  });
});
