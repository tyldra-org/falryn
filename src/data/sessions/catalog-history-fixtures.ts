import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { createExtensionCatalog } from "../../domain/extensions/catalog.ts";
import { catalogFixture } from "../../domain/extensions/catalog-fixtures.ts";
import { projectCatalogHistory } from "../../domain/extensions/catalog-history.ts";

export function sessionCatalogHistoryFixture() {
  return projectCatalogHistory(
    createExtensionCatalog({
      entries: [catalogFixture("historical-session-skill", "session")],
      generation: 7,
      inputs: bytesDigest("historical-inputs"),
    }),
  );
}
