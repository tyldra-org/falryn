import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";
import { digestSchema } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";

export const WORKSPACE_TRUST_POLICY = 1;
export const WORKSPACE_LOADER_FAMILIES = [
  "settings",
  "instructions",
  "mcp",
  "hooks",
  "skills",
] as const;
export const workspaceLoaderSchema = z.strictObject({
  source: digestSchema,
  label: z.string().max(256),
  family: z.enum(WORKSPACE_LOADER_FAMILIES),
  digest: digestSchema,
  sourceVersion: digestSchema,
  bytes: z.int().nonnegative(),
  activation: z.enum(["configuration", "unavailable"]),
});
export const workspaceInventorySchema = z.strictObject({
  version: z.literal(1),
  identity: digestSchema,
  generation: digestSchema,
  policy: z.literal(WORKSPACE_TRUST_POLICY),
  configuration: digestSchema,
  loaders: z.array(workspaceLoaderSchema).max(1_024),
});
export type WorkspaceInventory = z.infer<typeof workspaceInventorySchema>;
export const workspaceDecisionSchema = z.strictObject({
  version: z.literal(1),
  actor: digestSchema,
  inventory: workspaceInventorySchema,
  revision: z.int().positive(),
  decidedAt: z.int().nonnegative(),
});
export type WorkspaceDecision = z.infer<typeof workspaceDecisionSchema>;
export type WorkspaceTrustStore = {
  get(
    key: string,
  ):
    | Result<WorkspaceDecision | null, { readonly code: string }>
    | Promise<Result<WorkspaceDecision | null, { readonly code: string }>>;
  replace(
    key: string,
    revision: number,
    decision: WorkspaceDecision,
    signal?: AbortSignal,
  ): Result<null, { readonly code: string }> | Promise<Result<null, { readonly code: string }>>;
};
export function workspaceDecisionKey(identity: string, actor: string): string {
  return canonicalDigest({ kind: "workspace", identity, actor });
}
export const workspaceTrustReportSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["review-required", "accepted", "refused", "stale", "failed", "empty"]),
  inventory: workspaceInventorySchema.nullable(),
  priorGeneration: digestSchema.nullable(),
  reason: z.string().max(128),
  added: z.int().nonnegative(),
  changed: z.int().nonnegative(),
  removed: z.int().nonnegative(),
});
/** Safe event/replay/diagnostic facts. Neither file contents nor raw paths are portable authority. */
export type WorkspaceTrustReport = z.infer<typeof workspaceTrustReportSchema>;
/** Durable events retain bounded decision facts, not the potentially 1 MiB inventory. */
export const workspaceTrustEventPayloadSchema = workspaceTrustReportSchema.extend({
  inventory: workspaceInventorySchema
    .omit({ loaders: true })
    .extend({
      families: z
        .array(
          z.strictObject({
            family: z.enum(WORKSPACE_LOADER_FAMILIES),
            count: z.int().nonnegative(),
          }),
        )
        .max(5),
    })
    .nullable(),
});
export type WorkspaceTrustEventPayload = z.infer<typeof workspaceTrustEventPayloadSchema>;
export type WorkspaceTrustReview = (
  report: WorkspaceTrustReport,
  signal?: AbortSignal,
) => Promise<"proceed" | "refuse">;
