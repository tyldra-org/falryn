import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeRedactor } from "../application/index.ts";
import { sessionRecord } from "../domain/fixtures.ts";
import {
  createInMemoryPackageWriter,
  createManualClock,
  localPath,
  sessionId as sessionIdCodec,
  streamId as streamIdCodec,
} from "../domain/index.ts";
import { isGcPlanId } from "../domain/reachability-gc.ts";
import { createHostBlobStore, createSha256Hasher } from "../integrations/index.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { openProductStoreOrThrow, removeTemporaryRoots } from "./fixtures.ts";
import { computeGcPlanId, planReachabilityGc } from "./reachability-gc.ts";
import { createRecordRepositories } from "./repositories.ts";

afterEach(removeTemporaryRoots);

describe("reachability GC plan identity", () => {
  test("recognizes a structural GC plan identity", () => {
    expect(isGcPlanId("plan-gc-0123abcd-42")).toBe(true);
    expect(isGcPlanId("plan-reset-0123abcd-42")).toBe(false);
  });

  test("derives the same identity from the same candidate list", () => {
    const candidates = [
      { kind: "session" as const, identity: "session-a", byteCount: 0 },
      { kind: "artifact" as const, identity: "artifact-b", byteCount: 12 },
    ];
    expect(computeGcPlanId(candidates)).toBe(computeGcPlanId(candidates));
  });
});

describe("planning reachability garbage collection", () => {
  test("marks closed unreachable sessions as candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-reachability-gc-"));
    const state = join(root, "state");
    const artifacts = join(root, "artifacts");
    const temporary = join(root, "tmp");
    await mkdir(state, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await mkdir(temporary, { recursive: true });

    const store = await openProductStoreOrThrow(localPath(state));
    const repositories = createRecordRepositories(store);
    const clock = createManualClock();
    const open = sessionRecord({
      sessionId: sessionIdCodec.from("open"),
      streamId: streamIdCodec.from("stream-open"),
      closedAt: null,
    });
    const closed = sessionRecord({
      sessionId: sessionIdCodec.from("closed"),
      streamId: streamIdCodec.from("stream-closed"),
      closedAt: open.startedAt,
      outcome: { kind: "completed" },
    });
    repositories.sessions.insert(open);
    repositories.sessions.insert(closed);

    const packages = createInMemoryPackageWriter();
    const exportOptions = {
      store,
      repositories,
      events: createSqliteEventStore(store),
      blobs: createHostBlobStore({
        artifactsRoot: localPath(artifacts),
        temporaryRoot: localPath(temporary),
      }),
      packages,
      hasher: createSha256Hasher(),
      clock,
      buildIdentity: "test",
      redactor: createRuntimeRedactor(),
    };

    const planned = await planReachabilityGc({
      store,
      repositories,
      blobs: exportOptions.blobs,
      packages,
      exportOptions,
      pinnedSessionIds: [],
      exportPackageNames: [],
    });
    await store.close();
    await rm(root, { recursive: true, force: true });

    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(
      planned.value.candidates.some(
        (candidate) => candidate.kind === "session" && candidate.identity === "closed",
      ),
    ).toBe(true);
    expect(
      planned.value.candidates.some(
        (candidate) => candidate.kind === "session" && candidate.identity === "open",
      ),
    ).toBe(false);
  });
});
