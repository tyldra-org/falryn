import { afterEach, expect, test } from "bun:test";
import { createRuntimeRedactor } from "../../application/diagnostics/index.ts";
import { artifactId, createInMemoryBlobStore } from "../../domain/artifacts/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { createInMemoryPackageWriter } from "../../domain/extensions/index.ts";
import {
  capabilityInvocationStarted,
  processTaskChanged,
  sessionStarted,
  turnStarted,
} from "../../domain/fixtures.ts";
import {
  createManualClock,
  err,
  invocationId,
  type Result,
  runId,
  sessionId,
  type Timestamp,
} from "../../domain/foundation/index.ts";
import type { PeerMessage } from "../../domain/orchestration/peer-mailbox.ts";
import type { ProcessTaskSnapshot } from "../../domain/orchestration/process-task.ts";
import { exportName } from "../../domain/sessions/index.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createSha256Hasher } from "../../integrations/index.ts";
import { createArtifactRepository } from "../artifacts/artifact-repository.ts";
import { createArtifactStore } from "../artifacts/artifact-store.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  reservedArtifact,
  temporaryRoot,
} from "../fixtures.ts";
import { createMailboxRepository } from "../orchestration/mailbox-store.ts";
import { createSqliteProcessTaskStore } from "../orchestration/process-task-store.ts";
import { createSqliteEventStore } from "../sessions/event-store.ts";
import { createRecordRepositories } from "../sessions/repositories.ts";
import { resolveInventory, writePackage } from "./export.ts";
import {
  executeReachabilityGc,
  planReachabilityGc,
  type ReachabilityGcInputs,
} from "./reachability-gc.ts";

afterEach(removeTemporaryRoots);
const instant = "2026-07-31T12:00:00.000Z" as Timestamp;
const run = runId.from("gc-test-run");
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function fence(task: ProcessTaskSnapshot) {
  return {
    handle: task.handle,
    supervisorRunId: task.supervisor.runId,
    expectedRevision: task.revision,
  };
}
async function harness() {
  const root = await temporaryRoot("falryn-task-gc-");
  const store = await openProductStoreOrThrow(root);
  const events = createSqliteEventStore(store, { projectStartedRecords: true });
  for (const event of [
    sessionStarted(1),
    turnStarted(2),
    {
      ...capabilityInvocationStarted(3),
      payload: { capabilityVersion: 1, inputDigest: "a".repeat(64) },
    },
  ])
    value(await events.append(event));
  value(
    store.write((sql) =>
      sql.run("INSERT INTO runs (run_id, started_at, schema_version) VALUES ($run, $at, 11)", {
        run,
        at: instant,
      }),
    ),
  );
  const tasks = createSqliteProcessTaskStore(store);
  const original = value(tasks.create(processTaskChanged().payload.task)).value;
  const repository = createArtifactRepository(store, run);
  const blobs = createInMemoryBlobStore();
  const packages = createInMemoryPackageWriter();
  const clock = createManualClock();
  const hasher = createSha256Hasher();
  const artifacts = createArtifactStore({ repository, blobs, clock, hasher });
  const repositories = createRecordRepositories(store);
  const exportOptions = {
    store,
    events,
    repositories,
    blobs,
    packages,
    clock,
    hasher,
    buildIdentity: "test",
    redactor: createRuntimeRedactor(),
  };
  const inputs: ReachabilityGcInputs = {
    store,
    repositories,
    blobs,
    packages,
    exportOptions,
    pinnedSessionIds: [],
    exportPackageNames: [],
  };
  async function ingest(id = "task-output", content = "exact output", linked = true) {
    const bytes = new TextEncoder().encode(content);
    value(
      await artifacts.ingest({
        artifactId: artifactId.from(id),
        mediaType: "text/plain",
        encoding: "identity",
        sensitivity: "user-content",
        origin: "capture",
        invocationId: linked ? invocationId.from(original.owner.invocationId) : null,
        declaredByteLength: bytes.length,
        content: (async function* () {
          yield bytes;
        })(),
      }),
    );
    const record = value(repository.get(artifactId.from(id)));
    if (record === null) throw new Error("missing fixture artifact");
    return record;
  }
  function terminal() {
    const settling = value(tasks.transition(fence(original), { kind: "settling" }, 99)).value;
    return value(
      tasks.transition(
        fence(settling),
        {
          kind: "sealed",
          terminal: {
            outcome: "failed",
            effect: "none",
            reason: "spawn-failed",
            exitCode: null,
            signal: null,
            sealedAt: 100,
            result: null,
          },
        },
        100,
      ),
    ).value;
  }
  function cleanup(task = terminal()) {
    const wake = value(tasks.claimWake(task.handle)).value;
    value(tasks.acknowledgeWake(task.handle, wake.notificationId));
    value(tasks.cleanup(task.handle, task.revision, 100));
  }
  function closeSession() {
    value(
      store.write((sql) =>
        sql.run(
          "UPDATE sessions SET closed_at = $at, outcome_kind = 'completed', outcome_effect = 'completed'",
          { at: instant },
        ),
      ),
    );
  }
  async function collect(options = inputs) {
    const plan = value(await planReachabilityGc(options));
    return value(await executeReachabilityGc(options, plan, { planId: plan.planId }, repository));
  }
  return {
    root,
    store,
    tasks,
    original,
    repository,
    blobs,
    inputs,
    ingest,
    terminal,
    cleanup,
    closeSession,
    collect,
  };
}

