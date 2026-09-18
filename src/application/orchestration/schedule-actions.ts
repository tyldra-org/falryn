/** Shared user/model controls. Registration and inspection never start work. */
import { z } from "zod";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import {
  resolveScheduleDefaults,
  type ScheduleDefaults,
  scheduleDraftSchema,
} from "../../domain/orchestration/schedule-defaults.ts";
import {
  type ScheduleBinding,
  type ScheduleRecord,
  type ScheduleResult,
  type ScheduleStore,
  scheduleKeySchema,
  scheduleSlotId,
  scheduleSummary,
} from "../../domain/orchestration/schedule-state.ts";
import { scheduleWindow } from "../../domain/orchestration/schedule-trigger.ts";

export const SCHEDULE_OPERATIONS = [
  "validate",
  "preview",
  "create",
  "import",
  "adopt",
  "list",
  "inspect",
  "history",
  "enable",
  "pause",
  "resume",
  "update",
  "trigger-now",
  "cancel",
  "delete",
  "delete-preview",
] as const;
export const scheduleCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.enum(["validate", "preview"]),
    definition: scheduleDraftSchema,
  }),
  z.strictObject({
    operation: z.enum(["create", "import"]),
    id: scheduleKeySchema,
    definition: scheduleDraftSchema,
  }),
  z.strictObject({ operation: z.literal("list"), after: scheduleKeySchema.optional() }),
  z.strictObject({
    operation: z.enum(["inspect", "history", "delete-preview"]),
    id: scheduleKeySchema,
    after: scheduleKeySchema.optional(),
  }),
  z.strictObject({
    operation: z.enum(["adopt", "enable", "pause", "resume", "delete"]),
    id: scheduleKeySchema,
    expectedRevision: z.int().positive(),
  }),
  z.strictObject({
    operation: z.literal("update"),
    id: scheduleKeySchema,
    expectedRevision: z.int().positive(),
    definition: scheduleDraftSchema,
  }),
  z.strictObject({
    operation: z.literal("trigger-now"),
    id: scheduleKeySchema,
    expectedRevision: z.int().positive(),
    requestId: scheduleKeySchema,
  }),
  z.strictObject({
    operation: z.literal("cancel"),
    attempt: scheduleKeySchema,
    expectedRevision: z.int().positive(),
  }),
]);
export type ScheduleCommand = z.infer<typeof scheduleCommandSchema>;
export type ScheduleValidation = ScheduleResult<ScheduleBinding>;
export type ScheduleAuthority = {
  validate(record: ScheduleRecord, signal: AbortSignal): Promise<ScheduleValidation>;
};
export function createScheduleActions(options: {
  store: ScheduleStore;
  workspace: string;
  now(): number;
  authority: ScheduleAuthority;
  defaults?(): ScheduleDefaults;
}) {
  const { store, workspace } = options;
  const summary = (record: ScheduleRecord) => {
    const now = options.now();
    const next = scheduleWindow(
      record.definition.timing,
      record,
      now - 1,
      now + 32 * 86_400_000,
      1,
    );
    const latest = store.latest(workspace, record.id);
    return {
      ...scheduleSummary(record),
      lastAttempt: latest.ok ? latest.value : null,
      historyAvailability: latest.ok ? "available" : latest.error.code,
      next: next.slots[0] ?? null,
      nextSearchThrough: next.through,
    };
  };
  return {
    async execute(
      raw: unknown,
      actor: "user" | "model",
      signal: AbortSignal,
    ): Promise<ScheduleResult<Readonly<Record<string, unknown>>>> {
      const decoded = scheduleCommandSchema.safeParse(raw);
      if (!decoded.success) return { ok: false, error: { code: "invalid-command" } };
      const value = decoded.data;
      const command =
        "definition" in value
          ? {
              ...value,
              definition: resolveScheduleDefaults(
                value.definition,
                ["create", "preview", "validate"].includes(value.operation)
                  ? options.defaults?.()
                  : undefined,
              ),
            }
          : value;
      if (signal.aborted) return { ok: false, error: { code: "cancelled" } };
      if (
        actor === "model" &&
        ["enable", "resume", "trigger-now", "adopt"].includes(command.operation)
      )
        return { ok: false, error: { code: "user-action-required" } };
      const now = options.now();
      if ("definition" in command && command.operation !== "update") {
        const record: ScheduleRecord = {
          version: 1,
          id: "id" in command ? command.id : "preview",
          workspace,
          generation: 1,
          revision: 1,
          definition: command.definition,
          digest: canonicalDigest(command.definition),
          source: { kind: command.operation === "import" ? "import" : "user" },
          state: "disabled",
          binding: null,
          createdAt: now,
          anchor: now,
          cursor: now - 1,
          updatedAt: now,
          blocker: null,
          recovery: null,
        };
        if (command.operation === "create" || command.operation === "import") {
          const created = store.create(record);
          return created.ok ? ok(summary(created.value)) : created;
        }
        const valid = await options.authority.validate(record, signal);
        return ok({
          ...summary(record),
          kind: "schedule-preview",
          valid: valid.ok,
          blocker: valid.ok ? null : valid.error.code,
          executionStarted: false,
        });
      }
      if (command.operation === "list") {
        const page = store.page(workspace, command.after);
        const quarantine = store.quarantined(workspace, command.after);
        if (!quarantine.ok) return quarantine;
        return page.ok
          ? ok({
              kind: "schedules",
              entries: page.value.map(summary),
              quarantine: quarantine.value,
              nextQuarantined: quarantine.value.length === 16 ? quarantine.value.at(-1)?.id : null,
              next: page.value.at(-1)?.id ?? null,
            })
          : page;
      }
      if (command.operation === "cancel") {
        const changed = store.changeAttempt(
          workspace,
          command.attempt,
          command.expectedRevision,
          (attempt) =>
            ok({
              ...attempt,
              revision: attempt.revision + 1,
              cancelRequestedAt: attempt.cancelRequestedAt ?? now,
            }),
        );
        return changed.ok ? ok({ kind: "schedule-attempt", attempt: changed.value }) : changed;
      }
      if (!("id" in command)) return { ok: false, error: { code: "invalid-command" } };
      const read = store.get(workspace, command.id);
      if (!read.ok) return read;
      const record = read.value;
      if (command.operation === "inspect") {
        const validation = await options.authority.validate(record, signal);
        return ok({
          ...summary(record),
          availability: validation.ok ? "available" : "unavailable",
          blocker: validation.ok ? record.blocker : validation.error.code,
        });
      }
      if (command.operation === "delete-preview") {
        const attempts = store.attempts(workspace, record.id, command.after);
        return attempts.ok
          ? ok({
              ...summary(record),
              kind: "schedule-delete-preview",
              stopsNewAdmission: true,
              cancelsActiveRuns: false,
              retainsHistory: true,
              references: attempts.value.map((attempt) => ({
                attempt: attempt.id,
                task: attempt.task,
                workflow: attempt.workflow,
                result: attempt.terminal?.result ?? null,
                terminal: attempt.terminal?.status ?? null,
              })),
              next: attempts.value.length === 16 ? attempts.value.at(-1)?.id : null,
            })
          : attempts;
      }
      if (command.operation === "history") {
        const slots = store.slots(workspace, record.id, command.after);
        const attempts = store.attempts(workspace, record.id, command.after);
        if (!slots.ok) return slots;
        if (!attempts.ok) return attempts;
        return ok({
          kind: "schedule-history",
          id: record.id,
          slots: slots.value,
          attempts: attempts.value,
          nextSlots: slots.value.length === 32 ? slots.value.at(-1)?.id : null,
          nextAttempts: attempts.value.length === 16 ? attempts.value.at(-1)?.id : null,
        });
      }
      if (!("expectedRevision" in command))
        return { ok: false, error: { code: "invalid-command" } };
      if (command.operation === "trigger-now") {
        const id = scheduleSlotId(record.id, record.generation, `manual:${command.requestId}`);
        const prior = store.slot(workspace, id);
        if (prior.ok)
          return ok({
            kind: "schedule-queued",
            slot: id,
            recovered: true,
            disposition: prior.value.disposition,
            schedule: summary(record),
          });
        if (prior.error.code !== "not-found") return prior;
      }
      if (record.revision !== command.expectedRevision)
        return { ok: false, error: { code: "stale-revision", currentRevision: record.revision } };
      if (command.operation === "trigger-now") {
        if (record.state !== "enabled") return { ok: false, error: { code: "not-enabled" } };
        const valid = await options.authority.validate(record, signal);
        if (!valid.ok) return valid;
        if (canonicalDigest(valid.value) !== canonicalDigest(record.binding))
          return { ok: false, error: { code: "authority-changed" } };
        const id = scheduleSlotId(record.id, record.generation, `manual:${command.requestId}`);
        const saved = store.decide(record, record.cursor, [
          {
            id,
            schedule: record.id,
            generation: record.generation,
            kind: "manual",
            nominal: now,
            eligible: now,
            disposition: "pending",
            through: null,
          },
        ]);
        return saved.ok
          ? ok({ kind: "schedule-queued", slot: id, schedule: summary(saved.value) })
          : saved;
      }
      let binding = record.binding;
      if (command.operation === "enable" || command.operation === "resume") {
        if (record.source.kind === "import")
          return { ok: false, error: { code: "adoption-required" } };
        if (command.operation === "resume" && record.state !== "paused")
          return { ok: false, error: { code: "not-paused" } };
        const valid = await options.authority.validate(record, signal);
        if (!valid.ok) return valid;
        if (binding && canonicalDigest(valid.value) !== canonicalDigest(binding))
          return { ok: false, error: { code: "authority-changed" } };
        binding = valid.value;
      }
      if (command.operation === "pause" && record.state !== "enabled")
        return { ok: false, error: { code: "not-enabled" } };
      if (command.operation === "adopt" && record.source.kind !== "import")
        return { ok: false, error: { code: "not-imported" } };
      const changed = store.change(workspace, record.id, command.expectedRevision, (prior) => {
        const base = { ...prior, revision: prior.revision + 1, updatedAt: now, blocker: null };
        switch (command.operation) {
          case "enable":
          case "resume":
            return ok({
              ...base,
              state: "enabled",
              binding,
              recovery: {
                through: now - 1,
                remaining:
                  prior.definition.missed.kind === "bounded-all"
                    ? prior.definition.missed.maxCatchUpRuns
                    : 1,
              },
            });
          case "pause":
            return ok({ ...base, state: "paused" });
          case "delete":
            return ok({ ...base, state: "deleted" });
          case "adopt":
            return ok({
              ...base,
              generation: prior.generation + 1,
              source: { kind: "user" },
              state: "disabled",
              binding: null,
              anchor: now,
              cursor: now - 1,
            });
          case "update":
            return ok({
              ...base,
              generation: prior.generation + 1,
              definition: command.definition,
              digest: canonicalDigest(command.definition),
              state: "disabled",
              binding: null,
              anchor: now,
              cursor: now - 1,
            });
          default:
            return { ok: false, error: { code: "invalid-command" } };
        }
      });
      return changed.ok ? ok(summary(changed.value)) : changed;
    },
  };
}
export type ScheduleActions = ReturnType<typeof createScheduleActions>;
