import { z } from "zod";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import type { PackageSuggestionPage } from "../../application/extensions/package-suggestions.ts";
import { resolveConfigurationFilePath, writeConfigurationValue } from "../../config/index.ts";
import { createCuratedCatalogRepository } from "../../data/extensions/curated-catalog-repository.ts";
import { createRecordRepositories, createSqliteEventStore } from "../../data/index.ts";
import type { ConfigurationValues } from "../../domain/configuration/index.ts";
import { identityText } from "../../domain/extensions/identity.ts";
import {
  PACKAGE_SUGGESTION_LIMITS,
  PACKAGE_SUGGESTIONS_KEY,
  type PackageSuggestionPreferences,
  type PackageSuggestionRecord,
} from "../../domain/extensions/package-suggestion.ts";
import { recoveryForEffect, sequence, sessionId } from "../../domain/foundation/index.ts";
import { MAX_STREAM_READ_LIMIT } from "../../domain/foundation/limits.ts";
import type { GlobalOptions } from "../options.ts";
import type { CommandResultOf } from "../output/result.ts";
import {
  createConfiguredSuggestionResolver,
  packageSuggestionPreferences,
  packageSuggestionProposals,
} from "../runtime/package-suggestion-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
  validateProductConfigurationCandidate,
} from "../runtime/product-configuration.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

const sourceId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
/** The user configuration file's revision the caller read; null when it did not exist. */
const expectedRevision = z.string().min(1).max(256).nullable();

/**
 * One bounded request. `list` shows what a session recorded, checked against current
 * catalogs and preferences; `inspect` shows one listed package as an install decision
 * would see it. `dismiss` and `reset` change only the user's dismissals, revision-checked.
 * Nothing here installs, enables, trusts or fetches anything.
 */
export const extensionSuggestionArgumentsSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list"), sessionId: z.string().min(1).max(256) }),
  z.strictObject({
    operation: z.literal("inspect"),
    sourceId,
    listingId: z.string().min(1).max(129),
    packageId: identityText,
    packageVersion: z.string().min(1).max(128).nullable().default(null),
  }),
  z.strictObject({
    operation: z.literal("dismiss"),
    sourceId,
    packageId: identityText,
    expectedRevision,
  }),
  z.strictObject({
    operation: z.literal("reset"),
    /** Both absent clears every dismissal; otherwise only the named one. */
    sourceId: sourceId.optional(),
    packageId: identityText.optional(),
    expectedRevision,
  }),
]);
export type ExtensionSuggestionArguments = z.infer<typeof extensionSuggestionArgumentsSchema>;

export type SuggestionPreferencesView = PackageSuggestionPreferences & {
  /** Pass back as `expectedRevision` to dismiss or reset. */
  readonly revision: string | null;
  /** Sources the project proposes; never enabled by being proposed. */
  readonly proposals: readonly string[];
};

export type ExtensionSuggestionPayload =
  | {
      readonly status: "listed" | "inspected";
      readonly page: PackageSuggestionPage;
      readonly preferences: SuggestionPreferencesView;
    }
  | {
      readonly status: "dismissed" | "reset";
      /** False when the request matched the stored state and nothing was written. */
      readonly changed: boolean;
      readonly preferences: SuggestionPreferencesView;
    }
  | { readonly status: "failed"; readonly code: string };

