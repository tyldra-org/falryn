import { afterEach, expect, test } from "bun:test";
import {
  reflectionActionsFor,
  reflectionAuthority,
  reflectionBinding,
  reflectionCandidate,
  reflectionCode,
  reflectionFixture,
  reflectionRecord,
  reflectionValue,
} from "../../application/memory/reflection.fixtures.ts";
import { sessionStarted } from "../../domain/fixtures.ts";
import { REFLECTION_LIMITS } from "../../domain/memory/reflection.ts";
import { reflectionDigest } from "../../domain/memory/reflection-state.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createSqliteEventStore } from "../sessions/event-store.ts";
import { PRODUCTION_MIGRATIONS } from "../sqlite/sqlite-migrations.ts";
import { createReflectionRepository } from "./reflection-repository.ts";

afterEach(removeTemporaryRoots);

test("migration 25 upgrades version 24 without rewriting source or accepted memory", async () => {
  const root = await temporaryRoot("reflection-upgrade-");
  const old = await openProductStoreOrThrow(root, {
    migrations: PRODUCTION_MIGRATIONS.slice(0, 24),
  });
  const events = createSqliteEventStore(old, { projectStartedRecords: true });
  expect((await events.append(sessionStarted())).ok).toBe(true);
  const before = old.read("SELECT * FROM events");
  await old.close();
  const upgraded = await openProductStoreOrThrow(root);
  expect(upgraded.read("SELECT * FROM events")).toEqual(before);
  expect(upgraded.read("SELECT * FROM reflection_requests")).toEqual({ ok: true, value: [] });
  expect(
    reflectionRecord(
      await reflectionActionsFor(upgraded).execute(
        JSON.stringify({
          action: "create",
          binding: reflectionBinding,
          range: { first: 1, last: 1 },
          transform: "transform-1",
          reason: "explicit",
        }),
      ),
    ).state,
  ).toBe("due");
  await upgraded.close();
});

test.each(["record", "digest", "revision", "session_id"])(
  "corrupt %s fails closed with bounded diagnostics",
  async (column) => {
    const f = await reflectionFixture();
    const record = reflectionRecord(await f.create());
    const value = column === "revision" ? 999 : "private-corrupt-value";
    f.store.write((sql) => sql.run(`UPDATE reflection_requests SET ${column}=$value`, { value }));
    const result = await f.send({ action: "inspect", id: record.id });
    expect(reflectionCode(result)).toBe("corrupt");
    expect(JSON.stringify(result)).not.toContain("private-corrupt-value");
    await f.store.close();
  },
);

test("immutable request and append-only publication enforcement rolls back an attempted rewrite", async () => {
  const f = await reflectionFixture();
  const request = reflectionRecord(await f.create());
  const fence = await f.lease(request.id);
  const result = reflectionRecord(
    await f.send({
      action: "publish",
      id: request.id,
      fence,
      publicationId: "publication-1",
      range: request.range,
      disposition: "processed",
      candidates: [reflectionCandidate],
      prepared: null,
    }),
  );
  const repository = createReflectionRepository(f.store);
  const changed = repository.transaction((tx) => {
    const record = tx.get(request.id);
    if (!record) throw new Error("missing record");
    tx.save({ ...record, revision: record.revision + 1, reason: "recovery" }, record.revision);
  });
  expect(changed).toMatchObject({ ok: false, error: { code: "conflict" } });
  const removed = repository.transaction((tx) => {
    const record = tx.get(request.id);
    if (!record) throw new Error("missing record");
    tx.save(
      { ...record, revision: record.revision + 1, candidates: [], publications: [] },
      record.revision,
    );
  });
  expect(removed.ok).toBe(false);
  expect(reflectionRecord(await f.send({ action: "inspect", id: request.id }))).toEqual(result);
  await f.store.close();
});

test("an oversized stored source is refused before copying text and stays outstanding", async () => {
  const f = await reflectionFixture();
  const large = JSON.stringify({ secret: "x".repeat(REFLECTION_LIMITS.sourceBytes + 1) });
  f.store.write((sql) =>
    sql.run("UPDATE events SET payload=$payload WHERE sequence=3", { payload: large }),
  );
  const result = await f.create();
  expect(reflectionCode(result)).toBe("source-too-large");
  expect(JSON.stringify(result).length).toBeLessThan(120);
  expect(
    reflectionValue(
      await f.send({ action: "coverage", transform: "transform-1", committedThrough: 3 }),
    ),
  ).toMatchObject({
    kind: "coverage",
    coverage: { contiguousThrough: 0, pending: [{ first: 1, last: 3 }], partial: true },
  });
  expect(f.store.read("SELECT count(*) AS count FROM reflection_requests")).toEqual({
    ok: true,
    value: [{ count: 0 }],
  });
  await f.store.close();
});

