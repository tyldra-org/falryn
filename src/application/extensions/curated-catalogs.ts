/**
 * Curated catalogs and marketplace discovery (#165, #153). Import ingests one local
 * catalog document; refresh fetches each configured marketplace's document and ingests it
 * through the same path, recording where and when it was fetched. Either one decides the
 * catalog against its source's stored record and compare-and-replaces that record.
 * Listing and inspection read stored metadata only, offline, with each source's dated
 * freshness. Editorial rank and labels never order, filter or trust anything. Nothing
 * here installs, enables or trusts a package.
 */
import { z } from "zod";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import {
  type CatalogDiagnostic,
  type CatalogOrigin,
  CURATED_CONTRIBUTIONS,
  CURATED_KINDS,
  type CuratedCatalogRecord,
  type CuratedCatalogStore,
  type CuratedListing,
  decideCuratedImport,
  ingestCuratedCatalog,
  listingCompatibility,
} from "../../domain/extensions/curated-catalog.ts";
import type { HostFacts } from "../../domain/extensions/manifest.ts";
import {
  type CatalogFreshness,
  catalogFreshness,
  type MarketplaceSource,
  marketplaceCredentialReference,
} from "../../domain/extensions/marketplace.ts";
import { acquisitionLocation } from "../../domain/extensions/package-acquisition.ts";
import type { MarketplaceFetchFailure, MarketplaceFetchPort } from "./marketplace-port.ts";

const sourceIdSchema = z.string().min(1).max(64);
export const curatedListQuerySchema = z.strictObject({
  sourceId: sourceIdSchema.optional(),
  kind: z.enum(CURATED_KINDS).optional(),
  /** Only listings that declare this contribution kind. */
  provides: z.enum(CURATED_CONTRIBUTIONS).optional(),
  /**
   * Case-insensitive match on listing ID, title, summary or tag. A text query ranks by
   * where it matched, then listing ID and source; editorial rank never participates.
   */
  text: z.string().min(1).max(120).optional(),
  /** Only listings with a version that is compatible with this host and not withdrawn. */
  installable: z.boolean().default(false),
  offset: z.int().min(0).max(100_000).default(0),
  limit: z.int().min(1).max(100).default(50),
});
export type CuratedListQuery = z.infer<typeof curatedListQuerySchema>;

export const curatedInspectQuerySchema = z.strictObject({
  sourceId: sourceIdSchema,
  listingId: z.string().min(1).max(129),
  /** An exact listed version; absent selects the newest installable, else the newest. */
  packageVersion: z.string().min(1).max(128).nullable().optional(),
});
export type CuratedInspectQuery = z.infer<typeof curatedInspectQuerySchema>;

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

export type MarketplaceRefreshResult = {
  readonly sourceId: string;
  /** Present when the document was received; its import may still refuse it. */
  readonly fetchedAt: number | null;
  readonly receipt: CuratedImportReceipt;
};
export type MarketplaceRefreshReport =
  | { readonly status: "refreshed"; readonly results: readonly MarketplaceRefreshResult[] }
  | { readonly status: "failed"; readonly code: string };

export type CuratedListingView = {
  readonly sourceId: string;
  readonly sourceTitle: string;
  /** retained: kept from sequence fromSequence because its newer entry was refused. */
  readonly status: "current" | "retained";
  readonly fromSequence: number;
  readonly freshness: CatalogFreshness;
  readonly listing: CuratedListing;
  readonly versions: ReturnType<typeof listingCompatibility>;
  /** Other sources that list one of this listing's exact package identities. */
  readonly alsoListedBy: readonly string[];
};
export type CuratedSourceSummary = {
  readonly id: string;
  readonly title: string | null;
  readonly sequence: number;
  readonly publishedAt: number | null;
  readonly importedAt: number | null;
  /** null when readable; otherwise why its stored record is unavailable. */
  readonly unavailable: string | null;
  readonly origin: CatalogOrigin | null;
  readonly freshness: CatalogFreshness | null;
};
export type CuratedCatalogPage =
  | {
      readonly status: "listed";
      readonly sources: readonly CuratedSourceSummary[];
      readonly entries: readonly CuratedListingView[];
      readonly total: number;
      readonly nextOffset: number | null;
    }
  | { readonly status: "failed"; readonly code: string };

