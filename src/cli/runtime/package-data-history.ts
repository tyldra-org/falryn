import { randomUUID } from "node:crypto";
import { exportPackageData } from "../../application/extensions/package-data-transfer.ts";
import type { PackageDataDocument } from "../../domain/extensions/package-data-store.ts";
import type { PackageDataBundle } from "../../domain/extensions/package-data-transfer.ts";

/** Session export selects session state only. User settings require the explicit package data export. */
export function packageDataForSessionExport(
  documents: readonly PackageDataDocument[],
  sessions: readonly string[],
): PackageDataBundle[] {
  const bundles: PackageDataBundle[] = [];
  for (const document of documents) {
    const selected = document.records.filter(
      (record) => record.identity.scope === "session" && sessions.includes(record.identity.owner),
    );
    const first = selected[0];
    if (!first) continue;
    bundles.push(
      exportPackageData({ ...document, layers: [], records: selected }, randomUUID(), {
        binding: first.binding,
        hostControl: true,
        current: () => true,
        allows: (scope, owner) => scope === "session" && sessions.includes(owner),
      }),
    );
  }
  return bundles;
}
