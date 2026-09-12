import { afterEach, expect, test } from "bun:test";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../../data/fixtures.ts";
import { createReflectionRepository } from "../../data/memory/reflection-repository.ts";
import { err } from "../../domain/foundation/result.ts";
import {
  REFLECTION_LIMITS,
  type ReflectionBinding,
  type ReflectionRepository,
} from "../../domain/memory/reflection.ts";
import { replayReflection } from "../../domain/memory/reflection-export.ts";
import { reflectionDigest } from "../../domain/memory/reflection-state.ts";
import {
  reflectionActionsFor,
  reflectionAuthority,
  reflectionBinding,
  reflectionCandidate,
  reflectionCode,
  reflectionFixture,
  reflectionRecord,
  reflectionValue,
} from "./reflection.fixtures.ts";

afterEach(removeTemporaryRoots);
const publish = (
  id: string,
  fence: unknown,
  range = { first: 1, last: 3 },
  more: Record<string, unknown> = {},
) => ({
  action: "publish",
  id,
  fence,
  range,
  publicationId: "publication-1",
  disposition: "empty",
  candidates: [],
  prepared: null,
  ...more,
});

test("commits candidates and coverage once, reopens, exports and replays without memory admission", async () => {
  const f = await reflectionFixture();
  const request = reflectionRecord(await f.create());
  expect(reflectionRecord(await f.create()).id).toBe(request.id);
  const fence = await f.lease(request.id);
  const command = publish(request.id, fence, request.range, {
    disposition: "processed",
    candidates: [reflectionCandidate],
    prepared: {
      version: 1,
      authority: "derived",
      parentCheckpoint: null,
      fidelity: "lossy",
      represented: ["event-session-1", "event-turn-start-2", "event-turn-done-3"],
      protectedSources: ["event-turn-done-3"],
      omissions: [],
      recovery: "available",
      summary: "An unreviewed observation.",
    },
  });
  const result = reflectionRecord(await f.send(command));
  expect(result.state).toBe("completed");
  expect(result.candidates[0]?.decision).toBe("pending");
  expect(f.store.read("SELECT * FROM memory_records")).toEqual({ ok: true, value: [] });
  await f.store.close();
  const reopened = await openProductStoreOrThrow(f.root);
  const actions = reflectionActionsFor(reopened);
  const repeat = reflectionRecord(await actions.execute(JSON.stringify(command)));
  expect(repeat).toEqual(result);
  const exported = reflectionValue(
    await actions.execute(
      JSON.stringify({ action: "export", id: request.id, expectedRevision: result.revision }),
    ),
  );
  if (exported.kind !== "export") throw new Error("export missing");
  const json = JSON.stringify(exported.snapshot);
  expect(json).not.toContain(fence.token);
  expect(replayReflection(json)).toEqual({ ok: true, value: exported.snapshot });
  expect(reflectionCode(await actions.execute(json))).toBe("malformed");
  expect(reopened.read("SELECT count(*) AS count FROM memory_records")).toEqual({
    ok: true,
    value: [{ count: 0 }],
  });
  expect(reopened.read("SELECT count(*) AS count FROM events")).toEqual({
    ok: true,
    value: [{ count: 3 }],
  });
  await reopened.close();
});

test("later ranges leave an earlier gap; empty publication differs from pending after reopen", async () => {
  const f = await reflectionFixture();
  const recent = reflectionRecord(await f.create({ first: 3, last: 3 }));
  const fence = await f.lease(recent.id);
  const command = publish(recent.id, fence, recent.range);
  expect(reflectionRecord(await f.send(command)).state).toBe("empty");
  const coverage = () =>
    f.send({ action: "coverage", transform: "transform-1", committedThrough: 3 });
  const first = reflectionValue(await coverage());
  expect(first.kind === "coverage" && first.coverage).toMatchObject({
    contiguousThrough: 0,
    pending: [{ first: 1, last: 2 }],
    processed: [{ first: 3, last: 3 }],
    partial: true,
  });
  const older = reflectionRecord(await f.create({ first: 1, last: 2 }));
  const lease = await f.lease(older.id);
  await f.send(publish(older.id, lease, older.range));
  expect(reflectionValue(await coverage())).toMatchObject({
    kind: "coverage",
    coverage: {
      contiguousThrough: 3,
      pending: [],
      partial: false,
      semanticCompleteness: "unknown",
    },
  });
  expect(reflectionRecord(await f.send(command)).publications).toHaveLength(1);
  await f.store.close();
  const reopened = await openProductStoreOrThrow(f.root);
  expect(
    reflectionValue(
      await reflectionActionsFor(reopened).execute(
        JSON.stringify({ action: "coverage", transform: "transform-1", committedThrough: 3 }),
      ),
    ),
  ).toMatchObject({ kind: "coverage", coverage: { contiguousThrough: 3 } });
  await reopened.close();
});

