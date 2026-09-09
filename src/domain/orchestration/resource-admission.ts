/** Process-local admission contracts. Capacity identity never contains caller bindings. */
import { z } from "zod";

export const RESOURCE_DIMENSIONS = [
  "operations",
  "requests",
  "attempts",
  "retries",
  "inputTokens",
  "outputTokens",
  "costMicros",
  "cpuMs",
  "memoryBytes",
  "networkBytes",
  "bufferedBytes",
  "bufferedItems",
  "processes",
  "descendants",
  "artifactBytes",
  "diskBytes",
  "concurrency",
  "wallTimeMs",
] as const;
export type ResourceDimension = (typeof RESOURCE_DIMENSIONS)[number];
export const resourceAmountsSchema = z.partialRecord(
  z.enum(RESOURCE_DIMENSIONS),
  z.int().nonnegative(),
);
export type ResourceAmounts = Readonly<Partial<Record<ResourceDimension, number>>>;
const segment = z.string().min(1).max(256);
export const sharedCapacityScopeIdentitySchema = z
  .object({
    version: z.literal(1),
    ownerKind: z.enum(["process", "task", "platform", "provider", "tool", "package", "agent"]),
    destination: segment,
    account: segment.optional(),
    organization: segment.optional(),
    project: segment.optional(),
    workspace: segment.optional(),
    region: segment.optional(),
    serviceTier: segment.optional(),
    family: segment,
    dimension: z.enum(RESOURCE_DIMENSIONS),
    bucketKind: z.enum(["cumulative", "occupancy"]),
  })
  .strict();
export type SharedCapacityScopeIdentityV1 = z.infer<typeof sharedCapacityScopeIdentitySchema>;
export const resourceReservationIdentitySchema = z
  .object({
    version: z.literal(1),
    parentScope: segment,
    owner: segment,
    operation: segment,
    workspaceGeneration: segment,
    configurationGeneration: segment,
    attempt: segment,
    fence: segment,
    scopes: z.array(sharedCapacityScopeIdentitySchema).min(1).max(128),
  })
  .strict();
export type ResourceReservationIdentityV1 = z.infer<typeof resourceReservationIdentitySchema>;
export type ResourceDebit = {
  readonly scope: SharedCapacityScopeIdentityV1;
  readonly amount: number;
  readonly limit: number;
};
export const ADMISSION_STATES = [
  "admitted",
  "queued",
  "limit-exceeded",
  "admission-timeout",
  "cancelled",
  "stale-generation",
  "authority-denied",
  "quota-unknown",
  "uncertain-after-interruption",
  "shutdown",
] as const;
export type AdmissionState = (typeof ADMISSION_STATES)[number];
/** Digests are opaque and process salted. Never project raw scope or binding identifiers. */
export type ResourceAdmissionReceipt = {
  readonly version: 1;
  readonly state: AdmissionState;
  readonly reservation: string;
  readonly scope: string | null;
  readonly dimension: ResourceDimension | null;
  readonly acquired: boolean;
  readonly released: boolean;
  readonly uncertain: boolean;
  readonly queuePosition: number | null;
  readonly deadline: number | null;
};

/** Canonical structural equality, with field order independent of construction. */
export function canonicalResourceValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalResourceValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalResourceValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const resourceAdmissionReceiptSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(ADMISSION_STATES),
    reservation: z.string().min(1).max(128),
    scope: z.string().max(128).nullable(),
    dimension: z.enum(RESOURCE_DIMENSIONS).nullable(),
    acquired: z.boolean(),
    released: z.boolean(),
    uncertain: z.boolean(),
    queuePosition: z.int().nonnegative().nullable(),
    deadline: z.int().nullable(),
  })
  .strict();
