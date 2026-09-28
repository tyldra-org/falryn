/**
 * The skill usage diagnostic (#1191): a bounded, authorized query over stored admission
 * receipts. It reads recorded session events only, so inspection never loads a skill body,
 * starts a script or MCP server, probes a provider, or records a new observation.
 */
import { z } from "zod";
import {
  createSkillUsageFold,
  SKILL_USAGE_LIMITS,
  type SkillUsageTotals,
  UNRECORDED_SKILL_OBSERVATIONS,
} from "../../domain/context/skill-usage.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { MAX_STREAM_READ_LIMIT, sequence, streamId } from "../../domain/foundation/index.ts";
import type { EventStorePort } from "../../domain/sessions/index.ts";

export const SKILL_USAGE_QUERY_LIMITS = Object.freeze({
  defaultEvents: 1_024,
  maximumEvents: 4_096,
  omissions: 64,
});

export const skillUsageQuerySchema = z.strictObject({
  /** One session of the current workspace; omitted means all of its sessions. */
  session: z.string().min(1).max(256).optional(),
  skill: z.string().min(1).max(64).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  /** Stored events scanned by this page. */
  limit: z.int().min(1).max(SKILL_USAGE_QUERY_LIMITS.maximumEvents).optional(),
  /** The continuation returned by the previous page of the same query. */
  after: z.string().min(1).max(1_024).optional(),
  aggregate: z.enum(["generation", "source"]).optional(),
});
export type SkillUsageQuery = z.infer<typeof skillUsageQuerySchema>;

export type SkillUsageOmission = {
  readonly kind: "gap" | "malformed" | "unauthorized" | "unavailable" | "cancelled";
  readonly sessionId: string;
  /** The first affected sequence. */
  readonly sequence: number;
  readonly count: number;
};

export type SkillUsageSessionCoverage = {
  readonly sessionId: string;
  /** Sequences after this one were read by this page. */
  readonly afterSequence: number;
  readonly throughSequence: number;
  readonly events: number;
  /** True when this page read the session to its current end. */
  readonly complete: boolean;
};

export type SkillUsageReport =
  | ({
      readonly status: "reported";
      readonly workspaceId: string;
      readonly query: Omit<SkillUsageQuery, "after">;
      /** No producer records these yet: they are unknown, never zero. */
      readonly unrecorded: typeof UNRECORDED_SKILL_OBSERVATIONS;
      /** Provider-reported totals are not stored per session, and never attributed to a skill. */
      readonly providerInput: { readonly status: "unavailable"; readonly reason: "not-recorded" };
      readonly coverage: {
        readonly sessions: readonly SkillUsageSessionCoverage[];
        /** Sessions this page did not finish; continue with `next`. */
        readonly sessionsRemaining: number;
        /** The workspace holds more sessions than one query may select. */
        readonly sessionsTruncated: boolean;
        readonly events: number;
        readonly omissions: readonly SkillUsageOmission[];
        readonly omissionsOmitted: number;
        /** Every selected session was read to its end with nothing omitted or filtered by a limit. */
        readonly complete: boolean;
      };
      readonly cancelled: boolean;
      readonly next: string | null;
    } & SkillUsageTotals)
  | {
      readonly status: "failed";
      readonly code: "session-unavailable" | "cursor-invalid" | "sessions-unavailable";
    };

export type SkillUsageSession = { readonly sessionId: string; readonly streamId: string };

export type SkillUsagePorts = {
  readonly workspaceId: string;
  readonly events: Pick<EventStorePort, "readFrom">;
  /** The current workspace's sessions, bounded; anything else is not authorized. */
  readonly sessions: () => {
    readonly sessions: readonly SkillUsageSession[];
    readonly truncated: boolean;
  } | null;
};

type Cursor = { readonly session: string; readonly after: number };

const queryKey = (query: SkillUsageQuery) => {
  const { after: _after, ...rest } = query;
  return canonicalDigest(rest);
};
export function encodeSkillUsageCursor(query: SkillUsageQuery, cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, k: queryKey(query), s: cursor.session, a: cursor.after }),
  ).toString("base64url");
}
function decodeCursor(query: SkillUsageQuery): Cursor | null | "invalid" {
  if (query.after === undefined) return null;
  try {
    const value = z
      .strictObject({ v: z.literal(1), k: z.string(), s: z.string().min(1), a: z.int().min(0) })
      .parse(JSON.parse(Buffer.from(query.after, "base64url").toString("utf8")));
    return value.k === queryKey(query) ? { session: value.s, after: value.a } : "invalid";
  } catch {
    return "invalid";
  }
}

