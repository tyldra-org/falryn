import { expect, test } from "bun:test";
import {
  loadedRoute,
  receiptEvent,
  skillDecision,
} from "../../domain/context/skill-usage.fixtures.ts";
import type { RuntimeEvent } from "../../domain/sessions/index.ts";
import { querySkillUsage, type SkillUsagePorts, skillUsageLines } from "./skill-usage.ts";

const skill = skillDecision("release-notes", "project-agents", "selected");
const admission = (sequence: number, session = "session-a", extra = {}) =>
  receiptEvent({ sequence, session, sources: [skill], routes: [loadedRoute(skill)], ...extra });

/** A stream store whose listed sequences fail to decode, like a corrupt row. */
function ports(
  streams: Record<string, readonly RuntimeEvent[]>,
  options: { corrupt?: readonly number[]; truncated?: boolean } = {},
): SkillUsagePorts {
  const state = {
    workspaceId: "workspace-a",
    sessions: () => ({
      sessions: Object.keys(streams).map((sessionId) => ({
        sessionId,
        streamId: `live-turn:${sessionId}`,
      })),
      truncated: options.truncated ?? false,
    }),
    events: {
      async readFrom(cursor: { streamId: unknown; afterSequence: unknown }, limit: number) {
        const session = String(cursor.streamId).slice("live-turn:".length);
        const after = cursor.afterSequence === null ? 0 : Number(cursor.afterSequence);
        const page = (streams[session] ?? [])
          .filter((event) => Number(event.sequence) > after)
          .slice(0, limit);
        if (page.some((event) => options.corrupt?.includes(Number(event.sequence))))
          return { ok: false as const, error: { code: "codec" as const, error: {} as never } };
        return { ok: true as const, value: page };
      },
    },
  };
  return state as never;
}

test("pages count every event once and a continuation resumes exactly where it stopped", async () => {
  const store = ports({
    "session-a": [admission(1), admission(2), admission(3)],
    "session-b": [admission(1, "session-b")],
  });
  const first = await querySkillUsage(store, { limit: 2 });
  if (first.status !== "reported") throw new Error(first.status);
  expect(first.admissions).toBe(2);
  expect(first.coverage).toMatchObject({ complete: false, sessionsRemaining: 2 });
  expect(first.next).not.toBeNull();
  const second = await querySkillUsage(store, { limit: 2, after: first.next ?? "" });
  if (second.status !== "reported") throw new Error(second.status);
  const third = await querySkillUsage(store, { limit: 2, after: second.next ?? "" });
  if (third.status !== "reported") throw new Error(third.status);
  expect(first.admissions + second.admissions + third.admissions).toBe(4);
  expect(third.next).toBeNull();
  expect(third.coverage.complete).toBe(true);
  // A continuation cannot be replayed against a different query.
  expect(await querySkillUsage(store, { limit: 3, after: first.next ?? "" })).toEqual({
    status: "failed",
    code: "cursor-invalid",
  });
});

test("gaps, corrupt rows and foreign events are reported; their neighbours still count", async () => {
  const report = await querySkillUsage(
    ports(
      {
        "session-a": [
          admission(1),
          admission(2),
          admission(3),
          admission(6),
          admission(7, "session-a", { workspace: "workspace-other" }),
        ],
      },
      { corrupt: [2] },
    ),
    {},
  );
  if (report.status !== "reported") throw new Error(report.status);
  expect(report.admissions).toBe(3);
  expect(report.coverage.omissions).toEqual([
    { kind: "malformed", sessionId: "session-a", sequence: 2, count: 1 },
    { kind: "gap", sessionId: "session-a", sequence: 4, count: 2 },
    { kind: "unauthorized", sessionId: "session-a", sequence: 7, count: 1 },
  ]);
  expect(report.coverage.complete).toBe(false);
  expect(report.rows[0]?.counts.loaded).toBe(3);
});

test("an unknown session, cancellation and truncated sessions stay truthful", async () => {
  const store = ports({ "session-a": [admission(1), admission(2)] });
  expect(await querySkillUsage(store, { session: "session-z" })).toEqual({
    status: "failed",
    code: "session-unavailable",
  });
  const stop = new AbortController();
  stop.abort();
  const cancelled = await querySkillUsage(store, {}, stop.signal);
  if (cancelled.status !== "reported") throw new Error(cancelled.status);
  expect(cancelled).toMatchObject({ cancelled: true, admissions: 0 });
  expect(cancelled.coverage.complete).toBe(false);
  expect(cancelled.next).not.toBeNull();
  const truncated = await querySkillUsage(
    ports({ "session-a": [admission(1)] }, { truncated: true }),
    {},
  );
  if (truncated.status !== "reported") throw new Error(truncated.status);
  expect(truncated.coverage).toMatchObject({ sessionsTruncated: true, complete: false });
});

test("a turn committed between pages is counted once, never duplicated or skipped", async () => {
  const stream = [admission(1), admission(2)];
  const store = ports({ "session-a": stream });
  const first = await querySkillUsage(store, { limit: 1 });
  if (first.status !== "reported") throw new Error(first.status);
  stream.push(admission(3));
  let after = first.next;
  let total = first.admissions;
  while (after !== null) {
    const page = await querySkillUsage(store, { limit: 1, after });
    if (page.status !== "reported") throw new Error(page.status);
    total += page.admissions;
    expect(page.duplicates).toBe(0);
    after = page.next;
  }
  expect(total).toBe(3);
});

test("a time window filters admissions without hiding what was scanned", async () => {
  const report = await querySkillUsage(
    ports({ "session-a": [admission(1), admission(2), admission(3)] }),
    { since: "2026-09-01T00:00:02Z", until: "2026-09-01T00:00:03Z" },
  );
  if (report.status !== "reported") throw new Error(report.status);
  expect(report.admissions).toBe(1);
  expect(report.coverage.events).toBe(3);
});

test("no admissions reads as unavailable usage, and the human view labels every estimate", async () => {
  const empty = await querySkillUsage(ports({}), {});
  expect(skillUsageLines(empty).join("\n")).toContain("usage is unavailable, not zero");
  const report = await querySkillUsage(ports({ "session-a": [admission(1)] }), {});
  const text = skillUsageLines(report).join("\n");
  expect(text).toContain("(complete window)");
  expect(text).toContain("body 400 bytes, ~100 tokens");
  expect(text).toContain("not provider-measured");
  expect(text).toContain("Not recorded yet: invoked, resource-loaded.");
});
