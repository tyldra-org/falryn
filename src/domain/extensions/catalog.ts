/** Compact inspection facts. Neither a catalog entry nor a handle grants execution authority. */
import { z } from "zod";
import {
  canonicalDigest,
  canonicalJson,
  ExtensionInputError,
  freezeMetadata,
} from "./canonical.ts";
import {
  BEHAVIOR_FAMILIES,
  builtinOwnerIdentityV1Schema,
  capabilityBindingV1Schema,
  contributionIdentityV1Schema,
  decodeIdentity,
  digestSchema,
  EXTENSION_SCOPES,
  extensionActivationIdentityV1Schema,
  generationSchema,
  identityText,
  NATIVE_CONTRIBUTION_KINDS,
  packageIdentityV1Schema,
  standaloneSourceOwnerV1Schema,
  validateCapabilityBinding,
} from "./identity.ts";

export const CATALOG_LIMITS = Object.freeze({
  controls: 1_024,
  descriptors: 4_096,
  metadataBytes: 16_777_216,
  deadlineMs: 30_000,
  aliases: 16,
  defaultPage: 32,
  maximumPage: 256,
});
export const CATALOG_SCOPES = ["builtin", ...EXTENSION_SCOPES] as const;
export type CatalogScope = (typeof CATALOG_SCOPES)[number];
/** Stored aliases and lookup inputs use the same canonical spelling. */
export const catalogAliasSchema = identityText
  .refine((value) => value.isWellFormed())
  .transform((value) => value.normalize("NFC"))
  .pipe(identityText);
export const catalogSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("builtin"), owner: builtinOwnerIdentityV1Schema }),
  z.strictObject({ kind: z.literal("standalone"), owner: standaloneSourceOwnerV1Schema }),
  z.strictObject({
    kind: z.literal("package"),
    owner: packageIdentityV1Schema,
    activation: extensionActivationIdentityV1Schema,
  }),
]);
const catalogEntryFields = z.strictObject({
  source: catalogSourceSchema,
  contribution: contributionIdentityV1Schema,
  aliases: z.array(catalogAliasSchema).max(CATALOG_LIMITS.aliases),
  family: z.enum(BEHAVIOR_FAMILIES).nullable(),
  effects: z.array(z.enum(["observation", "mutation", "external", "interactive"])).max(4),
  compatibility: z.enum(["compatible", "incompatible", "unknown"]),
  lifecycle: z.enum(["current", "missing", "changed", "disabled", "historical"]),
  enabled: z.boolean(),
  preferred: z.boolean(),
  explicitOnly: z.boolean(),
  health: z.enum(["healthy", "degraded", "unknown"]),
  trust: z.enum(["accepted", "required", "revoked", "expired", "unknown"]),
  availability: z.enum(["available", "unavailable"]),
  reason: identityText,
  binding: capabilityBindingV1Schema.nullable(),
});
export type CatalogEntry = z.infer<typeof catalogEntryFields>;

export function catalogScope(entry: CatalogEntry): CatalogScope {
  switch (entry.source.kind) {
    case "builtin":
      return "builtin";
    case "package":
      return entry.source.activation.scope;
    case "standalone":
      return entry.source.owner.scope;
  }
}

export function catalogEntryKey(entry: CatalogEntry): string {
  return canonicalDigest({ source: entry.source, contribution: entry.contribution });
}

/** Reuse the V1 identity links rather than substituting names or display aliases. */
export const catalogEntrySchema = catalogEntryFields.refine((entry) => {
  const owner = canonicalDigest(entry.source.owner);
  if (
    entry.source.kind !== entry.contribution.owner.kind ||
    owner !== entry.contribution.owner.digest
  )
    return false;
  if (new Set(entry.aliases).size !== entry.aliases.length) return false;
  if (
    entry.source.kind === "standalone" &&
    entry.source.owner.kind !== entry.contribution.nativeKind
  )
    return false;
  if (entry.binding !== null && entry.family !== entry.binding.family) return false;
  if (entry.source.kind === "package" && entry.source.activation.packageIdentityDigest !== owner)
    return false;
  if (
    entry.binding !== null &&
    !validateCapabilityBinding({
      contribution: entry.contribution,
      binding: entry.binding,
      ...(entry.source.kind === "package" ? { activation: entry.source.activation } : {}),
      state: entry.availability === "available" ? "available" : "declared",
    })
  )
    return false;
  return (
    entry.availability === "unavailable" ||
    (entry.binding !== null &&
      entry.enabled &&
      entry.lifecycle === "current" &&
      entry.compatibility === "compatible" &&
      entry.trust === "accepted")
  );
});

export type ExtensionCatalog = {
  readonly version: 1;
  readonly generation: number;
  readonly identity: string;
  readonly inputs: string;
  readonly entries: readonly CatalogEntry[];
  readonly metadataBytes: number;
};