test("expired lease inspection runs nothing; takeover fences the paused owner across two connections", async () => {
  const f = await reflectionFixture();
  let time = Date.now();
  const first = reflectionActionsFor(f.store, reflectionAuthority, () => time);
  const record = reflectionRecord(await f.create());
  const lease = reflectionValue(
    await first.execute(
      JSON.stringify({
        action: "lease",
        id: record.id,
        durationMs: 10,
        process: { pid: 1, birth: "process-birth-1" },
      }),
    ),
  );
  if (lease.kind !== "record" || !lease.fence) throw new Error("lease missing");
  const competing = await openProductStoreOrThrow(f.root);
  const second = reflectionActionsFor(competing, reflectionAuthority, () => time);
  const send = (command: unknown) => second.execute(JSON.stringify(command));
  expect(
    reflectionCode(await send({ action: "lease", id: record.id, durationMs: 100, process: null })),
  ).toBe("conflict");
  time += 11;
  expect(reflectionValue(await send({ action: "reconcile", after: null, limit: 1 }))).toMatchObject(
    { kind: "page", items: [{ state: "leased", reconcilable: true, revision: 2 }] },
  );
  const takeover = reflectionValue(
    await send({ action: "lease", id: record.id, durationMs: 100, process: null }),
  );
  if (takeover.kind !== "record" || !takeover.fence) throw new Error("lease missing");
  expect(takeover.fence.epoch).toBe(2);
  for (const command of [
    publish(record.id, lease.fence),
    { action: "heartbeat", id: record.id, fence: lease.fence, durationMs: 100 },
    { action: "settle", id: record.id, fence: lease.fence, state: "failed", uncertainty: "none" },
  ])
    expect(reflectionCode(await send(command))).toBe("stale-lease");
  expect(reflectionRecord(await send(publish(record.id, takeover.fence))).state).toBe("empty");
  await competing.close();
  await f.store.close();
});

test.each(["before", "after"] as const)(
  "publication crash %s commit has one recoverable canonical outcome",
  async (boundary) => {
    const f = await reflectionFixture();
    const record = reflectionRecord(await f.create());
    const fence = await f.lease(record.id, 300000);
    const underlying = createReflectionRepository(f.store);
    let armed = true;
    const repository: ReflectionRepository = {
      transaction(work, signal) {
        if (!armed) return underlying.transaction(work, signal);
        armed = false;
        if (boundary === "before")
          return underlying.transaction((tx) => {
            work(tx);
            throw new Error("injected before commit");
          }, signal);
        const committed = underlying.transaction(work, signal);
        if (!committed.ok) return committed;
        return err({ kind: "reflection", code: "uncertain" });
      },
    };
    const actions = reflectionActionsFor(f.store, reflectionAuthority, Date.now, repository);
    const command = publish(record.id, fence, record.range, {
      disposition: "processed",
      candidates: [reflectionCandidate],
    });
    expect(reflectionCode(await actions.execute(JSON.stringify(command)))).toBe("uncertain");
    await f.store.close();
    const reopened = await openProductStoreOrThrow(f.root);
    const resumed = reflectionActionsFor(reopened);
    const inspected = reflectionRecord(
      await resumed.execute(JSON.stringify({ action: "inspect", id: record.id })),
    );
    expect(inspected.candidates.length).toBe(boundary === "before" ? 0 : 1);
    expect(inspected.publications.length).toBe(boundary === "before" ? 0 : 1);
    const retried = reflectionRecord(await resumed.execute(JSON.stringify(command)));
    expect(retried.candidates).toHaveLength(1);
    expect(retried.publications).toHaveLength(1);
    await reopened.close();
  },
);

test.each([
  "policyGeneration",
  "authorizationGeneration",
  "sourceGeneration",
  "configurationGeneration",
  "branch",
  "worktree",
] as const)("%s change invalidates before returning any derived prose", async (field) => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const fence = await f.lease(record.id);
  await f.send(
    publish(record.id, fence, record.range, {
      disposition: "processed",
      candidates: [reflectionCandidate],
    }),
  );
  const binding: ReflectionBinding = {
    ...reflectionBinding,
    [field]: field === "configurationGeneration" ? 1 : "changed",
  };
  const actions = reflectionActionsFor(f.store, { ...reflectionAuthority, current: () => binding });
  const result = await actions.execute(JSON.stringify({ action: "inspect", id: record.id }));
  expect(reflectionCode(result)).toBe("stale");
  expect(JSON.stringify(result)).not.toContain(reflectionCandidate.content);
  const stored = createReflectionRepository(f.store).transaction((tx) => tx.get(record.id));
  expect(stored.ok && stored.value?.invalidations).toHaveLength(1);
  expect(
    reflectionCode(await actions.execute(JSON.stringify({ action: "inspect", id: record.id }))),
  ).toBe("stale");
  const after = createReflectionRepository(f.store).transaction((tx) => tx.get(record.id));
  expect(after.ok && after.value?.revision).toBe(4);
  await f.store.close();
});

