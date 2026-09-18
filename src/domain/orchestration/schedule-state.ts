/** Durable schedule intent, occurrence evidence and the storage boundary. */
import { z } from "zod";
import { canonicalDigest, canonicalJson } from "../extensions/canonical.ts";
import { digestSchema, identityText } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";
import { processBirthIdentitySchema } from "../process/process-identity.ts";
import { processTaskArtifactSchema, processTaskHandleSchema } from "./process-task.ts";
import { scheduleTimingSchema } from "./schedule-trigger.ts";
import { workflowDefinitionSchema } from "./workflow-definition.ts";
import { workflowHandleSchema } from "./workflow-state.ts";

export const SCHEDULE_LIMITS = Object.freeze({
  page: 16,
  slots: 32,
  inputBytes: 65_536,
  definitionBytes: 1_114_112,
  lookbackMs: 30 * 86_400_000,
});
export const scheduleKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
export const scheduleDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    timing: scheduleTimingSchema,
    target: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("action"),
        capability: identityText,
        input: z.record(z.string(), z.json()),
      }),
      z.strictObject({
        kind: z.literal("workflow"),
        definition: workflowDefinitionSchema,
        arguments: z.json(),
      }),
    ]),
    overlap: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("skip") }),
        z.strictObject({ kind: z.literal("queue-latest") }),
        z.strictObject({ kind: z.literal("parallel"), limit: z.int().min(1).max(4) }),
      ])
      .default({ kind: "skip" }),
    missed: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("none") }),
        z.strictObject({ kind: z.literal("latest") }),
        z.strictObject({ kind: z.literal("bounded-all"), maxCatchUpRuns: z.int().min(1).max(32) }),
      ])
      .default({ kind: "none" }),
    lookbackMs: z.int().min(1000).max(SCHEDULE_LIMITS.lookbackMs).default(86_400_000),
  })
  .superRefine((value, context) => {
    const input = value.target.kind === "action" ? value.target.input : value.target.arguments;
    if (
      Buffer.byteLength(canonicalJson(input)) > SCHEDULE_LIMITS.inputBytes ||
      Buffer.byteLength(canonicalJson(value)) > SCHEDULE_LIMITS.definitionBytes
    )
      context.addIssue({ code: "custom", message: "schedule-byte-limit" });
  });
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;
export const scheduleBindingSchema = z.strictObject({
  descriptor: digestSchema,
  authority: digestSchema,
  configuration: digestSchema,
  configurationGeneration: z.int().nonnegative(),
  timezoneData: z.string().min(1).max(128),
});
export type ScheduleBinding = z.infer<typeof scheduleBindingSchema>;
export const scheduleSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({
    kind: z.literal("package"),
    contribution: identityText,
    digest: digestSchema,
    scope: digestSchema,
    effects: z.array(z.enum(["observation", "mutation", "external", "interactive"])).max(4),
  }),
  z.strictObject({ kind: z.literal("import") }),
]);
export const scheduleRecordSchema = z.strictObject({
  version: z.literal(1),
  id: scheduleKeySchema,
  workspace: identityText,
  generation: z.int().positive(),
  revision: z.int().positive(),
  definition: scheduleDefinitionSchema,
  digest: digestSchema,
  source: scheduleSourceSchema,
  state: z.enum(["disabled", "enabled", "paused", "deleted"]),
  binding: scheduleBindingSchema.nullable(),
  createdAt: z.int().nonnegative(),
  anchor: z.int().nonnegative(),
  cursor: z.int().min(-1),
  updatedAt: z.int().nonnegative(),
  recovery: z
    .strictObject({ through: z.int().nonnegative(), remaining: z.int().min(0).max(32) })
    .nullable(),
  blocker: z
    .string()
    .regex(/^[a-z0-9-]{1,128}$/u)
    .nullable(),
});
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;
export const scheduleSlotSchema = z.strictObject({
  id: scheduleKeySchema,
  schedule: scheduleKeySchema,
  generation: z.int().positive(),
  kind: z.enum(["nominal", "manual", "gap", "lookback"]),
  nominal: z.int().nonnegative(),
  eligible: z.int().nonnegative(),
  disposition: z.enum([
    "pending",
    "admitted",
    "missed",
    "coalesced",
    "superseded",
    "over-limit",
    "skipped-overlap",
  ]),
  through: z.int().nonnegative().nullable(),
  count: z.int().positive().max(1440).optional(),
});
export type ScheduleSlotRecord = z.infer<typeof scheduleSlotSchema>;
export const scheduleTerminalSchema = z.strictObject({
  status: z.enum([
    "succeeded",
    "failed",
    "denied",
    "unavailable",
    "cancelled",
    "timed-out",
    "uncertain",
    "partial",
  ]),
  effect: z.enum(["none", "completed", "partial", "uncertain"]),
  reason: z.string().regex(/^[a-z0-9-]{1,128}$/u),
  result: processTaskArtifactSchema.nullable(),
  at: z.int().nonnegative(),
});
export type ScheduleTerminal = z.infer<typeof scheduleTerminalSchema>;
export const scheduleAttemptSchema = z.strictObject({
  id: scheduleKeySchema,
  slot: scheduleKeySchema,
  schedule: scheduleKeySchema,
  generation: z.int().positive(),
  revision: z.int().positive(),
  host: identityText,
  process: processBirthIdentitySchema,
  admittedAt: z.int().nonnegative(),
  deadline: z.int().nonnegative(),
  task: processTaskHandleSchema.nullable(),
  workflow: workflowHandleSchema.nullable(),
  cancelRequestedAt: z.int().nonnegative().nullable(),
  cancelAcknowledgedAt: z.int().nonnegative().nullable(),
  terminal: scheduleTerminalSchema.nullable(),
});
export type ScheduleAttempt = z.infer<typeof scheduleAttemptSchema>;
export type ScheduleError = { code: string; currentRevision?: number };
export type ScheduleResult<T> = Result<T, ScheduleError>;
export type ScheduleStore = {
  create(record: ScheduleRecord): ScheduleResult<ScheduleRecord>;
  get(workspace: string, id: string, generation?: number): ScheduleResult<ScheduleRecord>;
  change(
    workspace: string,
    id: string,
    expectedRevision: number,
    update: (prior: ScheduleRecord) => ScheduleResult<ScheduleRecord>,
  ): ScheduleResult<ScheduleRecord>;
  quarantined(
    workspace: string,
    after?: string,
  ): ScheduleResult<readonly { id: string; generation: number; reason: string }[]>;
  retire(workspace: string): ScheduleResult<number>;
  page(workspace: string, after?: string): ScheduleResult<readonly ScheduleRecord[]>;
  slot(workspace: string, id: string): ScheduleResult<ScheduleSlotRecord>;
  slots(
    workspace: string,
    id: string,
    after?: string,
  ): ScheduleResult<readonly ScheduleSlotRecord[]>;
  decide(
    record: ScheduleRecord,
    through: number,
    slots: readonly ScheduleSlotRecord[],
    recovery?: ScheduleRecord["recovery"],
  ): ScheduleResult<ScheduleRecord>;
  pending(
    workspace: string,
    now: number,
    after?: string,
  ): ScheduleResult<readonly ScheduleSlotRecord[]>;
  claim(
    record: ScheduleRecord,
    slot: ScheduleSlotRecord,
    attempt: ScheduleAttempt,
  ): ScheduleResult<ScheduleAttempt | null>;
  attempt(workspace: string, id: string): ScheduleResult<ScheduleAttempt>;
  latest(workspace: string, schedule: string): ScheduleResult<ScheduleAttempt | null>;
  active(workspace: string, after?: string): ScheduleResult<readonly ScheduleAttempt[]>;
  attempts(
    workspace: string,
    schedule?: string,
    after?: string,
  ): ScheduleResult<readonly ScheduleAttempt[]>;
  changeAttempt(
    workspace: string,
    id: string,
    expectedRevision: number,
    update: (prior: ScheduleAttempt) => ScheduleResult<ScheduleAttempt>,
  ): ScheduleResult<ScheduleAttempt>;
  notifications(workspace: string, after?: string): ScheduleResult<readonly ScheduleAttempt[]>;
  acknowledge(workspace: string, id: string): ScheduleResult<null>;
};
export function scheduleSlotId(id: string, generation: number, nominal: number | string): string {
  return canonicalDigest({ id, generation, nominal }).slice(7);
}
export function scheduleSummary(record: ScheduleRecord) {
  return {
    kind: "schedule",
    id: record.id,
    workspace: record.workspace,
    generation: record.generation,
    revision: record.revision,
    state: record.state,
    digest: record.digest,
    source: record.source,
    timing: record.definition.timing,
    overlap: record.definition.overlap,
    missed: record.definition.missed,
    cursor: record.cursor,
    blocker: record.blocker,
    binding: record.binding,
    liveHostRequired: true,
  };
}

/** Content-free journal/notification projection. Definitions and inputs remain private storage. */
export const scheduleNoticeSchema = z.strictObject({
  version: z.literal(1),
  schedule: scheduleKeySchema,
  generation: z.int().positive(),
  attempt: scheduleKeySchema,
  terminal: scheduleTerminalSchema,
});
export type ScheduleNotice = z.infer<typeof scheduleNoticeSchema>;
