/** Hush command-catalog policy for diagnostic.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const DIAGNOSTIC_COMMAND_POLICY = {
  reducerId: "diagnostic.command",
  family: "lint",
  projection: "diagnostic",
  executables: ["hadolint", "markdownlint", "shellcheck", "yamllint"],
  examples: ["hadolint Dockerfile", "markdownlint docs", "shellcheck script.sh", "yamllint ."],
} as const satisfies HushCatalogEntry;