test("source deletion and permissions invalidate evidence, and another workspace cannot inspect or invalidate", async () => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const alien = reflectionActionsFor(f.store, {
    ...reflectionAuthority,
    current: () => ({ ...reflectionBinding, workspaceId: "other" }),
  });
  for (const command of [
    { action: "inspect", id: record.id },
    { action: "invalidate", id: record.id, expectedRevision: 1, reason: "source" },
  ])
    expect(reflectionCode(await alien.execute(JSON.stringify(command)))).toBe("denied");
  expect(f.store.write((sql) => sql.run("DELETE FROM events WHERE sequence=2")).ok).toBe(true);
  expect(reflectionCode(await f.send({ action: "inspect", id: record.id }))).toBe("stale");
  expect(
    reflectionValue(
      await f.send({ action: "coverage", transform: "transform-1", committedThrough: 3 }),
    ),
  ).toMatchObject({
    kind: "coverage",
    coverage: { contiguousThrough: 0, pending: [{ first: 1, last: 3 }] },
  });
  await f.store.close();
});

test("overlaps refuse, transform and fork generations preserve independent lineage", async () => {
  const f = await reflectionFixture();
  const first = reflectionRecord(await f.create({ first: 1, last: 2 }));
  expect(reflectionCode(await f.create({ first: 2, last: 3 }))).toBe("source-overlap");
  const transformed = reflectionRecord(await f.create(first.range, "transform-2"));
  expect(transformed.id).not.toBe(first.id);
  const binding = { ...reflectionBinding, branch: "fork", sourceGeneration: "restored-source" };
  const fork = reflectionActionsFor(f.store, { ...reflectionAuthority, current: () => binding });
  const restored = reflectionRecord(
    await fork.execute(
      JSON.stringify({
        action: "create",
        binding,
        range: first.range,
        transform: "transform-1",
        reason: "recovery",
      }),
    ),
  );
  expect(restored.lineage).not.toBe(first.lineage);
  expect(
    reflectionValue(
      await fork.execute(
        JSON.stringify({ action: "coverage", transform: "transform-1", committedThrough: 3 }),
      ),
    ),
  ).toMatchObject({
    kind: "coverage",
    coverage: { contiguousThrough: 0, pending: [{ first: 1, last: 3 }] },
  });
  await f.store.close();
});

test("candidate/projection privacy, provenance and missing artifacts fail without storing supplied text", async () => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const fence = await f.lease(record.id);
  const cases = [
    { ...reflectionCandidate, sensitivity: "restricted" },
    {
      ...reflectionCandidate,
      content: "api_key=sk-secret-private-value-123456789012345678901234567890",
    },
    { ...reflectionCandidate, sources: ["unknown-event"] },
    {
      ...reflectionCandidate,
      artifacts: [{ artifactId: "missing-artifact", digest: reflectionDigest("missing") }],
    },
    { ...reflectionCandidate, content: "🦊".repeat(3000) },
  ];
  for (const candidate of cases) {
    const result = await f.send(
      publish(record.id, fence, record.range, {
        disposition: "processed",
        candidates: [candidate],
      }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(candidate.content);
  }
  expect(reflectionRecord(await f.send({ action: "inspect", id: record.id })).candidates).toEqual(
    [],
  );
  const denied = reflectionActionsFor(f.store, {
    ...reflectionAuthority,
    sourceAllowed: () => false,
  });
  expect(
    reflectionCode(await denied.execute(JSON.stringify({ action: "inspect", id: record.id }))),
  ).toBe("stale");
  await f.store.close();
});

test("unavailable range is explicit and never advances contiguous processed coverage", async () => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const fence = await f.lease(record.id);
  expect(
    reflectionRecord(
      await f.send(
        publish(record.id, fence, { first: 2, last: 2 }, { disposition: "unavailable" }),
      ),
    ).state,
  ).toBe("partial");
  await f.send(
    publish(record.id, fence, { first: 1, last: 1 }, { publicationId: "publication-2" }),
  );
  await f.send(
    publish(record.id, fence, { first: 3, last: 3 }, { publicationId: "publication-3" }),
  );
  expect(
    reflectionValue(
      await f.send({ action: "coverage", transform: "transform-1", committedThrough: 3 }),
    ),
  ).toMatchObject({
    kind: "coverage",
    coverage: {
      contiguousThrough: 1,
      pending: [],
      unavailable: [{ first: 2, last: 2 }],
      partial: true,
    },
  });
  await f.store.close();
});