test("mailbox admission rejects a GC claim and pins selected bytes until tombstoned cleanup", async () => {
  const h = await harness();
  try {
    const record = await h.ingest("mailed-artifact", "selected evidence", false);
    const mailbox = createMailboxRepository(h.store);
    const scope = {
      workspace: canonicalDigest("w"),
      project: canonicalDigest("p"),
      user: canonicalDigest("u"),
      environment: canonicalDigest("e"),
      trust: canonicalDigest("t"),
    };
    const register = (name: string) =>
      value(
        mailbox.register(
          {
            endpoint: {
              version: 1,
              identity: { sessionId: name, agentId: "main", generation: 1 },
              scope,
              label: name,
              state: "idle",
              processGeneration: name,
              leaseUntil: 30_000,
            },
            publicKey: "test-public-key",
            address: "host-private",
            fence: `${name}-${"x".repeat(40)}`,
          },
          0,
        ),
      );
    const sender = register("sender");
    const recipient = register("recipient");
    value(
      mailbox.policy(recipient, sender.identity, { mode: "allow", muted: false, perMinute: 64 }, 0),
    );
    const message: PeerMessage = {
      version: 1,
      id: "mailed",
      sender: sender.identity,
      recipient: recipient.identity,
      scope,
      laneSequence: 1,
      createdAt: 0,
      expiresAt: 1_000,
      kind: "message",
      correlation: null,
      text: "selected evidence",
      artifacts: [
        { artifactId: String(record.artifactId), digest: record.digest, bytes: record.byteLength },
      ],
      sensitivity: "internal",
      retention: "normal",
      provenance: { source: "peer-evidence", effectAuthority: false, causalMessage: null, hops: 0 },
    };
    value(
      h.store.write((sql) =>
        sql.run(
          "INSERT INTO artifact_gc_claims (digest, artifact_id, owner_id) VALUES ($digest,$id,'mailbox-test')",
          { digest: record.digest, id: record.artifactId },
        ),
      ),
    );
    expect(mailbox.admit(recipient, message, 0)).toEqual({ ok: false, error: { code: "denied" } });
    value(
      h.store.write((sql) =>
        sql.run("DELETE FROM artifact_gc_claims WHERE owner_id='mailbox-test'"),
      ),
    );
    const accepted = value(mailbox.admit(recipient, message, 0));
    expect(
      value(await planReachabilityGc(h.inputs)).candidates.some(
        (candidate) => candidate.identity === record.artifactId,
      ),
    ).toBe(false);
    expect(value(mailbox.cleanup(recipient, accepted.key, 2_000)).tombstoned).toBe(true);
    expect(
      value(await planReachabilityGc(h.inputs)).candidates.some(
        (candidate) => candidate.identity === record.artifactId,
      ),
    ).toBe(true);
    await h.collect();
    expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).toBeNull();
    expect(value(mailbox.inspect(sender, accepted.key, 2_000))).toMatchObject({
      message: null,
      receipt: { delivery: "expired", tombstoned: true },
    });
  } finally {
    await h.store.close();
  }
});

for (const state of ["active", "terminal"] as const) {
  test(`${state} retained task roots survive session closure before any chunk/result reference`, async () => {
    const h = await harness();
    const record = await h.ingest();
    if (state === "terminal") h.terminal();
    h.closeSession();
    const plan = value(await planReachabilityGc(h.inputs));
    expect(plan.candidates).toEqual([]);
    expect(value(h.store.read("SELECT * FROM process_task_chunks"))).toEqual([]);
    expect((await h.collect()).deletedBytes).toBe(0);
    expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
    expect(value(h.store.read("SELECT * FROM sessions"))).toHaveLength(1);
    await h.store.close();
  });
}

