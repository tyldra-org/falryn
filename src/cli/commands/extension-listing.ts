import { resolve } from "node:path";
import { z } from "zod";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import {
  type CuratedCatalogPayload,
  createCuratedCatalogs,
  curatedInspectQuerySchema,
  curatedListQuerySchema,
} from "../../application/extensions/curated-catalogs.ts";
import type {
  MarketplaceFetch,
  MarketplaceFetchPort,
} from "../../application/extensions/marketplace-port.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createCuratedCatalogRepository } from "../../data/extensions/curated-catalog-repository.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import { CURATED_LIMITS } from "../../domain/extensions/curated-catalog.ts";
import { MARKETPLACE_LIMITS, type MarketplaceSource } from "../../domain/extensions/marketplace.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import { isCleanClose, isRootUsable } from "../../domain/storage/index.ts";
import { parseLocalPath } from "../../domain/workspace/filesystem/contracts.ts";
import { createHostMarketplaceHttp } from "../../integrations/extensions/host-marketplace-http.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { OwnedProcessRegistry } from "../../integrations/process/host-owned-process-registry.ts";
import type { GlobalOptions } from "../options.ts";
import type { CommandResultOf } from "../output/result.ts";
import { marketplaceSources } from "../runtime/marketplace-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "../runtime/product-configuration.ts";
import { composeHostProductCredentials } from "../runtime/product-credentials.ts";
import type { ServiceProvider, Services } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

/**
 * One bounded request: import a local catalog file, refresh configured marketplaces, page
 * the stored listings, or inspect one listed version. Only import and refresh write.
 */
export const extensionListingArgumentsSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("import"), file: z.string().min(1).max(4_096) }),
  z.strictObject({
    operation: z.literal("refresh"),
    sourceId: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({ operation: z.literal("list"), query: curatedListQuerySchema.optional() }),
  z.strictObject({ operation: z.literal("inspect"), query: curatedInspectQuerySchema }),
]);
export type ExtensionListingArguments = z.infer<typeof extensionListingArgumentsSchema>;
export type ExtensionListingPayload = CuratedCatalogPayload;

/**
 * Read the catalog through the host file system. Its size is checked before any bytes
 * are read, so an oversized document is refused without being loaded.
 */
