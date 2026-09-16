/** One bounded JSON document in each direction. This module never launches a handler. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, ExtensionInputError, freezeMetadata, parseMetadata } from "./canonical.ts";
import { type HookRegistration, hookBudgetClass } from "./hook-handlers.ts";
import {
  HOOK_LIMITS,
  HOOK_POINTS,
  type HookEnvelope,
  hookGeneration,
  hookIdentity,
  parseHookEnvelope,
} from "./hook-points.ts";

const annotations = z
  .record(z.string().min(1).max(64), z.string().max(HOOK_LIMITS.annotationValueLength))
  .refine((value) => Object.keys(value).length <= HOOK_LIMITS.annotationKeys);
const evidence = z
  .array(
    z.strictObject({
      sourceId: hookIdentity,
      text: z.string().max(HOOK_LIMITS.evidenceBytes),
      trust: z.literal("untrusted"),
    }),
  )
  .max(HOOK_LIMITS.evidenceEntries)
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= HOOK_LIMITS.evidenceBytes);
const decisionBinding = z.strictObject({
  factId: hookIdentity,
  subjectId: hookIdentity,
  ownerGeneration: hookGeneration,
  configurationGeneration: hookGeneration,
  registrationGeneration: hookGeneration,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
const inputPatch = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .refine((key) => !["__proto__", "prototype", "constructor"].includes(key)),
    z.unknown(),
  )
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 8);

/** Exact snapshot binding; a decision cannot be carried to another fact or generation. */
export function hookDecisionBinding(envelope: HookEnvelope) {
  return {
    factId: envelope.factId,
    subjectId: envelope.subjectId,
    ownerGeneration: envelope.ownerGeneration,
    configurationGeneration: envelope.configurationGeneration,
    registrationGeneration: envelope.registrationGeneration,
    payloadDigest: createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex"),
  };
}
export const hookDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("observe"),
    annotations: annotations.optional(),
    contextEvidence: evidence.optional(),
  }),
  z.strictObject({
    kind: z.literal("transform"),
    binding: decisionBinding,
    annotations: annotations.optional(),
    input: inputPatch.optional(),
  }),
  z.strictObject({
    kind: z.literal("veto"),
    binding: decisionBinding,
    reason: z.string().min(1).max(120),
  }),
  z.strictObject({
    kind: z.literal("external-effect-request"),
    binding: decisionBinding,
    request: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("tool"),
        name: hookIdentity,
        arguments: z.record(z.string(), z.unknown()),
      }),
      z.strictObject({ kind: z.literal("confirmation"), reason: z.string().min(1).max(120) }),
      z.strictObject({
        kind: z.literal("follow-up"),
        code: hookIdentity,
        reason: z.string().min(1).max(120),
      }),
    ]),
  }),
]);
const invocationHeader = z.strictObject({
  version: z.literal(1),
  invocationId: hookIdentity,
  contribution: z.strictObject({
    packageId: hookIdentity,
    contributionId: hookIdentity,
    generation: hookGeneration,
  }),
});
export type HookWireInput = Readonly<z.infer<typeof invocationHeader> & { envelope: HookEnvelope }>;
export type HookDecision = z.infer<typeof hookDecisionSchema>;

function document(bytes: Uint8Array, maximum: number) {
  if (bytes.byteLength > maximum) throw new ExtensionInputError("hook-document-too-large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExtensionInputError("hook-invalid-utf8");
  }
  // Reuse strict syntax/duplicate-key checks without normalizing protocol string values.
  parseMetadata(text);
  return JSON.parse(text) as unknown;
}
export function decodeHookInput(bytes: Uint8Array): HookWireInput {
  const input = invocationHeader
    .extend({ envelope: z.unknown() })
    .parse(document(bytes, HOOK_LIMITS.inputBytes));
  return freezeMetadata({ ...input, envelope: parseHookEnvelope(input.envelope) });
}
export function encodeHookInput(input: HookWireInput): Uint8Array {
  canonicalJson(input);
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  decodeHookInput(encoded);
  return encoded;
}

