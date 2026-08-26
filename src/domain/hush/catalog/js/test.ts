/** Hush command-catalog policy for js.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_TEST_POLICY = {
  reducerId: "js.test",
  family: "test",
  projection: "test",
  executables: ["jest", "vitest", "playwright", "mocha"],
  examples: ["jest", "vitest run", "playwright test", "mocha"],
} as const satisfies HushCatalogEntry;