test("cleanup releases unique task artifacts in an open session without changing invocation provenance", async () => {
  const h = await harness();
  const record = await h.ingest();
  h.cleanup();
  expect(value(h.repository.get(record.artifactId))?.invocationId).toBe(
    invocationId.from(h.original.owner.invocationId),
  );
  expect(value(h.store.read("SELECT released FROM process_task_artifacts"))).toEqual([
    { released: 1 },
  ]);
  const outcome = await h.collect();
  expect(outcome).toMatchObject({
    deletedArtifacts: 1,
    deletedBytes: record.byteLength,
    failed: 0,
  });
  expect(value(h.repository.get(record.artifactId))).toBeNull();
  expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).toBeNull();
  expect(value(h.store.read("SELECT * FROM sessions"))).toHaveLength(1);
  await h.store.close();
});

test("reserved ownership is registered atomically and reserved shared digests block claims", async () => {
  const h = await harness();
  const record = await h.ingest();
  value(
    h.repository.reserve(
      reservedArtifact("in-flight", record.digest, { invocationId: record.invocationId }),
    ),
  );
  expect(value(h.store.read("SELECT * FROM process_task_artifacts"))).toHaveLength(2);
  h.cleanup();
  const plan = value(await planReachabilityGc(h.inputs));
  expect(plan.candidateArtifacts).toBe(0);
  expect(plan.omissions.some((entry) => entry.reason === "shared-digest")).toBe(true);
  expect((await h.collect()).deletedBytes).toBe(0);
  expect(value(h.store.read("SELECT * FROM artifact_gc_claims"))).toEqual([]);
  await h.store.close();
});

for (const retention of ["pinned", "export", "shared", "provenance"] as const) {
  test(`cleanup preserves ${retention} roots`, async () => {
    const h = await harness();
    const record = await h.ingest();
    h.cleanup();
    let inputs = h.inputs;
    if (retention === "pinned")
      inputs = { ...inputs, pinnedSessionIds: [sessionId.from(h.original.owner.sessionId)] };
    if (retention === "export") {
      const name = exportName.from("retained-export");
      const selection = {
        kind: "sessions" as const,
        sessionIds: [sessionId.from(h.original.owner.sessionId)],
        includeSensitive: false,
      };
      const inventory = value(await resolveInventory(inputs.exportOptions, selection));
      value(await writePackage(inputs.exportOptions, name, selection, inventory));
      inputs = { ...inputs, exportPackageNames: [name] };
    }
    if (retention === "shared") await h.ingest("shared-output", "exact output", false);
    if (retention === "provenance") {
      const child = await h.ingest("ordinary-output", "projected output");
      value(
        h.store.write((sql) =>
          sql.run(
            "INSERT INTO artifact_transformations (child_artifact_id, parent_artifact_id, transformation, created_at) VALUES ($child, $parent, 'derived-from', $at)",
            { child: child.artifactId, parent: record.artifactId, at: instant },
          ),
        ),
      );
    }
    expect((await h.collect(inputs)).deletedBytes).toBe(0);
    expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
    await h.store.close();
  });
}

test("claim fences another connection between metadata deletion and unlink, then releases after removal", async () => {
  const h = await harness();
  const record = await h.ingest();
  h.cleanup();
  const second = await openProductStoreOrThrow(h.root);
  const other = createArtifactRepository(second, run);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const inputs = {
    ...h.inputs,
    blobs: {
      ...h.blobs,
      async remove(location: Parameters<typeof h.blobs.remove>[0]) {
        entered();
        await barrier;
        return h.blobs.remove(location);
      },
    },
  };
  const collection = h.collect(inputs);
  await deleting;
  expect(value(other.get(record.artifactId))).toBeNull();
  expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
  expect(other.reserve(reservedArtifact("new-output", record.digest))).toMatchObject({
    ok: false,
    error: {
      code: "storage",
      failure: {
        error: {
          code: "unavailable",
          cause: { detail: expect.stringContaining("GC deletion claim") },
        },
      },
    },
  });
  const competing = await h.collect();
  expect(competing.omissions).toContainEqual({
    kind: "artifact",
    identity: record.artifactId,
    reason: "gc-claim-outstanding",
  });
  expect(value(second.read("SELECT * FROM artifact_gc_claims"))).toHaveLength(1);
  release();
  expect(await collection).toMatchObject({ deletedBytes: record.byteLength, failed: 0 });
  expect(value(second.read("SELECT * FROM artifact_gc_claims"))).toEqual([]);
  expect(other.reserve(reservedArtifact("new-output", record.digest)).ok).toBe(true);
  await second.close();
  await h.store.close();
});

