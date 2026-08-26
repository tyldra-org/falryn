/** Hush command-catalog policy for precommit.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PRECOMMIT_DIAGNOSTIC_POLICY = {
  reducerId: "precommit.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["pre-commit"],
  examples: ["pre-commit run --all-files"],
} as const satisfies HushCatalogEntry;
