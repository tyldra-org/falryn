/** Hush command-catalog policy for ruby.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const RUBY_DIAGNOSTIC_POLICY = {
  reducerId: "ruby.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["rubocop"],
  examples: ["bundle exec rubocop"],
} as const satisfies HushCatalogEntry;