/**
 * Everything shown before an install decision about one exact version. Catalog claims
 * stay claims; the executable profile is only known after local package inspection; and
 * a marketplace cannot deliver package bytes yet, so install is an explicit handoff.
 */
export type CuratedInspection =
  | {
      readonly status: "inspected";
      readonly source: CuratedSourceSummary;
      /** Digest of the normalized catalog these facts were read from. */
      readonly catalogDigest: string;
      readonly view: CuratedListingView;
      readonly version: {
        readonly identity: CuratedListing["versions"][number]["identity"];
        readonly identityDigest: string;
        readonly publishedAt: number;
        readonly compatible: boolean;
        readonly compatibility: CuratedListing["versions"][number]["compatibility"];
        readonly withdrawn: CuratedListing["versions"][number]["withdrawn"];
      };
      readonly executableProfile: "unknown-until-local-inspection";
      readonly install:
        | {
            readonly status: "refused";
            readonly code: "version-withdrawn" | "version-incompatible" | "source-not-current";
          }
        | {
            /** The listed bytes can be acquired by package install or update (#1210). */
            readonly status: "available";
            readonly download: string;
            /** marketplace: the listing marketplace's credential is sent to this origin only. */
            readonly credential: "marketplace" | "none";
            readonly identityDigest: string;
          }
        | {
            readonly status: "unavailable";
            readonly code: "acquisition-source-unsupported" | "acquisition-insecure-origin";
            /** The listed exact identity; a package obtained another way is compared by hand. */
            readonly identityDigest: string;
          };
    }
  | {
      readonly status: "not-found";
      readonly code: "listing-not-found" | "version-not-found" | "listing-source-disabled";
    }
  | { readonly status: "failed"; readonly code: string };

type StoredView = Omit<CuratedListingView, "alsoListedBy"> & {
  readonly record: CuratedCatalogRecord;
};

const installable = (view: Pick<CuratedListingView, "versions">) =>
  view.versions.some((version) => version.compatible && !version.withdrawn);

/** Lower is a better match; null is no match. */
function matchRank(listing: CuratedListing, needle: string): number | null {
  const id = listing.listingId.toLowerCase();
  const title = listing.title.toLowerCase();
  const tags = listing.tags;
  if (id === needle || title === needle || id.endsWith(`/${needle}`)) return 0;
  if (title.startsWith(needle) || id.split("/").some((part) => part.startsWith(needle))) return 1;
  if (id.includes(needle) || title.includes(needle)) return 2;
  if (tags.includes(needle)) return 3;
  if (tags.some((tag) => tag.includes(needle)) || listing.summary.toLowerCase().includes(needle))
    return 4;
  return null;
}

