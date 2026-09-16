/** Handler declarations are validated metadata; adapters need separate host admission. */
import { z } from "zod";
import {
  HOOK_BUDGETS,
  HOOK_LIMITS,
  HOOK_POINTS,
  type HookPoint,
  hookGeneration,
  hookIdentity,
  hookPointSchema,
} from "./hook-points.ts";
import { relativePathSchema } from "./identity.ts";

const credential = hookIdentity.optional();
export const hookHandlerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("builtin"), id: hookIdentity }),
  z.strictObject({
    kind: z.literal("external-command-v1"),
    executable: hookIdentity,
    argv: z.array(z.string().max(4_096)).max(64),
    entrypoint: relativePathSchema,
    executionProfile: hookIdentity,
  }),
  z.strictObject({
    kind: z.literal("http-v1"),
    url: z
      .url()
      .max(2_048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        );
      }),
    credentialReference: credential,
  }),
  z.strictObject({
    kind: z.literal("mcp-tool-v1"),
    serverId: hookIdentity,
    toolId: hookIdentity,
    schemaGeneration: hookGeneration,
    outputField: hookIdentity,
  }),
  z.strictObject({
    kind: z.literal("prompt-evaluator-v1"),
    bindingId: hookIdentity,
    instructions: relativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("agent-evaluator-v1"),
    bindingId: hookIdentity,
    instructions: relativePathSchema,
  }),
]);
export type HookHandler = z.infer<typeof hookHandlerSchema>;
export type HookBudgetClass = "local" | "remote" | "evaluator";
export function hookBudgetClass(handler: HookHandler): HookBudgetClass {
  switch (handler.kind) {
    case "builtin":
    case "external-command-v1":
      return "local";
    case "http-v1":
    case "mcp-tool-v1":
      return "remote";
    case "prompt-evaluator-v1":
    case "agent-evaluator-v1":
      return "evaluator";
  }
}
export const hookRegistrationSchema = z
  .strictObject({
    version: z.literal(1),
    point: hookPointSchema,
    pointVersion: z.literal(1),
    handler: hookHandlerSchema,
    mode: z.enum(["sync", "async"]),
    nonlocalOptIn: z.boolean().default(false),
    timeoutMs: z.int().positive().optional(),
    priority: z.int().optional(),
    after: z.array(hookIdentity).max(32).optional(),
    filters: z
      .array(
        z.strictObject({
          field: hookIdentity,
          operator: z.enum(["exact", "prefix", "glob"]),
          value: z.string().max(HOOK_LIMITS.filterValueLength),
        }),
      )
      .max(HOOK_LIMITS.filterCount)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    const descriptor = HOOK_POINTS[value.point];
    const budget = hookBudgetClass(value.handler);
    if (budget !== "local" && !value.nonlocalOptIn) reject("hook-nonlocal-opt-in-required");
    if (value.timeoutMs !== undefined && value.timeoutMs > HOOK_BUDGETS[budget].maximumMs)
      reject("hook-timeout-bound");
    if (descriptor.policy === "local-observe" && (budget !== "local" || value.mode !== "sync"))
      reject("hook-local-observer-only");
    if ((descriptor.policy === "gate" || descriptor.policy === "evidence") && value.mode !== "sync")
      reject("hook-gate-must-settle");
    if (descriptor.policy === "completion" && budget !== "local" && value.mode !== "async")
      reject("hook-completion-cannot-wait");
    if (budget === "evaluator" && value.mode === "sync" && !descriptor.evaluatorGate)
      reject("hook-evaluator-point-unavailable");
    for (const filter of value.filters) {
      if (!descriptor.filters.includes(filter.field)) reject("hook-filter-field-unavailable");
      if (
        filter.operator === "glob" &&
        (filter.field !== "paths" ||
          filter.value.includes("..") ||
          filter.value.startsWith("/") ||
          /[\\[\]{}]/u.test(filter.value))
      )
        reject("hook-filter-glob-unavailable");
    }
  });
export type HookRegistration = z.infer<typeof hookRegistrationSchema>;

export function hookRegistrationAvailability(registration: HookRegistration) {
  const descriptor = HOOK_POINTS[registration.point];
  if (descriptor.producer !== "tool.gateway")
    return { status: "unavailable", code: "hook-publisher-unavailable" } as const;
  if (registration.handler.kind !== "builtin")
    return { status: "unavailable", code: "hook-handler-unavailable" } as const;
  return { status: "available" } as const;
}

/** Safe inspection excludes destinations, credentials, instructions and command arguments. */
export function inspectHookRegistration(input: unknown) {
  const checked = hookRegistrationSchema.safeParse(input);
  if (!checked.success) return null;
  const registration = checked.data;
  const descriptor = HOOK_POINTS[registration.point];
  return {
    point: registration.point,
    pointVersion: registration.pointVersion,
    handler: registration.handler.kind,
    mode: registration.mode,
    budgetClass: hookBudgetClass(registration.handler),
    timeoutMs:
      registration.timeoutMs ?? HOOK_BUDGETS[hookBudgetClass(registration.handler)].defaultMs,
    chainMaximumMs: HOOK_BUDGETS[hookBudgetClass(registration.handler)].chainMs,
    wait: registration.mode === "sync" ? "blocks-subject" : "bounded-background-observation",
    cost:
      hookBudgetClass(registration.handler) === "local"
        ? "local-resources"
        : "explicit-nonlocal-resources",
    phase: descriptor.phase,
    decisions: descriptor.decisions,
    mutableFields: descriptor.mutableFields,
    availability: hookRegistrationAvailability(registration),
  };
}

/** Returned schema, inspection and author validation have the same source. */
export function hookAuthorSchema(point: HookPoint) {
  return {
    point,
    version: 1,
    input: z.toJSONSchema(HOOK_POINTS[point].payload),
    registration: z.toJSONSchema(hookRegistrationSchema, { io: "input" }),
  };
}
