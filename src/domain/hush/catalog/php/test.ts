/** Hush command-catalog policy for php.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PHP_TEST_POLICY = {
  reducerId: "php.test",
  family: "test",
  projection: "test",
  executables: ["phpunit", "pest", "paratest"],
  examples: ["phpunit", "vendor/bin/pest", "vendor/bin/paratest"],
} as const satisfies HushCatalogEntry;
