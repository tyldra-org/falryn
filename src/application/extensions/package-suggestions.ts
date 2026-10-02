/**
 * Verified package suggestions (#1094). Observations come from admitted commands and
 * workspace tools; this owner checks each one against the catalogs the user opted
 * into and the current catalog facts, every time it is read. A hint names a package,
 * but only the catalog decides what that package is, and a dismissed, revoked,
 * withdrawn or stale listing never offers an install. Install is a handoff to
 * `falryn package install --listing`, which inspects and confirms again.
 */
import type { CatalogFreshness, MarketplaceSource } from "../../domain/extensions/marketplace.ts";
import {
  executableName,
  isDismissed,
  PACKAGE_SUGGESTION_LIMITS,
  PACKAGE_SUGGESTIONS_KEY,
  type PackageHint,
  type PackageSuggestionPreferences,
  type PackageSuggestionRecord,
  type PackageSuggestionSummary,
  packageSuggestionId,
  relevanceMatch,
  type SuggestionReason,
  type SuggestionSignal,
  scanPackageHints,
  suggestionReasonText,
} from "../../domain/extensions/package-suggestion.ts";
import type { ToolCapabilityKind } from "../../domain/tools/tool-registry.ts";
import {
  type CuratedInspection,
  type CuratedListingView,
  type createCuratedCatalogs,
  freshnessText,
} from "./curated-catalogs.ts";

export type SuggestionObservation =
  | {
      readonly kind: "hint";
      readonly hint: PackageHint;
      readonly executable: string | null;
      readonly invocationId: string;
    }
  | { readonly kind: "signal"; readonly signal: SuggestionSignal };

export type SuggestionRefusalCode =
  | "suggestion-source-not-enabled"
  | "suggestion-source-unauthenticated"
  | "suggestion-identity-mismatch"
  | "listing-not-found"
  | "listing-source-disabled"
  | "version-not-found";

/** A hint that named nothing installable. Kept so a spoofed hint is visible, never acted on. */
export type SuggestionRefusal = {
  readonly code: SuggestionRefusalCode;
  readonly sourceId: string;
  readonly listingId: string;
  /** The invocation, recorded turn or `inspect` request that named it. */
  readonly origin: string;
};

export type PackageSuggestionView = {
  readonly suggestionId: string;
  readonly sourceId: string;
  readonly listingId: string;
  readonly packageId: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: string;
  readonly version: {
    readonly packageVersion: string | null;
    readonly identityDigest: string;
  } | null;
  readonly reasons: readonly SuggestionReason[];
  readonly freshness: CatalogFreshness;
  readonly install:
    | Extract<CuratedInspection, { status: "inspected" }>["install"]
    | {
        readonly status: "refused";
        readonly code: "suggestion-dismissed";
      };
  readonly state: "suggested" | "dismissed";
  /** The exact request `package install` accepts; present only while install is available. */
  readonly handoff: {
    readonly listing: {
      readonly sourceId: string;
      readonly listingId: string;
      readonly packageVersion: string | null;
    };
  } | null;
};

export type PackageSuggestionPage =
  | {
      readonly status: "resolved";
      readonly suggestions: readonly PackageSuggestionView[];
      readonly refusals: readonly SuggestionRefusal[];
    }
  | { readonly status: "failed"; readonly code: string };

type Catalogs = Pick<ReturnType<typeof createCuratedCatalogs>, "list" | "inspect">;

export type PackageSuggestionResolverOptions = {
  readonly catalogs: Catalogs;
  /** Current user preferences, or null when configuration could not be read. */
  readonly preferences: () => PackageSuggestionPreferences | null;
  /** Configured marketplaces, or null when configuration could not be read. */
  readonly marketplaces: () => readonly MarketplaceSource[] | null;
};

/** A catalog fetched from a configured marketplace; a file import has no publisher to authenticate. */
const authenticated = (freshness: CatalogFreshness) => freshness.state !== "local";

/** Every listing an enabled source holds, a bounded page at a time (a catalog has at most 512). */
function enabledListings(
  catalogs: Catalogs,
  sources: readonly string[],
): { ok: true; views: CuratedListingView[] } | { ok: false; code: string } {
  const views: CuratedListingView[] = [];
  for (const sourceId of sources) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = catalogs.list({ sourceId, installable: false, offset, limit: 100 });
      if (page.status === "failed") return { ok: false, code: page.code };
      views.push(...page.entries);
      offset = page.nextOffset;
    }
  }
  return { ok: true, views };
}

