import { z } from "zod";
import { err, ok } from "../foundation/result.ts";
import {
  REFLECTION_LIMITS,
  type ReflectionRecord,
  type ReflectionResult,
  reflectionDigestSchema,
  reflectionRecordSchema,
} from "./reflection.ts";
import { reflectionDigest, validateReflectionRecord } from "./reflection-state.ts";

const leaseObservationSchema = reflectionRecordSchema.shape.lease.unwrap().omit({ token: true });
export const reflectionViewSchema = reflectionRecordSchema.extend({
  lease: leaseObservationSchema.nullable(),
});
export type ReflectionView = z.infer<typeof reflectionViewSchema>;
export function reflectionView(record: ReflectionRecord): ReflectionView {
  const { lease, ...rest } = record;
  return {
    ...rest,
    lease:
      lease === null
        ? null
        : { epoch: lease.epoch, expiresAt: lease.expiresAt, process: lease.process },
  };
}
export const reflectionExportSchema = z.strictObject({
  version: z.literal(1),
  authority: z.literal("derived-observation"),
  record: reflectionViewSchema,
  digest: reflectionDigestSchema,
});
export type ReflectionExport = z.infer<typeof reflectionExportSchema>;
export function exportReflection(record: ReflectionRecord): ReflectionExport {
  const view = reflectionView(record);
  return {
    version: 1,
    authority: "derived-observation",
    record: view,
    digest: reflectionDigest(view),
  };
}
/** Replay is a detached observation. There is deliberately no import, admission or execution operation. */
export function replayReflection(json: string): ReflectionResult<ReflectionExport> {
  if (Buffer.byteLength(json) > REFLECTION_LIMITS.recordBytes + 1024)
    return err({ kind: "reflection", code: "resource-exhausted" });
  try {
    const parsed = reflectionExportSchema.safeParse(JSON.parse(json));
    if (!parsed.success || reflectionDigest(parsed.data.record) !== parsed.data.digest)
      return err({ kind: "reflection", code: "corrupt" });
    const record = parsed.data.record;
    validateReflectionRecord({
      ...record,
      lease:
        record.lease === null
          ? null
          : { ...record.lease, token: "00000000-0000-4000-8000-000000000000" },
    });
    return ok(parsed.data);
  } catch {
    return err({ kind: "reflection", code: "corrupt" });
  }
}
