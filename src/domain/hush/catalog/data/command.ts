/** Hush command-catalog policy for data.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const DATA_COMMAND_POLICY = {
  reducerId: "data.command",
  family: "data",
  projection: "structured",
  executables: ["psql", "jq", "sqlite3"],
  examples: ["psql -c 'select 1'", "jq . package.json", "sqlite3 db.sqlite '.tables'"],
} as const satisfies HushCatalogEntry;