export function createCuratedCatalogs(options: {
  readonly store: CuratedCatalogStore;
  readonly now: () => number;
  readonly host: HostFacts;
  /** Configured marketplaces, or null when configuration could not be read. */
  readonly marketplaces?: () => readonly MarketplaceSource[] | null;
  readonly fetch?: MarketplaceFetchPort;
}) {
  const { store } = options;
  const marketplaces = () => (options.marketplaces ? options.marketplaces() : []);

  function admit(
    bytes: Uint8Array,
    signal: AbortSignal | undefined,
    origin: CatalogOrigin,
    expectedSourceId: string | null,
  ): CuratedImportReceipt {
    if (signal?.aborted) return { status: "failed", code: "cancelled" };
    const ingestion = ingestCuratedCatalog(bytes);
    if (ingestion.kind === "rejected")
      return {
        status: "rejected",
        code: ingestion.diagnostics[0]?.code ?? "catalog-malformed",
        sourceId: expectedSourceId,
        storedSequence: null,
        diagnostics: ingestion.diagnostics,
      };
    const { catalog } = ingestion;
    // A marketplace can only publish its own source; it can never overwrite another's.
    if (expectedSourceId !== null && catalog.source.id !== expectedSourceId)
      return {
        status: "rejected",
        code: "marketplace-source-mismatch",
        sourceId: expectedSourceId,
        storedSequence: null,
        diagnostics: [
          { code: "marketplace-source-mismatch", path: "/source/id", entry: null, listingId: null },
        ],
      };
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
      origin,
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
      retained: decision.record.retained.map((item) => item.listing.listingId),
    };
    if (decision.kind === "unchanged" && !decision.refreshed)
      return { status: "unchanged", ...summary, dropped: [] };
    if (signal?.aborted) return { status: "failed", code: "cancelled" };
    const saved = store.replace(decision.record, stored?.sequence ?? null, signal);
    if (!saved.ok) return { status: "failed", code: saved.error.code };
    return decision.kind === "unchanged"
      ? { status: "unchanged", ...summary, dropped: [] }
      : { status: "imported", ...summary, dropped: decision.dropped };
  }

  function stored():
    | { ok: true; views: StoredView[]; sources: CuratedSourceSummary[] }
    | { ok: false; code: string } {
    const found = store.list();
    if (!found.ok) return { ok: false, code: found.error.code };
    const configured = marketplaces();
    const now = options.now();
    const views: StoredView[] = [];
    const sources: CuratedSourceSummary[] = [];
    for (const row of found.value) {
      const record = row.record;
      const freshness =
        record === null ? null : catalogFreshness(record.origin, row.sourceId, configured, now);
      sources.push({
        id: row.sourceId,
        title: record?.catalog.source.title ?? null,
        sequence: row.sequence,
        publishedAt: record?.catalog.publishedAt ?? null,
        importedAt: record?.importedAt ?? null,
        unavailable: row.code,
        origin: record?.origin ?? null,
        freshness,
      });
      if (record === null || freshness === null) continue;
      const common = {
        sourceId: row.sourceId,
        sourceTitle: record.catalog.source.title,
        freshness,
        record,
      };
      for (const listing of record.catalog.entries)
        views.push({
          ...common,
          status: "current",
          fromSequence: record.catalog.sequence,
          listing,
          versions: listingCompatibility(listing, options.host),
        });
      for (const item of record.retained)
        views.push({
          ...common,
          status: "retained",
          fromSequence: item.fromSequence,
          listing: item.listing,
          versions: listingCompatibility(item.listing, options.host),
        });
    }
    return { ok: true, views, sources };
  }

  function withSources(views: readonly StoredView[]) {
    const sourcesByIdentity = new Map<string, Set<string>>();
    for (const view of views)
      for (const version of view.listing.versions)
        sourcesByIdentity.set(
          version.identityDigest,
          new Set([...(sourcesByIdentity.get(version.identityDigest) ?? []), view.sourceId]),
        );
    return ({ record: _record, ...view }: StoredView): CuratedListingView => ({
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
    });
  }

  return {
    import(bytes: Uint8Array, signal?: AbortSignal): CuratedImportReceipt {
      return admit(bytes, signal, { kind: "file" }, null);
    },

    /**
     * Fetch and import each selected enabled marketplace in configuration order. One
     * failure never stops the others or changes that source's cached catalog.
     */
    async refresh(sourceId: string | null, signal: AbortSignal): Promise<MarketplaceRefreshReport> {
      const configured = marketplaces();
      if (configured === null)
        return { status: "failed", code: "marketplace-configuration-unavailable" };
      if (options.fetch === undefined) return { status: "failed", code: "marketplace-unavailable" };
      const selected =
        sourceId === null
          ? configured.filter((source) => source.enabled)
          : configured.filter((source) => source.id === sourceId);
      if (sourceId !== null && selected.length === 0)
        return { status: "failed", code: "marketplace-unknown" };
      if (selected.length === 0) return { status: "failed", code: "marketplace-none-enabled" };
      const results: MarketplaceRefreshResult[] = [];
      const failed = (source: MarketplaceSource, code: string): MarketplaceRefreshResult => ({
        sourceId: source.id,
        fetchedAt: null,
        receipt: { status: "failed", code },
      });
      for (const source of selected) {
        if (!source.enabled) {
          results.push(failed(source, "marketplace-disabled"));
          continue;
        }
        if (signal.aborted) {
          results.push(failed(source, "marketplace-cancelled" satisfies MarketplaceFetchFailure));
          continue;
        }
        const fetched = await options.fetch.fetch(source, signal);
        if (fetched.kind === "failed") {
          results.push(failed(source, fetched.code));
          continue;
        }
        const receipt = admit(
          fetched.bytes,
          signal,
          {
            kind: "marketplace",
            url: source.url,
            fetchedAt: fetched.fetchedAt,
            bodyDigest: bytesDigest(fetched.bytes),
          },
          source.id,
        );
        results.push({ sourceId: source.id, fetchedAt: fetched.fetchedAt, receipt });
      }
      return { status: "refreshed", results };
    },

    list(query: CuratedListQuery): CuratedCatalogPage {
      const found = stored();
      if (!found.ok) return { status: "failed", code: found.code };
      const needle = query.text?.toLowerCase();
      const ranked = found.views
        // A disabled marketplace's listings are withheld until it is enabled again.
        .filter((view) => view.freshness.state !== "disabled")
        .filter(
          (view) =>
            (query.sourceId === undefined || view.sourceId === query.sourceId) &&
            (query.kind === undefined || view.listing.kind === query.kind) &&
            (query.provides === undefined || view.listing.provides.includes(query.provides)) &&
            (!query.installable || installable(view)),
        )
        .map((view) => ({
          view,
          rank: needle === undefined ? 0 : matchRank(view.listing, needle),
        }))
        .filter((item): item is { view: StoredView; rank: number } => item.rank !== null)
        .sort((a, b) =>
          a.rank !== b.rank
            ? a.rank - b.rank
            : needle !== undefined && a.view.listing.listingId !== b.view.listing.listingId
              ? a.view.listing.listingId < b.view.listing.listingId
                ? -1
                : 1
              : a.view.sourceId !== b.view.sourceId
                ? a.view.sourceId < b.view.sourceId
                  ? -1
                  : 1
                : a.view.listing.listingId < b.view.listing.listingId
                  ? -1
                  : 1,
        );
      const project = withSources(found.views);
      const page = ranked
        .slice(query.offset, query.offset + query.limit)
        .map((item) => project(item.view));
      const next = query.offset + page.length;
      return {
        status: "listed",
        sources: found.sources,
        entries: page,
        total: ranked.length,
        nextOffset: next < ranked.length ? next : null,
      };
    },

    inspect(query: CuratedInspectQuery): CuratedInspection {
      const found = stored();
      if (!found.ok) return { status: "failed", code: found.code };
      const match = found.views.find(
        (view) => view.sourceId === query.sourceId && view.listing.listingId === query.listingId,
      );
      if (match === undefined) return { status: "not-found", code: "listing-not-found" };
      if (match.freshness.state === "disabled")
        return { status: "not-found", code: "listing-source-disabled" };
      const view = withSources(found.views)(match);
      const facts = (index: number) => ({
        listed: match.listing.versions[index],
        compat: view.versions[index],
      });
      let index: number;
      if (query.packageVersion !== undefined) {
        index = match.listing.versions.findIndex(
          (version) => version.identity.packageVersion === query.packageVersion,
        );
        if (index < 0) return { status: "not-found", code: "version-not-found" };
      } else {
        const best = view.versions.findIndex((version) => version.compatible && !version.withdrawn);
        index = best < 0 ? 0 : best;
      }
      const { listed, compat } = facts(index);
      if (listed === undefined || compat === undefined)
        return { status: "not-found", code: "version-not-found" };
      const source = found.sources.find((item) => item.id === match.sourceId);
      if (source === undefined) return { status: "failed", code: "catalog-record-corrupt" };
      // Stale or unconfigured withdrawal facts cannot vouch for an install; refresh first.
      const current = match.freshness.state === "local" || match.freshness.state === "fresh";
      const location = acquisitionLocation(listed.identity);
      const origin = match.record.origin;
      const marketplace =
        origin.kind === "marketplace"
          ? (marketplaces() ?? []).find(
              (candidate) => candidate.id === match.sourceId && candidate.url === origin.url,
            )
          : undefined;
      const credential =
        location.ok &&
        marketplace !== undefined &&
        marketplaceCredentialReference(marketplace) !== null &&
        new URL(location.url).origin === new URL(marketplace.url).origin
          ? ("marketplace" as const)
          : ("none" as const);
      return {
        status: "inspected",
        source,
        catalogDigest: match.record.catalog.digest,
        view,
        version: {
          identity: listed.identity,
          identityDigest: listed.identityDigest,
          publishedAt: listed.publishedAt,
          compatible: compat.compatible,
          compatibility: listed.compatibility,
          withdrawn: listed.withdrawn,
        },
        executableProfile: "unknown-until-local-inspection",
        install:
          listed.withdrawn !== null
            ? { status: "refused", code: "version-withdrawn" }
            : !compat.compatible
              ? { status: "refused", code: "version-incompatible" }
              : !current
                ? { status: "refused", code: "source-not-current" }
                : location.ok
                  ? {
                      status: "available",
                      download: location.url,
                      credential,
                      identityDigest: listed.identityDigest,
                    }
                  : {
                      status: "unavailable",
                      code: location.code,
                      identityDigest: listed.identityDigest,
                    },
      };
    },
  };
}

