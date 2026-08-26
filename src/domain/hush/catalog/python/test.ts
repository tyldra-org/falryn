/** Hush command-catalog policy for python.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PYTHON_TEST_POLICY = {
  reducerId: "python.test",
  family: "test",
  projection: "test",
  executables: ["pytest"],
  examples: ["pytest", "python -m pytest"],
} as const satisfies HushCatalogEntry;
