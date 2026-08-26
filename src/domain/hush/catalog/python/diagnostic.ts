/** Hush command-catalog policy for python.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PYTHON_DIAGNOSTIC_POLICY = {
  reducerId: "python.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["mypy", "ruff"],
  examples: ["mypy src", "python -m mypy src", "ruff check .", "ruff format --check ."],
} as const satisfies HushCatalogEntry;
