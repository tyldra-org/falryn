/** Built-in compatibility is translated at the same validated decision boundary as wire input. */
import { z } from "zod";
import { canonicalJson, freezeMetadata } from "../extensions/canonical.ts";
import { hookDecisionBinding, validateHookDecision } from "../extensions/hook-protocol.ts";
import type { ToolHookDecision, ToolHookEnvelope } from "./tool-hooks.ts";

const annotations = z
  .record(z.string().min(1).max(64), z.string().max(120))
  .refine((value) => Object.keys(value).length <= 8);
const reason = z.string().min(1).max(120);
const code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/u);
const legacySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("allow") }),
  z.strictObject({ kind: z.literal("annotate"), annotations }),
  z.strictObject({ kind: z.literal("transform"), annotations }),
  z.strictObject({ kind: z.literal("deny"), reason }),
  z.strictObject({ kind: z.literal("request-confirmation"), reason }),
  z.strictObject({
    kind: z.literal("diagnostic"),
    code,
    level: z.enum(["debug", "info", "warn", "error"]),
  }),
  z.strictObject({
    kind: z.literal("propose-follow-up"),
    followUp: z.strictObject({ code, reason }),
  }),
]);

export function validateToolHookDecision(
  candidate: unknown,
  envelope: ToolHookEnvelope,
): ToolHookDecision {
  canonicalJson(candidate);
  const legacy = legacySchema.safeParse(candidate);
  const binding = hookDecisionBinding(envelope.catalog);
  let decision: unknown = candidate;
  if (legacy.success) {
    const value = legacy.data;
    switch (value.kind) {
      case "allow":
        decision = { kind: "observe" };
        break;
      case "annotate":
        decision = { kind: "observe", annotations: value.annotations };
        break;
      case "transform":
        decision = { ...value, binding };
        break;
      case "deny":
        decision = { kind: "veto", reason: value.reason, binding };
        break;
      case "request-confirmation":
        decision = {
          kind: "external-effect-request",
          binding,
          request: { kind: "confirmation", reason: value.reason },
        };
        break;
      case "propose-follow-up":
        decision = {
          kind: "external-effect-request",
          binding,
          request: { kind: "follow-up", ...value.followUp },
        };
        break;
      case "diagnostic":
        if (envelope.phase !== "post") throw new Error("hook-diagnostic-unavailable");
        return freezeMetadata(value);
    }
  }
  const validated = validateHookDecision(
    {
      version: 1,
      point: envelope.point,
      pointVersion: 1,
      handler: { kind: "builtin", id: "tool-hook" },
      mode: "sync",
      nonlocalOptIn: false,
      filters: [],
    },
    envelope.catalog,
    decision,
  );
  // Keep legacy settlement/result consumers stable; validation is shared with the wire algebra.
  return legacy.success ? freezeMetadata(legacy.data) : validated;
}