async function readCatalogFile(
  services: ServiceProvider,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array | { readonly refused: string } | null> {
  const local = parseLocalPath(resolve(path));
  if (!local.ok) return null;
  const read = await services().fileSystem.readText(
    local.value,
    CURATED_LIMITS.documentBytes,
    signal,
  );
  if (read.ok) return new TextEncoder().encode(read.value);
  if (read.error.code === "oversized") return { refused: "catalog-too-large" };
  if (read.error.code === "malformed-encoding") return { refused: "catalog-malformed" };
  return null;
}

/** Refusals and failures a caller must see, one per source for a refresh. */
function refusals(payload: ExtensionListingPayload): readonly string[] {
  if (payload.status === "failed" || payload.status === "rejected") return [payload.code];
  if (payload.status === "not-found") return [payload.code];
  if (payload.status === "refreshed")
    return payload.results.flatMap((result) =>
      result.receipt.status === "failed" || result.receipt.status === "rejected"
        ? [result.receipt.code]
        : [],
    );
  return [];
}

function wrote(payload: ExtensionListingPayload): boolean {
  if (payload.status === "imported") return true;
  return (
    payload.status === "refreshed" &&
    payload.results.some(
      (result) =>
        result.receipt.status === "imported" ||
        (result.receipt.status === "unchanged" && result.fetchedAt !== null),
    )
  );
}

export async function runExtensionListing(
  services: ServiceProvider,
  args: ExtensionListingArguments,
  globals: GlobalOptions,
  signal = new AbortController().signal,
  ownedProcesses?: OwnedProcessRegistry,
): Promise<CommandResultOf<"extension.listing", ExtensionListingPayload>> {
  const payload = await execute(services, args, globals, signal, ownedProcesses);
  const codes = refusals(payload);
  const effect = !wrote(payload) ? "none" : codes.length > 0 ? "partial" : "completed";
  const errors = codes.map((code) =>
    adoptForeignError(
      {
        code,
        category: code.startsWith("marketplace-") ? "network" : "configuration",
        message:
          payload.status === "refreshed"
            ? "A marketplace was not refreshed; its cached catalog is unchanged. Inspect the source's result before retrying."
            : payload.status === "rejected"
              ? "The catalog was refused. Fix the reported fields or publish a higher sequence."
              : payload.status === "not-found"
                ? "No matching listing or version is available. List the catalog first."
                : "The curated catalog operation failed. Inspect current state before retrying.",
      },
      { operation: "extension listing" },
    ),
  );
  const mutating = args.operation === "import" || args.operation === "refresh";
  return resultFor(
    "extension.listing",
    payload,
    errors.map((error) => ({ ...error, effect, recovery: recoveryForEffect(effect) })),
    signal.aborted
      ? { kind: "cancelled", effect }
      : errors.length > 0
        ? { kind: "failed", effect }
        : undefined,
    { intent: mutating ? "mutate" : "none", observed: effect },
  );
}

/** Each fetch is admitted by the product resource owner as one external request. */
function admittedFetch(
  graph: Services,
  generation: string,
  ownedProcesses: OwnedProcessRegistry | undefined,
): { readonly port: MarketplaceFetchPort; close(): void } {
  const http = createHostMarketplaceHttp({
    credentials: composeHostProductCredentials({
      clock: graph.clock,
      environment: graph.environment,
      ...(ownedProcesses ? { ownedProcesses } : {}),
    }).resolver,
    now: () => Number(graph.clock.now()),
    ...(graph.egress === undefined ? {} : { egress: graph.egress }),
  });
  const resources = processProductResources.openTask(generation);
  return {
    port: {
      async fetch(source: MarketplaceSource, signal: AbortSignal) {
        const identity = crypto.randomUUID();
        const admitted = await resources.execute<MarketplaceFetch>({
          operation: identity,
          attempt: identity,
          generation: resources.generation,
          inputBytes: source.url.length,
          amounts: {
            operations: 1,
            requests: 1,
            bufferedBytes: MARKETPLACE_LIMITS.responseBytes,
          },
          signal,
          unit: {
            id: workUnitId(identity),
            effect: "external",
            priority: "interactive",
            conflictKeys: [],
            dependencies: [],
            deadline: null,
            expectedOutputBytes: MARKETPLACE_LIMITS.responseBytes,
            retry: NO_RETRY,
            scopeId: null,
          },
          async run(admittedSignal) {
            const value = await http.fetch(source, admittedSignal);
            // A GET changes nothing remotely; the local cache write happens after admission.
            return { value, terminated: true, observedEffect: "none" };
          },
        });
        if (admitted.kind === "completed") return admitted.value;
        return {
          kind: "failed",
          code: signal.aborted ? "marketplace-cancelled" : "marketplace-resource-admission-denied",
        };
      },
    },
    close: () => resources.close(),
  };
}

async function execute(
  services: ServiceProvider,
  args: ExtensionListingArguments,
  globals: GlobalOptions,
  signal: AbortSignal,
  ownedProcesses: OwnedProcessRegistry | undefined,
): Promise<ExtensionListingPayload> {
  const resolved = services();
  const host = {
    falryn: FALRYN_VERSION,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
  };
  let bytes: Uint8Array | null = null;
  if (args.operation === "import") {
    const read = await readCatalogFile(services, args.file, signal);
    if (read === null) return { status: "failed", code: "catalog-file-unreadable" };
    if ("refused" in read)
      return {
        status: "rejected",
        code: read.refused,
        sourceId: null,
        storedSequence: null,
        diagnostics: [{ code: read.refused, path: "/", entry: null, listingId: null }],
      };
    bytes = read;
  }
  // Configuration names the marketplaces; an unreadable one leaves freshness unknown.
  let sources: readonly MarketplaceSource[] | null = null;
  let generation = "0";
  if (args.operation !== "import") {
    try {
      const loaded = await loadProductConfiguration(
        resolved,
        productConfigurationLoadRequest(globals),
        signal,
      );
      if (loaded.outcome.kind === "published" || loaded.outcome.kind === "unchanged") {
        sources = marketplaceSources(loaded.values, resolved.loader.current());
        generation = String(loaded.generation);
      }
    } catch {
      sources = null;
    }
    if (args.operation === "refresh" && sources === null)
      return { status: "failed", code: "marketplace-configuration-unavailable" };
  }
  let opened = await openSessionStore(services, signal);
  if (!opened.ok) return { status: "failed", code: "catalog-store-unavailable" };
  if (opened.kind === "absent") {
    if (args.operation === "list")
      return { status: "listed", sources: [], entries: [], total: 0, nextOffset: null };
    if (args.operation === "inspect") return { status: "not-found", code: "listing-not-found" };
    // The first import or refresh creates local state; nothing else is written before it.
    const stateRoot = rootChild(resolved.localData.layout, "state");
    const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
    if (stateRoot === null || databasePath === null)
      return { status: "failed", code: "catalog-store-unavailable" };
    const roots = await resolved.localData.prepareRoots(["state"], signal);
    if (!roots.every(isRootUsable)) return { status: "failed", code: "catalog-store-unavailable" };
    const created = await openSqliteStore(
      {
        open: openBunSqlite,
        clock: resolved.clock,
        databasePath,
        backupDirectory: stateRoot,
        migrations: PRODUCTION_MIGRATIONS,
        create: true,
      },
      signal,
    );
    if (!created.ok) return { status: "failed", code: "catalog-store-unavailable" };
    opened = { ok: true, kind: "open", store: created.value };
  }
  const fetcher =
    args.operation === "refresh" ? admittedFetch(resolved, generation, ownedProcesses) : null;
  const catalogs = createCuratedCatalogs({
    store: createCuratedCatalogRepository(opened.store),
    now: () => Number(resolved.clock.now()),
    host,
    marketplaces: () => sources,
    ...(fetcher === null ? {} : { fetch: fetcher.port }),
  });
  let payload: ExtensionListingPayload;
  try {
    payload =
      args.operation === "import" && bytes !== null
        ? catalogs.import(bytes, signal)
        : args.operation === "refresh"
          ? await catalogs.refresh(args.sourceId ?? null, signal)
          : args.operation === "inspect"
            ? catalogs.inspect(args.query)
            : catalogs.list(
                curatedListQuerySchema.parse(args.operation === "list" ? (args.query ?? {}) : {}),
              );
  } finally {
    fetcher?.close();
  }
  if (!isCleanClose(await opened.store.close()))
    payload = {
      status: "failed",
      code: wrote(payload) ? "catalog-store-uncertain" : "catalog-store-close-failed",
    };
  return payload;
}
