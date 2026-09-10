import { z } from "zod";

export const PACKAGE_ARTIFACT_LIMITS = {
  valueBytes: 67_108_864,
  packageBytes: 268_435_456,
  globalBytes: 1_073_741_824,
  references: 128,
} as const;
export const packageArtifactReferenceSchema = z.strictObject({
  kind: z.literal("artifact-reference"),
  artifactId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  digest: z.string().regex(/^sha-256:[a-f0-9]{64}$/u),
  bytes: z.int().nonnegative().max(PACKAGE_ARTIFACT_LIMITS.valueBytes),
});
export type PackageArtifactReference = z.infer<typeof packageArtifactReferenceSchema>;

/** Values have already crossed the bounded JSON decoder. */
export function packageArtifactReferences(value: unknown): PackageArtifactReference[] {
  if (value === null || typeof value !== "object") return [];
  const parsed = packageArtifactReferenceSchema.safeParse(value);
  if (parsed.success) return [parsed.data];
  return Object.values(value).flatMap(packageArtifactReferences);
}