test("cancellation, uncertain settlement and unsupported replay do not retry work", async () => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const fence = await f.lease(record.id);
  const controller = new AbortController();
  controller.abort();
  expect(
    reflectionCode(
      await f.actions.execute(JSON.stringify(publish(record.id, fence)), controller.signal),
    ),
  ).toBe("cancelled");
  const settled = reflectionRecord(
    await f.send({
      action: "settle",
      id: record.id,
      fence,
      state: "uncertain",
      uncertainty: "provider-outcome",
    }),
  );
  expect(settled.state).toBe("uncertain");
  expect(settled.candidates).toEqual([]);
  expect(
    reflectionCode(
      await f.send({ action: "lease", id: record.id, durationMs: 100, process: null }),
    ),
  ).toBe("conflict");
  expect(replayReflection('{"version":0}').ok).toBe(false);
  const tooMany = Array.from(
    { length: REFLECTION_LIMITS.candidates + 1 },
    () => reflectionCandidate,
  );
  expect(
    reflectionCode(
      await f.send(
        publish(record.id, fence, record.range, { disposition: "processed", candidates: tooMany }),
      ),
    ),
  ).toBe("malformed");
  await f.store.close();
});

test("candidate ineligibility leaves original session evidence usable by the checkpoint contract", async () => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const fence = await f.lease(record.id);
  await f.send(
    publish(record.id, fence, record.range, {
      disposition: "processed",
      candidates: [reflectionCandidate],
    }),
  );
  const { checkpointHistory } = await import("../../domain/compression/history-checkpoint.ts");
  const { createSha256Hasher } = await import("../../integrations/index.ts");
  const original = f.store.read("SELECT event_id,payload FROM events WHERE sequence=3");
  if (!original.ok || typeof original.value[0]?.payload !== "string")
    throw new Error("missing source");
  const source = original.value[0];
  const checkpoint = () =>
    checkpointHistory(
      {
        checkpointId: "checkpoint-reflection",
        items: [
          { id: source.event_id, kind: "tool-outcome", text: source.payload, retained: true },
        ],
      },
      createSha256Hasher(),
      null,
    );
  const before = checkpoint();
  expect(before.ok).toBe(true);
  const ineligible = reflectionActionsFor(f.store, {
    ...reflectionAuthority,
    candidateAllowed: () => false,
  });
  expect(
    reflectionCode(await ineligible.execute(JSON.stringify({ action: "inspect", id: record.id }))),
  ).toBe("stale");
  expect(f.store.read("SELECT event_id,payload FROM events WHERE sequence=3")).toEqual(original);
  expect(checkpoint()).toEqual(before);
  expect(f.store.read("SELECT count(*) AS count FROM memory_records")).toEqual({
    ok: true,
    value: [{ count: 0 }],
  });
  await f.store.close();
});

test("prepared coverage rejects omitted protected evidence and never grants a queue mutation operation", async () => {
  const f = await reflectionFixture();
  const record = reflectionRecord(await f.create());
  const fence = await f.lease(record.id);
  const prepared = {
    version: 1,
    authority: "derived",
    parentCheckpoint: "checkpoint-1",
    fidelity: "lossy",
    represented: ["event-session-1", "event-turn-start-2"],
    protectedSources: ["event-turn-done-3"],
    omissions: [{ source: "event-turn-done-3", reason: "pending" }],
    recovery: "partial",
    summary: "A historical task checkbox was observed, not current queue completion.",
  };
  expect(reflectionCode(await f.send(publish(record.id, fence, record.range, { prepared })))).toBe(
    "malformed",
  );
  const published = reflectionRecord(
    await f.send(
      publish(record.id, fence, record.range, { prepared: { ...prepared, protectedSources: [] } }),
    ),
  );
  expect(published.publications[0]?.prepared?.authority).toBe("derived");
  expect(reflectionCode(await f.send({ action: "complete-task", id: record.id }))).toBe(
    "malformed",
  );
  expect(f.store.read("SELECT count(*) AS count FROM work_queues")).toEqual({
    ok: true,
    value: [{ count: 0 }],
  });
  const revoked = reflectionActionsFor(f.store, {
    ...reflectionAuthority,
    preparedAllowed: () => false,
  });
  expect(
    reflectionCode(
      await revoked.execute(
        JSON.stringify({ action: "export", id: record.id, expectedRevision: published.revision }),
      ),
    ),
  ).toBe("stale");
  await f.store.close();
});