export function createPackageSuggestionResolver(options: PackageSuggestionResolverOptions) {
  function view(
    inspected: Extract<CuratedInspection, { status: "inspected" }>,
    reasons: readonly SuggestionReason[],
    preferences: PackageSuggestionPreferences,
  ): PackageSuggestionView {
    const listing = inspected.view.listing;
    const packageId = inspected.version.identity.packageId;
    const dismissed = isDismissed(preferences, inspected.view.sourceId, packageId);
    const install = dismissed
      ? ({ status: "refused", code: "suggestion-dismissed" } as const)
      : inspected.install;
    return {
      suggestionId: packageSuggestionId(inspected.view.sourceId, packageId),
      sourceId: inspected.view.sourceId,
      listingId: listing.listingId,
      packageId,
      title: listing.title,
      summary: listing.summary,
      kind: listing.kind,
      version: {
        packageVersion: inspected.version.identity.packageVersion,
        identityDigest: inspected.version.identityDigest,
      },
      reasons: reasons.slice(0, PACKAGE_SUGGESTION_LIMITS.reasons),
      freshness: inspected.view.freshness,
      install,
      state: dismissed ? "dismissed" : "suggested",
      handoff:
        install.status === "available"
          ? {
              listing: {
                sourceId: inspected.view.sourceId,
                listingId: listing.listingId,
                packageVersion: inspected.version.identity.packageVersion,
              },
            }
          : null,
    };
  }

  /** A named package, from a hint, a recorded turn or an explicit inspect request. */
  type Named = {
    readonly sourceId: string;
    readonly listingId: string;
    readonly packageId: string;
    readonly packageVersion: string | null;
    readonly reasons: readonly SuggestionReason[];
    /** Where the name came from: an invocation, a recorded turn or `inspect`. */
    readonly origin: string;
  };
  type Entry = Omit<Named, "origin" | "reasons"> & {
    reasons: SuggestionReason[];
    /** The first name that admitted this entry, for a refusal if its facts change. */
    origin: string;
  };

  function begin() {
    const preferences = options.preferences();
    if (preferences === null) return null;
    const configured = options.marketplaces();
    // A source counts only while it is both opted in and still a configured marketplace.
    const enabled = preferences.sources.filter((id) =>
      (configured ?? []).some((source) => source.id === id),
    );
    const found = new Map<string, Entry>();
    const refusals: SuggestionRefusal[] = [];
    const note = (key: Omit<Entry, "reasons">, reasons: readonly SuggestionReason[]) => {
      const id = packageSuggestionId(key.sourceId, key.packageId);
      const entry = found.get(id) ?? { ...key, reasons: [] };
      found.set(id, entry);
      for (const reason of reasons)
        if (
          entry.reasons.length < PACKAGE_SUGGESTION_LIMITS.reasons &&
          !entry.reasons.some((item) => JSON.stringify(item) === JSON.stringify(reason))
        )
          entry.reasons.push(reason);
    };
    /**
     * Admit a named package only from an opted-in, authenticated catalog that lists that
     * exact package. The namer is untrusted: it may name a real listing but another package.
     */
    const refuseFor =
      (named: Pick<Named, "sourceId" | "listingId" | "origin">) =>
      (code: SuggestionRefusalCode) => {
        refusals.push({
          code,
          sourceId: named.sourceId,
          listingId: named.listingId,
          origin: named.origin,
        });
        return null;
      };
    const admit = (named: Named): string | null => {
      const refuse = refuseFor(named);
      if (!enabled.includes(named.sourceId)) return refuse("suggestion-source-not-enabled");
      const inspected = options.catalogs.inspect({
        sourceId: named.sourceId,
        listingId: named.listingId,
        ...(named.packageVersion === null ? {} : { packageVersion: named.packageVersion }),
      });
      if (inspected.status === "failed") return inspected.code;
      if (inspected.status === "not-found") return refuse(inspected.code);
      if (!authenticated(inspected.view.freshness))
        return refuse("suggestion-source-unauthenticated");
      if (inspected.version.identity.packageId !== named.packageId)
        return refuse("suggestion-identity-mismatch");
      note(
        {
          sourceId: named.sourceId,
          listingId: named.listingId,
          packageId: named.packageId,
          packageVersion: named.packageVersion,
          origin: named.origin,
        },
        named.reasons,
      );
      return null;
    };
    /**
     * Present every admitted entry from facts read now: a withdrawal, removal or disabled
     * source wins. The catalog may have been replaced since admission, so identity and
     * authentication are checked again on the facts actually presented; a listing that
     * now names another package, or became a file import, is refused rather than shown.
     */
    const finish = (): PackageSuggestionPage => {
      const suggestions: PackageSuggestionView[] = [];
      for (const entry of found.values()) {
        const inspected = options.catalogs.inspect({
          sourceId: entry.sourceId,
          listingId: entry.listingId,
          ...(entry.packageVersion === null ? {} : { packageVersion: entry.packageVersion }),
        });
        if (inspected.status === "failed") return { status: "failed", code: inspected.code };
        if (inspected.status !== "inspected") continue;
        const refuse = refuseFor(entry);
        if (!authenticated(inspected.view.freshness)) {
          refuse("suggestion-source-unauthenticated");
          continue;
        }
        if (inspected.version.identity.packageId !== entry.packageId) {
          refuse("suggestion-identity-mismatch");
          continue;
        }
        suggestions.push(view(inspected, entry.reasons, preferences));
      }
      return { status: "resolved", suggestions, refusals };
    };
    return { enabled, note, admit, finish };
  }

  const unavailable: PackageSuggestionPage = {
    status: "failed",
    code: "suggestion-preferences-unavailable",
  };

  /** Admit names in order; a storage failure stops the whole read. */
  function current(named: readonly Named[]): PackageSuggestionPage {
    const run = begin();
    if (run === null) return unavailable;
    for (const item of named) {
      const failed = run.admit(item);
      if (failed !== null) return { status: "failed", code: failed };
    }
    return run.finish();
  }

  return {
    /** Resolve observations against current preferences and catalogs, in observation order. */
    resolve(observations: readonly SuggestionObservation[]): PackageSuggestionPage {
      const run = begin();
      if (run === null) return unavailable;
      for (const observation of observations) {
        if (observation.kind !== "hint") continue;
        const { hint } = observation;
        const failed = run.admit({
          ...hint,
          origin: observation.invocationId,
          reasons: [
            {
              kind: "hint",
              executable: observation.executable,
              invocationId: observation.invocationId,
            },
          ],
        });
        if (failed !== null) return { status: "failed", code: failed };
      }
      const signals = observations.flatMap((item) => (item.kind === "signal" ? [item.signal] : []));
      if (signals.length > 0) {
        const listings = enabledListings(options.catalogs, run.enabled);
        if (!listings.ok) return { status: "failed", code: listings.code };
        for (const listingView of listings.views) {
          const declaration = listingView.listing.relevance;
          if (declaration === undefined || !authenticated(listingView.freshness)) continue;
          const packageId = listingView.listing.versions[0]?.identity.packageId;
          if (packageId === undefined) continue;
          for (const signal of signals) {
            const rule = relevanceMatch(declaration, signal);
            if (rule === null) continue;
            run.note(
              {
                sourceId: listingView.sourceId,
                listingId: listingView.listing.listingId,
                packageId,
                packageVersion: null,
                origin: `relevance:${signal.kind}`,
              },
              [{ kind: "relevance", signal: signal.kind, rule }],
            );
          }
        }
      }
      return run.finish();
    },

    /** Current facts for suggestions a session recorded; replay never rematches. */
    recorded(
      records: readonly { readonly origin: string; readonly record: PackageSuggestionRecord }[],
    ) {
      return current(
        records.flatMap(({ origin, record }) =>
          [record.surfaced, ...record.additional].map((item) => ({
            sourceId: item.sourceId,
            listingId: item.listingId,
            packageId: item.packageId,
            packageVersion: item.packageVersion,
            reasons: item.reasons,
            origin,
          })),
        ),
      );
    },

    /** One named package, as an install decision would see it now. */
    inspect(named: {
      readonly sourceId: string;
      readonly listingId: string;
      readonly packageId: string;
      readonly packageVersion: string | null;
    }): PackageSuggestionPage {
      return current([{ ...named, reasons: [], origin: "inspect" }]);
    },
  };
}

