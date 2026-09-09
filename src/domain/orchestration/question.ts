import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { processTaskHandleSchema, processTaskOwnerSchema } from "./process-task.ts";

export const QUESTION_LIMITS = {
  requestBytes: 32_768,
  answerBytes: 16_384,
  activePerOwner: 8,
  defaultWaitMs: 900_000,
  maxWaitMs: 1_800_000,
  retainedPerOwner: 64,
} as const;
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const text = z.string().min(1).max(8192);
const option = z.strictObject({ id, label: text });
const item = z.discriminatedUnion("kind", [
  z.strictObject({
    id,
    kind: z.literal("single-select"),
    prompt: text,
    options: z.array(option).min(1).max(32),
  }),
  z.strictObject({
    id,
    kind: z.literal("multi-select"),
    prompt: text,
    options: z.array(option).min(1).max(32),
    minimum: z.int().min(0).max(32),
    maximum: z.int().min(1).max(32),
  }),
  z.strictObject({
    id,
    kind: z.literal("free-text"),
    prompt: text,
    maxBytes: z.int().min(1).max(16_384),
  }),
  z.strictObject({ id, kind: z.literal("review"), prompt: text }),
]);
export const questionInputSchema = z
  .strictObject({
    version: z.literal(1),
    handle: processTaskHandleSchema,
    items: z.array(item).min(1).max(8),
    sensitivity: z.enum(["normal", "protected"]),
    retention: z.enum(["answer", "metadata-only"]),
    presenter: z.strictObject({
      actorId: id,
      channel: z.enum(["local-user", "headless-user", "authenticated-user"]),
      bindingId: id,
    }),
    waitMs: z.int().min(1).max(QUESTION_LIMITS.maxWaitMs).default(QUESTION_LIMITS.defaultWaitMs),
    missingPresenter: z.enum(["wait", "unavailable"]).default("wait"),
  })
  .superRefine((value, context) => {
    if (
      Buffer.byteLength(JSON.stringify(value)) > QUESTION_LIMITS.requestBytes ||
      new Set(value.items.map((i) => i.id)).size !== value.items.length ||
      (value.sensitivity === "protected" && value.retention !== "metadata-only")
    )
      context.addIssue({ code: "custom", message: "invalid question bounds or retention" });
    for (const item of value.items) {
      if ("options" in item && new Set(item.options.map((o) => o.id)).size !== item.options.length)
        context.addIssue({ code: "custom", message: "duplicate option" });
      if (
        item.kind === "multi-select" &&
        (item.minimum > item.maximum || item.maximum > item.options.length)
      )
        context.addIssue({ code: "custom", message: "invalid selection bounds" });
    }
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;
export const questionOwnerSchema = processTaskOwnerSchema.extend({ generation: id });
export type QuestionOwner = z.infer<typeof questionOwnerSchema>;
export const questionAnswerSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        itemId: id,
        kind: z.literal("selection"),
        optionIds: z.array(id).max(32),
      }),
      z.strictObject({ itemId: id, kind: z.literal("text"), text: z.string().max(16_384) }),
      z.strictObject({ itemId: id, kind: z.literal("review"), acknowledged: z.literal(true) }),
      // Protected input owns secret bytes. This service records only non-retention.
      z.strictObject({ itemId: id, kind: z.literal("protected"), retained: z.literal(false) }),
    ]),
  )
  .min(1)
  .max(8)
  .refine((a) => Buffer.byteLength(JSON.stringify(a)) <= QUESTION_LIMITS.answerBytes);
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export const QUESTION_TERMINALS = [
  "answered",
  "refused",
  "expired",
  "cancelled",
  "unavailable",
] as const;
export const questionSettlementSchema = z.strictObject({
  id,
  kind: z.enum(QUESTION_TERMINALS),
  at: z.int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  answer: questionAnswerSchema.nullable(),
  retained: z.boolean(),
  effectAuthority: z.literal(false),
});
export type QuestionSettlement = z.infer<typeof questionSettlementSchema>;
export const questionRecordSchema = z
  .strictObject({
    input: questionInputSchema,
    owner: questionOwnerSchema,
    ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
    presenterKey: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.int().min(1).max(64),
    createdAt: z.int().nonnegative(),
    expiresAt: z.int().nonnegative(),
    state: z.enum(["created", "published", "waiting", ...QUESTION_TERMINALS]),
    presenter: z.enum(["unavailable", "connected", "disconnected"]),
    settlement: questionSettlementSchema.nullable(),
  })
  .refine(
    (r) =>
      r.expiresAt > r.createdAt &&
      r.expiresAt - r.createdAt <= QUESTION_LIMITS.maxWaitMs &&
      (r.settlement === null
        ? ["created", "published", "waiting"].includes(r.state)
        : r.state === r.settlement.kind &&
          r.settlement.at >= r.createdAt &&
          (r.settlement.retained
            ? r.state === "answered" &&
              r.input.sensitivity === "normal" &&
              r.input.retention === "answer" &&
              r.settlement.answer !== null &&
              validQuestionAnswer(r.input, r.settlement.answer)
            : r.settlement.answer === null)),
  );
export type QuestionRecord = z.infer<typeof questionRecordSchema>;
export type QuestionError = { readonly code: string };
export type QuestionResult<T> = Result<T, QuestionError>;
export type QuestionStore = {
  create(record: QuestionRecord, signal?: AbortSignal): QuestionResult<QuestionRecord>;
  change(
    handle: QuestionInput["handle"],
    update: (current: QuestionRecord) => QuestionResult<QuestionRecord>,
    signal?: AbortSignal,
  ): QuestionResult<QuestionRecord>;
  get(handle: QuestionInput["handle"]): QuestionResult<QuestionRecord>;
  active(): QuestionResult<readonly QuestionRecord[]>;
  cleanup(ownerKey: string, before: number, signal?: AbortSignal): QuestionResult<number>;
};

export function validQuestionAnswer(input: QuestionInput, answer: QuestionAnswer): boolean {
  if (
    answer.length !== input.items.length ||
    new Set(answer.map((a) => a.itemId)).size !== answer.length
  )
    return false;
  return input.items.every((item) => {
    const value = answer.find((a) => a.itemId === item.id);
    if (!value) return false;
    if (input.sensitivity === "protected") return value.kind === "protected";
    if (item.kind === "review") return value.kind === "review";
    if (item.kind === "free-text")
      return value.kind === "text" && Buffer.byteLength(value.text) <= item.maxBytes;
    if (
      value.kind !== "selection" ||
      new Set(value.optionIds).size !== value.optionIds.length ||
      value.optionIds.some((id) => !item.options.some((o) => o.id === id))
    )
      return false;
    return item.kind === "single-select"
      ? value.optionIds.length === 1
      : value.optionIds.length >= item.minimum && value.optionIds.length <= item.maximum;
  });
}

/** Request details and answer bodies never appear in task notifications or diagnostics. */
export function questionDto(record: QuestionRecord) {
  return {
    version: 1 as const,
    handle: record.input.handle,
    revision: record.revision,
    state: record.state,
    presenter: record.presenter,
    expiresAt: record.expiresAt,
    items: record.input.items,
    sensitivity: record.input.sensitivity,
    retention: record.input.retention,
    settlement: record.settlement,
    effectAuthority: false as const,
  };
}
