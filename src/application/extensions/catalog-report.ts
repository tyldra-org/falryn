import type { CatalogPage } from "../../domain/extensions/catalog.ts";
import type { ScopeChangeResult } from "./scope-controls.ts";

export type ExtensionCatalogReport =
  | ScopeChangeResult
  | { readonly status: "inspected"; readonly page: CatalogPage };

/** Shared inspection text contains compact identity facts, never instructions or executable grants. */
export function extensionCatalogLines(payload: ExtensionCatalogReport): readonly string[] {
  if (payload.status === "failed") return [`extensions: ${payload.code}`];
  if (payload.status !== "inspected")
    return [
      `scope ${payload.status}; revision ${payload.receipt.revision}; native execution unavailable`,
      `control: ${payload.receipt.key}`,
      `confirmation: ${payload.receipt.confirmation}`,
    ];
  return [
    `catalog: ${payload.page.catalog}; generation ${payload.page.generation}; ${payload.page.total} entries; ${payload.page.omitted} omitted`,
    ...payload.page.entries.map(
      (entry) =>
        `${entry.contribution.nativeKind} ${entry.contribution.namespace}/${entry.contribution.localId}: ${entry.enabled ? "enabled" : "disabled"}; ${entry.reason}; owner ${entry.contribution.owner.digest}`,
    ),
    ...(payload.page.next === null ? [] : [`next: ${JSON.stringify(payload.page.next)}`]),
  ];
}
