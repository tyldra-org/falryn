import { resolve } from "node:path";
import { z } from "zod";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import {
  type CuratedCatalogPage,
  type CuratedImportReceipt,
  createCuratedCatalogs,
  curatedListQuerySchema,
} from "../../application/extensions/curated-catalogs.ts";
import { createCuratedCatalogRepository } from "../../data/extensions/curated-catalog-repository.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import { CURATED_LIMITS } from "../../domain/extensions/curated-catalog.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { isCleanClose, isRootUsable } from "../../domain/storage/index.ts";
import { parseLocalPath } from "../../domain/workspace/filesystem/contracts.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { CommandResultOf } from "../output/result.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

/** One bounded request: import a local catalog file, or page the imported listings. */
export const extensionListingArgumentsSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("import"), file: z.string().min(1).max(4_096) }),
  z.strictObject({ operation: z.literal("list"), query: curatedListQuerySchema.optional() }),
]);
export type ExtensionListingArguments = z.infer<typeof extensionListingArgumentsSchema>;
export type ExtensionListingPayload = CuratedImportReceipt | CuratedCatalogPage;

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

export async function runExtensionListing(
  services: ServiceProvider,
  args: ExtensionListingArguments,
  signal = new AbortController().signal,
): Promise<CommandResultOf<"extension.listing", ExtensionListingPayload>> {
  const payload = await execute(services, args, signal);
  const effect = payload.status === "imported" ? "completed" : "none";
  const refused =
    payload.status === "failed"
      ? payload.code
      : payload.status === "rejected"
        ? payload.code
        : null;
  const errors =
    refused === null
      ? []
      : [
          adoptForeignError(
            {
              code: refused,
              category: "configuration",
              message:
                payload.status === "rejected"
                  ? "The catalog was refused. Fix the reported fields or publish a higher sequence."
                  : "The curated catalog operation failed. Inspect current state before retrying.",
            },
            { operation: "extension listing" },
          ),
        ];
  return resultFor(
    "extension.listing",
    payload,
    errors.map((error) => ({ ...error, effect, recovery: recoveryForEffect(effect) })),
    signal.aborted ? { kind: "cancelled", effect } : undefined,
    { intent: args.operation === "import" ? "mutate" : "none", observed: effect },
  );
}

async function execute(
  services: ServiceProvider,
  args: ExtensionListingArguments,
  signal: AbortSignal,
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
  let opened = await openSessionStore(services, signal);
  if (!opened.ok) return { status: "failed", code: "catalog-store-unavailable" };
  if (opened.kind === "absent") {
    if (args.operation === "list")
      return { status: "listed", sources: [], entries: [], total: 0, nextOffset: null };
    // The first import creates local state; nothing else is written before it.
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
  const catalogs = createCuratedCatalogs({
    store: createCuratedCatalogRepository(opened.store),
    now: () => Number(resolved.clock.now()),
    host,
  });
  let payload: ExtensionListingPayload =
    args.operation === "import" && bytes !== null
      ? catalogs.import(bytes, signal)
      : catalogs.list(
          args.operation === "list"
            ? curatedListQuerySchema.parse(args.query ?? {})
            : curatedListQuerySchema.parse({}),
        );
  if (!isCleanClose(await opened.store.close()))
    payload = {
      status: "failed",
      code:
        payload.status === "imported" ? "catalog-store-uncertain" : "catalog-store-close-failed",
    };
  return payload;
}
