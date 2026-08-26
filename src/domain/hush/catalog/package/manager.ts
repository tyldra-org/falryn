/** Hush command-catalog policy for package.manager. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PACKAGE_MANAGER_POLICY = {
  reducerId: "package.manager",
  family: "package",
  projection: "package",
  executables: ["brew", "composer", "bundle"],
  examples: [
    "brew install bun",
    "brew upgrade bun",
    "composer install",
    "composer update",
    "composer require package",
    "bundle install",
    "bundle update",
  ],
} as const satisfies HushCatalogEntry;