test("unconfirmed removal leaves a durable visible claim which later GC never steals", async () => {
  const h = await harness();
  const record = await h.ingest();
  h.cleanup();
  const outcome = await h.collect({
    ...h.inputs,
    blobs: {
      ...h.blobs,
      remove: async () =>
        err({ kind: "blob", code: "io-failure", operation: "remove", scope: "content" }),
    },
  });
  expect(outcome).toMatchObject({
    deletedArtifacts: 1,
    deletedBytes: 0,
    failed: 1,
    effect: "partial",
  });
  const claim = value(h.store.read("SELECT * FROM artifact_gc_claims"));
  // The existing artifact sweep must respect the claim too, not only reachability GC.
  expect(value(h.repository.referencedDigests([record.digest])).has(record.digest)).toBe(true);
  await h.store.close();
  const reopened = await openProductStoreOrThrow(h.root);
  const repository = createArtifactRepository(reopened, run);
  expect(repository.reserve(reservedArtifact("retry", record.digest))).toMatchObject({
    ok: false,
    error: { code: "storage" },
  });
  const inputs = { ...h.inputs, store: reopened };
  const plan = value(await planReachabilityGc(inputs));
  expect(plan.completeness).toBe("partial");
  expect(plan.omissions).toContainEqual({
    kind: "artifact",
    identity: record.artifactId,
    reason: "gc-claim-outstanding",
  });
  value(await executeReachabilityGc(inputs, plan, { planId: plan.planId }, repository));
  expect(value(reopened.read("SELECT * FROM artifact_gc_claims"))).toEqual(claim);
  expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
  await reopened.close();
});

test("a task admitted after planning protects its session in the metadata transaction", async () => {
  const h = await harness();
  h.cleanup();
  h.closeSession();
  let injected = false;
  const store: SqliteStorePort = {
    ...h.store,
    write(work, signal) {
      if (!injected) {
        injected = true;
        value(
          h.tasks.create({ ...h.original, handle: { ...h.original.handle, taskId: "late-task" } }),
        );
      }
      return h.store.write(work, signal);
    },
  };
  const outcome = await h.collect({ ...h.inputs, store });
  expect(outcome.deletedSessions).toBe(0);
  expect(value(h.store.read("SELECT * FROM sessions"))).toHaveLength(1);
  await h.store.close();
});

test("late task ownership and foreign-key refusal never delete protected bytes", async () => {
  for (const protection of ["ownership", "foreign-key"] as const) {
    const h = await harness();
    const record = await h.ingest();
    h.cleanup();
    let injected = false;
    const store: SqliteStorePort = {
      ...h.store,
      write(work, signal) {
        if (!injected) {
          injected = true;
          value(
            h.store.write((sql) => {
              if (protection === "ownership")
                sql.run("UPDATE process_task_artifacts SET released = 0");
              else {
                sql.run(
                  "CREATE TABLE fixture_reference (artifact_id TEXT REFERENCES artifacts(artifact_id))",
                );
                sql.run("INSERT INTO fixture_reference VALUES ($id)", { id: record.artifactId });
              }
            }),
          );
        }
        return h.store.write(work, signal);
      },
    };
    const outcome = await h.collect({ ...h.inputs, store });
    expect(outcome.deletedBytes).toBe(0);
    expect(value(h.repository.get(record.artifactId))).not.toBeNull();
    expect(value(h.store.read("SELECT * FROM artifact_gc_claims"))).toEqual([]);
    expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
    await h.store.close();
  }
});