test("retained transform bound preserves earlier generations and unknown future coverage", async () => {
  const f = await reflectionFixture();
  for (let index = 0; index < REFLECTION_LIMITS.generations; index++)
    expect((await f.create({ first: 1, last: 3 }, `transform-${index}`)).ok).toBe(true);
  expect(reflectionCode(await f.create({ first: 1, last: 3 }, "transform-next"))).toBe(
    "resource-exhausted",
  );
  expect(
    reflectionValue(
      await f.send({ action: "coverage", transform: "transform-next", committedThrough: 3 }),
    ),
  ).toMatchObject({
    kind: "coverage",
    coverage: { contiguousThrough: 0, pending: [{ first: 1, last: 3 }] },
  });
  await f.store.close();
});

test("artifact expiry invalidates an existing candidate before inspection or export", async () => {
  const f = await reflectionFixture();
  const request = reflectionRecord(await f.create());
  const fence = await f.lease(request.id);
  const digest = reflectionDigest("artifact bytes");
  expect(
    f.store.write((sql) =>
      sql.run(
        "INSERT INTO artifacts(artifact_id,digest,media_type,encoding,byte_length,sensitivity,origin,invocation_id,created_at,finalized_at,availability) VALUES('artifact-1',$digest,'text/plain','identity',14,'user-content','capture',NULL,'2026-09-11','2026-09-11','available')",
        { digest },
      ),
    ).ok,
  ).toBe(true);
  const candidate = { ...reflectionCandidate, artifacts: [{ artifactId: "artifact-1", digest }] };
  expect(
    reflectionCode(
      await f.send({
        action: "publish",
        id: request.id,
        fence,
        publicationId: "publication-1",
        range: request.range,
        disposition: "processed",
        candidates: [candidate],
        prepared: null,
      }),
    ),
  ).toBe("record");
  f.store.write((sql) =>
    sql.run("UPDATE artifacts SET availability='missing' WHERE artifact_id='artifact-1'"),
  );
  const result = await f.send({ action: "inspect", id: request.id });
  expect(reflectionCode(result)).toBe("stale");
  expect(JSON.stringify(result)).not.toContain(candidate.content);
  await f.store.close();
});

test("changing authority inside validation rolls back the attempted publication", async () => {
  const f = await reflectionFixture();
  const request = reflectionRecord(await f.create());
  const fence = await f.lease(request.id);
  let binding = reflectionBinding;
  const actions = reflectionActionsFor(f.store, {
    ...reflectionAuthority,
    current: () => binding,
    candidateAllowed: () => {
      binding = { ...binding, policyGeneration: "new-policy" };
      return true;
    },
  });
  expect(
    reflectionCode(
      await actions.execute(
        JSON.stringify({
          action: "publish",
          id: request.id,
          fence,
          publicationId: "publication-1",
          range: request.range,
          disposition: "processed",
          candidates: [reflectionCandidate],
          prepared: null,
        }),
      ),
    ),
  ).toBe("stale");
  expect(reflectionRecord(await f.send({ action: "inspect", id: request.id })).candidates).toEqual(
    [],
  );
  await f.store.close();
});

test("publication metadata exhaustion preserves processed chunks and every remaining gap", async () => {
  const f = await reflectionFixture();
  const { turnStarted } = await import("../../domain/fixtures.ts");
  const { turnId } = await import("../../domain/foundation/index.ts");
  for (let position = 4; position <= 130; position++) {
    const event = turnStarted(position);
    expect(
      (
        await f.events.append({
          ...event,
          correlation: { ...event.correlation, turnId: turnId.from(`turn-${position}`) },
        })
      ).ok,
    ).toBe(true);
  }
  const record = reflectionRecord(await f.create({ first: 1, last: 130 }));
  const fence = await f.lease(record.id, 300000);
  for (let index = 1; index <= REFLECTION_LIMITS.publications; index++) {
    expect(
      reflectionCode(
        await f.send({
          action: "publish",
          id: record.id,
          fence,
          publicationId: `publication-${index}`,
          range: { first: index * 2, last: index * 2 },
          disposition: "empty",
          candidates: [],
          prepared: null,
        }),
      ),
    ).toBe("record");
  }
  const exhausted = reflectionRecord(await f.send({ action: "inspect", id: record.id }));
  expect(exhausted.state).toBe("partial");
  expect(exhausted.lease).toBeNull();
  expect(
    reflectionCode(
      await f.send({ action: "lease", id: record.id, durationMs: 100, process: null }),
    ),
  ).toBe("resource-exhausted");
  const coverage = reflectionValue(
    await f.send({ action: "coverage", transform: "transform-1", committedThrough: 130 }),
  );
  if (coverage.kind !== "coverage") throw new Error("missing coverage");
  expect(coverage.coverage.contiguousThrough).toBe(0);
  expect(coverage.coverage.partial).toBe(true);
  const count = (ranges: readonly { first: number; last: number }[]) =>
    ranges.reduce((sum, r) => sum + r.last - r.first + 1, 0);
  expect(count(coverage.coverage.processed)).toBe(64);
  expect(count(coverage.coverage.pending)).toBe(66);
  await f.store.close();
});
