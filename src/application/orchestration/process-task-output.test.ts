import { afterEach, describe, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { ok } from "../../domain/foundation/result.ts";
import type { ProcessTaskSnapshot } from "../../domain/orchestration/process-task.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import { createProcessTaskBuffer } from "./process-task-buffer.ts";
import {
  projectProcessTaskBytes,
  readProcessTaskBytes,
  retainProcessTaskBytes,
} from "./process-task-output.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
const fence = (task: ProcessTaskSnapshot) => ({
  handle: task.handle,
  supervisorRunId: task.supervisor.runId,
  expectedRevision: task.revision,
});

async function opened() {
  const fixture = await createProcessTaskFixture();
  const created = taskValue(fixture.tasks.create(fixture.snapshot)).value;
  const task = taskValue(
    fixture.tasks.transition(
      fence(created),
      { kind: "started", process: { platform: "linux", pid: 101, birth: "boot:1001" } },
      1,
    ),
  ).value;
  return {
    ...fixture,
    task,
    async append(bytes: Uint8Array, offset: number) {
      const artifact = taskValue(
        await retainProcessTaskBytes(fixture.artifacts, task, `stdout:${offset}`, bytes),
      );
      taskValue(
        fixture.tasks.appendChunk(
          fence(task),
          { handle: task.handle, stream: "stdout", offset, artifact },
          2,
        ),
      );
      return artifact;
    },
    async seal(outputComplete = true) {
      const artifact = taskValue(
        await retainProcessTaskBytes(
          fixture.artifacts,
          task,
          "result",
          new TextEncoder().encode('{"result":"done"}'),
          "application/json",
        ),
      );
      const settling = taskValue(
        fixture.tasks.transition(fence(task), { kind: "settling" }, 3),
      ).value;
      return taskValue(
        fixture.tasks.transition(
          fence(settling),
          {
            kind: "sealed",
            terminal: {
              outcome: "completed",
              effect: "completed",
              reason: "exited",
              exitCode: 0,
              signal: null,
              sealedAt: 4,
              result: artifact,
              outputComplete,
            },
          },
          4,
        ),
      ).value;
    },
  };
}

describe("bounded durable task bytes", () => {
  test("fragmented writes share bounded blocks and live tails disclose durability", async () => {
    const f = await opened();
    const buffer = createProcessTaskBuffer(async (_stream, offset, bytes) => {
      await f.append(bytes, offset);
    });
    try {
      for (let i = 0; i < 300; i++) await buffer.append("stdout", new Uint8Array([65]));
      expect(taskValue(f.tasks.chunks(f.task.handle, "stdout"))).toHaveLength(0);
      const live = taskValue(
        await readProcessTaskBytes(
          f.tasks,
          f.artifacts,
          f.task,
          "stdout",
          290,
          10,
          signal,
          buffer.snapshot("stdout"),
        ),
      );
      expect(projectProcessTaskBytes(live)).toMatchObject({
        data: "AAAAAAAAAA",
        durableBytes: 0,
        availableBytes: 300,
        complete: false,
      });
      await buffer.append("stdout", new Uint8Array(70_000).fill(66));
      expect(taskValue(f.tasks.chunks(f.task.handle, "stdout"))).toHaveLength(1);
      const crossing = taskValue(
        await readProcessTaskBytes(
          f.tasks,
          f.artifacts,
          f.task,
          "stdout",
          65_530,
          20,
          signal,
          buffer.snapshot("stdout"),
        ),
      );
      expect(crossing.bytes).toEqual(new Uint8Array(20).fill(66));
      expect(crossing.durableBytes).toBe(65_536);
      await buffer.finish();
      expect(taskValue(f.tasks.chunks(f.task.handle, "stdout"))).toHaveLength(2);
      const terminal = await f.seal();
      const last = taskValue(
        await readProcessTaskBytes(f.tasks, f.artifacts, terminal, "stdout", 70_290, 10, signal),
      );
      expect(last.complete).toBe(true);
      expect(last.durableBytes).toBe(70_300);
    } finally {
      await f.close();
    }
  });
  test("reads exact cross-chunk UTF-8 ranges and exposes live versus sealed completeness", async () => {
    const f = await opened();
    try {
      const bytes = new TextEncoder().encode("A🌍Z");
      await f.append(bytes.slice(0, 3), 0);
      await f.append(bytes.slice(3), 3);
      const live = taskValue(
        await readProcessTaskBytes(f.tasks, f.artifacts, f.task, "stdout", 1, 4, signal),
      );
      expect(live.bytes).toEqual(bytes.slice(1, 5));
      expect(live.complete).toBe(false);
      expect(projectProcessTaskBytes(live)).toMatchObject({
        encoding: "utf8",
        data: "🌍",
        exact: true,
        nextOffset: 5,
      });
      const terminal = await f.seal();
      const tail = taskValue(
        await readProcessTaskBytes(f.tasks, f.artifacts, terminal, "stdout", 5, 32, signal),
      );
      expect(projectProcessTaskBytes(tail)).toMatchObject({
        data: "Z",
        byteLength: 1,
        complete: true,
        sealed: true,
      });
      expect(
        (await readProcessTaskBytes(f.tasks, f.artifacts, terminal, "stdout", 7, 1, signal)).ok,
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("BOM-prefixed UTF-8 ranges preserve every byte marked exact", () => {
    const bytes = Uint8Array.from([239, 187, 191, 65]);
    for (const offset of [0, 17]) {
      const view = projectProcessTaskBytes({
        bytes,
        offset,
        nextOffset: offset + 4,
        availableBytes: offset + 4,
        sealed: true,
        complete: true,
      });
      expect(view.encoding).toBe("utf8");
      expect(view.exact).toBe(true);
      expect(new TextEncoder().encode(view.data)).toEqual(bytes);
      expect(view.nextOffset).toBe(offset + 4);
    }
  });
  test("binary and JSON-escape-heavy data fit the declared model envelope without dropping bytes", () => {
    for (const bytes of [new Uint8Array(32_768), new Uint8Array(32_768).fill(255)]) {
      const view = projectProcessTaskBytes({
        bytes,
        offset: 0,
        nextOffset: bytes.length,
        availableBytes: bytes.length,
        sealed: true,
        complete: true,
      });
      expect(view.encoding).toBe("base64");
      expect(Buffer.from(view.data, "base64")).toEqual(Buffer.from(bytes));
      expect(view.exact).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(64 * 1_024);
    }
  });

  test("binary secrets are redacted before encoding and never mislabeled exact", async () => {
    const f = await opened();
    try {
      const bytes = Uint8Array.from([
        255,
        10,
        ...new TextEncoder().encode("api_key=fixture-secret\nvisible"),
      ]);
      await f.append(bytes, 0);
      const read = taskValue(
        await readProcessTaskBytes(f.tasks, f.artifacts, f.task, "stdout", 0, 32_768, signal),
      );
      const view = projectProcessTaskBytes(read);
      expect(view).toMatchObject({ encoding: "base64", redacted: true, exact: false });
      expect(Buffer.from(view.data, "base64").toString("latin1")).not.toContain("fixture-secret");
      expect(read.bytes).toEqual(bytes);
    } finally {
      await f.close();
    }
  });

  test("missing and corrupt artifacts fail closed and unsealed results remain unavailable", async () => {
    const f = await opened();
    try {
      await f.append(new Uint8Array([1, 2, 3]), 0);
      const missing = { ...f.artifacts, get: () => ok(null) };
      expect(await readProcessTaskBytes(f.tasks, missing, f.task, "stdout", 0, 2, signal)).toEqual({
        ok: false,
        error: { code: "missing-artifact" },
      });
      const corrupt = { ...f.artifacts, verifyIntegrity: async () => ok(false) };
      expect(await readProcessTaskBytes(f.tasks, corrupt, f.task, "stdout", 0, 2, signal)).toEqual({
        ok: false,
        error: { code: "artifact-integrity" },
      });
      expect(
        await readProcessTaskBytes(f.tasks, f.artifacts, f.task, "result", 0, 1, signal),
      ).toEqual({ ok: false, error: { code: "result-not-sealed" } });
      const terminal = await f.seal(false);
      expect(
        taskValue(
          await readProcessTaskBytes(f.tasks, f.artifacts, terminal, "stdout", 0, 3, signal),
        ).complete,
      ).toBe(false);
      const result = taskValue(
        await readProcessTaskBytes(f.tasks, f.artifacts, terminal, "result", 0, 32_768, signal),
      );
      expect(projectProcessTaskBytes(result)).toMatchObject({
        data: '{"result":"done"}',
        complete: true,
        exact: true,
      });
    } finally {
      await f.close();
    }
  });
});