export type PackageSuggestionResolver = ReturnType<typeof createPackageSuggestionResolver>;

export const summarizeSuggestion = (
  suggestion: PackageSuggestionView,
): PackageSuggestionSummary => ({
  suggestionId: suggestion.suggestionId,
  sourceId: suggestion.sourceId,
  listingId: suggestion.listingId,
  packageId: suggestion.packageId,
  packageVersion: suggestion.version?.packageVersion ?? null,
  identityDigest: suggestion.version?.identityDigest ?? null,
  title: suggestion.title.slice(0, 120),
  reasons: [...suggestion.reasons],
});

/**
 * One session's observations. Command output and workspace paths are noted as facts;
 * nothing is resolved or shown until a root turn settles or the user asks. Each
 * suggestion surfaces unsolicited at most once per session and at most one per turn.
 */
export function createPackageSuggestionSession(resolver: () => PackageSuggestionResolver | null) {
  const observations: SuggestionObservation[] = [];
  const keys = new Set<string>();
  const surfaced = new Set<string>();
  let omitted = 0;
  const add = (key: string, observation: SuggestionObservation) => {
    if (keys.has(key)) return;
    if (observations.length >= PACKAGE_SUGGESTION_LIMITS.sessionObservations) {
      omitted += 1;
      return;
    }
    keys.add(key);
    observations.push(observation);
  };

  return {
    /**
     * Note an admitted command's exact stderr. Only argv-mode commands carry a program
     * name; shell text is never parsed for one.
     */
    observeCommand(input: {
      readonly stderr: Uint8Array;
      readonly executablePath: string | null;
      readonly invocationId: string;
    }) {
      const executable =
        input.executablePath === null ? null : executableName(input.executablePath);
      if (executable !== null)
        add(`signal:executable:${executable}`, {
          kind: "signal",
          signal: { kind: "executable", name: executable },
        });
      const scan = scanPackageHints(input.stderr);
      for (const hint of scan.hints)
        add(`hint:${JSON.stringify(hint)}`, {
          kind: "hint",
          hint,
          executable,
          invocationId: input.invocationId,
        });
      return scan;
    },
    /** Note workspace-relative paths a workspace tool has already resolved. */
    observePaths(paths: readonly string[]) {
      for (const path of paths)
        if (path.length > 0 && path.length <= 1_024 && !path.startsWith("/"))
          add(`signal:file:${path}`, { kind: "signal", signal: { kind: "file", path } });
    },
    /** Note the kind of a capability a completed, non-hook call used; never its input or output. */
    observeCapability(capability: ToolCapabilityKind) {
      add(`signal:capability:${capability}`, {
        kind: "signal",
        signal: { kind: "capability", capability },
      });
    },
    observations: (): readonly SuggestionObservation[] => [...observations],
    omitted: () => omitted,
    /** The explicit list: every resolved suggestion, surfaced or not. */
    list(): PackageSuggestionPage {
      const current = resolver();
      if (current === null) return { status: "failed", code: "suggestion-owner-unavailable" };
      return current.resolve(observations);
    },
    /**
     * At a settled root turn, choose at most one installable, undismissed suggestion
     * not surfaced before, and record the other eligible matches for the explicit list.
     */
    settleRootTurn(): PackageSuggestionRecord | null {
      if (observations.length === 0) return null;
      const current = resolver();
      if (current === null) return null;
      const page = current.resolve(observations);
      if (page.status !== "resolved") return null;
      const eligible = page.suggestions.filter(
        (item) => item.install.status === "available" && !surfaced.has(item.suggestionId),
      );
      const [first, ...rest] = eligible;
      if (first === undefined) return null;
      surfaced.add(first.suggestionId);
      return {
        version: 1,
        surfaced: summarizeSuggestion(first),
        additional: rest.slice(0, PACKAGE_SUGGESTION_LIMITS.additional).map(summarizeSuggestion),
      };
    },
  };
}

