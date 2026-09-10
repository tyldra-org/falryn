/** Historical preferences and identity facts. This shape cannot be used as a live catalog entry. */
import { z } from "zod";
import type { WorkspaceSet } from "../workspace/index.ts";
import { canonicalDigest, freezeMetadata } from "./canonical.ts";
import { catalogEntrySchema, catalogSourceSchema, type ExtensionCatalog } from "./catalog.ts";
import {
  BEHAVIOR_FAMILIES,
  contributionIdentityV1Schema,
  digestSchema,
  generationSchema,
  identityText,
} from "./identity.ts";

// Leaves headroom in the 64 KiB session.started envelope.
export const CATALOG_HISTORY_BYTES = 49_152;
export const CATALOG_HISTORY_ENTRIES = 32;
const historicalEntrySchema = z
  .strictObject({
    source: catalogSourceSchema,
    contribution: contributionIdentityV1Schema,
    family: z.enum(BEHAVIOR_FAMILIES).nullable(),
    wasEnabled: z.boolean(),
    preferred: z.boolean(),
    explicitOnly: z.boolean(),
    compatibility: z.enum(["compatible", "incompatible", "unknown"]),
    trust: z.enum(["accepted", "required", "revoked", "expired", "unknown"]),
    reason: identityText,
  })
  .refine(
    (entry) =>
      catalogEntrySchema.safeParse({
        source: entry.source,
        contribution: entry.contribution,
        family: entry.family,
        aliases: [],
        effects: [],
        enabled: false,
        preferred: entry.preferred,
        explicitOnly: entry.explicitOnly,
        compatibility: entry.compatibility,
        trust: entry.trust,
        reason: entry.reason,
        lifecycle: "historical",
        health: "unknown",
        availability: "unavailable",
        binding: null,
      }).success,
  );
export const catalogHistorySchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("historical"),
    catalog: digestSchema,
    generation: generationSchema,
    inputs: digestSchema,
    workspaceBinding: digestSchema.optional(),
    entries: z.array(historicalEntrySchema).max(CATALOG_HISTORY_ENTRIES),
    total: z.int().nonnegative().max(4_096),
    omitted: z.int().nonnegative().max(4_096),
  })
  .refine(
    (record) =>
      record.total === record.entries.length + record.omitted &&
      Buffer.byteLength(JSON.stringify(record)) <= CATALOG_HISTORY_BYTES,
  );
export type CatalogHistory = z.infer<typeof catalogHistorySchema>;

/** Host-resolved roots only; this digest records identity, never grants authority. */
export function catalogWorkspaceBinding(workspace: WorkspaceSet): string {
  return canonicalDigest(workspace.roots.map(({ rootId, path }) => ({ rootId, path })));
}

export function projectCatalogHistory(
  catalog: ExtensionCatalog,
  workspace?: WorkspaceSet | null,
): CatalogHistory {
  const history: CatalogHistory = {
    version: 1,
    kind: "historical",
    catalog: catalog.identity,
    generation: catalog.generation,
    inputs: catalog.inputs,
    ...(workspace == null ? {} : { workspaceBinding: catalogWorkspaceBinding(workspace) }),
    entries: [],
    total: catalog.entries.length,
    omitted: catalog.entries.length,
  };
  for (const entry of catalog.entries.slice(0, CATALOG_HISTORY_ENTRIES)) {
    history.entries.push({
      source: entry.source,
      contribution: entry.contribution,
      family: entry.family,
      wasEnabled: entry.enabled,
      preferred: entry.preferred,
      explicitOnly: entry.explicitOnly,
      compatibility: entry.compatibility,
      trust: entry.trust,
      reason: entry.reason,
    });
    history.omitted--;
    if (Buffer.byteLength(JSON.stringify(history)) > CATALOG_HISTORY_BYTES) {
      history.entries.pop();
      history.omitted++;
      break;
    }
  }
  return freezeMetadata(catalogHistorySchema.parse(history));
}
