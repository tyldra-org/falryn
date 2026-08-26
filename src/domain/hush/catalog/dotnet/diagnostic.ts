/** Hush command-catalog policy for dotnet.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const DOTNET_DIAGNOSTIC_POLICY = {
  reducerId: "dotnet.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["dotnet"],
  examples: ["dotnet format"],
  matches: (tokens) => tokens[1] === "format",
} as const satisfies HushCatalogEntry;
