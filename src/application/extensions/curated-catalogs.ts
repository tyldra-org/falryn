/**
 * Imported curated catalogs (#165). Import ingests one local catalog document, decides
 * it against its source's stored record and compare-and-replaces that record. Listing
 * pages stored listings in a stable order that editorial rank never changes. Nothing here
 * fetches, installs, enables or trusts a package.
 */
import { z } from "zod";
import {
  type CatalogDiagnostic,
  CURATED_KINDS,
  type CuratedCatalogStore,
  type CuratedListing,
  decideCuratedImport,
  ingestCuratedCatalog,
  listingCompatibility,
} from "../../domain/extensions/curated-catalog.ts";
import type { HostFacts } from "../../domain/extensions/manifest.ts";

export const curatedListQuerySchema = z.strictObject({
  sourceId: z.string().max(64).optional(),
  kind: z.enum(CURATED_KINDS).optional(),
  /** Case-insensitive match on listing ID, title, summary or tag. */
  text: z.string().min(1).max(120).optional(),
  offset: z.int().min(0).max(100_000).default(0),
  limit: z.int().min(1).max(100).default(50),
});
export type CuratedListQuery = z.infer<typeof curatedListQuerySchema>;

export type CuratedImportReceipt =
  | {
      readonly status: "imported" | "unchanged";
      readonly sourceId: string;
      readonly sequence: number;
      readonly accepted: number;
      readonly rejected: readonly string[];
      /** Listings kept from an earlier import because their new entry was refused. */
      readonly retained: readonly string[];
      /** Earlier listings not kept because the new catalog lists their package. */
      readonly dropped: readonly string[];
      readonly diagnostics: readonly CatalogDiagnostic[];
    }
  | {
      readonly status: "rejected";
      readonly code: string;
      readonly sourceId: string | null;
      readonly storedSequence: number | null;
      readonly diagnostics: readonly CatalogDiagnostic[];
    }
  | { readonly status: "failed"; readonly code: string };

export type CuratedListingView = {
  readonly sourceId: string;
  readonly sourceTitle: string;
  /** retained: kept from sequence fromSequence because its newer entry was refused. */
  readonly status: "current" | "retained";
  readonly fromSequence: number;
  readonly listing: CuratedListing;
  readonly versions: ReturnType<typeof listingCompatibility>;
  /** Other sources that list one of this listing's exact package identities. */
  readonly alsoListedBy: readonly string[];
};
export type CuratedCatalogPage =
  | {
      readonly status: "listed";
      readonly sources: readonly {
        readonly id: string;
        readonly title: string | null;
        readonly sequence: number;
        readonly publishedAt: number | null;
        readonly importedAt: number | null;
        /** null when readable; otherwise why its stored record is unavailable. */
        readonly unavailable: string | null;
      }[];
      readonly entries: readonly CuratedListingView[];
      readonly total: number;
      readonly nextOffset: number | null;
    }
  | { readonly status: "failed"; readonly code: string };