const iso = (at: number) => new Date(at).toISOString();

/** Freshness in words: a date and its basis, never a claim that advisories are current. */
export function freshnessText(freshness: CatalogFreshness): string {
  switch (freshness.state) {
    case "local":
      return "imported from a file; no freshness claim";
    case "fresh":
      return `fetched ${iso(freshness.fetchedAt)}`;
    case "stale":
      return (
        "stale: fetched " +
        iso(freshness.fetchedAt) +
        ", older than " +
        freshness.maxAgeHours +
        "h; withdrawals may be out of date"
      );
    case "unconfigured":
      return `fetched ${iso(freshness.fetchedAt)} from a location no longer configured`;
    case "disabled":
      return "marketplace disabled; listings withheld";
    case "unknown":
      return `fetched ${iso(freshness.fetchedAt)}; configuration unreadable`;
  }
}

function receiptLines(payload: CuratedImportReceipt): string[] {
  if (payload.status === "failed") return [`Curated catalog: failed (${payload.code})`];
  if (payload.status === "rejected")
    return [
      "Catalog refused: " +
        payload.code +
        (payload.storedSequence === null ? "" : ` (stored sequence ${payload.storedSequence})`),
      ...payload.diagnostics.map((item) => `  ${item.code} at ${item.path}`),
    ];
  return [
    "Catalog " +
      payload.sourceId +
      " sequence " +
      payload.sequence +
      ": " +
      payload.status +
      "; " +
      payload.accepted +
      " listings accepted, " +
      payload.rejected.length +
      " refused.",
    ...(payload.retained.length
      ? [`Kept from an earlier import: ${payload.retained.join(", ")}`]
      : []),
    ...(payload.dropped.length ? [`No longer kept: ${payload.dropped.join(", ")}`] : []),
    ...payload.diagnostics.map(
      (item) => `  ${item.code} at ${item.path}${item.listingId ? ` (${item.listingId})` : ""}`,
    ),
  ];
}

