/** Transactions own occurrence uniqueness and fencing, including independent Falryn hosts. */
import type { z } from "zod";
import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  SCHEDULE_LIMITS,
  type ScheduleAttempt,
  type ScheduleRecord,
  type ScheduleResult,
  type ScheduleSlotRecord,
  type ScheduleStore,
  scheduleAttemptSchema,
  scheduleRecordSchema,
  scheduleSlotSchema,
} from "../../domain/orchestration/schedule-state.ts";
import type { Migration, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";

export const SCHEDULE_TABLES = [
  "schedule_definitions",
  "schedule_generations",
  "schedule_slots",
  "schedule_occurrences",
  "schedule_attempts",
  "schedule_notifications",
  "schedule_artifacts",
  "schedule_quarantine",
] as const;
export const MIGRATION_0030: Migration = {
  version: 30,
  name: "durable-schedules",
  destructive: false,
  statements: [
    "CREATE TABLE schedule_quarantine (workspace TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(workspace,id)) STRICT",
    "CREATE TABLE schedule_definitions (workspace TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(workspace,id)) STRICT",
    "CREATE TABLE schedule_generations (workspace TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(workspace,id,generation),FOREIGN KEY(workspace,id) REFERENCES schedule_definitions(workspace,id)) STRICT",
    "CREATE TABLE schedule_slots (workspace TEXT NOT NULL,id TEXT NOT NULL,schedule TEXT NOT NULL,generation INTEGER NOT NULL,kind TEXT NOT NULL,nominal INTEGER NOT NULL,eligible INTEGER NOT NULL,disposition TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(workspace,id),UNIQUE(workspace,schedule,generation,kind,nominal,id),FOREIGN KEY(workspace,schedule,generation) REFERENCES schedule_generations(workspace,id,generation)) STRICT",
    "CREATE UNIQUE INDEX schedule_nominal_identity ON schedule_slots(workspace,schedule,generation,nominal) WHERE kind='nominal'",
    "CREATE INDEX schedule_due ON schedule_slots(workspace,disposition,nominal,id,eligible)",
    "CREATE INDEX schedule_history ON schedule_slots(workspace,schedule,id)",
    "CREATE TABLE schedule_occurrences (workspace TEXT NOT NULL,slot TEXT NOT NULL,attempt TEXT NOT NULL UNIQUE,PRIMARY KEY(workspace,slot),FOREIGN KEY(workspace,slot) REFERENCES schedule_slots(workspace,id)) STRICT",
    "CREATE TABLE schedule_attempts (workspace TEXT NOT NULL,id TEXT NOT NULL,schedule TEXT NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,admitted_at INTEGER NOT NULL,terminal INTEGER NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(workspace,id),FOREIGN KEY(id) REFERENCES schedule_occurrences(attempt)) STRICT",
    "CREATE INDEX schedule_latest ON schedule_attempts(workspace,schedule,admitted_at DESC,id DESC)",
    "CREATE INDEX schedule_recovery ON schedule_attempts(workspace,terminal,id)",
    "CREATE INDEX schedule_active ON schedule_attempts(workspace,schedule,terminal,id)",
    "CREATE TABLE schedule_artifacts (workspace TEXT NOT NULL,attempt TEXT NOT NULL,artifact_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(workspace,attempt,artifact_id),FOREIGN KEY(workspace,attempt) REFERENCES schedule_attempts(workspace,id)) STRICT",
    "CREATE TABLE schedule_notifications (workspace TEXT NOT NULL,attempt TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace,attempt),FOREIGN KEY(workspace,attempt) REFERENCES schedule_attempts(workspace,id)) STRICT",
  ],
};

export function createScheduleStore(store: SqliteStorePort): ScheduleStore {
  function write<T>(run: (sql: SqliteStatements) => ScheduleResult<T>): ScheduleResult<T> {
    const result = store.write(run);
    return result.ok
      ? result.value.value
      : err({
          code:
            result.error.effect === "uncertain"
              ? "recovery-required"
              : `storage-${result.error.code}`,
        });
  }
  function decode<T>(
    row: Readonly<Record<string, unknown>> | undefined,
    schema: z.ZodType<T>,
  ): ScheduleResult<T> {
    if (!row) return err({ code: "not-found" });
    try {
      if (
        typeof row.record !== "string" ||
        Buffer.byteLength(row.record) > SCHEDULE_LIMITS.definitionBytes + 8192
      )
        return err({ code: "corrupt" });
      const parsed = schema.safeParse(JSON.parse(row.record));
      if (!parsed.success || canonicalDigest(parsed.data) !== row.digest)
        return err({ code: "corrupt" });
      const value = parsed.data as Readonly<Record<string, unknown>>;
      for (const key of [
        "id",
        "workspace",
        "schedule",
        "generation",
        "revision",
        "state",
        "kind",
        "nominal",
        "eligible",
        "disposition",
      ]) {
        if (key in row && key in value && row[key] !== value[key]) return err({ code: "corrupt" });
      }
      if (
        ("terminal" in row && row.terminal !== Number(value.terminal !== null)) ||
        ("admitted_at" in row && row.admitted_at !== value.admittedAt)
      )
        return err({ code: "corrupt" });
      return ok(parsed.data);
    } catch {
      return err({ code: "corrupt" });
    }
  }
  function load(
    sql: SqliteStatements,
    workspace: string,
    id: string,
    generation?: number,
  ): ScheduleResult<ScheduleRecord> {
    if (
      sql.all("SELECT id FROM schedule_quarantine WHERE workspace=$workspace AND id=$id", {
        workspace,
        id,
      }).length
    )
      return err({ code: "quarantined" });
    const row = sql.all(
      generation === undefined
        ? "SELECT g.* FROM schedule_generations g JOIN schedule_definitions d USING(workspace,id,generation) WHERE g.workspace=$workspace AND g.id=$id"
        : "SELECT * FROM schedule_generations WHERE workspace=$workspace AND id=$id AND generation=$generation",
      { workspace, id, ...(generation === undefined ? {} : { generation }) },
    )[0];
    const read = decode(row, scheduleRecordSchema);
    const valid =
      read.ok &&
      read.value.workspace === workspace &&
      read.value.id === id &&
      canonicalDigest(read.value.definition) === read.value.digest;
    if (!valid && row) {
      sql.run(
        "INSERT OR REPLACE INTO schedule_quarantine(workspace,id,generation,reason) VALUES($workspace,$id,$generation,'corrupt')",
        { workspace, id, generation: Number(row.generation) },
      );
      sql.run(
        "UPDATE schedule_definitions SET state='quarantined' WHERE workspace=$workspace AND id=$id",
        { workspace, id },
      );
    }
    return read.ok && !valid ? err({ code: "corrupt" }) : read;
  }

  function save(sql: SqliteStatements, record: ScheduleRecord) {
    sql.run(
      "INSERT INTO schedule_generations(workspace,id,generation,record,digest) VALUES($workspace,$id,$generation,$record,$digest) ON CONFLICT(workspace,id,generation) DO UPDATE SET record=excluded.record,digest=excluded.digest",
      {
        workspace: record.workspace,
        id: record.id,
        generation: record.generation,
        record: canonicalJson(record),
        digest: canonicalDigest(record),
      },
    );
    sql.run(
      "UPDATE schedule_definitions SET generation=$generation,revision=$revision,state=$state WHERE workspace=$workspace AND id=$id",
      {
        workspace: record.workspace,
        id: record.id,
        generation: record.generation,
        revision: record.revision,
        state: record.state,
      },
    );
  }
  function saveSlot(sql: SqliteStatements, workspace: string, slot: ScheduleSlotRecord) {
    sql.run(
      "INSERT INTO schedule_slots(workspace,id,schedule,generation,kind,nominal,eligible,disposition,record,digest) VALUES($workspace,$id,$schedule,$generation,$kind,$nominal,$eligible,$disposition,$record,$digest) ON CONFLICT(workspace,id) DO UPDATE SET disposition=excluded.disposition,record=excluded.record,digest=excluded.digest",
      {
        workspace,
        id: slot.id,
        schedule: slot.schedule,
        generation: slot.generation,
        kind: slot.kind,
        nominal: slot.nominal,
        eligible: slot.eligible,
        disposition: slot.disposition,
        record: canonicalJson(slot),
        digest: canonicalDigest(slot),
      },
    );
  }
  function readAttempt(sql: SqliteStatements, workspace: string, id: string) {
    return decode(
      sql.all("SELECT * FROM schedule_attempts WHERE workspace=$workspace AND id=$id", {
        workspace,
        id,
      })[0],
      scheduleAttemptSchema,
    );
  }
  function saveAttempt(sql: SqliteStatements, workspace: string, attempt: ScheduleAttempt) {
    sql.run(
      "INSERT INTO schedule_attempts(workspace,id,schedule,generation,revision,admitted_at,terminal,record,digest) VALUES($workspace,$id,$schedule,$generation,$revision,$admittedAt,$terminal,$record,$digest) ON CONFLICT(workspace,id) DO UPDATE SET revision=excluded.revision,terminal=excluded.terminal,record=excluded.record,digest=excluded.digest",
      {
        workspace,
        id: attempt.id,
        schedule: attempt.schedule,
        generation: attempt.generation,
        revision: attempt.revision,
        admittedAt: attempt.admittedAt,
        terminal: Number(attempt.terminal !== null),
        record: canonicalJson(attempt),
        digest: canonicalDigest(attempt),
      },
    );
    if (attempt.terminal?.effect === "uncertain" || attempt.terminal?.status === "uncertain") {
      const current = load(sql, workspace, attempt.schedule);
      if (current.ok && current.value.state === "enabled")
        save(sql, {
          ...current.value,
          revision: current.value.revision + 1,
          state: "paused",
          blocker: "uncertain-attempt-inspect-before-resume",
        });
    }
    if (attempt.terminal?.result)
      sql.run(
        "INSERT OR IGNORE INTO schedule_artifacts(workspace,attempt,artifact_id,digest) VALUES($workspace,$attempt,$artifact,$digest)",
        {
          workspace,
          attempt: attempt.id,
          artifact: attempt.terminal.result.artifactId,
          digest: attempt.terminal.result.digest,
        },
      );
    if (attempt.terminal)
      sql.run(
        "INSERT OR IGNORE INTO schedule_notifications(workspace,attempt) VALUES($workspace,$id)",
        { workspace, id: attempt.id },
      );
  }
  function page<T>(
    rows: readonly Readonly<Record<string, unknown>>[],
    schema: z.ZodType<T>,
  ): ScheduleResult<readonly T[]> {
    const values: T[] = [];
    for (const row of rows) {
      const value = decode(row, schema);
      if (!value.ok) return value;
      values.push(value.value);
    }
    return ok(values);
  }
  function runnablePage<T>(
    sql: SqliteStatements,
    workspace: string,
    rows: readonly Readonly<Record<string, unknown>>[],
    schema: z.ZodType<T>,
  ): ScheduleResult<readonly T[]> {
    const values: T[] = [];
    for (const row of rows) {
      const decoded = decode(row, schema);
      if (decoded.ok) values.push(decoded.value);
      else {
        sql.run(
          "INSERT OR REPLACE INTO schedule_quarantine(workspace,id,generation,reason) VALUES($workspace,$id,$generation,'corrupt-history')",
          { workspace, id: String(row.schedule), generation: Number(row.generation) },
        );
        sql.run(
          "UPDATE schedule_definitions SET state='quarantined' WHERE workspace=$workspace AND id=$id",
          { workspace, id: String(row.schedule) },
        );
      }
    }
    return ok(values);
  }
  return {
    create(record) {
      if (
        !scheduleRecordSchema.safeParse(record).success ||
        record.generation !== 1 ||
        record.revision !== 1 ||
        record.state !== "disabled" ||
        record.binding !== null ||
        canonicalDigest(record.definition) !== record.digest
      )
        return err({ code: "invalid-record" });
      return write((sql) => {
        const prior = load(sql, record.workspace, record.id);
        if (prior.ok) {
          // Native publication reattaches the original declaration. Explicit user
          // edits keep their own generation and must not erase that registration.
          const registered =
            record.source.kind === "package" && prior.value.generation > 1
              ? load(sql, record.workspace, record.id, 1)
              : prior;
          return registered.ok &&
            registered.value.digest === record.digest &&
            canonicalDigest(registered.value.source) === canonicalDigest(record.source)
            ? prior
            : err({ code: "conflicting-identity" });
        }
        if (prior.error.code !== "not-found") return prior;
        sql.run(
          "INSERT INTO schedule_definitions(workspace,id,generation,revision,state) VALUES($workspace,$id,1,1,'disabled')",
          { workspace: record.workspace, id: record.id },
        );
        save(sql, record);
        return ok(record);
      });
    },
    get: (workspace, id, generation) => write((sql) => load(sql, workspace, id, generation)),
    change(workspace, id, expectedRevision, update) {
      return write((sql) => {
        const prior = load(sql, workspace, id);
        if (!prior.ok) return prior;
        if (prior.value.revision !== expectedRevision)
          return err({ code: "stale-revision", currentRevision: prior.value.revision });
        if (prior.value.state === "deleted") return err({ code: "deleted" });
        const next = update(prior.value);
        if (!next.ok) return next;
        const value = next.value;
        const changed = value.generation === prior.value.generation + 1;
        if (
          !scheduleRecordSchema.safeParse(value).success ||
          value.id !== id ||
          value.workspace !== workspace ||
          value.createdAt !== prior.value.createdAt ||
          value.revision !== expectedRevision + 1 ||
          value.updatedAt < prior.value.updatedAt ||
          canonicalDigest(value.definition) !== value.digest ||
          (!changed &&
            (value.generation !== prior.value.generation ||
              value.digest !== prior.value.digest ||
              canonicalDigest(value.source) !== canonicalDigest(prior.value.source))) ||
          (changed && (value.state !== "disabled" || value.binding !== null)) ||
          (["enabled", "paused"].includes(value.state) && value.binding === null)
        )
          return err({ code: "invalid-transition" });
        save(sql, value);
        if (changed || value.state === "deleted") {
          // Pending old slots remain evidence but can never regain admission.
          const rows = sql.all(
            "SELECT * FROM schedule_slots WHERE workspace=$workspace AND schedule=$id AND disposition='pending' LIMIT 32",
            { workspace, id },
          );
          for (const row of rows) {
            const slot = decode(row, scheduleSlotSchema);
            if (!slot.ok) throw new Error("schedule-corrupt");
            saveSlot(sql, workspace, { ...slot.value, disposition: "superseded" });
          }
        }
        return next;
      });
    },
    retire: (workspace) =>
      write((sql) => {
        const rows = sql.all(
          "SELECT s.* FROM schedule_slots s JOIN schedule_definitions d ON d.workspace=s.workspace AND d.id=s.schedule WHERE s.workspace=$workspace AND s.disposition='pending' AND (s.generation<>d.generation OR d.state='deleted') ORDER BY s.id LIMIT 32",
          { workspace },
        );
        const decoded = runnablePage(sql, workspace, rows, scheduleSlotSchema);
        if (!decoded.ok) return decoded;
        for (const slot of decoded.value)
          saveSlot(sql, workspace, { ...slot, disposition: "superseded" });
        return ok(decoded.value.length);
      }),
    quarantined: (workspace, after = "") =>
      write((sql) =>
        ok(
          sql
            .all(
              "SELECT id,generation,reason FROM schedule_quarantine WHERE workspace=$workspace AND id>$after ORDER BY id LIMIT 16",
              { workspace, after },
            )
            .map((row) => ({
              id: String(row.id),
              generation: Number(row.generation),
              reason: String(row.reason),
            })),
        ),
      ),
    page: (workspace, after = "") =>
      write((sql) => {
        const records: ScheduleRecord[] = [];
        // One bounded batch may quarantine bad definitions; the next wake continues
        // through healthy records without treating corruption as executable intent.
        const rows = sql.all(
          "SELECT d.id FROM schedule_definitions d WHERE d.workspace=$workspace AND d.id>$after AND d.state<>'quarantined' ORDER BY d.id LIMIT 16",
          { workspace, after },
        );
        for (const row of rows) {
          const read = load(sql, workspace, String(row.id));
          if (read.ok) records.push(read.value);
          else if (!["corrupt", "quarantined"].includes(read.error.code)) return read;
        }
        return ok(records);
      }),
    slot: (workspace, id) =>
      write((sql) =>
        decode(
          sql.all("SELECT * FROM schedule_slots WHERE workspace=$workspace AND id=$id", {
            workspace,
            id,
          })[0],
          scheduleSlotSchema,
        ),
      ),
    slots: (workspace, id, after = "") =>
      write((sql) =>
        page(
          sql.all(
            "SELECT * FROM schedule_slots WHERE workspace=$workspace AND schedule=$id AND id>$after ORDER BY id LIMIT 32",
            { workspace, id, after },
          ),
          scheduleSlotSchema,
        ),
      ),
    decide(record, through, slots, recovery = record.recovery) {
      if (
        slots.length > SCHEDULE_LIMITS.slots ||
        through < record.cursor ||
        slots.some(
          (slot) =>
            !scheduleSlotSchema.safeParse(slot).success ||
            slot.schedule !== record.id ||
            slot.generation !== record.generation,
        )
      )
        return err({ code: "invalid-slots" });
      return write((sql) => {
        const current = load(sql, record.workspace, record.id);
        if (!current.ok) return current;
        if (
          current.value.revision !== record.revision ||
          current.value.state !== "enabled" ||
          current.value.cursor !== record.cursor ||
          canonicalDigest(current.value.recovery) !== canonicalDigest(record.recovery)
        )
          return err({ code: "stale-revision" });
        const additions: ScheduleSlotRecord[] = [];
        for (const slot of slots) {
          const prior = decode(
            sql.all("SELECT * FROM schedule_slots WHERE workspace=$workspace AND id=$id", {
              workspace: record.workspace,
              id: slot.id,
            })[0],
            scheduleSlotSchema,
          );
          if (prior.ok) {
            if (
              prior.value.schedule !== slot.schedule ||
              prior.value.generation !== slot.generation ||
              (slot.kind !== "manual" && prior.value.nominal !== slot.nominal) ||
              prior.value.kind !== slot.kind
            )
              return err({ code: "conflicting-slot" });
          } else {
            if (prior.error.code !== "not-found") return prior;
            additions.push(slot);
          }
        }
        // Coalescing is part of the decision transaction, so competing hosts
        // never observe two queued occurrences for queue-latest.
        if (record.definition.overlap.kind === "queue-latest") {
          const queued = page(
            sql.all(
              "SELECT * FROM schedule_slots WHERE workspace=$workspace AND schedule=$id AND generation=$generation AND disposition='pending' LIMIT 32",
              { workspace: record.workspace, id: record.id, generation: record.generation },
            ),
            scheduleSlotSchema,
          );
          if (!queued.ok) return queued;
          const candidates = [
            ...queued.value,
            ...additions.filter((slot) => slot.disposition === "pending"),
          ];
          const latest = candidates.sort(
            (a, b) => b.nominal - a.nominal || b.id.localeCompare(a.id),
          )[0];
          for (const slot of queued.value)
            if (slot.id !== latest?.id)
              saveSlot(sql, record.workspace, { ...slot, disposition: "coalesced" });
          for (const slot of additions)
            saveSlot(
              sql,
              record.workspace,
              slot.disposition === "pending" && slot.id !== latest?.id
                ? { ...slot, disposition: "coalesced" }
                : slot,
            );
        } else for (const slot of additions) saveSlot(sql, record.workspace, slot);
        const next = {
          ...current.value,
          cursor: through,
          recovery,
          // Wake progress has its own cursor/recovery fence; it does not invalidate
          // a user's unchanged definition revision between inspection and control.
          revision: current.value.revision,
        };
        save(sql, next);
        return ok(next);
      });
    },
    pending(workspace, now, after = "") {
      const separator = after.indexOf(":");
      const nominal = after === "" ? -1 : Number(after.slice(0, separator));
      const id = after === "" ? "" : after.slice(separator + 1);
      if (
        !Number.isSafeInteger(nominal) ||
        nominal < -1 ||
        id.length > 128 ||
        (after !== "" && separator < 1)
      )
        return err({ code: "invalid-cursor" });
      return write((sql) =>
        runnablePage(
          sql,
          workspace,
          sql.all(
            "SELECT s.* FROM schedule_slots s JOIN schedule_definitions d ON d.workspace=s.workspace AND d.id=s.schedule AND d.generation=s.generation WHERE s.workspace=$workspace AND s.disposition='pending' AND s.eligible<=$now AND (s.nominal>$nominal OR (s.nominal=$nominal AND s.id>$id)) AND d.state='enabled' ORDER BY s.nominal,s.id LIMIT 16",
            { workspace, now, nominal, id },
          ),
          scheduleSlotSchema,
        ),
      );
    },
    claim(record, slot, attempt) {
      if (
        !scheduleAttemptSchema.safeParse(attempt).success ||
        attempt.slot !== slot.id ||
        attempt.schedule !== record.id ||
        attempt.generation !== record.generation ||
        attempt.revision !== 1 ||
        attempt.terminal !== null ||
        attempt.task !== null ||
        attempt.workflow !== null ||
        attempt.admittedAt < slot.eligible ||
        attempt.deadline <= attempt.admittedAt
      )
        return err({ code: "invalid-attempt" });
      return write((sql) => {
        const current = load(sql, record.workspace, record.id);
        if (!current.ok) return current;
        if (
          current.value.revision !== record.revision ||
          current.value.generation !== slot.generation ||
          current.value.state !== "enabled" ||
          !current.value.binding
        )
          return err({ code: "stale-revision" });
        const stored = decode(
          sql.all("SELECT * FROM schedule_slots WHERE workspace=$workspace AND id=$id", {
            workspace: record.workspace,
            id: slot.id,
          })[0],
          scheduleSlotSchema,
        );
        if (!stored.ok) return stored;
        if (stored.value.disposition !== "pending") return ok(null);
        if (canonicalDigest(stored.value) !== canonicalDigest(slot))
          return err({ code: "stale-slot" });
        const active = sql.all(
          "SELECT id FROM schedule_attempts WHERE workspace=$workspace AND schedule=$id AND terminal=0 LIMIT 4",
          { workspace: record.workspace, id: record.id },
        ).length;
        const overlap = record.definition.overlap;
        if (active >= (overlap.kind === "parallel" ? overlap.limit : 1)) {
          if (overlap.kind === "skip")
            saveSlot(sql, record.workspace, { ...stored.value, disposition: "skipped-overlap" });
          else if (overlap.kind === "queue-latest") {
            const newer = sql.all(
              "SELECT id FROM schedule_slots WHERE workspace=$workspace AND schedule=$id AND disposition='pending' AND nominal>$nominal LIMIT 1",
              { workspace: record.workspace, id: record.id, nominal: slot.nominal },
            );
            if (newer.length)
              saveSlot(sql, record.workspace, { ...stored.value, disposition: "coalesced" });
          }
          return ok(null);
        }
        sql.run(
          "INSERT INTO schedule_occurrences(workspace,slot,attempt) VALUES($workspace,$slot,$attempt)",
          { workspace: record.workspace, slot: slot.id, attempt: attempt.id },
        );
        saveAttempt(sql, record.workspace, attempt);
        saveSlot(sql, record.workspace, { ...stored.value, disposition: "admitted" });
        return ok(attempt);
      });
    },
    attempt: (workspace, id) => write((sql) => readAttempt(sql, workspace, id)),
    latest: (workspace, schedule) =>
      write((sql) => {
        const row = sql.all(
          "SELECT * FROM schedule_attempts WHERE workspace=$workspace AND schedule=$schedule ORDER BY admitted_at DESC,id DESC LIMIT 1",
          { workspace, schedule },
        )[0];
        return row ? decode(row, scheduleAttemptSchema) : ok(null);
      }),
    active: (workspace, after = "") =>
      write((sql) =>
        runnablePage(
          sql,
          workspace,
          sql.all(
            "SELECT a.* FROM schedule_attempts a JOIN schedule_definitions d ON d.workspace=a.workspace AND d.id=a.schedule WHERE a.workspace=$workspace AND a.terminal=0 AND a.id>$after AND d.state<>'quarantined' ORDER BY a.id LIMIT 16",
            { workspace, after },
          ),
          scheduleAttemptSchema,
        ),
      ),
    attempts: (workspace, schedule, after = "") =>
      write((sql) =>
        page(
          sql.all(
            `SELECT * FROM schedule_attempts WHERE workspace=$workspace AND id>$after${schedule === undefined ? "" : " AND schedule=$schedule"} ORDER BY id LIMIT 16`,
            { workspace, after, ...(schedule === undefined ? {} : { schedule }) },
          ),
          scheduleAttemptSchema,
        ),
      ),
    changeAttempt(workspace, id, expectedRevision, update) {
      return write((sql) => {
        const prior = readAttempt(sql, workspace, id);
        if (!prior.ok) return prior;
        if (prior.value.revision !== expectedRevision)
          return err({ code: "stale-revision", currentRevision: prior.value.revision });
        if (prior.value.terminal) return prior;
        const next = update(prior.value);
        if (!next.ok) return next;
        const {
          revision: _r,
          task: _t,
          workflow: _w,
          cancelRequestedAt: _cr,
          cancelAcknowledgedAt: _ca,
          terminal: _e,
          ...before
        } = prior.value;
        const {
          revision: _nr,
          task: _nt,
          workflow: _nw,
          cancelRequestedAt: _ncr,
          cancelAcknowledgedAt: _nca,
          terminal: _ne,
          ...after
        } = next.value;
        if (
          !scheduleAttemptSchema.safeParse(next.value).success ||
          canonicalDigest(before) !== canonicalDigest(after) ||
          next.value.revision !== expectedRevision + 1 ||
          (prior.value.task &&
            canonicalDigest(prior.value.task) !== canonicalDigest(next.value.task)) ||
          (prior.value.workflow &&
            canonicalDigest(prior.value.workflow) !== canonicalDigest(next.value.workflow)) ||
          (prior.value.cancelRequestedAt !== null &&
            next.value.cancelRequestedAt !== prior.value.cancelRequestedAt) ||
          (prior.value.cancelAcknowledgedAt !== null &&
            next.value.cancelAcknowledgedAt !== prior.value.cancelAcknowledgedAt)
        )
          return err({ code: "invalid-transition" });
        saveAttempt(sql, workspace, next.value);
        return next;
      });
    },
    notifications: (workspace, after = "") =>
      write((sql) =>
        runnablePage(
          sql,
          workspace,
          sql.all(
            "SELECT a.* FROM schedule_notifications n JOIN schedule_attempts a ON a.workspace=n.workspace AND a.id=n.attempt JOIN schedule_definitions d ON d.workspace=a.workspace AND d.id=a.schedule WHERE d.state<>'quarantined' AND n.workspace=$workspace AND n.acknowledged=0 AND n.attempt>$after ORDER BY n.attempt LIMIT 16",
            { workspace, after },
          ),
          scheduleAttemptSchema,
        ),
      ),
    acknowledge: (workspace, id) =>
      write((sql) => {
        sql.run(
          "UPDATE schedule_notifications SET acknowledged=1 WHERE workspace=$workspace AND attempt=$id",
          { workspace, id },
        );
        return ok(null);
      }),
  };
}