export async function runExtensionSuggestion(
  services: ServiceProvider,
  args: ExtensionSuggestionArguments,
  globals: GlobalOptions,
  signal = new AbortController().signal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"extension.suggestion", ExtensionSuggestionPayload>> {
  const payload = await execute(services, args, globals, signal, onMutationStart);
  const wrote = (payload.status === "dismissed" || payload.status === "reset") && payload.changed;
  const code = payload.status === "failed" ? payload.code : null;
  const effect: "completed" | "none" = wrote ? "completed" : "none";
  const errors =
    code === null
      ? []
      : [
          {
            ...adoptForeignError(
              {
                code,
                category: "configuration",
                message:
                  code === "suggestion-preferences-stale"
                    ? "Suggestion preferences changed since they were read. List them again and retry with the new revision."
                    : "The package suggestion request could not be completed. Inspect current state before retrying.",
              },
              { operation: "extension suggestion" },
            ),
            effect,
            recovery: recoveryForEffect(effect),
          },
        ];
  return resultFor(
    "extension.suggestion",
    payload,
    errors,
    signal.aborted
      ? { kind: "cancelled", effect }
      : errors.length > 0
        ? { kind: "failed", effect }
        : undefined,
    {
      intent: args.operation === "dismiss" || args.operation === "reset" ? "mutate" : "none",
      observed: effect,
    },
  );
}

async function userFileRevision(
  services: ServiceProvider,
  signal: AbortSignal,
): Promise<string | null> {
  const graph = services();
  const home = await graph.configurationHomeForRead(signal);
  const root =
    home.kind === "current" || home.kind === "legacy" || home.kind === "empty"
      ? home.root
      : graph.configurationRoot;
  const path = resolveConfigurationFilePath({
    configurationRoot: root,
    workspaceRoot: graph.workspaceRoot,
    profile: null,
    scope: "user",
  });
  const stated = path.ok ? await graph.fileSystem.stat(path.value, signal) : null;
  return stated?.ok && stated.value !== null ? stated.value.revision : null;
}

/** Every suggestion record in one session's stream, read a bounded page at a time. */
async function recordedSuggestions(
  store: Parameters<typeof createSqliteEventStore>[0],
  session: string,
  signal: AbortSignal,
): Promise<
  | { ok: true; records: { origin: string; record: PackageSuggestionRecord }[] }
  | { ok: false; code: string }
> {
  const id = sessionId.parse(session);
  if (!id.ok) return { ok: false, code: "session-not-found" };
  const record = createRecordRepositories(store).sessions.get(id.value);
  if (!record.ok) return { ok: false, code: "session-store-unavailable" };
  if (record.value === null) return { ok: false, code: "session-not-found" };
  const events = createSqliteEventStore(store);
  const records: { origin: string; record: PackageSuggestionRecord }[] = [];
  let after: number | null = null;
  for (;;) {
    const page = await events.readFrom(
      {
        streamId: record.value.streamId,
        afterSequence: after === null ? null : sequence.from(after),
      },
      MAX_STREAM_READ_LIMIT,
      signal,
    );
    if (!page.ok) return { ok: false, code: "session-store-unavailable" };
    for (const event of page.value)
      if (event.kind === "extension.suggestion.recorded" && records.length < 64)
        records.push({ origin: String(event.correlation.turnId), record: event.payload });
    const last = page.value.at(-1);
    if (page.value.length < MAX_STREAM_READ_LIMIT || last === undefined) break;
    after = Number(last.sequence);
  }
  return { ok: true, records };
}

/** The dismissals a change leaves: dismiss adds one pair once; reset removes what it names. */
function nextDismissals(
  current: PackageSuggestionPreferences["dismissed"],
  change: Extract<ExtensionSuggestionArguments, { operation: "dismiss" | "reset" }>,
): PackageSuggestionPreferences["dismissed"] {
  if (change.operation === "dismiss") {
    const present = current.some(
      (item) => item.sourceId === change.sourceId && item.packageId === change.packageId,
    );
    return present
      ? current
      : [...current, { sourceId: change.sourceId, packageId: change.packageId }];
  }
  return current.filter(
    (item) =>
      (change.sourceId !== undefined && item.sourceId !== change.sourceId) ||
      (change.packageId !== undefined && item.packageId !== change.packageId),
  );
}

async function execute(
  services: ServiceProvider,
  args: ExtensionSuggestionArguments,
  globals: GlobalOptions,
  signal: AbortSignal,
  onMutationStart: (() => void) | undefined,
): Promise<ExtensionSuggestionPayload> {
  const graph = services();
  // Read the revision before the preferences it guards. A writer landing in between then
  // makes this request's write stale instead of letting it overwrite newer dismissals
  // with older contents under the newer revision.
  const revision = await userFileRevision(services, signal);
  let values: ConfigurationValues;
  let record: ReturnType<typeof graph.loader.current>;
  try {
    const loaded = await loadProductConfiguration(
      graph,
      productConfigurationLoadRequest(globals),
      signal,
    );
    if (loaded.outcome.kind !== "published" && loaded.outcome.kind !== "unchanged")
      return { status: "failed", code: "suggestion-preferences-unavailable" };
    values = loaded.values;
    record = graph.loader.current();
  } catch {
    return { status: "failed", code: "suggestion-preferences-unavailable" };
  }
  const preferences = packageSuggestionPreferences(values, record);
  if (preferences === null) return { status: "failed", code: "suggestion-preferences-unavailable" };
  const view = (next: PackageSuggestionPreferences, at: string | null) => ({
    ...next,
    revision: at,
    proposals: packageSuggestionProposals(values),
  });

  if (args.operation === "dismiss" || args.operation === "reset") {
    if (args.expectedRevision !== revision)
      return { status: "failed", code: "suggestion-preferences-stale" };
    const dismissed = nextDismissals(preferences.dismissed, args);
    if (dismissed.length > PACKAGE_SUGGESTION_LIMITS.dismissed)
      return { status: "failed", code: "suggestion-dismissals-full" };
    const status = args.operation === "dismiss" ? "dismissed" : "reset";
    if (dismissed.length === preferences.dismissed.length)
      return { status, changed: false, preferences: view(preferences, revision) };
    const next = { ...preferences, dismissed };
    onMutationStart?.();
    const outcome = await writeConfigurationValue(
      graph.registry,
      graph.fileSystem,
      {
        configurationRoot: graph.configurationRoot,
        legacyConfigurationRoot: graph.legacyConfigurationRoot,
        workspaceRoot: graph.workspaceRoot,
        profile: null,
        scope: "user",
        keyPath: PACKAGE_SUGGESTIONS_KEY,
        value: next,
        // Two writers that read the same revision cannot both win.
        expectedRevision: revision,
        requireAbsent: revision === null,
        validateCandidate: (path, text, abort) =>
          validateProductConfigurationCandidate(graph, null, path, text, abort),
      },
      signal,
    );
    switch (outcome.kind) {
      case "written":
        return { status, changed: true, preferences: view(next, outcome.revision) };
      case "unchanged":
        return { status, changed: false, preferences: view(preferences, revision) };
      case "stale-write":
        return { status: "failed", code: "suggestion-preferences-stale" };
      case "cancelled":
        return { status: "failed", code: "cancelled" };
      default:
        return { status: "failed", code: `suggestion-preferences-${outcome.kind}` };
    }
  }

  const opened = await openSessionStore(services, signal);
  if (!opened.ok) return { status: "failed", code: "suggestion-store-unavailable" };
  if (opened.kind === "absent")
    return args.operation === "list"
      ? { status: "failed", code: "session-not-found" }
      : {
          status: "inspected",
          page: { status: "resolved", suggestions: [], refusals: [] },
          preferences: view(preferences, revision),
        };
  try {
    const resolver = createConfiguredSuggestionResolver({
      store: createCuratedCatalogRepository(opened.store),
      now: () => Number(graph.clock.now()),
      configuration: () => ({ values, record }),
    });
    if (args.operation === "inspect")
      return {
        status: "inspected",
        page: resolver.inspect(args),
        preferences: view(preferences, revision),
      };
    const recorded = await recordedSuggestions(opened.store, args.sessionId, signal);
    if (!recorded.ok) return { status: "failed", code: recorded.code };
    return {
      status: "listed",
      page: resolver.recorded(recorded.records),
      preferences: view(preferences, revision),
    };
  } finally {
    await opened.store.close();
  }
}