test("released or missing ownership cannot be acquired by chunk or terminal result linking", async () => {
  const h = await harness();
  const record = await h.ingest();
  const artifact = {
    artifactId: record.artifactId,
    digest: record.digest,
    byteLength: record.byteLength,
  };
  const running = value(
    h.tasks.transition(
      fence(h.original),
      {
        kind: "started",
        process: {
          platform: "linux",
          pid: 101,
          birth: "boot:101",
        },
      },
      1,
    ),
  ).value;
  value(h.store.write((sql) => sql.run("UPDATE process_task_artifacts SET released = 1")));
  expect(
    h.tasks.appendChunk(
      fence(running),
      { handle: running.handle, stream: "stdout", offset: 0, artifact },
      2,
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid-record" } });
  const settling = value(h.tasks.transition(fence(running), { kind: "settling" }, 3)).value;
  const change = {
    kind: "sealed" as const,
    terminal: {
      outcome: "completed" as const,
      effect: "completed" as const,
      reason: "exited" as const,
      exitCode: 0,
      signal: null,
      sealedAt: 4,
      result: artifact,
    },
  };
  expect(h.tasks.transition(fence(settling), change, 4)).toMatchObject({
    ok: false,
    error: { code: "invalid-record" },
  });
  value(h.store.write((sql) => sql.run("DELETE FROM process_task_artifacts")));
  expect(h.tasks.transition(fence(settling), change, 4)).toMatchObject({
    ok: false,
    error: { code: "invalid-record" },
  });
  await h.store.close();
});

test("ownership reservation and cleanup roll back atomically on statement refusal", async () => {
  const h = await harness();
  const record = await h.ingest();
  value(
    h.store.write((sql) =>
      sql.run(
        "CREATE TRIGGER refuse_ownership BEFORE INSERT ON process_task_artifacts BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      ),
    ),
  );
  expect(
    h.repository.reserve(
      reservedArtifact("refused", record.digest, { invocationId: record.invocationId }),
    ).ok,
  ).toBe(false);
  expect(value(h.repository.get(artifactId.from("refused")))).toBeNull();
  const terminal = h.terminal();
  const wake = value(h.tasks.claimWake(terminal.handle)).value;
  value(h.tasks.acknowledgeWake(terminal.handle, wake.notificationId));
  value(
    h.store.write((sql) =>
      sql.run(
        "CREATE TRIGGER refuse_cleanup BEFORE DELETE ON process_tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      ),
    ),
  );
  expect(h.tasks.cleanup(terminal.handle, terminal.revision, 100).ok).toBe(false);
  expect(value(h.store.read("SELECT released FROM process_task_artifacts"))).toEqual([
    { released: 0 },
  ]);
  expect(h.tasks.cleaned(terminal.handle).ok).toBe(false);
  expect(value(h.tasks.get(terminal.handle))).toEqual(terminal);
  await h.store.close();
});

test("outstanding deletion claims are bounded without stealing or deleting another candidate", async () => {
  const h = await harness();
  const record = await h.ingest();
  h.cleanup();
  value(
    h.store.write((sql) => {
      for (let index = 0; index < 256; index++)
        sql.run(
          "INSERT INTO artifact_gc_claims (digest, artifact_id, owner_id) VALUES ($digest, $id, 'interrupted')",
          { digest: `fixture-${index}`, id: `candidate-${index}` },
        );
    }),
  );
  const outcome = await h.collect();
  expect(outcome).toMatchObject({ deletedBytes: 0, failed: 1, completeness: "partial" });
  expect(value(h.repository.get(record.artifactId))).not.toBeNull();
  expect(value(h.store.read("SELECT * FROM artifact_gc_claims"))).toHaveLength(256);
  expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
  await h.store.close();
});

test("cleanup permits artifact metadata removal before deleting the closed session tree", async () => {
  const h = await harness();
  const record = await h.ingest();
  h.closeSession();
  h.cleanup();
  expect(await h.collect()).toMatchObject({
    deletedSessions: 1,
    deletedArtifacts: 1,
    deletedBytes: record.byteLength,
    failed: 0,
  });
  expect(value(h.store.read("SELECT * FROM sessions"))).toEqual([]);
  await h.store.close();
});

test("a stale plan is refused after a task acquires an artifact root", async () => {
  const h = await harness();
  const record = await h.ingest();
  h.cleanup();
  const plan = value(await planReachabilityGc(h.inputs));
  value(h.store.write((sql) => sql.run("UPDATE process_task_artifacts SET released = 0")));
  expect(
    await executeReachabilityGc(h.inputs, plan, { planId: plan.planId }, h.repository),
  ).toMatchObject({ ok: false, error: { code: "plan-mismatch" } });
  expect(h.blobs.bytesAt({ scope: "content", digest: record.digest })).not.toBeNull();
  await h.store.close();
});