export type PackageSuggestionSession = ReturnType<typeof createPackageSuggestionSession>;

/** Install state in words; available always names the confirming handoff, never an install. */
function installText(suggestion: PackageSuggestionView): string {
  const install = suggestion.install;
  if (install.status === "available")
    return (
      "Install: available after review. Run `falryn package install` with listing " +
      JSON.stringify(suggestion.handoff?.listing ?? null) +
      "; it inspects and asks for confirmation again."
    );
  if (install.status === "unavailable") return `Install: unavailable (${install.code}).`;
  return `Install: refused (${install.code}).`;
}

/**
 * Human lines for one resolved page, shared by `/suggestions` and the CLI so both show
 * the same identity, reasons, freshness and refusal state.
 */
export function packageSuggestionLines(
  page: PackageSuggestionPage,
  context: { readonly proposals?: readonly string[]; readonly omitted?: number } = {},
): readonly string[] {
  if (page.status === "failed") return [`Package suggestions: unavailable (${page.code}).`];
  const lines: string[] = [];
  if (page.suggestions.length === 0) lines.push("No package suggestions in this session.");
  for (const item of page.suggestions) {
    lines.push(
      `${item.sourceId}:${item.listingId} · ${item.kind} · ${item.title}` +
        (item.version?.packageVersion ? ` · ${item.version.packageVersion}` : "") +
        (item.state === "dismissed" ? " · dismissed" : ""),
      `  ${item.summary}`,
      `  Package ${item.packageId}` +
        (item.version === null ? "" : ` · identity ${item.version.identityDigest}`),
      `  Because of ${item.reasons.map(suggestionReasonText).join("; ")}`,
      `  Source: ${freshnessText(item.freshness)}`,
      `  ${installText(item)}`,
    );
  }
  for (const refusal of page.refusals)
    lines.push(
      `Refused ${refusal.sourceId}:${refusal.listingId} from ${refusal.origin}: ${refusal.code}.`,
    );
  if ((context.proposals ?? []).length > 0)
    lines.push(
      `Proposed by project configuration, not enabled: ${(context.proposals ?? []).join(", ")}. ` +
        `Only user configuration (${PACKAGE_SUGGESTIONS_KEY}) opts a source in.`,
    );
  if ((context.omitted ?? 0) > 0)
    lines.push(`${context.omitted} later observations were not kept (session limit).`);
  lines.push("Suggestions install, enable and trust nothing.");
  return lines;
}
