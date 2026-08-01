/**
 * Zod building blocks shared by every schema that parses untrusted structure
 * into domain values.
 *
 * An event arriving from transport and a row read back out of SQLite are the
 * same problem seen twice: bytes somebody else wrote, which have to become
 * branded identities, canonical timestamps, and closed unions or be refused.
 * Both answer to the same helpers so the two can never drift into accepting
 * different things.
 *
 * Every helper reports structure only. A rejection carries a path and an issue
 * code, never the rejected value, because a malformed record may carry a
 * credential and the error describing it has to be safe to log and export.
 */

import { z } from "zod";

import type { CodecIssue } from "./codec-error.ts";
import type { IdentifierCodec, IntegerCodec } from "./identity.ts";
import { EFFECT_CERTAINTIES, type TerminalOutcome } from "./outcome.ts";
import { parseTimestamp } from "./time.ts";

/** Validates a string through an identifier codec and brands the result. */
export function brandedString<Id extends string>(codec: IdentifierCodec<Id>): z.ZodType<Id> {
  return z.string().transform((value, ctx) => {
    const parsed = codec.parse(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error.code });
      return z.NEVER;
    }
    return parsed.value;
  });
}

/** Validates a number through an integer codec and brands the result. */
export function brandedInteger<Value extends number>(codec: IntegerCodec<Value>): z.ZodType<Value> {
  return z.number().transform((value, ctx) => {
    const parsed = codec.parse(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error.code });
      return z.NEVER;
    }
    return parsed.value;
  });
}

export const timestampSchema = z.string().transform((value, ctx) => {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error.code });
    return z.NEVER;
  }
  return parsed.value;
});

const effectSchema = z.literal(EFFECT_CERTAINTIES);

/**
 * `completed` carries no effect field: a completed operation applied its
 * effect by definition, and `uncertain` is pinned so an uncertain outcome can
 * never claim a settled effect.
 */
export const terminalOutcomeSchema: z.ZodType<TerminalOutcome> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("failed"), effect: effectSchema }),
  z.object({ kind: z.literal("cancelled"), effect: effectSchema }),
  z.object({ kind: z.literal("timed-out"), effect: effectSchema }),
  z.object({ kind: z.literal("uncertain"), effect: z.literal("uncertain") }),
]);

/** Flattens a Zod failure into path-and-code issues that carry no user data. */
export function toCodecIssues(error: z.ZodError): readonly CodecIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    code: issue.code,
  }));
}
