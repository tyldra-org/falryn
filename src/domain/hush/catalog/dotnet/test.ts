/** Hush command-catalog policy for dotnet.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const DOTNET_TEST_POLICY = {
  reducerId: "dotnet.test",
  family: "test",
  projection: "test",
  executables: ["dotnet"],
  examples: ["dotnet test"],
  matches: (tokens) => tokens[1] === "test",
} as const satisfies HushCatalogEntry;
