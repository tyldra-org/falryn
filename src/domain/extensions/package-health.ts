import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { processBirthIdentitySchema } from "../process/process-identity.ts";
import { sandboxReceiptSchema } from "../security/sandbox.ts";
import { digestSchema, identityText } from "./identity.ts";

export const PACKAGE_HEALTH_PROTOCOL = "falryn-package-health/1";
export const PACKAGE_HEALTH_LIMITS = {
  frames: 8,
  frameBytes: 16_384,
  outputBytes: 65_536,
  wallTimeMs: 30_000,
  requestMs: 5_000,
  shutdownMs: 1_000,
  processes: 4,
  packageProcesses: 1,
  crashes: 3,
} as const;

export const packageHealthRequestSchema = z.strictObject({
  contribution: digestSchema,
  recover: z.boolean().default(false),
  /** A required hard resource ceiling is never replaced by accounting or sampling. */
  requiredControls: z
    .array(z.enum(["cpu", "memory"]))
    .max(2)
    .default([]),
});
export type PackageHealthRequest = z.infer<typeof packageHealthRequestSchema>;

export const packageHealthBindingSchema = z.strictObject({
  protocol: z.literal(PACKAGE_HEALTH_PROTOCOL),
  attempt: z.string().uuid(),
  package: digestSchema,
  contribution: digestSchema,
  generation: digestSchema,
});
export type PackageHealthBinding = z.infer<typeof packageHealthBindingSchema>;
export const packageHealthFrameSchema = packageHealthBindingSchema.extend({
  id: z.int().min(1).max(4),
  method: z.enum(["initialize", "health", "shutdown"]),
  result: z.literal("ok"),
});

export const packageHealthResultSchema = z.strictObject({
  version: z.literal(1),
  binding: packageHealthBindingSchema,
  state: z.enum(["starting", "running", "healthy", "failed", "uncertain", "recovered"]),
  code: identityText,
  pid: z.int().positive().nullable(),
  requests: z.int().nonnegative().max(4),
  outputBytes: z.int().nonnegative(),
  terminated: z.boolean(),
  cleanup: z.enum(["pending", "removed", "retained", "unknown"]),
  timings: z.strictObject({
    startMs: z.number().nonnegative(),
    requestsMs: z.array(z.number().nonnegative()).max(4),
    shutdownMs: z.number().nonnegative(),
  }),
  resources: z.strictObject({
    cpu: z.literal("unavailable"),
    memory: z.literal("unavailable"),
    containment: z.enum(["unavailable", "filesystem-network-single-process"]),
  }),
  sandbox: sandboxReceiptSchema.nullable(),
});
export type PackageHealthResult = z.infer<typeof packageHealthResultSchema>;

/** Storage-only recovery facts never appear in command projections. */
export const packageHealthRecordSchema = z.strictObject({
  operation: z.string().uuid(),
  packageId: identityText,
  fingerprint: digestSchema,
  revision: z.int().positive(),
  result: packageHealthResultSchema,
  birth: processBirthIdentitySchema.nullable(),
  directory: z.string().max(4096).nullable(),
});
export type PackageHealthRecord = z.infer<typeof packageHealthRecordSchema>;
export interface PackageHealthStore {
  get(operation: string): Result<PackageHealthRecord | null, { code: string }>;
  pending(contribution: string): Result<PackageHealthRecord | null, { code: string }>;
  failures(contribution: string, generation: string): Result<number, { code: string }>;
  save(record: PackageHealthRecord, expected: number): Result<null, { code: string }>;
}

export function initialHealthResult(binding: PackageHealthBinding): PackageHealthResult {
  return {
    version: 1,
    binding,
    state: "starting",
    code: "launch-pending",
    pid: null,
    requests: 0,
    outputBytes: 0,
    terminated: false,
    cleanup: "pending",
    timings: { startMs: 0, requestsMs: [], shutdownMs: 0 },
    resources: {
      cpu: "unavailable",
      memory: "unavailable",
      containment: "unavailable",
    },
    sandbox: null,
  };
}