const claimText = (value: CuratedListing["claims"]["review"]) =>
  value.status === "claimed" ? (value.value ? "yes" : "no") : value.status;
const claimsLine = (listing: CuratedListing) =>
  "  Catalog claims (unverified): review " +
  claimText(listing.claims.review) +
  ", signature " +
  claimText(listing.claims.signature) +
  ", tests " +
  claimText(listing.claims.tests);

export type CuratedCatalogPayload =
  | CuratedImportReceipt
  | CuratedCatalogPage
  | MarketplaceRefreshReport
  | CuratedInspection;

/** Human lines. Claims read as claims; rank and labels read as editorial, never as trust. */
export function curatedCatalogLines(payload: CuratedCatalogPayload): readonly string[] {
  if (payload.status === "failed") return [`Curated catalog: failed (${payload.code})`];
  if (payload.status === "rejected") return receiptLines(payload);
  if (payload.status === "refreshed")
    return [
      ...payload.results.flatMap((result) => [
        "Marketplace " +
          result.sourceId +
          (result.fetchedAt === null ? ": not fetched" : `: fetched ${iso(result.fetchedAt)}`),
        ...receiptLines(result.receipt).map((line) => `  ${line}`),
      ]),
      "Refreshed metadata is untrusted: it installs, enables and trusts nothing.",
    ];
  if (
    payload.status !== "listed" &&
    payload.status !== "not-found" &&
    payload.status !== "inspected"
  )
    return [
      ...receiptLines(payload),
      "Imported metadata is untrusted: it installs, enables and trusts nothing.",
    ];
  if (payload.status === "not-found") return [`Listing: ${payload.code}`];
  if (payload.status === "inspected") {
    const { view, version, source } = payload;
    const withdrawn = version.withdrawn;
    return [
      view.sourceId +
        ":" +
        view.listing.listingId +
        " · " +
        view.listing.kind +
        " · " +
        view.listing.title,
      `  ${view.listing.summary}`,
      "  Publisher: " +
        view.listing.publisher.name +
        (view.listing.license ? ` · license ${view.listing.license}` : ""),
      "  Source: " +
        (source.origin?.kind === "marketplace" ? source.origin.url : "local file") +
        " · sequence " +
        source.sequence +
        " · " +
        freshnessText(view.freshness),
      "  Version: " +
        (version.identity.packageVersion ?? "unversioned") +
        " · package " +
        version.identity.packageId +
        " · identity " +
        version.identityDigest,
      "  Compatibility: " +
        (version.compatible ? "compatible with this host" : "incompatible with this host"),
      "  Withdrawal: " +
        (withdrawn === null
          ? "not withdrawn"
          : `withdrawn (${withdrawn.reason}, ${iso(withdrawn.at)})`) +
        (view.freshness.state === "local" ? "" : " as of the fetch above"),
      "  Contributes: " +
        (view.listing.provides.length ? view.listing.provides.join(", ") : "not declared"),
      claimsLine(view.listing),
      "  Executable profile: unknown until the package is inspected locally.",
      ...(view.alsoListedBy.length ? [`  Also listed by: ${view.alsoListedBy.join(", ")}`] : []),
      payload.install.status === "refused"
        ? `Install: refused (${payload.install.code}).`
        : payload.install.status === "available"
          ? `Install: available from ${payload.install.download}${payload.install.credential === "marketplace" ? " with the marketplace credential" : ""}; package install with this listing must reproduce identity ${payload.install.identityDigest}.`
          : `Install: unavailable (${payload.install.code}). A package obtained another way must match package ${version.identity.packageDigest} and manifest ${version.identity.manifestDigest}.`,
    ];
  }
  return [
    ...payload.sources.map(
      (source) =>
        "Source " +
        source.id +
        " · sequence " +
        source.sequence +
        (source.unavailable
          ? ` · unavailable (${source.unavailable})`
          : " · " +
            source.title +
            (source.freshness ? ` · ${freshnessText(source.freshness)}` : "")),
    ),
    ...payload.entries.flatMap((view) => [
      view.sourceId +
        ":" +
        view.listing.listingId +
        " · " +
        view.listing.kind +
        " · " +
        view.listing.title +
        (view.status === "retained" ? ` · kept from sequence ${view.fromSequence}` : ""),
      `  ${view.listing.summary}`,
      "  Versions: " +
        view.versions
          .map(
            (version) =>
              (version.packageVersion ?? "unversioned") +
              (version.withdrawn ? " withdrawn" : "") +
              (version.compatible ? "" : " incompatible"),
          )
          .join(", "),
      claimsLine(view.listing),
      ...(view.alsoListedBy.length ? [`  Also listed by: ${view.alsoListedBy.join(", ")}`] : []),
    ]),
    payload.entries.length +
      " of " +
      payload.total +
      " listings" +
      (payload.nextOffset === null ? "" : `; next offset ${payload.nextOffset}`) +
      ".",
  ];
}
