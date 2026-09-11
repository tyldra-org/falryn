/** Explicit native activation is separate from inert scope preferences and package trust. */
import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { canonicalDigest } from "./canonical.ts";
import { digestSchema, generationSchema } from "./identity.ts";
import { scopeAuthoritySchema } from "./scope-controls.ts";

export const nativeActivationRequestSchema = z
  .strictObject({
    scope: z.enum(["user", "workspace", "session", "process", "development"]),
    expectedRevision: generationSchema,
    contributions: z.array(digestSchema).min(1).max(1_024),
  })
  .refine((value) => new Set(value.contributions).size === value.contributions.length);

export const nativeActivationSchema = z
  .strictObject({
    version: z.literal(1),
    actor: digestSchema,
    scopeKey: digestSchema,
    scopeBinding: digestSchema,
    authority: scopeAuthoritySchema,
    package: digestSchema,
    installedRevision: z.int().positive(),
    configuration: digestSchema,
    contributions: z.array(digestSchema).min(1).max(1_024),
    revision: z.int().positive(),
  })
  .refine((value) => new Set(value.contributions).size === value.contributions.length);
export type NativeActivation = z.infer<typeof nativeActivationSchema>;
export function nativeActivationKey(record: Pick<NativeActivation, "actor" | "scopeKey">): string {
  return canonicalDigest({ actor: record.actor, scopeKey: record.scopeKey });
}
export const nativeActivationReceiptSchema = z.strictObject({
  operation: z.string().uuid(),
  fingerprint: digestSchema,
  confirmation: digestSchema,
  key: digestSchema,
  priorRevision: generationSchema,
  record: nativeActivationSchema,
});
export type NativeActivationReceipt = z.infer<typeof nativeActivationReceiptSchema>;
export interface NativeActivationStore {
  get(key: string): Result<NativeActivation | null, { code: string }>;
  operation(id: string): Result<NativeActivationReceipt | null, { code: string }>;
  /** The existing SQLite writer rechecks installation and scope before publishing. */
  save(
    receipt: NativeActivationReceipt,
    scopeRevision: number,
    signal: AbortSignal,
  ): Result<NativeActivationReceipt, { code: string }>;
}