/** Validate and freeze an entire candidate before any caller publishes it. */
export function createExtensionCatalog(input: {
  readonly generation: number;
  readonly inputs: string;
  readonly entries: readonly unknown[];
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): ExtensionCatalog {
  generationSchema.parse(input.generation);
  digestSchema.parse(input.inputs);
  if (input.entries.length > CATALOG_LIMITS.descriptors)
    throw new ExtensionInputError("catalog-descriptor-limit");
  const now = input.now ?? (() => performance.now());
  const started = now();
  const guard = () => {
    if (input.signal?.aborted) throw new ExtensionInputError("cancelled");
    if (now() - started >= CATALOG_LIMITS.deadlineMs)
      throw new ExtensionInputError("catalog-deadline");
  };
  const entries: CatalogEntry[] = [];
  const keys = new Set<string>();
  let metadataBytes = 0;
  for (const candidate of input.entries) {
    guard();
    // Per-entry canonicalization also rejects accessors, cycles and ambiguous Unicode keys.
    const decoded = decodeIdentity(catalogEntrySchema, candidate);
    if (!decoded.ok) throw new ExtensionInputError("invalid-catalog-entry");
    const entry = decoded.value;
    const key = catalogEntryKey(entry);
    if (keys.has(key)) throw new ExtensionInputError("duplicate-catalog-identity");
    keys.add(key);
    metadataBytes += Buffer.byteLength(canonicalJson(entry));
    if (metadataBytes > CATALOG_LIMITS.metadataBytes)
      throw new ExtensionInputError("catalog-metadata-limit");
    entries.push(entry);
  }
  entries.sort((a, b) => {
    const left = catalogEntryKey(a);
    const right = catalogEntryKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  guard();
  const identity = canonicalDigest({
    version: 1,
    generation: input.generation,
    inputs: input.inputs,
    entries: entries.map((entry) => canonicalDigest(entry)),
  });
  return freezeMetadata({
    version: 1,
    generation: input.generation,
    identity,
    inputs: input.inputs,
    entries,
    metadataBytes,
  });
}

export const catalogFilterSchema = z.strictObject({
  owner: digestSchema.optional(),
  contribution: digestSchema.optional(),
  scope: z.enum(CATALOG_SCOPES).optional(),
  package: digestSchema.optional(),
  nativeKind: z.enum(NATIVE_CONTRIBUTION_KINDS).optional(),
  family: z.enum(BEHAVIOR_FAMILIES).optional(),
  compatibility: catalogEntryFields.shape.compatibility.optional(),
  lifecycle: catalogEntryFields.shape.lifecycle.optional(),
});
export type CatalogFilter = z.infer<typeof catalogFilterSchema>;
export const catalogHandleSchema = z.strictObject({
  version: z.literal(1),
  catalog: digestSchema,
  generation: generationSchema,
  query: digestSchema,
  offset: z.int().nonnegative().max(CATALOG_LIMITS.descriptors),
});
export type CatalogHandle = z.infer<typeof catalogHandleSchema>;
export const catalogQuerySchema = z.strictObject({
  catalog: digestSchema,
  filter: catalogFilterSchema.default({}),
  limit: z.int().positive().max(CATALOG_LIMITS.maximumPage).default(CATALOG_LIMITS.defaultPage),
  handle: catalogHandleSchema.optional(),
});
export type CatalogPage = {
  readonly catalog: string;
  readonly generation: number;
  readonly entries: readonly CatalogEntry[];
  readonly total: number;
  readonly omitted: number;
  readonly next: CatalogHandle | null;
};

function matches(entry: CatalogEntry, filter: CatalogFilter): boolean {
  return (
    (filter.owner === undefined || filter.owner === entry.contribution.owner.digest) &&
    (filter.contribution === undefined ||
      filter.contribution === canonicalDigest(entry.contribution)) &&
    (filter.scope === undefined || filter.scope === catalogScope(entry)) &&
    (filter.package === undefined ||
      (entry.source.kind === "package" &&
        filter.package === canonicalDigest(entry.source.owner))) &&
    (filter.nativeKind === undefined || filter.nativeKind === entry.contribution.nativeKind) &&
    (filter.family === undefined || filter.family === entry.family) &&
    (filter.compatibility === undefined || filter.compatibility === entry.compatibility) &&
    (filter.lifecycle === undefined || filter.lifecycle === entry.lifecycle)
  );
}

export function queryExtensionCatalog(catalog: ExtensionCatalog, input: unknown): CatalogPage {
  const request = catalogQuerySchema.parse(input);
  const query = canonicalDigest({ filter: request.filter, limit: request.limit });
  const handle = request.handle;
  if (
    request.catalog !== catalog.identity ||
    (handle !== undefined &&
      (handle.catalog !== catalog.identity ||
        handle.generation !== catalog.generation ||
        handle.query !== query))
  )
    throw new ExtensionInputError("stale-catalog-handle");
  const all = catalog.entries.filter((entry) => matches(entry, request.filter));
  const offset = handle?.offset ?? 0;
  if (offset > all.length) throw new ExtensionInputError("invalid-catalog-offset");
  const entries = all.slice(offset, offset + request.limit);
  const nextOffset = offset + entries.length;
  return freezeMetadata({
    catalog: catalog.identity,
    generation: catalog.generation,
    entries,
    total: all.length,
    omitted: all.length - entries.length,
    next:
      nextOffset < all.length
        ? {
            version: 1,
            catalog: catalog.identity,
            generation: catalog.generation,
            query,
            offset: nextOffset,
          }
        : null,
  });
}
