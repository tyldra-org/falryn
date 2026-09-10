import { z } from "zod";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import type { ExtensionCatalogReport } from "../../application/extensions/catalog-report.ts";
import { createCatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { catalogQuerySchema, queryExtensionCatalog } from "../../domain/extensions/catalog.ts";
import { EXTENSION_SCOPES, identityText } from "../../domain/extensions/identity.ts";
import { scopeRequestSchema } from "../../domain/extensions/scope-controls.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { isCleanClose } from "../../domain/storage/index.ts";
import type { CommandResultOf } from "../output/result.ts";
import { composeExtensionCatalog } from "../runtime/extension-catalog.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export const extensionCatalogArgumentsSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("catalog"),
    session: identityText.optional(),
    query: catalogQuerySchema.optional(),
  }),
  z.strictObject({
    action: z.literal("scope"),
    session: identityText.optional(),
    packageId: identityText,
    scope: z.enum(EXTENSION_SCOPES),
    request: scopeRequestSchema,
  }),
]);
export type ExtensionCatalogArguments = z.infer<typeof extensionCatalogArgumentsSchema>;
export type ExtensionCatalogPayload = ExtensionCatalogReport;

export async function runExtensionCatalog(
  services: ServiceProvider,
  args: ExtensionCatalogArguments,
  signal = new AbortController().signal,
): Promise<CommandResultOf<"extension.catalog" | "extension.scope", ExtensionCatalogPayload>> {
  let payload: ExtensionCatalogPayload;
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) payload = { status: "failed", code: "scope-store-unavailable" };
  else {
    try {
      const owner = composeExtensionCatalog({
        services: services(),
        records: opened.kind === "open" ? createCatalogRepositories(opened.store) : null,
        ...(args.session === undefined ? {} : { session: args.session }),
      });
      if (args.action === "scope")
        payload = ["process", "development"].includes(args.scope)
          ? { status: "failed", code: "scope-requires-live-host" }
          : await owner.change(args.packageId, args.scope, args.request, signal);
      else {
        const result = await owner.refresh(signal);
        payload =
          result.status === "failed"
            ? result
            : {
                status: "inspected",
                page: queryExtensionCatalog(
                  result.catalog,
                  args.query ?? { catalog: result.catalog.identity },
                ),
              };
      }
    } catch (error) {
      payload = {
        status: "failed",
        code: error instanceof ExtensionInputError ? error.code : "scope-input-unavailable",
      };
    }
    if (opened.kind === "open" && !isCleanClose(await opened.store.close()))
      payload = {
        status: "failed",
        code: payload.status === "applied" ? "uncertain" : "scope-store-close-failed",
      };
  }
  const effect =
    payload.status === "applied"
      ? "completed"
      : payload.status === "failed" && payload.code === "uncertain"
        ? "uncertain"
        : "none";
  const errors =
    payload.status !== "failed"
      ? []
      : [
          adoptForeignError(
            {
              code: payload.code,
              category: "configuration",
              message: "Extension catalog operation failed. Inspect current state before retrying.",
            },
            { operation: "extension catalog" },
          ),
        ];
  return resultFor(
    args.action === "catalog" ? "extension.catalog" : "extension.scope",
    payload,
    errors.map((error) => ({ ...error, effect, recovery: recoveryForEffect(effect) })),
    effect === "uncertain" ? { kind: "uncertain", effect } : undefined,
    {
      intent:
        args.action === "scope" && args.request.confirmation !== undefined ? "mutate" : "none",
      observed: effect,
    },
  );
}
