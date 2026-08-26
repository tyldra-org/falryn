/** Hush command-catalog policy for php.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PHP_DIAGNOSTIC_POLICY = {
  reducerId: "php.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["phpstan", "ecs", "pint"],
  examples: ["phpstan analyse src", "ecs check src", "pint --test"],
} as const satisfies HushCatalogEntry;