export async function querySkillUsage(
  ports: SkillUsagePorts,
  query: SkillUsageQuery,
  signal: AbortSignal = new AbortController().signal,
): Promise<SkillUsageReport> {
  const cursor = decodeCursor(query);
  if (cursor === "invalid") return { status: "failed", code: "cursor-invalid" };
  const authorized = ports.sessions();
  if (authorized === null) return { status: "failed", code: "sessions-unavailable" };
  // A stable order, so a continuation resumes exactly where the previous page stopped.
  const ordered = [...authorized.sessions].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  const selected =
    query.session === undefined
      ? ordered
      : ordered.filter((session) => session.sessionId === query.session);
  if (query.session !== undefined && selected.length === 0)
    return { status: "failed", code: "session-unavailable" };
  const start =
    cursor === null ? 0 : selected.findIndex((item) => item.sessionId >= cursor.session);
  const since = query.since === undefined ? null : Date.parse(query.since);
  const until = query.until === undefined ? null : Date.parse(query.until);
  const fold = createSkillUsageFold({ skill: query.skill, aggregate: query.aggregate });
  const omissions: SkillUsageOmission[] = [];
  let omissionsOmitted = 0;
  const omit = (omission: SkillUsageOmission) => {
    if (omissions.length < SKILL_USAGE_QUERY_LIMITS.omissions) omissions.push(omission);
    else omissionsOmitted++;
  };
  const coverage: SkillUsageSessionCoverage[] = [];
  let budget = query.limit ?? SKILL_USAGE_QUERY_LIMITS.defaultEvents;
  let scanned = 0;
  let next: Cursor | null = null;
  let cancelled = false;

  const sessions = start < 0 ? [] : selected.slice(start);
  for (const [index, session] of sessions.entries()) {
    let after =
      index === 0 && cursor !== null && cursor.session === session.sessionId ? cursor.after : 0;
    const from = after;
    let events = 0;
    let complete = false;
    // After a codec failure the rest of the chunk is read one event at a time.
    let single = 0;
    while (true) {
      if (signal.aborted) {
        cancelled = true;
        omit({ kind: "cancelled", sessionId: session.sessionId, sequence: after + 1, count: 0 });
        break;
      }
      if (budget === 0) break;
      const size = single > 0 ? 1 : Math.min(budget, MAX_STREAM_READ_LIMIT);
      const read = await ports.events.readFrom(
        {
          streamId: streamId.from(session.streamId),
          afterSequence: after === 0 ? null : sequence.from(after),
        },
        size,
        signal,
      );
      if (!read.ok) {
        if (read.error.code === "cancelled") {
          cancelled = true;
          omit({ kind: "cancelled", sessionId: session.sessionId, sequence: after + 1, count: 0 });
          break;
        }
        if (read.error.code === "codec") {
          if (size > 1) {
            single = size;
            continue;
          }
          // The unreadable event is skipped and reported; its neighbours still count.
          omit({ kind: "malformed", sessionId: session.sessionId, sequence: after + 1, count: 1 });
          after++;
          budget--;
          scanned++;
          events++;
          single = Math.max(0, single - 1);
          continue;
        }
        omit({ kind: "unavailable", sessionId: session.sessionId, sequence: after + 1, count: 0 });
        break;
      }
      if (read.value.length === 0) {
        complete = true;
        break;
      }
      for (const event of read.value) {
        const at = Number(event.sequence);
        if (at > after + 1)
          omit({
            kind: "gap",
            sessionId: session.sessionId,
            sequence: after + 1,
            count: at - after - 1,
          });
        after = at;
        budget--;
        scanned++;
        events++;
        if (
          String(event.correlation.sessionId) !== session.sessionId ||
          String(event.correlation.workspaceId) !== ports.workspaceId
        ) {
          omit({ kind: "unauthorized", sessionId: session.sessionId, sequence: at, count: 1 });
          continue;
        }
        const time = Date.parse(String(event.occurredAt));
        if ((since !== null && time < since) || (until !== null && time >= until)) continue;
        fold.add(event);
      }
      single = Math.max(0, single - read.value.length);
    }
    coverage.push({
      sessionId: session.sessionId,
      afterSequence: from,
      throughSequence: after,
      events,
      complete,
    });
    if (!complete) {
      next = { session: session.sessionId, after };
      break;
    }
  }
  const totals = fold.totals();
  const { after: _after, ...normalized } = query;
  return {
    status: "reported",
    workspaceId: ports.workspaceId,
    query: normalized,
    ...totals,
    unrecorded: UNRECORDED_SKILL_OBSERVATIONS,
    providerInput: { status: "unavailable", reason: "not-recorded" },
    coverage: {
      sessions: coverage,
      sessionsRemaining: sessions.length - coverage.filter((item) => item.complete).length,
      sessionsTruncated: authorized.truncated && query.session === undefined,
      events: scanned,
      omissions,
      omissionsOmitted,
      complete:
        next === null &&
        !cancelled &&
        !(authorized.truncated && query.session === undefined) &&
        omissions.length === 0 &&
        omissionsOmitted === 0 &&
        totals.observationsBeyondRowLimit === 0 &&
        totals.sourcesOmitted === 0,
    },
    cancelled,
    next: next === null ? null : encodeSkillUsageCursor(query, next),
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const estimate = (total: { tokens: number; unestimated: number; count: number; bytes: number }) =>
  total.count === 0
    ? "none"
    : `${total.bytes} bytes, ~${total.tokens} tokens${total.unestimated > 0 ? ` (${total.unestimated} without an estimate)` : ""}`;

/** Human lines; every figure is labelled as observed, estimated or unknown. */
export function skillUsageLines(report: SkillUsageReport): string[] {
  if (report.status === "failed") return [`Skill usage unavailable: ${report.code}`];
  const lines = [
    `Skill usage in workspace ${report.workspaceId}: ${plural(report.admissions, "admission")} from ${plural(report.coverage.events, "stored event")} across ${plural(report.coverage.sessions.length, "session")}${report.coverage.complete ? " (complete window)" : " (incomplete window: zero counts are not proof of no use)"}.`,
  ];
  if (report.rows.length === 0)
    lines.push(
      report.admissions === 0
        ? "No skill admissions are recorded in this window; usage is unavailable, not zero."
        : "No skill was observed in the recorded admissions.",
    );
  for (const row of report.rows) {
    const counts = Object.entries(row.counts)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ");
    lines.push(
      `${row.name} [${row.origin ?? "unresolved source"}${row.path === null ? "" : ` ${row.path}`}] ${row.generation === null ? `${plural(row.versions?.length ?? 0, "generation")}` : `generation ${row.generation.slice(7, 19)}`}: ${counts || "no observations"}${row.reused > 0 ? `; reused ${row.reused}` : ""}`,
      `  body ${estimate(row.body)}; listing ${estimate(row.listing)}; scopes main ${row.scopes.main}, child ${row.scopes.child}, workflow ${row.scopes.workflow}`,
    );
  }
  if (report.observationsBeyondRowLimit > 0)
    lines.push(
      `${plural(report.observationsBeyondRowLimit, "observation")} past the ${SKILL_USAGE_LIMITS.rows}-row limit were not counted.`,
    );
  lines.push(
    `Routing sections: ${estimate(report.routingSection)}. Estimates use ${report.estimator}; they are not provider-measured.`,
    "Provider-reported input totals: unavailable (not recorded per session); never attributed to a skill.",
    `Not recorded yet: ${report.unrecorded.join(", ")}.`,
  );
  for (const omission of report.coverage.omissions)
    lines.push(
      `Omitted: ${omission.kind} in session ${omission.sessionId} at sequence ${omission.sequence}${omission.count > 1 ? ` (${omission.count} events)` : ""}.`,
    );
  if (report.coverage.omissionsOmitted > 0)
    lines.push(`${plural(report.coverage.omissionsOmitted, "further omission")} not listed.`);
  if (report.sourcesOmitted > 0)
    lines.push(
      `${plural(report.sourcesOmitted, "admission")} listed more sources than they retained.`,
    );
  if (report.cancelled) lines.push("Cancelled before the window was read.");
  if (report.next !== null) lines.push(`More: continue with "after": "${report.next}".`);
  return lines;
}
