/** Resolve inspection choices without preparing, disclosing, or executing native contributions. */
import { z } from "zod";
import { canonicalDigest, ExtensionInputError, freezeMetadata } from "./canonical.ts";
import {
  type CatalogEntry,
  type CatalogHandle,
  type CatalogScope,
  catalogAliasSchema,
  catalogEntryKey,
  catalogHandleSchema,
  catalogScope,
  type ExtensionCatalog,
} from "./catalog.ts";
import { digestSchema } from "./identity.ts";

const precedence: Readonly<Record<CatalogScope, number>> = {
  builtin: 0,
  user: 1,
  workspace: 2,
  session: 3,
  process: 4,
  development: 5,
};
export const catalogResolutionSchema = z.strictObject({
  catalog: digestSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("exact"), identity: digestSchema }),
    z.strictObject({
      kind: z.literal("alias"),
      name: catalogAliasSchema,
      preference: digestSchema.optional(),
    }),
  ]),
  retry: catalogHandleSchema.optional(),
});
export type CatalogIdentityCard = {
  readonly key: string;
  readonly owner: string;
  readonly contribution: string;
  readonly scope: CatalogScope;
};
export type CatalogResolution =
  | {
      readonly status: "missing";
      readonly catalog: string;
      readonly reason: "exact-choice-missing" | "alias-missing";
    }
  | {
      readonly status: "resolved";
      readonly catalog: string;
      readonly reason:
        | "exact-identity"
        | "exact-preference"
        | "scope-precedence"
        | "equivalent-tie-break";
      readonly entry: CatalogEntry;
      readonly shadowed: number;
    }
  | {
      readonly status: "ambiguous-contribution";
      readonly catalog: string;
      readonly cards: readonly CatalogIdentityCard[];
      readonly total: number;
      readonly omitted: number;
      readonly retry: CatalogHandle;
    };

function sameIdentity(entry: CatalogEntry, identity: string): boolean {
  return catalogEntryKey(entry) === identity || canonicalDigest(entry.contribution) === identity;
}

function equivalent(entries: readonly CatalogEntry[]): boolean {
  const first = entries[0];
  if (first?.binding == null || first.availability !== "available") return false;
  const expected = first.binding;
  return entries.every((entry) => {
    const binding = entry.binding;
    return (
      entry.availability === "available" &&
      binding !== null &&
      entry.contribution.nativeKind === first.contribution.nativeKind &&
      binding.family === expected.family &&
      binding.schemaDigest === expected.schemaDigest &&
      binding.effectDigest === expected.effectDigest &&
      binding.authorityDigest === expected.authorityDigest &&
      binding.resultDigest === expected.resultDigest &&
      binding.settlementDigest === expected.settlementDigest
    );
  });
}

function ambiguity(
  catalog: ExtensionCatalog,
  entries: readonly CatalogEntry[],
  query: string,
): CatalogResolution {
  const cards = entries.slice(0, 4).map((entry) => ({
    key: catalogEntryKey(entry),
    owner: entry.contribution.owner.digest,
    contribution: canonicalDigest(entry.contribution),
    scope: catalogScope(entry),
  }));
  const receipt: CatalogResolution = {
    status: "ambiguous-contribution",
    catalog: catalog.identity,
    cards,
    total: entries.length,
    omitted: entries.length - cards.length,
    retry: {
      version: 1,
      catalog: catalog.identity,
      generation: catalog.generation,
      query,
      offset: 0,
    },
  };
  if (
    cards.some((card) => Buffer.byteLength(JSON.stringify(card)) > 384) ||
    Buffer.byteLength(JSON.stringify(receipt)) > 2_048
  )
    throw new ExtensionInputError("catalog-receipt-limit");
  return freezeMetadata(receipt);
}

/** Explicit identity failure never falls through to a same-named replacement. */
export function resolveExtensionCatalog(
  catalog: ExtensionCatalog,
  input: unknown,
): CatalogResolution {
  const request = catalogResolutionSchema.parse(input);
  const query = canonicalDigest(request.target);
  if (
    request.catalog !== catalog.identity ||
    (request.retry !== undefined &&
      (request.retry.catalog !== catalog.identity ||
        request.retry.generation !== catalog.generation ||
        request.retry.query !== query ||
        request.retry.offset !== 0))
  )
    throw new ExtensionInputError("stale-catalog-handle");
  const target = request.target;
  const alias = target.kind === "alias" ? target.name : null;
  const exact = target.kind === "exact" ? target.identity : target.preference;
  let candidates = catalog.entries.filter((entry) =>
    exact !== undefined
      ? sameIdentity(entry, exact)
      : alias !== null && entry.aliases.includes(alias),
  );
  if (exact === undefined)
    candidates = candidates.filter(
      (entry) => entry.enabled && !entry.explicitOnly && entry.lifecycle === "current",
    );
  if (candidates.length === 0)
    return {
      status: "missing",
      catalog: catalog.identity,
      reason: exact === undefined ? "alias-missing" : "exact-choice-missing",
    };
  const total = candidates.length;
  if (exact === undefined) {
    const preferred = candidates.filter((entry) => entry.preferred);
    if (preferred.length > 0) candidates = preferred;
  }
  const rank = Math.max(...candidates.map((entry) => precedence[catalogScope(entry)]));
  const best = candidates.filter((entry) => precedence[catalogScope(entry)] === rank);
  const entry = best[0];
  if (entry === undefined) throw new ExtensionInputError("invalid-catalog-candidates");
  if (best.length > 1 && !equivalent(best)) return ambiguity(catalog, best, query);
  let reason: Extract<CatalogResolution, { status: "resolved" }>["reason"] = "scope-precedence";
  if (best.length > 1) reason = "equivalent-tie-break";
  else if (target.kind === "exact") reason = "exact-identity";
  else if (exact !== undefined || entry.preferred) reason = "exact-preference";
  return freezeMetadata({
    status: "resolved",
    catalog: catalog.identity,
    reason,
    entry,
    shadowed: total - 1,
  });
}