export function validateHookDecision(
  registration: HookRegistration,
  envelope: HookEnvelope,
  candidate: unknown,
) {
  canonicalJson(candidate);
  if (Buffer.byteLength(JSON.stringify(candidate)) > HOOK_LIMITS.responseBytes)
    throw new ExtensionInputError("hook-document-too-large");
  const decision = hookDecisionSchema.parse(candidate);
  if (
    decision.kind !== "observe" &&
    JSON.stringify(decision.binding) !== JSON.stringify(hookDecisionBinding(envelope))
  )
    throw new ExtensionInputError("hook-decision-stale");
  if (registration.point !== envelope.point || registration.pointVersion !== envelope.pointVersion)
    throw new ExtensionInputError("hook-point-mismatch");
  const descriptor = HOOK_POINTS[envelope.point];
  if (!descriptor.decisions.includes(decision.kind))
    throw new ExtensionInputError("hook-decision-unavailable");
  const budget = hookBudgetClass(registration.handler);
  const localOnly = envelope.reason === "user-stop" || envelope.reason === "shutdown";
  if (localOnly && (budget !== "local" || registration.mode !== "sync"))
    throw new ExtensionInputError("hook-stop-local-only");
  if (budget === "evaluator" && envelope.origin === "evaluator")
    throw new ExtensionInputError("hook-evaluator-recursion");
  if (
    ((registration.mode === "async" && decision.kind !== "external-effect-request") ||
      localOnly ||
      descriptor.policy === "local-observe") &&
    decision.kind !== "observe"
  )
    throw new ExtensionInputError("hook-observation-only");
  if (decision.kind === "veto" && descriptor.policy !== "gate" && descriptor.policy !== "evidence")
    throw new ExtensionInputError("hook-terminal-immutable");
  if (
    decision.kind === "transform" &&
    (budget === "evaluator" || !descriptor.mutableFields.includes("annotations"))
  )
    throw new ExtensionInputError("hook-transform-unavailable");
  if (
    decision.kind === "transform" &&
    ((!decision.annotations && !decision.input) ||
      (decision.input && !descriptor.mutableFields.includes("input")))
  )
    throw new ExtensionInputError("hook-transform-field-unavailable");
  if (
    decision.kind === "observe" &&
    decision.contextEvidence &&
    (!descriptor.mutableFields.includes("contextEvidence") ||
      localOnly ||
      registration.mode === "async")
  )
    throw new ExtensionInputError("hook-context-evidence-unavailable");
  if (decision.kind === "external-effect-request") {
    const gate =
      descriptor.phase === "pre" &&
      (descriptor.policy === "gate" || descriptor.policy === "evidence");
    if (
      budget === "evaluator" ||
      envelope.recursionDepth >= HOOK_LIMITS.recursionDepth ||
      (decision.request.kind === "confirmation"
        ? !gate || registration.mode === "async"
        : decision.request.kind === "follow-up"
          ? gate
          : envelope.point !== "after-capability-invocation")
    )
      throw new ExtensionInputError("hook-effect-request-unavailable");
  }
  return freezeMetadata(decision);
}

export function decodeHookResponse(
  bytes: Uint8Array,
  input: HookWireInput,
  registration: HookRegistration,
): HookDecision {
  const response = z
    .strictObject({
      version: z.literal(1),
      invocationId: hookIdentity,
      decision: hookDecisionSchema,
    })
    .parse(document(bytes, HOOK_LIMITS.responseBytes));
  if (response.invocationId !== input.invocationId)
    throw new ExtensionInputError("hook-invocation-mismatch");
  if (input.contribution.generation !== input.envelope.registrationGeneration)
    throw new ExtensionInputError("hook-registration-stale");
  return validateHookDecision(registration, input.envelope, response.decision);
}
