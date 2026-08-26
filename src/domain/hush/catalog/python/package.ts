/** Hush command-catalog policy for python.package. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PYTHON_PACKAGE_POLICY = {
  reducerId: "python.package",
  family: "package",
  projection: "package",
  executables: ["pip", "pip3", "uv", "poetry"],
  examples: [
    "pip list",
    "pip outdated",
    "pip install package",
    "pip show package",
    "uv pip install package",
    "uv run custom",
    "uv sync",
    "poetry install",
    "poetry lock",
    "poetry update",
  ],
} as const satisfies HushCatalogEntry;