export function createCuratedCatalogs(options: {
  readonly store: CuratedCatalogStore;
  readonly now: () => number;
  readonly host: HostFacts;
}) {
  const { store } = options;
  return {
    import(bytes: Uint8Array, signal?: AbortSignal): CuratedImportReceipt {
      if (signal?.aborted) return { status: "failed", code: "cancelled" };
      const ingestion = ingestCuratedCatalog(bytes);
      if (ingestion.kind === "rejected")
        return {
          status: "rejected",
          code: ingestion.diagnostics[0]?.code ?? "catalog-malformed",
          sourceId: null,
          storedSequence: null,
          diagnostics: ingestion.diagnostics,
        };
      const { catalog } = ingestion;
      const found = store.get(catalog.source.id);
      if (!found.ok) return { status: "failed", code: found.error.code };
      const stored = found.value;
      // An unreadable record is never silently replaced; it needs repair first.
      if (stored !== null && stored.record === null)
        return { status: "failed", code: stored.code ?? "catalog-record-corrupt" };
      const decision = decideCuratedImport(
        stored?.record ?? null,
        catalog,
        ingestion.rejected,
        options.now(),
      );
      if (decision.kind === "stale" || decision.kind === "conflict")
        return {
          status: "rejected",
          code: decision.kind === "stale" ? "catalog-stale" : "catalog-sequence-conflict",
          sourceId: catalog.source.id,
          storedSequence: decision.storedSequence,
          diagnostics: ingestion.diagnostics,
        };
      const summary = {
        sourceId: catalog.source.id,
        sequence: catalog.sequence,
        accepted: catalog.entries.length,
        rejected: ingestion.rejected,
        diagnostics: ingestion.diagnostics,
      };
      if (decision.kind === "unchanged")
        return {
          status: "unchanged",
          ...summary,
          retained: decision.record.retained.map((item) => item.listing.listingId),
          dropped: [],
        };
      if (signal?.aborted) return { status: "failed", code: "cancelled" };
      const saved = store.replace(decision.record, stored?.sequence ?? null, signal);
      if (!saved.ok) return { status: "failed", code: saved.error.code };
      return {
        status: "imported",
        ...summary,
        retained: decision.record.retained.map((item) => item.listing.listingId),
        dropped: decision.dropped,
      };
    },

    list(query: CuratedListQuery): CuratedCatalogPage {
      const found = store.list();
      if (!found.ok) return { status: "failed", code: found.error.code };
      const views: Omit<CuratedListingView, "alsoListedBy">[] = [];
      for (const stored of found.value) {
        const record = stored.record;
        if (record === null) continue;
        const source = { sourceId: stored.sourceId, sourceTitle: record.catalog.source.title };
        for (const listing of record.catalog.entries)
          views.push({
            ...source,
            status: "current",
            fromSequence: record.catalog.sequence,
            listing,
            versions: listingCompatibility(listing, options.host),
          });
        for (const item of record.retained)
          views.push({
            ...source,
            status: "retained",
            fromSequence: item.fromSequence,
            listing: item.listing,
            versions: listingCompatibility(item.listing, options.host),
          });
      }
      const sourcesByIdentity = new Map<string, Set<string>>();
      for (const view of views)
        for (const version of view.listing.versions)
          sourcesByIdentity.set(
            version.identityDigest,
            new Set([...(sourcesByIdentity.get(version.identityDigest) ?? []), view.sourceId]),
          );
      const needle = query.text?.toLowerCase();
      const matches = views
        .filter(
          (view) =>
            (query.sourceId === undefined || view.sourceId === query.sourceId) &&
            (query.kind === undefined || view.listing.kind === query.kind) &&
            (needle === undefined ||
              [
                view.listing.listingId,
                view.listing.title,
                view.listing.summary,
                ...view.listing.tags,
              ]
                .join("\n")
                .toLowerCase()
                .includes(needle)),
        )
        .sort((a, b) =>
          a.sourceId !== b.sourceId
            ? a.sourceId < b.sourceId
              ? -1
              : 1
            : a.listing.listingId < b.listing.listingId
              ? -1
              : 1,
        );
      const page = matches.slice(query.offset, query.offset + query.limit).map((view) => ({
        ...view,
        alsoListedBy: [
          ...new Set(
            view.listing.versions.flatMap((version) => [
              ...(sourcesByIdentity.get(version.identityDigest) ?? []),
            ]),
          ),
        ]
          .filter((id) => id !== view.sourceId)
          .sort(),
      }));
      const next = query.offset + page.length;
      return {
        status: "listed",
        sources: found.value.map((stored) => ({
          id: stored.sourceId,
          title: stored.record?.catalog.source.title ?? null,
          sequence: stored.sequence,
          publishedAt: stored.record?.catalog.publishedAt ?? null,
          importedAt: stored.record?.importedAt ?? null,
          unavailable: stored.code,
        })),
        entries: page,
        total: matches.length,
        nextOffset: next < matches.length ? next : null,
      };
    },
  };
}

/** Human lines. Claims read as claims; rank and labels read as editorial, never as trust. */
export function curatedCatalogLines(
  payload: CuratedImportReceipt | CuratedCatalogPage,
): readonly string[] {
  if (payload.status === "failed") return [`Curated catalog: failed (${payload.code})`];
  if (payload.status === "rejected")
    return [
      `Catalog refused: ${payload.code}${payload.storedSequence === null ? "" : ` (stored sequence ${payload.storedSequence})`}`,
      ...payload.diagnostics.map((item) => `  ${item.code} at ${item.path}`),
    ];
  if (payload.status !== "listed")
    return [
      `Catalog ${payload.sourceId} sequence ${payload.sequence}: ${payload.status}; ${payload.accepted} listings accepted, ${payload.rejected.length} refused.`,
      ...(payload.retained.length
        ? [`Kept from an earlier import: ${payload.retained.join(", ")}`]
        : []),
      ...(payload.dropped.length ? [`No longer kept: ${payload.dropped.join(", ")}`] : []),
      ...payload.diagnostics.map(
        (item) => `  ${item.code} at ${item.path}${item.listingId ? ` (${item.listingId})` : ""}`,
      ),
      "Imported metadata is untrusted: it installs, enables and trusts nothing.",
    ];
  const claim = (value: CuratedListing["claims"]["review"]) =>
    value.status === "claimed" ? (value.value ? "yes" : "no") : value.status;
  return [
    ...payload.sources.map(
      (source) =>
        `Source ${source.id} · sequence ${source.sequence}${source.unavailable ? ` · unavailable (${source.unavailable})` : ` · ${source.title}`}`,
    ),
    ...payload.entries.flatMap((view) => [
      `${view.sourceId}:${view.listing.listingId} · ${view.listing.kind} · ${view.listing.title}${view.status === "retained" ? ` · kept from sequence ${view.fromSequence}` : ""}`,
      `  ${view.listing.summary}`,
      `  Versions: ${view.versions
        .map(
          (version) =>
            `${version.packageVersion ?? "unversioned"}${version.withdrawn ? " withdrawn" : ""}${version.compatible ? "" : " incompatible"}`,
        )
        .join(", ")}`,
      `  Catalog claims (unverified): review ${claim(view.listing.claims.review)}, signature ${claim(view.listing.claims.signature)}, tests ${claim(view.listing.claims.tests)}`,
      ...(view.alsoListedBy.length ? [`  Also listed by: ${view.alsoListedBy.join(", ")}`] : []),
    ]),
    `${payload.entries.length} of ${payload.total} listings${payload.nextOffset === null ? "" : `; next offset ${payload.nextOffset}`}.`,
  ];
}
